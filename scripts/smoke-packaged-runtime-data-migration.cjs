#!/usr/bin/env node

'use strict'

const { spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} = require('node:fs/promises')
const { createServer } = require('node:net')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const {
  createDesktopLaunchPlan,
  createIsolatedEnvironment,
  desktopUserDataCandidates,
  platformDesktopArguments,
  resolvedDesktopResourceCandidates,
  resolveDesktopLaunchSelection,
  terminateProcessTree
} = require('./smoke-packaged-extension-desktop.cjs')
const {
  makeTreeWritable,
  resolvePackagedRuntimeExecutable
} = require('./smoke-packaged-extensions.cjs')

const DEFAULT_TIMEOUT_MS = 120_000
const PROCESS_OUTPUT_LIMIT = 128 * 1024
const LEGACY_THREAD_ID = 'thr_packaged_upgrade_legacy'
const DISPLACED_THREAD_ID = 'thr_packaged_upgrade_displaced'
const RUNTIME_TOKEN = 'packaged-runtime-data-migration-smoke-token'

async function main() {
  const timeoutMs = positiveIntegerArgument('--timeout-ms', DEFAULT_TIMEOUT_MS)
  const resourcesDir = resolveResources(argumentValue('--resources'))
  const packagedRuntimeExecutable = resolvePackagedRuntimeExecutable(resourcesDir)
  if (!packagedRuntimeExecutable) {
    throw new Error(`The packaged application at ${resourcesDir} is not host-native for ${process.arch}`)
  }
  const desktopLaunchSelection = resolveDesktopLaunchSelection({
    resourcesDir,
    runtimeExecutable: packagedRuntimeExecutable,
    packagedRuntimeExecutable,
    desktopExecutable: argumentValue('--desktop-executable')
  })

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'kun-packaged-runtime-migration-smoke-'))
  const home = join(temporaryRoot, 'home')
  const legacyDataDir = join(home, '.deepseekgui', 'kun')
  const currentDataDir = join(home, '.kun', 'data')
  const workspaceRoot = join(home, '.kun', 'default_workspace')
  const explicitUserData = join(temporaryRoot, 'electron-user-data')
  const appData = join(temporaryRoot, 'app-data')
  const localAppData = join(temporaryRoot, 'local-app-data')
  const temporaryDirectory = join(temporaryRoot, 'tmp')
  const runtimePort = await availablePort()
  const userDataCandidates = desktopUserDataCandidates({
    platform: process.platform,
    home,
    appData,
    explicitUserData
  })

  await Promise.all([
    home,
    legacyDataDir,
    currentDataDir,
    workspaceRoot,
    explicitUserData,
    appData,
    localAppData,
    temporaryDirectory,
    ...userDataCandidates
  ].map((path) => mkdir(path, { recursive: true })))
  await seedThread(legacyDataDir, LEGACY_THREAD_ID, 'pre-upgrade legacy history', workspaceRoot)
  await seedThread(currentDataDir, DISPLACED_THREAD_ID, 'pre-existing new history', workspaceRoot)
  await writeFile(
    join(legacyDataDir, 'config.json'),
    `${JSON.stringify({
      models: {
        profiles: {
          legacy_authority_model: { contextWindowTokens: 128_000 }
        }
      }
    }, null, 2)}\n`
  )
  await writeFile(
    join(currentDataDir, 'config.json'),
    `${JSON.stringify({
      models: {
        profiles: {
          displaced_destination_model: { contextWindowTokens: 128_000 }
        }
      }
    }, null, 2)}\n`
  )

  const settingsText = `${JSON.stringify(
    packagedUpgradeSettings(runtimePort, workspaceRoot, legacyDataDir),
    null,
    2
  )}\n`
  await Promise.all(userDataCandidates.map((directory) =>
    writeFile(join(directory, 'kun-settings.json'), settingsText)
  ))

  const isolatedEnvironment = createIsolatedEnvironment(process.env, {
    home,
    appData,
    localAppData,
    temporaryDirectory
  })
  const applicationEntry = desktopLaunchSelection.applicationEntry
  const applicationArguments = [
    ...(applicationEntry ? [applicationEntry] : []),
    `--user-data-dir=${explicitUserData}`,
    '--no-first-run',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    ...platformDesktopArguments(process.platform)
  ]
  const launch = createDesktopLaunchPlan({
    executable: desktopLaunchSelection.desktopExecutable,
    applicationArguments,
    environment: isolatedEnvironment,
    platform: process.platform,
    hasDisplay: Boolean(isolatedEnvironment.DISPLAY),
    xvfbExecutable: argumentValue('--xvfb-run') ?? 'xvfb-run'
  })

  let desktopProcess
  let output = ''
  let primaryError
  const cleanupErrors = []
  try {
    desktopProcess = spawn(launch.command, launch.args, {
      cwd: home,
      env: launch.env,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const appendOutput = (chunk) => {
      output = `${output}${String(chunk)}`.slice(-PROCESS_OUTPUT_LIMIT)
    }
    desktopProcess.stdout?.on('data', appendOutput)
    desktopProcess.stderr?.on('data', appendOutput)
    desktopProcess.once('error', (error) => appendOutput(`\nlaunch error: ${String(error)}\n`))

    const threads = await waitForMigratedHistory({
      port: runtimePort,
      token: RUNTIME_TOKEN,
      timeoutMs,
      processState: () => processState(desktopProcess)
    })
    assertThreadIds(threads, [LEGACY_THREAD_ID, DISPLACED_THREAD_ID])

    const activeUserData = userDataCandidates.find((directory) =>
      existsSync(join(directory, 'kun-runtime-data-migration-v2.json'))
    )
    if (!activeUserData) {
      throw new Error('Packaged GUI did not create a Runtime migration journal')
    }
    await assertMigratedFilesystem({
      activeUserData,
      legacyDataDir,
      currentDataDir,
      timeoutMs: Math.min(timeoutMs, 10_000)
    })

    process.stdout.write(
      `Packaged Runtime data migration smoke OK (${process.platform}/${process.arch}): ` +
      'legacy authority promoted, displaced history salvaged, compatibility link verified, ' +
      'new settings/config authority committed, Runtime healthy, and both histories enumerated.\n'
    )
  } catch (error) {
    primaryError = error
  } finally {
    if (desktopProcess) {
      await terminateProcessTree(desktopProcess, process.platform, {
        timeoutMs: 15_000,
        ports: [runtimePort]
      }).catch((error) => cleanupErrors.push(error))
    }
    if (process.env.KUN_KEEP_PACKAGED_RUNTIME_MIGRATION_SMOKE === '1') {
      process.stderr.write(`Preserved packaged Runtime migration profile: ${temporaryRoot}\n`)
    } else {
      await makeTreeWritable(temporaryRoot).catch(() => undefined)
      await rm(temporaryRoot, { recursive: true, force: true })
        .catch((error) => cleanupErrors.push(error))
    }
  }

  if (primaryError || cleanupErrors.length > 0) {
    const message = primaryError instanceof Error
      ? primaryError.stack ?? primaryError.message
      : primaryError === undefined
        ? 'Packaged Runtime migration smoke cleanup failed'
        : String(primaryError)
    const cleanupDiagnostics = cleanupErrors.length > 0
      ? `\nCleanup failures:\n${cleanupErrors.map((error) =>
          `- ${error instanceof Error ? error.message : String(error)}`
        ).join('\n')}`
      : ''
    const processDiagnostics = output.trim()
      ? `\nPackaged Electron output (tail):\n${output.trim()}`
      : ''
    throw new Error(`${message}${cleanupDiagnostics}${processDiagnostics}`)
  }
}

function packagedUpgradeSettings(runtimePort, workspaceRoot, legacyDataDir) {
  return {
    version: 1,
    workspaceRoot,
    agents: {
      kun: {
        dataDir: legacyDataDir,
        port: runtimePort,
        runtimeToken: RUNTIME_TOKEN,
        autoStart: true,
        providerId: 'deepseek',
        model: 'deepseek-chat',
        baseUrl: 'https://invalid.example'
      }
    }
  }
}

async function seedThread(dataDir, id, title, workspace) {
  const threadDirectory = join(dataDir, 'threads', id)
  const timestamp = '2026-07-26T00:00:00.000Z'
  const thread = {
    id,
    title,
    workspace,
    model: 'deepseek-chat',
    mode: 'agent',
    status: 'idle',
    approvalPolicy: 'on-request',
    sandboxMode: 'workspace-write',
    relation: 'primary',
    createdAt: timestamp,
    updatedAt: timestamp,
    turns: []
  }
  await mkdir(threadDirectory, { recursive: true })
  await writeFile(
    join(threadDirectory, 'metadata.jsonl'),
    `${JSON.stringify({
      kind: 'thread_metadata',
      version: 1,
      timestamp,
      thread
    })}\n`
  )
  await writeFile(join(threadDirectory, 'messages.jsonl'), '')
}

async function waitForMigratedHistory({ port, token, timeoutMs, processState: readProcessState }) {
  const deadline = Date.now() + timeoutMs
  let lastFailure = 'Runtime has not answered yet'
  while (Date.now() < deadline) {
    const state = readProcessState()
    if (state !== 'running') {
      throw new Error(`Packaged GUI exited before migration validation (${state})`)
    }
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`)
      if (health.ok) {
        const response = await fetch(
          `http://127.0.0.1:${port}/v1/threads?limit=500&include_archived=true&include=side`,
          { headers: { authorization: `Bearer ${token}` } }
        )
        const text = await response.text()
        if (!response.ok) {
          lastFailure = `thread API returned ${response.status}: ${text.slice(0, 500)}`
        } else {
          const payload = JSON.parse(text)
          const threads = Array.isArray(payload.threads) ? payload.threads : []
          const ids = new Set(threads.map((thread) => thread?.id))
          if (ids.has(LEGACY_THREAD_ID) && ids.has(DISPLACED_THREAD_ID)) return threads
          lastFailure = `thread API is missing migrated ids (found ${[...ids].join(', ')})`
        }
      } else {
        lastFailure = `health returned ${health.status}`
      }
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error)
    }
    await delay(200)
  }
  throw new Error(`Timed out waiting for migrated packaged Runtime history: ${lastFailure}`)
}

