#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import extractZip from 'extract-zip'

const TEMPORARY_DIRECTORY_REMOVE_RETRIES = 10
const TEMPORARY_DIRECTORY_REMOVE_DELAY_MS = 250

export function createArchiveExtractionInvocation(
  artifact,
  destination,
  pathApi = { basename, dirname }
) {
  if (artifact.toLowerCase().endsWith('.zip')) {
    return {
      kind: 'zip',
      artifact,
      options: { dir: destination }
    }
  }
  return {
    kind: 'tar',
    command: 'tar',
    args: ['-xf', pathApi.basename(artifact), '-C', destination],
    options: {
      cwd: pathApi.dirname(artifact),
      stdio: 'inherit'
    }
  }
}

export async function extractArchive(artifact, destination) {
  const extraction = createArchiveExtractionInvocation(artifact, destination)
  if (extraction.kind === 'zip') {
    await extractZip(extraction.artifact, extraction.options)
  } else {
    execFileSync(extraction.command, extraction.args, extraction.options)
  }
}

async function main() {
  const flags = readFlags(process.argv.slice(2))
  const artifact = resolve(required(flags, 'artifact'))
  const expectedVersion = required(flags, 'version')
  const expectedTarget = required(flags, 'target')
  const temporary = await mkdtemp(join(tmpdir(), 'kun-tui-smoke-'))
  const managerControlDir = join(temporary, 'manager', 'control')
  const runtimeDataDir = join(temporary, 'headless-runtime')
  try {
    await extractArchive(artifact, temporary)
    const root = join(temporary, 'kun')
    const release = JSON.parse(await readFile(join(root, 'release.json'), 'utf8'))
    if (release.version !== expectedVersion || release.target !== expectedTarget) {
      throw new Error(
        `release metadata mismatch: ${release.version}/${release.target}, ` +
        `expected ${expectedVersion}/${expectedTarget}`
      )
    }
    const node = join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node')
    const entry = join(root, 'app', 'kun', 'dist', 'cli', 'serve-entry.js')
    const geminiRoot = join(root, 'app', 'kun', 'node_modules', '@google', 'gemini-cli')
    const geminiEntry = join(geminiRoot, 'bundle', 'gemini.js')
    const geminiManifest = JSON.parse(await readFile(join(geminiRoot, 'package.json'), 'utf8'))
    await stat(node)
    await stat(entry)
    await stat(geminiEntry)
    const environment = {
      ...process.env,
      KUN_STANDALONE_ROOT: root,
      KUN_MANAGER_BASE_URL: '',
      KUN_MANAGER_CONTROL_DIR: managerControlDir,
      KUN_MANAGER_SETTINGS_PATH: join(temporary, 'manager', 'kun-settings.json')
    }
    if (process.platform === 'linux') {
      delete environment.DISPLAY
      delete environment.WAYLAND_DISPLAY
    }
    expectOutput(node, ['-p', 'process.versions.node'], environment, release.nodeVersion)
    expectOutput(node, [entry, '--version'], environment, `kun ${expectedVersion}`)
    expectOutput(node, [geminiEntry, '--version'], environment, geminiManifest.version)
    expectContains(node, [entry, '--help'], environment, 'kun <command> [options]')
    expectContains(node, [entry, 'tui', '--help'], environment, 'kun [tui options]')
    expectContains(
      node,
      [entry, 'runtime', 'status', '--data-dir', runtimeDataDir],
      environment,
      'Kun runtime: stopped'
    )
    await smokeHeadlessRuntime(
      node,
      entry,
      environment,
      runtimeDataDir
    )
    execFileSync(
      node,
      ['--input-type=module', '-e', "await import('better-sqlite3'); process.stdout.write('sqlite-ok')"],
      {
        cwd: join(root, 'app', 'kun'),
        env: environment,
        encoding: 'utf8',
        timeout: 15_000,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    process.stdout.write(`Standalone TUI smoke passed: ${expectedTarget} ${expectedVersion}\n`)
  } finally {
    await shutdownIsolatedManager(managerControlDir)
    await removeTemporaryDirectory(temporary)
  }
}

async function shutdownIsolatedManager(controlDir) {
  let discovery
  try {
    discovery = JSON.parse(await readFile(join(controlDir, 'manager.json'), 'utf8'))
  } catch {
    return
  }
  try {
    await fetch(`${discovery.baseUrl}/v1/manager/shutdown`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${discovery.managerToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ instanceId: discovery.instanceId }),
      signal: AbortSignal.timeout(5_000)
    })
  } catch {
    // The manager may exit before the response is fully observed.
  }
  await delay(250)
}

