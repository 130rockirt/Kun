import { spawn, type ChildProcess } from 'node:child_process'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import {
  DEFAULT_OPEN_CONNECTOR_PORT,
  OPEN_CONNECTOR_PROTOCOL_VERSION,
  type OpenConnectorHealth
} from '../../shared/open-connector'
import {
  loadOrCreateOpenConnectorBootstrap,
  type OpenConnectorBootstrapSecrets
} from './open-connector-bootstrap'

export const PINNED_OPEN_CONNECTOR_VERSION = '1.4.0'
export const OPEN_CONNECTOR_RUNTIME_DIR_ENV = 'KUN_OPENCONNECTOR_RUNTIME_DIR'
export const KUN_OPEN_CONNECTOR_RUNTIME_TOKEN_ENV = 'KUN_OPENCONNECTOR_RUNTIME_TOKEN'
export const KUN_OPEN_CONNECTOR_INSTANCE_PROOF_KEY_ENV = 'KUN_OPENCONNECTOR_INSTANCE_PROOF_KEY'

const SIDECAR_ENV_ALLOWLIST = [
  'PATH',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'PATHEXT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR'
] as const

const RuntimeMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.literal('open-connector'),
  version: z.string().min(1),
  protocolVersion: z.string().min(1),
  nodeRange: z.string().min(1),
  entrypoint: z.string().min(1)
}).strict()

const RuntimeHealthEnvelopeSchema = z.object({
  success: z.literal(true),
  data: z.object({
    ok: z.literal(true),
    runtime: z.string(),
    runtimeVersion: z.string(),
    protocolVersion: z.string()
  }).passthrough()
}).passthrough()

const PublicRuntimeHealthSchema = z.object({
  ok: z.literal(true),
  runtime: z.literal('open-connector'),
  runtimeVersion: z.string(),
  protocolVersion: z.string(),
  instanceProof: z.string().regex(/^[a-f0-9]{64}$/i)
}).passthrough()

type RuntimeMetadata = z.infer<typeof RuntimeMetadataSchema>

type SidecarState = {
  state: OpenConnectorHealth['state']
  message?: string
  version?: string
  protocolVersion?: string
}

export type OpenConnectorSidecarOptions = {
  userDataDir: string
  isPackaged: boolean
  resourcesPath: string
  appRoot: string
  execPath: string
  environment?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  log?: (level: 'info' | 'warn' | 'error', message: string, details?: Record<string, unknown>) => void
  onRuntimeToken?: (token: string) => void
  onInstanceProofKey?: (key: string) => void
}

export class OpenConnectorSidecar {
  private child: ChildProcess | null = null
  private port = DEFAULT_OPEN_CONNECTOR_PORT
  private desiredRunning = false
  private stopping = false
  private restartAttempts = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private startPromise: Promise<OpenConnectorHealth> | null = null
  private secrets: OpenConnectorBootstrapSecrets | null = null
  private state: SidecarState = { state: 'stopped' }

