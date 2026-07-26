import { randomBytes } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { RuntimeInfoResponse, type RuntimeInfoResponse as RuntimeInfo } from '../contracts/runtime-info.js'
import { isLoopbackHost } from '../server/loopback-host.js'
import {
  type RuntimeDiscoveryRecord,
  readRuntimeDiscovery,
  removeRuntimeDiscovery,
  withRuntimeStartLock
} from '../server/runtime-discovery.js'
import {
  hasUnpublishedGuiRuntime,
  readGuiSharedSettings,
  syncGuiProviderCatalogToConfig
} from './gui-settings-bridge.js'

const START_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 15_000
const POLL_MS = 100
const MAX_LOG_BYTES = 5 * 1024 * 1024

export type SharedRuntimeConnection = {
  discovery: RuntimeDiscoveryRecord
  info: RuntimeInfo
}

export async function runRuntimeCommand(
  argv: readonly string[],
  io: {
    stdout: { write(chunk: string): unknown }
    stderr: { write(chunk: string): unknown }
    env?: Record<string, string | undefined>
    fetch?: typeof fetch
  }
): Promise<number> {
  const command = argv[0]
  if (!command || command === '--help' || command === '-h') {
    io.stdout.write('kun runtime <status|stop|restart> [--data-dir <path>]\n')
    return 0
  }
  if (command !== 'status' && command !== 'stop' && command !== 'restart') {
    io.stderr.write(`kun runtime: unknown command: ${command}\n`)
    return 64
  }
  const environment = io.env ?? {}
  const dataDirResult = runtimeDataDir(argv.slice(1), environment)
  if (!dataDirResult.ok) {
    io.stderr.write(`kun runtime: ${dataDirResult.message}\n`)
    return 64
  }
  let dataDir = dataDirResult.dataDir
  const guiSettings = await readGuiSharedSettings({ env: environment })
  if (dataDirResult.source === 'default' && guiSettings) dataDir = guiSettings.dataDir
  const fetchImpl = io.fetch ?? fetch
  const unpublishedGuiRuntime = guiSettings && dataDir === guiSettings.dataDir
    ? await hasUnpublishedGuiRuntime(guiSettings, fetchImpl)
    : false
  try {
    if (command === 'status') {
      if (unpublishedGuiRuntime) {
        io.stdout.write(
          `Kun runtime: older GUI runtime active (shared discovery unavailable)\nData directory: ${dataDir}\n`
        )
        return 0
      }
      const connection = await resolveSharedRuntime(dataDir, fetchImpl)
      if (!connection) {
        io.stdout.write(`Kun runtime: stopped\nData directory: ${dataDir}\n`)
        return 0
      }
      const record = connection.discovery
      io.stdout.write([
        'Kun runtime: healthy',
        `Version: ${record.serviceVersion}`,
        `PID: ${record.pid}`,
        `URL: ${record.baseUrl}`,
        `Started: ${record.startedAt}`,
        `Mode: ${record.launchMode}`,
        `Logs: ${record.logPath ?? '(foreground process)'}`,
        ''
      ].join('\n'))
      return 0
    }
    if (unpublishedGuiRuntime) {
      throw new Error('an older GUI runtime is using this data directory; close or update the GUI before stop/restart')
    }
    if (command === 'stop') {
      const stopped = await stopSharedRuntime(dataDir, fetchImpl)
      io.stdout.write(stopped ? 'Kun runtime stopped.\n' : 'Kun runtime is not running.\n')
      return 0
    }
    await stopSharedRuntime(dataDir, fetchImpl)
    if (guiSettings) await syncGuiProviderCatalogToConfig(dataDir, guiSettings)
    const restarted = await ensureSharedRuntime({ dataDir, env: io.env, fetch: fetchImpl })
    io.stdout.write(`Kun runtime restarted at ${restarted.discovery.baseUrl}.\n`)
    return 0
  } catch (error) {
    io.stderr.write(`kun runtime: ${error instanceof Error ? error.message : String(error)}\n`)
    return 70
  }
}

