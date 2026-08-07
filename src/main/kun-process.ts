import { app } from 'electron'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  isKunRuntimeInsecure,
  getKunRuntimeSettings,
  getModelProviderSettings,
  resolveModelProviderProxyUrl,
  resolveKunRuntimeSettings,
  normalizeAppSettings,
  type ModelProviderProfileV1,
  type KunRuntimeSettingsV1,
  type AppSettingsV1
} from '../shared/app-settings'
import {
  buildKunServeArgs,
  resolveKunExecutable,
  resolveKunRuntimeBuildId
} from './resolve-kun-binary'
import { resolveCodexOAuthApiKey } from './codex-auth'
import { ensureFreshGrokCredentials } from './grok-auth'
import {
  KunConfigSchema,
  type KunConfig,
  KunServeConfigSchema,
  ModelConfigSchema,
  ContextCompactionConfigSchema,
  QualityConfigSchema,
  RuntimeTuningConfigSchema,
  RolesConfigSchema
} from '../../kun/src/config/kun-config.js'
import { HooksConfigSchema } from '../../kun/src/hooks/hook-config.js'
import {
  AttachmentsCapabilityConfig,
  ComputerUseCapabilityConfig,
  ImageGenCapabilityConfig,
  InstructionsCapabilityConfig,
  McpCapabilityConfig,
  McpServerConfig,
  MemoryCapabilityConfig,
  MusicGenCapabilityConfig,
  SkillsCapabilityConfig,
  SpeechGenCapabilityConfig,
  SubagentsCapabilityConfig,
  VideoGenCapabilityConfig,
  WebCapabilityConfig
} from '../../kun/src/contracts/capabilities.js'
import {
  resolveClawScheduleMcpCommand,
  resolveKunMcpJsonPath,
  type ClawScheduleMcpLaunchConfig
} from './claw-schedule-mcp-config'
import { defaultKunDataDir } from './runtime/kun-adapter'
import { resolveClaudeBinary } from './agent-sdk-installer'
import { resolveAntigravityCliBinary } from './antigravity-cli'
import { appendManagedLogLine } from './logger'
import {
  KunProcessController,
  type KunUnexpectedExitInfo
} from './runtime/kun-process-controller'
import {
  waitForKunStartup
} from './runtime/kun-runtime-health-monitor'
import {
  contextCompactionConfigForRuntime,
  modelConfigForRuntime,
  providersConfigForRuntime,
  rolesConfigForRuntime,
  storageConfigForRuntime,
  tokenEconomyConfigForRuntime,
  toolOutputLimitsConfigForRuntime
} from './runtime/kun-runtime-model-config'
import {
  computerUseConfigForRuntime,
  imageGenConfigForRuntime,
  musicGenConfigForRuntime,
  qualityConfigForRuntime,
  runtimeTuningConfigForRuntime,
  speechGenConfigForRuntime,
  videoGenConfigForRuntime
} from './runtime/kun-runtime-capability-config'
import {
  KUN_BROWSER_USE_APPROVAL_SIGNING_KEY_ENV,
  KUN_BROWSER_USE_BRIDGE_TOKEN_ENV,
  KUN_BROWSER_USE_BRIDGE_URL_ENV
} from '../../kun/src/contracts/browser-use.js'
import { prepareBrowserUseHostForKunLaunch } from './browser-use/browser-use-host'
import {
  KUN_COMPUTER_USE_BRIDGE_TOKEN_ENV,
  KUN_COMPUTER_USE_BRIDGE_URL_ENV
} from '../../kun/src/contracts/computer-use-bridge.js'
import { prepareComputerUseHostForKunLaunch } from './computer-use/computer-use-host'
import {
  buildGuiScheduleKunMcpServer,
  GUI_SCHEDULE_MCP_SERVER_NAME,
  readGuiManagedMcpServers,
  readJsonObjectIfExists,
  skillCapabilityConfigForRuntime
} from './runtime/kun-runtime-mcp-config'
import { availableBundledExtensionsDirectory } from './bundled-extension-resources'
import { resolveOfficeCliBinary } from './officecli-resources'
import { subagentProfilesForRuntime } from './runtime/kun-runtime-subagent-config'
import { syncGuiManagedKunConfig } from './runtime/kun-runtime-config-service'
import { assertManagedKunDataDirIsCurrent } from './kun-data-dir-paths'
import {
  ensureSharedRuntime,
  inspectSharedRuntime,
  resolveSharedRuntime,
  stopSharedRuntime,
  type SharedRuntimeConnection
} from '../../kun/src/cli/shared-runtime.js'
import {
  allowsDevelopmentManagerBootstrap,
  resolveCliRuntimeFlavor
} from '../../kun/src/cli/runtime-flavor.js'
import {
  ensureServiceManager,
  requestManagerJson,
  resolveServiceManager,
  type ServiceManagerConnection
} from '../../kun/src/manager/manager-client.js'
import { sameCanonicalPath } from '../../kun/src/manager/canonical-path.js'
import { configureManagerAtomicJsonClient } from '../../kun/src/extensions/atomic-json.js'