export async function removeTemporaryDirectory(
  directory,
  {
    remove = rm,
    platform = process.platform,
    maxRetries = TEMPORARY_DIRECTORY_REMOVE_RETRIES,
    retryDelayMs = TEMPORARY_DIRECTORY_REMOVE_DELAY_MS,
    wait = delay
  } = {}
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await remove(directory, { recursive: true, force: true })
      return
    } catch (error) {
      if (!isRetryableWindowsRemoveError(error, platform) || attempt >= maxRetries) {
        throw error
      }
      await wait(retryDelayMs)
    }
  }
}

export function isRetryableWindowsRemoveError(error, platform = process.platform) {
  return platform === 'win32' &&
    error instanceof Error &&
    ['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(error.code)
}

export function createHeadlessRuntimeStopInvocation(pid, platform = process.platform) {
  return platform === 'win32'
    ? { command: 'taskkill', args: ['/pid', String(pid), '/t', '/f'] }
    : null
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

async function smokeHeadlessRuntime(node, entry, env, dataDir) {
  const child = spawn(node, [
    entry,
    'serve',
    '--host',
    '127.0.0.1',
    '--port',
    '0',
    '--data-dir',
    dataDir
  ], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr += chunk })
  try {
    const ready = await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`headless runtime did not become ready: ${stderr.slice(-4_000)}`))
      }, 30_000)
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('exit', (code, signal) => {
        clearTimeout(timer)
        reject(new Error(
          `headless runtime exited before ready (${signal ?? code}): ${stderr.slice(-4_000)}`
        ))
      })
      child.stdout.on('data', (chunk) => {
        stdout += chunk
        const match = stdout.match(/KUN_READY (\{[^\r\n]+\})/)
        if (!match) return
        clearTimeout(timer)
        try {
          resolvePromise(JSON.parse(match[1]))
        } catch (error) {
          reject(error)
        }
      })
    })
    const response = await fetch(`http://127.0.0.1:${ready.port}/health`, {
      signal: AbortSignal.timeout(5_000)
    })
    const health = await response.json()
    if (!response.ok || health?.status !== 'ok') {
      throw new Error(`headless runtime health check failed: HTTP ${response.status}`)
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      const stop = createHeadlessRuntimeStopInvocation(child.pid)
      if (stop) execFileSync(stop.command, stop.args, { stdio: 'ignore' })
      else child.kill()
      await Promise.race([
        exited,
        new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000))
      ])
    }
  }
}

function expectOutput(command, args, env, expected) {
  const output = execFileSync(command, args, {
    env,
    encoding: 'utf8',
    timeout: 15_000
  }).trim()
  if (output !== expected) {
    throw new Error(`${args.join(' ')} returned ${JSON.stringify(output)}, expected ${JSON.stringify(expected)}`)
  }
}

function expectContains(command, args, env, expected) {
  const output = execFileSync(command, args, {
    env,
    encoding: 'utf8',
    timeout: 15_000
  })
  if (!output.includes(expected)) {
    throw new Error(`${args.join(' ')} output does not contain ${JSON.stringify(expected)}`)
  }
}

function readFlags(argv) {
  const flags = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || !value) throw new Error(`Invalid argument near ${name}`)
    flags.set(name.slice(2), value)
  }
  return flags
}

function required(flags, name) {
  const value = flags.get(name)
  if (!value) throw new Error(`Missing --${name}`)
  return value
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`[smoke-standalone-tui] ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