export async function probeRuntimeDiscovery(
  record: RuntimeDiscoveryRecord,
  fetchImpl: typeof fetch = fetch
): Promise<SharedRuntimeConnection | null> {
  if (!safeDiscoveryUrl(record)) return null
  if (!processAlive(record.pid)) return null
  try {
    const response = await fetchImpl(`${record.baseUrl.replace(/\/$/u, '')}/v1/runtime/info`, {
      headers: record.runtimeToken
        ? { authorization: `Bearer ${record.runtimeToken}` }
        : {},
      signal: AbortSignal.timeout(2_000)
    })
    if (!response.ok) return null
    const info = RuntimeInfoResponse.parse(await response.json())
    if (
      info.instanceId !== record.instanceId ||
      info.pid !== record.pid ||
      info.startedAt !== record.startedAt ||
      info.serviceVersion !== record.serviceVersion
    ) return null
    return { discovery: record, info }
  } catch {
    return null
  }
}

export async function resolveSharedRuntime(
  dataDir: string,
  fetchImpl: typeof fetch = fetch
): Promise<SharedRuntimeConnection | null> {
  const record = await readRuntimeDiscovery(dataDir).catch(() => null)
  return record ? probeRuntimeDiscovery(record, fetchImpl) : null
}

export async function ensureSharedRuntime(input: {
  dataDir: string
  env?: Record<string, string | undefined>
  fetch?: typeof fetch
  timeoutMs?: number
  launch?: {
    command: string
    args: string[]
    env?: NodeJS.ProcessEnv
    runAsNode?: boolean
  }
}): Promise<SharedRuntimeConnection> {
  const fetchImpl = input.fetch ?? fetch
  const existing = await resolveSharedRuntime(input.dataDir, fetchImpl)
  if (existing) return existing
  return withRuntimeStartLock(input.dataDir, async () => {
    const elected = await resolveSharedRuntime(input.dataDir, fetchImpl)
    if (elected) return elected
    const stale = await readRuntimeDiscovery(input.dataDir).catch(() => null)
    if (stale) await removeRuntimeDiscovery(input.dataDir, stale.instanceId).catch(() => undefined)
    await prepareFreshSharedRuntimeCapabilities(input.dataDir)

    const logsDir = join(input.dataDir, 'logs')
    await mkdir(logsDir, { recursive: true, mode: 0o700 })
    const logPath = join(logsDir, 'runtime.log')
    await rotateLog(logPath)
    const logFd = openSync(logPath, 'a', 0o600)
    const runtimeToken = randomBytes(32).toString('base64url')
    const entry = fileURLToPath(new URL('./serve-entry.js', import.meta.url))
    const command = input.launch?.command ?? process.execPath
    const args = input.launch?.args ?? [
      entry,
      'serve',
      '--host', '127.0.0.1',
      '--port', '0',
      '--data-dir', input.dataDir
    ]
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(input.env ?? {}),
      ...(input.launch?.env ?? {}),
      KUN_RUNTIME_TOKEN: runtimeToken,
      KUN_RUNTIME_LAUNCH_MODE: 'shared',
      KUN_RUNTIME_LOG_PATH: logPath
    }
    const runAsNode = input.launch?.runAsNode ?? Boolean(process.versions.electron)
    if (runAsNode) env.ELECTRON_RUN_AS_NODE = '1'
    else delete env.ELECTRON_RUN_AS_NODE
    let child
    try {
      child = spawn(command, args, {
        detached: true,
        windowsHide: true,
        stdio: ['ignore', logFd, logFd],
        env
      })
      child.unref()
    } finally {
      closeSync(logFd)
    }

    const deadline = Date.now() + (input.timeoutMs ?? START_TIMEOUT_MS)
    while (Date.now() < deadline) {
      const connection = await resolveSharedRuntime(input.dataDir, fetchImpl)
      if (connection) return connection
      if (child.exitCode !== null) break
      await delay(POLL_MS)
    }
    throw new Error(`Kun shared runtime did not become ready; inspect ${logPath}`)
  })
}