export { subagentProfilesForRuntime } from './runtime/kun-runtime-subagent-config'
export { syncGuiManagedKunConfig } from './runtime/kun-runtime-config-service'

export type { KunUnexpectedExitInfo } from './runtime/kun-process-controller'
export { resolveKunStartupTimeoutMs } from './runtime/kun-runtime-health-monitor'

let serviceManagerSettingsPath: string | undefined
let mainManagerBinding: ServiceManagerConnection | undefined

/** Read-only authority selection performed before the Manager opens settings. */
export async function resolveKunManagerDataDirFromSettings(
  settingsPath: string
): Promise<string> {
  try {
    const parsed = JSON.parse(await readFile(settingsPath, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaultKunDataDir()
    const settings = normalizeAppSettings(parsed as AppSettingsV1)
    return resolveKunDataDir(resolveKunRuntimeSettings(settings))
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' || error instanceof SyntaxError) {
      return defaultKunDataDir()
    }
    throw error
  }
}

export async function handoffExistingKunServiceManagerForDataDir(
  existing: ServiceManagerConnection,
  dataDir: string,
  settingsPath: string,
  overrides: {
    inspect?: typeof inspectSharedRuntime
    stop?: typeof stopSharedRuntime
    shutdown?: () => Promise<void>
    waitForExit?: (pid: number, timeoutMs: number) => Promise<boolean>
  } = {}
): Promise<void> {
  if (
    sameCanonicalPath(existing.discovery.dataDir, dataDir) &&
    sameCanonicalPath(existing.discovery.settingsPath, settingsPath)
  ) return
  if (!sameCanonicalPath(existing.discovery.settingsPath, settingsPath)) {
    throw new Error('Kun Service Manager owns a different canonical settings path')
  }
  const inspect = overrides.inspect ?? inspectSharedRuntime
  const stop = overrides.stop ?? stopSharedRuntime
  for (const runtimeFlavor of ['production', 'development'] as const) {
    const inspected = await inspect(existing.discovery.dataDir, fetch, {
      runtimeFlavor,
      manager: existing
    })
    if (!inspected) continue
    if (!inspected.connection || inspected.connection.activeTurnCount === undefined) {
      throw new Error(`Kun ${runtimeFlavor} Runtime could not be verified for a safe data-directory handoff`)
    }
    if (inspected.connection.activeTurnCount > 0) {
      throw new Error(`Kun ${runtimeFlavor} Runtime still has active turns; custom data-directory handoff was deferred`)
    }
  }
  await Promise.all((['production', 'development'] as const).map((runtimeFlavor) =>
    stop(existing.discovery.dataDir, fetch, {
      runtimeFlavor,
      manager: existing
    })
  ))
  if (overrides.shutdown) await overrides.shutdown()
  else await requestManagerJson(existing, '/v1/manager/shutdown', {
      method: 'POST',
      body: { instanceId: existing.discovery.instanceId },
      timeoutMs: 10_000
    })
  if (!(await (overrides.waitForExit ?? waitForPidExit)(existing.discovery.pid, 15_000))) {
    throw new Error('Kun Service Manager did not exit during custom data-directory handoff')
  }
}

async function handoffMismatchedKunServiceManager(
  dataDir: string,
  settingsPath: string
): Promise<void> {
  const existing = await resolveServiceManager()
  if (!existing) return
  await handoffExistingKunServiceManagerForDataDir(existing, dataDir, settingsPath)
}

export async function ensureKunServiceManager(input: {
  dataDir?: string
  settingsPath: string
}): Promise<ServiceManagerConnection> {
  serviceManagerSettingsPath = input.settingsPath
  const dataDir = input.dataDir ?? defaultKunDataDir()
  await handoffMismatchedKunServiceManager(dataDir, input.settingsPath)
  const resolution = resolveKunExecutable(appRoot(), '')
  const serveEntry = resolution.args[0]
  if (!serveEntry || !existsSync(serveEntry)) {
    throw new Error(
      `Kun Service Manager build is missing next to ${serveEntry || 'the bundled runtime entry'}. Run \`npm run build:kun\` first.`
    )
  }
  const managerEntry = join(dirname(serveEntry), '..', 'manager', 'manager-entry.js')
  const flavor = resolveCliRuntimeFlavor({ env: process.env })
  const manager = await ensureServiceManager({
    flavor,
    allowDevelopmentBootstrap: allowsDevelopmentManagerBootstrap({
      flavor,
      env: process.env,
      isPackaged: app.isPackaged
    }),
    dataDir,
    settingsPath: input.settingsPath,
    launch: {
      command: resolveNodeScriptCommand(process.execPath),
      args: [managerEntry],
      runAsNode: true
    }
  })
  return configureKunManagerDataPlaneForCurrentProcess(manager)
}

/**
 * Makes Main-process AtomicJson consumers join the Manager-owned data plane.
 * This must run before constructing a Main Registry or credential store.
 */
export function configureKunManagerDataPlaneForCurrentProcess(
  manager: ServiceManagerConnection
): ServiceManagerConnection {
  if (mainManagerBinding) mainManagerBinding.discovery = manager.discovery
  else mainManagerBinding = { discovery: manager.discovery }
  configureManagerAtomicJsonClient({
    baseUrl: mainManagerBinding.discovery.baseUrl,
    token: mainManagerBinding.discovery.managerToken,
    dataDir: mainManagerBinding.discovery.dataDir
  })
  return mainManagerBinding
}

/** Current Main-owned Manager binding for authoritative Runtime discovery. */
export function getKunServiceManagerBinding(): ServiceManagerConnection | undefined {
  return mainManagerBinding
}

/**
 * Called when a READY kun child exits without the GUI asking for it.
 * Startup failures are excluded: those are already reported to the
 * caller of startKunChild via the thrown error.
 */
export function setKunUnexpectedExitHandler(
  handler: ((info: KunUnexpectedExitInfo) => void) | null
): void {
  processController.setUnexpectedExitHandler(handler)
}

const execFileAsync = promisify(execFile)
const KUN_STOP_GRACE_MS = 5_000
const KUN_STOP_FORCE_MS = 1_000
const STDERR_TAIL_MAX_CHARS = 32_768
const MAX_TCP_PORT = 65_535

type KunLogStream = 'stdout' | 'stderr' | 'lifecycle'
type KunChildLogCapture = {
  captureStdout: (chunk: Buffer | string) => void
  captureStderr: (chunk: Buffer | string) => void
  logLifecycle: (message: string) => void
  close: () => Promise<void>
}

const processController = new KunProcessController<KunChildLogCapture>()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function appendTail(current: string, nextChunk: string, maxChars = STDERR_TAIL_MAX_CHARS): string {
  const combined = `${current}${nextChunk}`
  return combined.length > maxChars ? combined.slice(-maxChars) : combined
}

function formatKunLogLine(
  stream: KunLogStream,
  pid: number | undefined,
  message: string
): string {
  const stamp = new Date().toISOString()
  const pidLabel = typeof pid === 'number' ? `kun pid=${pid}` : 'kun'
  return `[${stamp}] [${stream.toUpperCase()}] [${pidLabel}] ${message}\n`
}

function normalizeCapturedChunk(chunk: Buffer | string): string {
  return String(chunk).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function createKunChildLogCapture(pid: number | undefined): KunChildLogCapture {
  let stdoutRemainder = ''
  let stderrRemainder = ''
  let closed = false
  let pending = Promise.resolve()

  const writeLine = (stream: KunLogStream, message: string): void => {
    pending = pending
      .then(() => appendManagedLogLine('kun', formatKunLogLine(stream, pid, message)))
      .catch(() => undefined)
  }

  const captureChunk = (
    stream: 'stdout' | 'stderr',
    chunk: Buffer | string
  ): void => {
    if (closed) return
    const text = normalizeCapturedChunk(chunk)
    const buffered = `${stream === 'stdout' ? stdoutRemainder : stderrRemainder}${text}`
    const parts = buffered.split('\n')
    const remainder = parts.pop() ?? ''
    if (stream === 'stdout') {
      stdoutRemainder = remainder
    } else {
      stderrRemainder = remainder
    }
    for (const part of parts) {
      writeLine(stream, part)
    }
  }

  return {
    captureStdout(chunk) {
      captureChunk('stdout', chunk)
    },
    captureStderr(chunk) {
      captureChunk('stderr', chunk)
    },
    logLifecycle(message) {
      if (closed) return
      writeLine('lifecycle', message)
    },
    async close() {
      if (closed) {
        await pending
        return
      }
      closed = true
      if (stdoutRemainder) {
        writeLine('stdout', stdoutRemainder)
        stdoutRemainder = ''
      }
      if (stderrRemainder) {
        writeLine('stderr', stderrRemainder)
        stderrRemainder = ''
      }
      await pending
    }
  }
}

function appRoot(): string {
  return app.isPackaged
    ? app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked')
    : app.getAppPath()
}

function resolveNodeScriptCommand(command: string): string {
  if (command !== process.execPath) return command
  if (process.platform !== 'darwin') return command
  return resolveClawScheduleMcpCommand({
    appPath: app.getAppPath(),
    execPath: command,
    isPackaged: app.isPackaged
  })
}

export function resolveKunDataDir(runtime: { dataDir: string }): string {
  const trimmed = runtime.dataDir?.trim()
  const dataDir = trimmed ? expandHomePath(trimmed) : defaultKunDataDir()
  assertManagedKunDataDirIsCurrent(dataDir)
  return dataDir
}

function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return join(homedir(), path.slice(2).replace(/\\/g, '/'))
  }
  return path
}