  constructor(private readonly options: OpenConnectorSidecarOptions) {}

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`
  }

  get runtimeToken(): string | undefined {
    return this.secrets?.runtimeToken
  }

  get adminToken(): string | undefined {
    return this.secrets?.adminToken
  }

  get instanceProofKey(): string | undefined {
    return this.secrets?.instanceProofKey
  }

  async prepareSecrets(): Promise<void> {
    if (this.secrets) return
    this.secrets = (await loadOrCreateOpenConnectorBootstrap(this.options.userDataDir)).secrets
    this.options.onRuntimeToken?.(this.secrets.runtimeToken)
    this.options.onInstanceProofKey?.(this.secrets.instanceProofKey)
  }

  start(port = DEFAULT_OPEN_CONNECTOR_PORT): Promise<OpenConnectorHealth> {
    assertConnectorPort(port)
    this.desiredRunning = true
    if (this.startPromise) {
      return this.startPromise.then(() => {
        if (!this.desiredRunning) return this.snapshot(false)
        if (this.port === port && this.child?.exitCode === null) return this.health()
        return this.start(port)
      })
    }
    const operation = this.startOnce(port)
    const tracked = operation.finally(() => {
      if (this.startPromise === tracked) this.startPromise = null
    })
    this.startPromise = tracked
    return tracked
  }

  private async startOnce(port: number): Promise<OpenConnectorHealth> {
    if (this.child && this.port === port && this.child.exitCode === null) {
      return this.health()
    }
    if (this.child) await this.stopOwnedChild()
    this.port = port
    this.state = { state: 'starting' }

    let runtime: { root: string; entrypoint: string; metadata: RuntimeMetadata }
    try {
      runtime = await resolveOpenConnectorRuntime(this.options)
      await this.prepareSecrets()
    } catch (error) {
      this.state = { state: 'unavailable', message: safeErrorMessage(error) }
      return this.snapshot(false)
    }
    if (!this.desiredRunning) {
      this.state = { state: 'stopped' }
      return this.snapshot(false)
    }

    if (!(await canListenOnLoopback(port))) {
      this.state = {
        state: 'port_conflict',
        message: `Port ${port} is already in use. Choose another connector port and update OAuth callback registrations.`
      }
      return this.snapshot(false)
    }

    const secrets = this.secrets!
    const environment = buildOpenConnectorSidecarEnvironment(this.options.environment ?? process.env, {
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(port),
      OOMOL_CONNECT_ORIGIN: this.baseUrl,
      OOMOL_CONNECT_DATA_DIR: join(this.options.userDataDir, 'connectors', 'open-connector', 'data'),
      OOMOL_CONNECT_ADMIN_TOKEN: secrets.adminToken,
      OOMOL_CONNECT_RUNTIME_TOKEN: secrets.runtimeToken,
      OOMOL_CONNECT_ENCRYPTION_KEY: secrets.encryptionKey,
      OOMOL_CONNECT_INSTANCE_PROOF_KEY: secrets.instanceProofKey,
      OOMOL_CONNECT_BLOCKED_PROXIES: '*',
      OOMOL_CONNECT_LOG_LEVEL: 'info'
    })

    const child = spawn(this.options.execPath, [runtime.entrypoint], {
      cwd: runtime.root,
      env: environment,
      detached: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.child = child
    this.stopping = false
    this.attachChild(child)

    const healthy = await this.waitForHealth(20_000)
    if (!healthy) {
      if (this.child === child) await this.stopOwnedChild()
      if (!this.desiredRunning) {
        this.state = { state: 'stopped' }
        return this.snapshot(false)
      }
      if (this.state.state !== 'incompatible') {
        this.state = {
          state: 'failed',
          message: 'OpenConnector did not become healthy within 20 seconds.'
        }
      }
      return this.snapshot(false)
    }

    this.restartAttempts = 0
    this.state = {
      state: 'running',
      version: runtime.metadata.version,
      protocolVersion: runtime.metadata.protocolVersion
    }
    this.options.log?.('info', 'OpenConnector sidecar is ready.', {
      port,
      version: runtime.metadata.version,
      protocolVersion: runtime.metadata.protocolVersion,
      pid: child.pid
    })
    return this.snapshot(true)
  }

  async health(): Promise<OpenConnectorHealth> {
    if (!this.child || this.child.exitCode !== null) return this.snapshot(false)
    const probe = await this.probeHealth()
    if (!probe) {
      this.state = { state: 'failed', message: 'OpenConnector health check failed.' }
      return this.snapshot(false)
    }
    return this.snapshot(true)
  }

  async stop(): Promise<OpenConnectorHealth> {
    this.desiredRunning = false
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    await this.startPromise?.catch(() => undefined)
    await this.stopOwnedChild()
    this.state = { state: 'stopped' }
    return this.snapshot(false)
  }

  async reconcile(enabled: boolean, port: number): Promise<OpenConnectorHealth> {
    return enabled ? this.start(port) : this.stop()
  }

  private attachChild(child: ChildProcess): void {
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const message = this.redact(String(chunk)).trim()
      if (message) this.options.log?.('info', 'OpenConnector output.', { message: bounded(message) })
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const message = this.redact(String(chunk)).trim()
      if (message) this.options.log?.('warn', 'OpenConnector diagnostic.', { message: bounded(message) })
    })
    child.once('error', (error) => {
      if (this.child !== child) return
      this.state = { state: 'failed', message: safeErrorMessage(error) }
      this.options.log?.('error', 'OpenConnector process failed.', { message: safeErrorMessage(error) })
    })
    child.once('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = null
      if (this.stopping) return
      this.state = {
        state: 'failed',
        message: signal
          ? `OpenConnector exited with signal ${signal}.`
          : `OpenConnector exited with code ${code ?? 'unknown'}.`
      }
      this.options.log?.('warn', 'OpenConnector exited unexpectedly.', {
        code: code ?? undefined,
        signal: signal ?? undefined
      })
      this.scheduleRestart()
    })
  }

  private scheduleRestart(): void {
    if (!this.desiredRunning || this.restartAttempts >= 3 || this.restartTimer) return
    const delayMs = 500 * 2 ** this.restartAttempts
    this.restartAttempts += 1
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      void this.start(this.port)
    }, delayMs)
    this.restartTimer.unref?.()
  }

  private async stopOwnedChild(): Promise<void> {
    const child = this.child
    if (!child) return
    this.stopping = true
    child.kill('SIGTERM')
    if (!(await waitForChildExit(child, 5_000))) {
      child.kill('SIGKILL')
      await waitForChildExit(child, 1_000)
    }
    if (this.child === child) this.child = null
    this.stopping = false
  }

  private async waitForHealth(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!this.desiredRunning) return false
      if (!this.child || this.child.exitCode !== null) return false
      if (await this.probeHealth()) return true
      await delay(150)
    }
    return false
  }

  private async probeHealth(): Promise<boolean> {
    if (!this.secrets) return false
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2_000)
    try {
      const ownsPort = await verifyOpenConnectorInstanceProof(
        this.options.fetchImpl ?? fetch,
        this.baseUrl,
        this.secrets.instanceProofKey,
        controller.signal
      )
      if (!ownsPort) return false
      const response = await (this.options.fetchImpl ?? fetch)(`${this.baseUrl}/v1/health`, {
        headers: { authorization: `Bearer ${this.secrets.runtimeToken}` },
        signal: controller.signal
      })
      if (!response.ok) return false
      const parsed = RuntimeHealthEnvelopeSchema.safeParse(await response.json())
      if (!parsed.success) return false
      const metadata = parsed.data.data
      if (metadata.protocolVersion !== OPEN_CONNECTOR_PROTOCOL_VERSION) {
        this.state = {
          state: 'incompatible',
          version: metadata.runtimeVersion,
          protocolVersion: metadata.protocolVersion,
          message: `OpenConnector protocol ${metadata.protocolVersion} is incompatible with Kun protocol ${OPEN_CONNECTOR_PROTOCOL_VERSION}.`
        }
        return false
      }
      this.state = {
        state: 'running',
        version: metadata.runtimeVersion,
        protocolVersion: metadata.protocolVersion
      }
      return true
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  private snapshot(managed: boolean): OpenConnectorHealth {
    return {
      state: this.state.state,
      enabled: this.desiredRunning,
      managed,
      baseUrl: this.baseUrl,
      port: this.port,
      ...(this.state.version ? { version: this.state.version } : {}),
      ...(this.state.protocolVersion ? { protocolVersion: this.state.protocolVersion } : {}),
      ...(this.child?.pid ? { pid: this.child.pid } : {}),
      ...(this.state.message ? { message: this.state.message } : {}),
      checkedAt: new Date().toISOString()
    }
  }

  private redact(value: string): string {
    let redacted = value
    for (const secret of [
      ...(this.secrets
        ? [this.secrets.adminToken, this.secrets.runtimeToken, this.secrets.encryptionKey]
        : []),
      this.secrets?.instanceProofKey
    ]) {
      if (secret) redacted = redacted.replaceAll(secret, '[REDACTED]')
    }
    return redacted
  }
}

export async function verifyOpenConnectorInstanceProof(
  fetchImpl: typeof fetch,
  baseUrl: string,
  proofKey: string,
  signal?: AbortSignal
): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/i.test(proofKey)) return false
  signal?.throwIfAborted()
  const challenge = randomBytes(32).toString('hex')
  const url = new URL('/health', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
  url.searchParams.set('challenge', challenge)
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal
  })
  signal?.throwIfAborted()
  if (!response.ok) return false
  const advertised = Number(response.headers.get('content-length'))
  if (Number.isFinite(advertised) && advertised > 64 * 1024) return false
  const body = await response.text()
  if (Buffer.byteLength(body) > 64 * 1024) return false
  let decoded: unknown
  try {
    decoded = JSON.parse(body)
  } catch {
    return false
  }
  const parsed = PublicRuntimeHealthSchema.safeParse(decoded)
  if (!parsed.success) return false
  const expected = createHmac('sha256', Buffer.from(proofKey, 'hex')).update(challenge).digest()
  const actual = Buffer.from(parsed.data.instanceProof, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export async function resolveOpenConnectorRuntime(
  options: Pick<OpenConnectorSidecarOptions, 'isPackaged' | 'resourcesPath' | 'appRoot' | 'environment'>
): Promise<{ root: string; entrypoint: string; metadata: RuntimeMetadata }> {
  const explicit = options.isPackaged
    ? undefined
    : options.environment?.[OPEN_CONNECTOR_RUNTIME_DIR_ENV]?.trim()
  const root = resolve(explicit || (options.isPackaged
    ? join(options.resourcesPath, 'open-connector', 'current')
    : join(options.appRoot, 'resources', 'open-connector', 'current')))
  const metadataPath = join(root, 'runtime.json')
  if (!existsSync(metadataPath)) {
    const hint = options.isPackaged
      ? 'The packaged OpenConnector runtime is missing.'
      : `Set ${OPEN_CONNECTOR_RUNTIME_DIR_ENV} to an extracted OpenConnector runtime or run the preparation script.`
    throw new Error(`${hint} Expected ${metadataPath}`)
  }
  const metadata = RuntimeMetadataSchema.parse(JSON.parse(await readFile(metadataPath, 'utf8')) as unknown)
  if (metadata.protocolVersion !== OPEN_CONNECTOR_PROTOCOL_VERSION) {
    throw new Error(
      `OpenConnector protocol ${metadata.protocolVersion} does not match required protocol ${OPEN_CONNECTOR_PROTOCOL_VERSION}.`
    )
  }
  if (metadata.version !== PINNED_OPEN_CONNECTOR_VERSION && !explicit) {
    throw new Error(
      `OpenConnector ${metadata.version} does not match pinned version ${PINNED_OPEN_CONNECTOR_VERSION}.`
    )
  }
  const entrypoint = resolve(root, metadata.entrypoint)
  if (!entrypoint.startsWith(`${root}${process.platform === 'win32' ? '\\' : '/'}`) || !existsSync(entrypoint)) {
    throw new Error(`OpenConnector runtime entrypoint is missing or escapes its runtime root: ${metadata.entrypoint}`)
  }
  return { root, entrypoint, metadata }
}

export function buildOpenConnectorSidecarEnvironment(
  inherited: NodeJS.ProcessEnv,
  required: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const key of SIDECAR_ENV_ALLOWLIST) {
    const value = inherited[key]
    if (value !== undefined) environment[key] = value
  }
  return { ...environment, ...required }
}

async function canListenOnLoopback(port: number): Promise<boolean> {
  return await new Promise((resolveResult) => {
    const server = createServer()
    const finish = (available: boolean): void => {
      server.removeAllListeners()
      resolveResult(available)
    }
    server.once('error', () => finish(false))
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close(() => finish(true))
    })
  })
}

function assertConnectorPort(port: number): void {
  if (!Number.isInteger(port) || port < 10_000 || port > 65_535) {
    throw new Error(`Invalid OpenConnector port: ${port}`)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit)
      resolveExit(false)
    }, timeoutMs)
    const onExit = (): void => {
      clearTimeout(timer)
      resolveExit(true)
    }
    child.once('exit', onExit)
  })
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return bounded(message.replace(/(?:kun_oc_(?:admin|runtime)_[A-Za-z0-9_-]+|[A-Za-z0-9+/]{40,}={0,2})/g, '[REDACTED]'))
}

function bounded(value: string, max = 4_096): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}