async function assertMigratedFilesystem({
  activeUserData,
  legacyDataDir,
  currentDataDir,
  timeoutMs
}) {
  const journalPath = join(activeUserData, 'kun-runtime-data-migration-v2.json')
  const journal = await waitForRuntimeVerification(journalPath, timeoutMs)
  if (journal.phase !== 'completed') {
    throw new Error(`Runtime migration journal did not complete: ${String(journal.phase)}`)
  }
  if (typeof journal.runtimeVerifiedAt !== 'string' || !journal.runtimeVerifiedAt) {
    throw new Error('Runtime migration journal has no post-launch verification timestamp')
  }
  if (typeof journal.destinationBackupPath !== 'string') {
    throw new Error('Populated destination was not retained as a migration backup')
  }
  const settings = JSON.parse(await readFile(join(activeUserData, 'kun-settings.json'), 'utf8'))
  if (settings?.agents?.kun?.dataDir !== '~/.kun/data') {
    throw new Error(`Packaged settings still select ${String(settings?.agents?.kun?.dataDir)}`)
  }
  const legacyStats = await lstat(legacyDataDir)
  if (!legacyStats.isSymbolicLink()) {
    throw new Error('Legacy Runtime path is not a compatibility link/junction')
  }
  const legacyRealPath = await realpath(legacyDataDir)
  const currentRealPath = await realpath(currentDataDir)
  const sameRealPath = process.platform === 'win32'
    ? legacyRealPath.toLocaleLowerCase('en-US') === currentRealPath.toLocaleLowerCase('en-US')
    : legacyRealPath === currentRealPath
  if (!sameRealPath) {
    throw new Error('Legacy Runtime compatibility path does not resolve to the canonical store')
  }
  const activeConfig = JSON.parse(await readFile(join(currentDataDir, 'config.json'), 'utf8'))
  if (!activeConfig?.models?.profiles?.legacy_authority_model) {
    throw new Error('The settings-selected legacy config did not remain authoritative')
  }
  const displacedConfig = JSON.parse(await readFile(
    join(journal.destinationBackupPath, 'config.json'),
    'utf8'
  ))
  if (!displacedConfig?.models?.profiles?.displaced_destination_model) {
    throw new Error('The displaced destination config was not preserved in its backup')
  }
}