export function isKunChildRunning(): boolean {
  return processController.isRunning()
}

function isCurrentKunChildPid(pid: number): boolean {
  return processController.isCurrentPid(pid)
}

/**
 * Resolve once any in-flight kun launch has settled — whether it became
 * ready or failed. The settings/MCP-apply paths use this to avoid
 * SIGTERM-ing a child that is still inside its (deliberately generous)
 * startup window: interrupting a slow-but-healthy boot only restarts the
 * clock and is what turns one slow start into the #544 restart storm.
 *
 * Deadlock-safe by construction: `kunStartPromise` is only set once a launch
 * has already passed the settings-apply gate, so an apply that awaits it can
 * never be the thing that launch is itself waiting on.
 */
export function waitForKunStartupSettled(): Promise<void> {
  return processController.waitForStartupSettled()
}

export function startKunChild(settings: AppSettingsV1): Promise<void> {
  return processController.start(async () => {
    const runtime = resolveKunRuntimeSettings(settings)
    if (isKunChildRunning() || !runtime.autoStart) return
    await startKunChildOnce(settings, runtime)
  })
}

/**
 * Start (or attach to) the data-dir scoped runtime used by both the GUI and
 * terminal clients. Unlike the legacy child controller, this process is
 * detached and writes directly to its own log, so closing Electron does not
 * terminate active turns or disconnect other clients.
 */
