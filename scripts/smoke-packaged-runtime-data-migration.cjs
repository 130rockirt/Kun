#!/usr/bin/env node

'use strict'

const { spawn, spawnSync } = require('node:child_process')
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
const { DatabaseSync } = require('node:sqlite')
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

const {
  MIGRATED_EXTENSION_ID,
  MIGRATED_EXTENSION_VERSION,
  RUNTIME_TOKEN,
  packagedUpgradeSettings,
  seedLegacyExtensionRegistry,
  seedLegacyThreadIndex,
  seedThread
} = require('./smoke-packaged-runtime-data-migration-fixtures.cjs')

const DEFAULT_TIMEOUT_MS = 120_000
const PROCESS_OUTPUT_LIMIT = 128 * 1024
const LEGACY_THREAD_ID = 'thr_packaged_upgrade_legacy'
const DISPLACED_THREAD_ID = 'thr_packaged_upgrade_displaced'

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
  seedLegacyThreadIndex(legacyDataDir, [{
    id: LEGACY_THREAD_ID,
    title: 'pre-upgrade legacy history',
    workspace: workspaceRoot
  }])
  const seededLegacyRegistry = await seedLegacyExtensionRegistry(legacyDataDir)
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
  let electedRuntimeConnection
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
      dataDir: currentDataDir,
      timeoutMs,
      onConnection: (connection) => {
        electedRuntimeConnection = connection
      },
      processState: () => processState(desktopProcess)
    })
    assertThreadIds(threads, [LEGACY_THREAD_ID, DISPLACED_THREAD_ID])

    const activeUserData = userDataCandidates.find((directory) =>
      existsSync(join(directory, 'kun-runtime-data-migration-v3.json'))
    )
    if (!activeUserData) {
      throw new Error('Packaged GUI did not create a Runtime migration journal')
    }
    await assertMigratedFilesystem({
      activeUserData,
      legacyDataDir,
      currentDataDir,
      seededLegacyRegistry,
      timeoutMs: Math.min(timeoutMs, 10_000)
    })

    process.stdout.write(
      `Packaged Runtime data migration smoke OK (${process.platform}/${process.arch}): ` +
      'legacy history preserved independently, displaced history salvaged, ' +
      'extension paths rebased, new settings/config authority committed, Runtime healthy, ' +
      'and both histories enumerated.\n'
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
    const latestRuntimeConnection = await readRuntimeConnection(currentDataDir)
      .catch(() => electedRuntimeConnection)
    if (latestRuntimeConnection) {
      await stopElectedRuntime(latestRuntimeConnection, process.platform)
        .catch((error) => cleanupErrors.push(error))
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

function runtimeConnectionFromDocument(document) {
  const port = document?.port
  const pid = document?.pid
  const token = document?.runtimeToken
  const instanceId = document?.instanceId
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('shared Runtime discovery has an invalid port')
  }
  if (typeof token !== 'string' || !token) {
    throw new Error('shared Runtime discovery has no bearer token')
  }
  if (typeof instanceId !== 'string' || !instanceId) {
    throw new Error('shared Runtime discovery has no instance id')
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error('shared Runtime discovery has an invalid process id')
  }
  return { instanceId, pid, port, token }
}

async function readRuntimeConnection(dataDir) {
  return runtimeConnectionFromDocument(JSON.parse(
    await readFile(join(dataDir, 'runtime.json'), 'utf8')
  ))
}

async function stopElectedRuntime(connection, platform) {
  const { instanceId, pid, port, token } = connection
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/runtime/shutdown`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ instanceId }),
      signal: AbortSignal.timeout(5_000)
    })
    if (!response.ok) {
      throw new Error(`shared Runtime shutdown returned ${response.status}`)
    }
  } catch {
    if (!processIsAlive(pid)) return
    // The isolated discovery record still gives us the exact elected PID.
    // Continue with bounded process-tree cleanup if its HTTP shutdown path
    // disappeared before returning a response.
  }
  if (await waitForProcessIdExit(pid, 3_000)) return
  if (platform === 'win32') {
    const result = spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      timeout: 5_000,
      windowsHide: true
    })
    if (result.error || result.status !== 0) {
      throw new Error(`could not terminate elected shared Runtime PID ${pid}`)
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch (error) {
      if (processIsAlive(pid)) throw error
    }
  }
  if (!await waitForProcessIdExit(pid, 5_000)) {
    throw new Error(`elected shared Runtime PID ${pid} survived cleanup`)
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function waitForProcessIdExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true
    await delay(100)
  }
  return !processIsAlive(pid)
}

async function waitForMigratedHistory({
  dataDir,
  timeoutMs,
  onConnection = () => undefined,
  processState: readProcessState
}) {
  const deadline = Date.now() + timeoutMs
  let lastFailure = 'Runtime has not answered yet'
  while (Date.now() < deadline) {
    const state = readProcessState()
    if (state !== 'running') {
      throw new Error(`Packaged GUI exited before migration validation (${state})`)
    }
    try {
      const connection = await readRuntimeConnection(dataDir)
      onConnection(connection)
      const { port, token } = connection
      const health = await fetch(`http://127.0.0.1:${port}/health`)
      if (health.ok) {
        const response = await fetch(
          `http://127.0.0.1:${port}/v1/threads?include_archived=true&include=side`,
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
  seededLegacyRegistry,
  timeoutMs
}) {
  const journalPath = join(activeUserData, 'kun-runtime-data-migration-v3.json')
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
  if (journal.extensionRegistryRebasedRecords !== 1) {
    throw new Error(
      `Expected one migrated extension path, found ${String(journal.extensionRegistryRebasedRecords)}`
    )
  }
  const settings = JSON.parse(await readFile(join(activeUserData, 'kun-settings.json'), 'utf8'))
  if (settings?.agents?.kun?.dataDir !== '~/.kun/data') {
    throw new Error(`Packaged settings still select ${String(settings?.agents?.kun?.dataDir)}`)
  }
  const legacyStats = await lstat(legacyDataDir)
  if (!legacyStats.isDirectory() || legacyStats.isSymbolicLink()) {
    throw new Error('Legacy Runtime history was not preserved as a real directory')
  }
  const legacyRealPath = await realpath(legacyDataDir)
  const currentRealPath = await realpath(currentDataDir)
  const sameRealPath = process.platform === 'win32'
    ? legacyRealPath.toLocaleLowerCase('en-US') === currentRealPath.toLocaleLowerCase('en-US')
    : legacyRealPath === currentRealPath
  if (sameRealPath) {
    throw new Error('Legacy Runtime history still aliases the writable canonical store')
  }
  const preservedLegacyRegistry = await readFile(
    join(legacyDataDir, 'extensions', 'registry.json'),
    'utf8'
  )
  if (preservedLegacyRegistry !== seededLegacyRegistry) {
    throw new Error('Legacy extension registry bytes changed during migration')
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
  const registry = JSON.parse(await readFile(
    join(currentDataDir, 'extensions', 'registry.json'),
    'utf8'
  ))
  const installed = registry?.extensions?.[MIGRATED_EXTENSION_ID]
    ?.versions?.[MIGRATED_EXTENSION_VERSION]
  const expectedPackagePath = join(
    currentDataDir,
    'extensions',
    MIGRATED_EXTENSION_ID,
    MIGRATED_EXTENSION_VERSION
  )
  if (installed?.packagePath !== expectedPackagePath) {
    throw new Error(
      `Migrated extension path is not canonical: ${String(installed?.packagePath)}`
    )
  }
  const originalRegistry = JSON.parse(preservedLegacyRegistry)
  const originalPath = originalRegistry?.extensions?.[MIGRATED_EXTENSION_ID]
    ?.versions?.[MIGRATED_EXTENSION_VERSION]?.packagePath
  if (originalPath !== join(
    legacyDataDir,
    'extensions',
    MIGRATED_EXTENSION_ID,
    MIGRATED_EXTENSION_VERSION
  )) {
    throw new Error(`Preserved extension registry lost the legacy path: ${String(originalPath)}`)
  }

  const database = new DatabaseSync(join(currentDataDir, 'index.sqlite3'), {
    readOnly: true
  })
  try {
    const row = database.prepare(
      'SELECT metadata_path, messages_path, events_path FROM threads WHERE id = ?'
    ).get(LEGACY_THREAD_ID)
    const expectedThreadDirectory = join(currentDataDir, 'threads', LEGACY_THREAD_ID)
    const expectedPaths = {
      metadata_path: join(expectedThreadDirectory, 'metadata.jsonl'),
      messages_path: join(expectedThreadDirectory, 'messages.jsonl'),
      events_path: join(expectedThreadDirectory, 'events.jsonl')
    }
    if (
      row?.metadata_path !== expectedPaths.metadata_path ||
      row?.messages_path !== expectedPaths.messages_path ||
      row?.events_path !== expectedPaths.events_path
    ) {
      throw new Error(
        `Migrated thread index paths were not repaired: ${JSON.stringify(row)}`
      )
    }
  } finally {
    database.close()
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
  processState,
  runtimeConnectionFromDocument
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