async function prepareFreshSharedRuntimeCapabilities(dataDir: string): Promise<void> {
  const target = join(dataDir, 'config.json')
  let current: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(await readFile(target, 'utf8')) as unknown
    if (!isRecord(parsed)) return
    current = parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      current = {}
    } else {
      // Let the normal config loader report malformed or unreadable files.
      return
    }
  }
  const capabilities = isRecord(current.capabilities) ? current.capabilities : {}
  const defaults: Record<string, unknown> = {
    skills: { enabled: true, projectConfigEnabled: true },
    instructions: { enabled: true },
    attachments: { enabled: true },
    memory: { enabled: true },
    subagents: { enabled: true }
  }
  let changed = false
  const nextCapabilities = { ...capabilities }
  for (const [id, value] of Object.entries(defaults)) {
    if (Object.prototype.hasOwnProperty.call(nextCapabilities, id)) continue
    nextCapabilities[id] = value
    changed = true
  }
  if (!changed) return
  const next = { ...current, capabilities: nextCapabilities }
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  const temporary = `${target}.${process.pid}.shared.tmp`
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await chmod(temporary, 0o600).catch(() => undefined)
  await rename(temporary, target)
  await chmod(target, 0o600).catch(() => undefined)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function stopSharedRuntime(
  dataDir: string,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  const record = await readRuntimeDiscovery(dataDir).catch(() => null)
  if (!record) return false
  const live = await probeRuntimeDiscovery(record, fetchImpl)
  if (!live) {
    await removeRuntimeDiscovery(dataDir, record.instanceId).catch(() => undefined)
    return false
  }
  const response = await fetchImpl(`${record.baseUrl.replace(/\/$/u, '')}/v1/runtime/shutdown`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${record.runtimeToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ instanceId: record.instanceId }),
    signal: AbortSignal.timeout(5_000)
  })
  if (!response.ok) throw new Error(`runtime shutdown failed with HTTP ${response.status}`)
  const deadline = Date.now() + STOP_TIMEOUT_MS
  while (Date.now() < deadline) {
    const current = await readRuntimeDiscovery(dataDir).catch(() => null)
    if (!current || current.instanceId !== record.instanceId) return true
    await delay(POLL_MS)
  }
  throw new Error('timed out waiting for the Kun runtime to stop')
}

function safeDiscoveryUrl(record: RuntimeDiscoveryRecord): boolean {
  try {
    const url = new URL(record.baseUrl)
    return url.protocol === 'http:' &&
      isLoopbackHost(url.hostname) &&
      (url.pathname === '/' || url.pathname === '') &&
      url.username === '' &&
      url.password === '' &&
      Number(url.port || '80') === record.port &&
      isLoopbackHost(record.host)
  } catch {
    return false
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return String((error as { code?: unknown })?.code ?? '') === 'EPERM'
  }
}

async function rotateLog(logPath: string): Promise<void> {
  try {
    if ((await stat(logPath)).size < MAX_LOG_BYTES) return
    await rename(logPath, `${logPath}.1`).catch(() => undefined)
  } catch (error) {
    if (String((error as { code?: unknown })?.code ?? '') !== 'ENOENT') throw error
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function runtimeDataDir(
  argv: readonly string[],
  env: Record<string, string | undefined>
): { ok: true; dataDir: string; source: 'argument' | 'environment' | 'default' } | { ok: false; message: string } {
  const environmentDataDir = env.KUN_DATA_DIR?.trim()
  let dataDir = environmentDataDir || join(homedir(), '.kun', 'data')
  let source: 'argument' | 'environment' | 'default' = environmentDataDir ? 'environment' : 'default'
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--data-dir') return { ok: false, message: `unknown option: ${argv[index]}` }
    const value = argv[++index]?.trim()
    if (!value) return { ok: false, message: 'missing value for --data-dir' }
    dataDir = value
    source = 'argument'
  }
  return { ok: true, dataDir, source }
}