export async function startKunSharedRuntime(
  settings: AppSettingsV1
): Promise<SharedRuntimeConnection | null> {
  const runtime = resolveKunRuntimeSettings(settings)
  if (!runtime.autoStart) return null
  const dataDir = resolveKunDataDir(runtime)
  const runtimeFlavor = resolveCliRuntimeFlavor({ env: process.env })
  if (await hasUnpublishedKunWriter(runtime, dataDir, runtimeFlavor)) {
    throw new Error(
      'An older GUI-private Kun runtime is already writing this data directory without shared discovery. Close or update that GUI once before starting the shared runtime.'
    )
  }
  // A shared runtime is elected under the data-directory start lock. Let the
  // elected server bind an ephemeral loopback port and publish the real
  // port/token through discovery instead of treating the GUI preference as a
  // live connection contract.
  const launch = await prepareKunLaunch(settings, runtime, { port: 0 })
  const serveEntry = launch.args.find((argument) => /serve-entry\.js$/u.test(argument))
  if (!serveEntry) throw new Error('Kun service-manager entry could not be resolved from the runtime launch')
  const managerEntry = join(dirname(serveEntry), '..', 'manager', 'manager-entry.js')
  const discoveredManager = await ensureServiceManager({
    flavor: runtimeFlavor,
    allowDevelopmentBootstrap: allowsDevelopmentManagerBootstrap({
      flavor: runtimeFlavor,
      env: process.env,
      isPackaged: app.isPackaged
    }),
    dataDir: launch.dataDir,
    ...(serviceManagerSettingsPath ? { settingsPath: serviceManagerSettingsPath } : {}),
    launch: {
      command: resolveNodeScriptCommand(process.execPath),
      args: [managerEntry],
      runAsNode: true
    }
  })
  const manager = configureKunManagerDataPlaneForCurrentProcess(discoveredManager)
  return ensureSharedRuntime({
    dataDir: launch.dataDir,
    runtimeFlavor,
    manager,
    ...(launch.expectedBuildId ? { expectedBuildId: launch.expectedBuildId } : {}),
    launch: {
      command: launch.command,
      args: launch.args,
      env: launch.env,
      runAsNode: launch.runAsNode
    }
  })
}