async function waitForRuntimeVerification(journalPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let journal
  while (Date.now() < deadline) {
    journal = JSON.parse(await readFile(journalPath, 'utf8'))
    if (typeof journal.runtimeVerifiedAt === 'string' && journal.runtimeVerifiedAt) return journal
    await delay(50)
  }
  return journal
}

function assertThreadIds(threads, requiredIds) {
  const ids = new Set(threads.map((thread) => thread?.id))
  for (const id of requiredIds) {
    if (!ids.has(id)) throw new Error(`Packaged Runtime thread listing is missing ${id}`)
  }
}

function resolveResources(explicit) {
  if (explicit) {
    const path = resolve(explicit)
    if (!existsSync(path)) throw new Error(`Packaged resources do not exist: ${path}`)
    return path
  }
  const candidates = resolvedDesktopResourceCandidates()
  const found = candidates.find(existsSync)
  if (found) return found
  throw new Error(
    `Cannot find host-native packaged resources for ${process.platform}/${process.arch}; ` +
    `pass --resources <path> (checked ${candidates.join(', ') || 'no supported path'})`
  )
}

async function availablePort() {
  const server = createServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise())
  })
  if (!port) throw new Error('Could not allocate a packaged Runtime migration smoke port')
  return port
}

function processState(child) {
  if (!child) return 'not-started'
  if (child.exitCode !== null) return `exit-${child.exitCode}`
  if (child.signalCode !== null) return `signal-${child.signalCode}`
  return 'running'
}

function argumentValue(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function positiveIntegerArgument(name, fallback) {
  const raw = argumentValue(name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

module.exports = {
  DISPLACED_THREAD_ID,
  LEGACY_THREAD_ID,
  RUNTIME_TOKEN,
  assertThreadIds,
  packagedUpgradeSettings,
  processState
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