async function hasUnpublishedKunWriter(
  runtime: KunRuntimeSettingsV1,
  dataDir: string,
  runtimeFlavor = resolveCliRuntimeFlavor({ env: process.env })
): Promise<boolean> {
  if (await resolveSharedRuntime(dataDir, fetch, { runtimeFlavor }).catch(() => null)) return false
  try {
    const headers = new Headers()
    if (runtime.runtimeToken.trim()) {
      headers.set('authorization', `Bearer ${runtime.runtimeToken.trim()}`)
    }
    const response = await fetch(`http://127.0.0.1:${runtime.port}/v1/runtime/info`, {
      headers,
      signal: AbortSignal.timeout(2_000)
    })
    if (!response.ok) return false
    const body = await response.json() as { dataDir?: unknown }
    return typeof body.dataDir === 'string' && sameRuntimePath(body.dataDir, dataDir)
  } catch {
    return false
  }
}

function sameRuntimePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left)
  const normalizedRight = resolve(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

type PreparedKunLaunch = {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  dataDir: string
  runAsNode: boolean
  expectedBuildId?: string
}

async function prepareKunLaunch(
  settings: AppSettingsV1,
  runtime: KunRuntimeSettingsV1,
  options: { port?: number } = {}
): Promise<PreparedKunLaunch> {
  const root = appRoot()
  const resolution = resolveKunExecutable(root, runtime.binaryPath)
  if (resolution.command === process.execPath && !existsSync(resolution.args[0])) {
    throw new Error(
      `Kun runtime build is missing at ${resolution.args[0]}. Run \`npm run build:kun\` before starting the GUI.`
    )
  }
  const expectedBuildId = await resolveKunRuntimeBuildId(resolution)
  const dataDir = resolveKunDataDir(runtime)
  await syncGuiManagedKunConfig(dataDir, runtime, {
    scheduleMcp: {
      settings,
      launch: {
        appPath: app.getAppPath(),
        execPath: process.execPath,
        isPackaged: app.isPackaged
      }
    }
  })
  processController.lastResolvedBinary = resolution.command === process.execPath
    ? resolution.args.join(' ')
    : resolution.command
  const args = buildKunServeArgs({
    resolution,
    host: '127.0.0.1',
    port: options.port ?? runtime.port,
    dataDir,
    approvalPolicy: runtime.approvalPolicy,
    sandboxMode: runtime.sandboxMode,
    approvalReviewer: runtime.approvalReviewer,
    tokenEconomyMode: runtime.tokenEconomyMode,
    insecure: isKunRuntimeInsecure(runtime)
  })
  const command = resolveNodeScriptCommand(resolution.command)
  const runtimeApiKey = (await ensureFreshGrokCredentials(runtime.apiKey)).apiKey
  const defaultClientApiKey = resolveCodexOAuthApiKey(runtimeApiKey).apiKey
  const activeProviderKind = (getModelProviderSettings(settings).providers as ModelProviderProfileV1[]).find(
    (provider) => provider.id?.trim() === getKunRuntimeSettings(settings).providerId.trim()
  )?.kind
  const claudeBinary = resolveClaudeBinary(app.getPath('userData'), [join(appRoot(), 'kun')])
  const antigravityBinary = resolveAntigravityCliBinary(app.getPath('userData'))
  const officeCliBinary = resolveOfficeCliBinary({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appRoot: root,
    explicitPath: process.env.KUN_OFFICECLI_BINARY
  })
  const browserUseBridge = runtime.browserUse.enabled
    ? await prepareBrowserUseHostForKunLaunch()
    : undefined
  const computerUseBridge = runtime.computerUse.enabled
    ? await prepareComputerUseHostForKunLaunch()
    : undefined
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEEPSEEK_API_KEY: defaultClientApiKey || process.env.DEEPSEEK_API_KEY || '',
    ...(activeProviderKind ? { KUN_RUNTIME_PROVIDER_KIND: activeProviderKind } : {}),
    ...(claudeBinary ? { KUN_CLAUDE_BINARY: claudeBinary } : {}),
    ...(antigravityBinary ? { KUN_ANTIGRAVITY_BINARY: antigravityBinary } : {}),
    ...(officeCliBinary ? { KUN_OFFICECLI_BINARY: officeCliBinary } : {}),
    ...(browserUseBridge
      ? {
          [KUN_BROWSER_USE_BRIDGE_URL_ENV]: browserUseBridge.url,
          [KUN_BROWSER_USE_BRIDGE_TOKEN_ENV]: browserUseBridge.token,
          [KUN_BROWSER_USE_APPROVAL_SIGNING_KEY_ENV]:
            browserUseBridge.approvalSigningKey
        }
      : {}),
    ...(computerUseBridge
      ? {
          [KUN_COMPUTER_USE_BRIDGE_URL_ENV]: computerUseBridge.url,
          [KUN_COMPUTER_USE_BRIDGE_TOKEN_ENV]: computerUseBridge.token
        }
      : {})
  }
  if (!browserUseBridge) {
    delete env[KUN_BROWSER_USE_BRIDGE_URL_ENV]
    delete env[KUN_BROWSER_USE_BRIDGE_TOKEN_ENV]
    delete env[KUN_BROWSER_USE_APPROVAL_SIGNING_KEY_ENV]
  }
  if (!computerUseBridge) {
    delete env[KUN_COMPUTER_USE_BRIDGE_URL_ENV]
    delete env[KUN_COMPUTER_USE_BRIDGE_TOKEN_ENV]
  }
  const bundledExtensionsDirectory = availableBundledExtensionsDirectory({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appRoot: root
  })
  if (bundledExtensionsDirectory) env.KUN_BUNDLED_EXTENSIONS_DIR = bundledExtensionsDirectory
  env.ELECTRON_RUN_AS_NODE = '1'
  return {
    command,
    args,
    env,
    dataDir,
    runAsNode: true,
    ...(expectedBuildId ? { expectedBuildId } : {})
  }
}

async function startKunChildOnce(
  settings: AppSettingsV1,
  runtime: KunRuntimeSettingsV1
): Promise<void> {
  if (processController.logCapture) {
    await processController.logCapture.close()
    processController.logCapture = null
  }
  const launch = await prepareKunLaunch(settings, runtime)
  processController.child = spawn(launch.command, launch.args, {
    env: {
      ...launch.env,
      KUN_RUNTIME_TOKEN: runtime.runtimeToken,
      KUN_RUNTIME_LAUNCH_MODE: 'gui'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false
  })
  const startedChild = processController.child
  processController.childPort = runtime.port
  const startedLogCapture = createKunChildLogCapture(startedChild.pid)
  processController.logCapture = startedLogCapture
  processController.stderrTail = ''
  startedLogCapture.logLifecycle(`spawned on port ${runtime.port} using data dir ${launch.dataDir}`)
  startedChild.stdout?.on('data', startedLogCapture.captureStdout)
  startedChild.stderr?.on('data', (chunk: Buffer | string) => {
    processController.stderrTail = appendTail(
      processController.stderrTail,
      normalizeCapturedChunk(chunk)
    )
    startedLogCapture.captureStderr(chunk)
  })
  startedChild.on('exit', (code, signal) => {
    startedLogCapture.logLifecycle(
      signal
        ? `exited with signal ${signal}`
        : `exited with code ${code ?? 'unknown'}`
    )
    void startedLogCapture.close()
    processController.clearChild(startedChild)
    if (processController.shouldReportUnexpectedExit(startedChild)) {
      processController.reportUnexpectedExit({
        code: code ?? null,
        signal: signal ?? null,
        stderrTail: processController.stderrTail
      })
    }
  })
  startedChild.on('error', (error) => {
    startedLogCapture.logLifecycle(
      `process error: ${error instanceof Error ? error.message : String(error)}`
    )
  })
  try {
    await waitForKunStartup(startedChild, runtime.port)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    startedLogCapture.logLifecycle(`startup failed before ready: ${message}`)
    if (processController.child === startedChild) {
      await stopKunChildAndWait()
    }
    throw error
  }
  processController.markReady(startedChild)
  startedLogCapture.logLifecycle(`ready marker received on port ${runtime.port}`)
}

export async function stopKunChildAndWait(): Promise<void> {
  if (!processController.child) {
    if (processController.logCapture) {
      const capture = processController.logCapture
      processController.logCapture = null
      await capture.close()
    }
    return
  }
  const stoppingChild = processController.child
  processController.markIntentionalStop(stoppingChild)
  const pid = stoppingChild.pid
  const capture = processController.logCapture
  if (stoppingChild.exitCode === null && stoppingChild.signalCode === null) {
    try {
      stoppingChild.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }
  const exited = await waitForChildExit(stoppingChild, KUN_STOP_GRACE_MS)
  if (!exited) {
    try {
      if (pid) process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
    await waitForChildExit(stoppingChild, KUN_STOP_FORCE_MS)
  }
  processController.clearChild(stoppingChild)
  if (capture) {
    processController.logCapture = null
    await capture.close()
  }
}

function waitForChildExit(process: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (process.exitCode !== null || process.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => settle(false), timeoutMs)
    const settle = (exited: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      process.removeListener('exit', onExit)
      process.removeListener('error', onError)
      resolve(exited)
    }
    const onExit = (): void => settle(true)
    const onError = (): void => settle(true)
    process.once('exit', onExit)
    process.once('error', onError)
  })
}

export async function reclaimKunPort(
  port: number
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (port <= 0) return { ok: true }
  if (await canBindTcpPort(port, '127.0.0.1')) return { ok: true }
  if (await killStaleKunOnPort(port) && await canBindTcpPort(port, '127.0.0.1')) {
    return { ok: true }
  }
  return { ok: false, message: `port ${port} is in use` }
}

export async function resolveAvailableKunPort(
  preferredPort: number
): Promise<{ port: number; changed: boolean; message?: string }> {
  if (preferredPort > 0) {
    // A temporarily unresponsive managed child still owns its configured
    // endpoint. Moving settings to another port here strands the live child
    // and makes every concurrent request launch/probe a port with no server.
    if (isKunChildRunning() && processController.childPort === preferredPort) {
      return { port: preferredPort, changed: false }
    }
    if (await canBindTcpPort(preferredPort, '127.0.0.1')) {
      return { port: preferredPort, changed: false }
    }
    // Prefer reclaiming the configured port from a stale kun left by a
    // crashed previous app run over silently moving to a new port.
    if (
      await killStaleKunOnPort(preferredPort) &&
      await canBindTcpPort(preferredPort, '127.0.0.1')
    ) {
      return { port: preferredPort, changed: false }
    }
    for (let port = preferredPort + 1; port <= MAX_TCP_PORT; port += 1) {
      if (await canBindTcpPort(port, '127.0.0.1')) {
        return {
          port,
          changed: true,
          message: `port ${preferredPort} is in use`
        }
      }
    }
  }
  const port = await allocateTcpPort('127.0.0.1')
  return {
    port,
    changed: true,
    ...(preferredPort > 0 ? { message: `port ${preferredPort} is in use` } : {})
  }
}

/**
 * Kill a stale kun serve process from a previous app run that is still
 * holding the configured port. Only processes whose command line looks
 * like our serve entry are touched; anything else keeps the port and we
 * fall back to allocating a different one.
 *
 * Safe by construction on every platform: any failure to positively
 * identify the holder as our own serve-entry leaves it untouched and the
 * caller allocates a different port instead.
 */
async function killStaleKunOnPort(port: number): Promise<boolean> {
  const pids = await listListeningPidsOnPort(port)
  let reclaimed = false
  for (const pid of pids) {
    if (isCurrentKunChildPid(pid)) continue
    let command = ''
    try {
      command = await processCommandLine(pid)
    } catch {
      continue
    }
    if (!command.includes('serve-entry')) continue
    void appendManagedLogLine(
      'kun',
      formatKunLogLine('lifecycle', pid, `killing stale kun process holding port ${port}`)
    )
    if (await terminateStalePid(pid)) reclaimed = true
  }
  return reclaimed
}

/**
 * PIDs listening on `port`, excluding our own process. Uses `lsof` on
 * macOS/Linux and `netstat -ano` on Windows.
 */
async function listListeningPidsOnPort(port: number): Promise<number[]> {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('netstat', ['-ano'], {
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 8 * 1024 * 1024
      })
      return parseListeningPidsFromNetstat(stdout, port)
    } catch {
      return []
    }
  }
  try {
    const { stdout } = await execFileAsync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'])
    return stdout
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
  } catch {
    return []
  }
}

/**
 * Parse `netstat -ano` output into the PIDs holding a LISTENING TCP socket
 * on `port`. Columns are `Proto  Local  Foreign  State  PID`; UDP rows
 * (no State column) and non-matching ports are ignored. Matches both IPv4
 * (`127.0.0.1:<port>`) and IPv6 (`[::1]:<port>`) local addresses.
 */
export function parseListeningPidsFromNetstat(stdout: string, port: number): number[] {
  const pids = new Set<number>()
  for (const raw of stdout.split(/\r?\n/)) {
    const cols = raw.trim().split(/\s+/)
    if (cols.length < 5 || cols[0].toUpperCase() !== 'TCP') continue
    if (cols[3].toUpperCase() !== 'LISTENING') continue
    if (!cols[1].endsWith(`:${port}`)) continue
    const pid = Number(cols[cols.length - 1])
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid)
  }
  return [...pids]
}

/** Read a process's full command line (best effort, platform-specific). */
async function processCommandLine(pid: number): Promise<string> {
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`
      ],
      { windowsHide: true, timeout: 5_000 }
    )
    return stdout.trim()
  }
  const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command='])
  return stdout.trim()
}

/** Terminate a positively-identified stale kun process. */
async function terminateStalePid(pid: number): Promise<boolean> {
  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 5_000
      })
      return true
    } catch {
      // taskkill exits non-zero when the PID is already gone — treat the
      // port as reclaimed only if the process really is no longer alive.
      return await waitForPidExit(pid, 0)
    }
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return false
  }
  if (!(await waitForPidExit(pid, 2_000))) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
    await waitForPidExit(pid, 1_000)
  }
  return true
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    if (Date.now() >= deadline) return false
    await sleep(100)
  }
}

function canBindTcpPort(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const server = createServer()
    const settle = (available: boolean): void => {
      if (settled) return
      settled = true
      server.removeAllListeners('error')
      resolve(available)
    }
    server.unref()
    server.once('error', () => settle(false))
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => settle(true))
    })
  })
}

function allocateTcpPort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    const cleanup = (): void => {
      server.removeAllListeners('error')
      server.removeAllListeners('listening')
    }
    server.unref()
    server.once('error', (error) => {
      cleanup()
      reject(error)
    })
    server.listen({ port: 0, host, exclusive: true }, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => {
        cleanup()
        if (error) reject(error)
        else if (port > 0) resolve(port)
        else reject(new Error('failed to allocate an available Kun port'))
      })
    })
  })
}
