import type { McpCapabilityConfig, McpServerConfig } from '../../contracts/capabilities.js'
import { redactSecretText } from '../../config/secret-redaction.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import {
  catalogFingerprint,
  canUseMcpServer,
  isMcpServerTrusted,
  isMcpServerVisible,
  normalizeMcpToolName
} from './mcp-naming.js'
import {
  clearMcpOAuthCredentials,
  listMcpOAuthDiagnostics
} from './mcp-oauth-provider.js'
import {
  authorizeMcpServerOAuth,
  createSdkMcpClient,
  isMcpAuthorizationRequiredError
} from './mcp-transport.js'
import { errorMessage, formatMcpConnectionError } from './mcp-stdio-environment.js'
import { createMcpFacadeProvider } from './mcp-facade-provider.js'
import type {
  McpClientLike,
  McpOAuthAuthorizeResult,
  McpOAuthClearResult,
  McpOAuthDiagnostic,
  McpServerDiagnostic,
  McpToolDescriptor
} from './mcp-types.js'
import {
  createMcpSearchProvider,
  mcpSearchDiagnostic,
  type McpSearchCatalogRecord,
  type McpSearchCatalogState,
  type McpSearchRuntimeDiagnostic
} from './mcp-tool-search.js'
import {
  attachMcpClientLifecycle,
  createMcpLocalTool,
  createMcpSearchCatalogRecord,
  defaultMcpReconnectDelay,
  listAllMcpTools,
  raceStartupTimeout,
  refreshMcpConnectionCatalog,
  runMcpBackgroundReconnect,
  serverDiagnostic,
  shouldUseMcpSearch,
  startupConnectionError,
  syncMcpDiagnostic
} from './mcp-tool-runtime.js'

// Re-export the MCP module surface so existing consumers (and the
// `adapters/tool/index.ts` barrel) keep importing from one place even though
// the implementation now lives in focused modules: persistence, OAuth, the
// transport adapter, naming/trust, and stdio environment.
export type {
  McpClientLike,
  McpClientLifecycleHandlers,
  McpOAuthAuthorizeResult,
  McpOAuthClearResult,
  McpOAuthDiagnostic,
  McpOAuthStatus,
  McpServerDiagnostic,
  McpToolDescriptor
} from './mcp-types.js'
export {
  canUseMcpServer,
  isMcpServerTrusted,
  isMcpServerVisible,
  normalizeMcpToolName,
  resolveMcpServerCwd
} from './mcp-naming.js'
export {
  FileMcpOAuthProvider,
  clearMcpOAuthCredentials,
  createMcpOAuthProvider,
  listMcpOAuthDiagnostics
} from './mcp-oauth-provider.js'
export {
  authorizeMcpServerOAuth,
  createSdkMcpClient,
  isMcpAuthorizationRequiredError,
  McpAuthorizationRequiredError
} from './mcp-transport.js'
export {
  buildMcpStdioEnvironment,
  formatMcpConnectionError,
  type McpStdioEnvironmentOptions
} from './mcp-stdio-environment.js'

export type McpToolProviderBuildResult = {
  providers: CapabilityToolProvider[]
  diagnostics: McpServerDiagnostic[]
  oauth: McpOAuthDiagnostic[]
  search: McpSearchRuntimeDiagnostic
  connectedServers: number
  toolCount: number
  /**
   * Begin retrying servers that failed/timed out during the fast startup pass.
   * Call once, after the tool registries exist, passing a callback that adds a
   * late-connected server's provider to them. Without this, a server that loses
   * the startup race (e.g. an npx-based stdio server whose first cold start
   * exceeds the connect timeout on Windows) stays "error" forever until the
   * whole runtime restarts — exactly issue #342. Safe to call when there is
   * nothing to retry (it no-ops). The returned promise resolves once every
   * failed server has reconnected or exhausted its retries (used by tests).
   */
  startBackgroundReconnect: (register: (provider: CapabilityToolProvider) => void) => Promise<void>
  clearOAuthCredentials: (serverId?: string) => Promise<McpOAuthClearResult>
  /**
   * Run the interactive OAuth authorization flow for one configured remote
   * server (the explicit, user-triggered entry point). Refreshes the cached
   * OAuth diagnostics on completion. Startup never calls this.
   */
  authorizeOAuth: (serverId: string) => Promise<McpOAuthAuthorizeResult>
  close: () => Promise<void>
}

export type McpToolProviderOptions = {
  clientFactory?: (serverId: string, server: McpServerConfig) => Promise<McpClientLike>
  nowIso?: () => string
  oauthStorageDir?: string
  /** Optional encryptor so persisted OAuth tokens are encrypted at rest. */
  oauthEncryptor?: import('../../security/secret-store.js').SecretEncryptor
  openExternal?: (url: URL) => void | Promise<void>
  /**
   * Upper bound for connect + initial tool listing per server during startup.
   * A slow or hung server (e.g. an npx-based stdio server resolving packages)
   * must not keep the whole runtime from reporting ready.
   */
  startupConnectTimeoutMs?: number
  /** Tunables for the post-startup background reconnect of failed servers. */
  backgroundReconnect?: McpBackgroundReconnectOptions
  /** Test seam for the inter-attempt backoff; defaults to a real unref'd timer. */
  delay?: (ms: number) => Promise<void>
  /**
   * Test seam for the interactive authorization step. Defaults to the real
   * browser-driven {@link authorizeMcpServerOAuth}. Tests inject a fake to
   * exercise the authorize-then-register + reconnect path without a network.
   */
  authorize?: (serverId: string, server: McpServerConfig) => Promise<McpOAuthAuthorizeResult>
}

export type McpBackgroundReconnectOptions = {
  /** Disable the retry loop entirely. Defaults to enabled. */
  enabled?: boolean
  /** Attempts per failed server before giving up. Default 5. */
  maxAttempts?: number
  /** First backoff delay; doubles each attempt up to maxDelayMs. Default 4000. */
  baseDelayMs?: number
  /** Backoff ceiling. Default 30000. */
  maxDelayMs?: number
}

const DEFAULT_MCP_STARTUP_CONNECT_TIMEOUT_MS = 10_000
const DEFAULT_MCP_RECONNECT_MAX_ATTEMPTS = 5
const DEFAULT_MCP_RECONNECT_BASE_DELAY_MS = 4_000
const DEFAULT_MCP_RECONNECT_MAX_DELAY_MS = 30_000

export type McpConnectionState = {
  serverId: string
  server: McpServerConfig
  client: McpClientLike
  clientFactory: (serverId: string, server: McpServerConfig) => Promise<McpClientLike>
  nowIso: () => string
  catalogFingerprint?: string
  catalogDrift?: boolean
  toolNames: string[]
  lastConnectedAt?: string
  lastError?: string
  // Reconnect state machine (#642/#639), ported from upstream so a dropped
  // transport flips the live diagnostic to `reconnecting`/`error` and a single
  // shared reconnect recovers concurrent callers.
  status: 'connected' | 'reconnecting' | 'error'
  reconnectAttempts: number
  reconnectBackoffMs: number
  reconnectPromise?: Promise<McpClientLike>
  lastDisconnectedAt?: string
  lastReconnectAt?: string
  nextReconnectAt?: string
  /** Live diagnostic object — the SAME reference stored in the diagnostics array. */
  diagnostic?: McpServerDiagnostic
  intentionallyClosing?: boolean
}

export async function buildMcpToolProviders(
  config: McpCapabilityConfig | undefined,
  options: McpToolProviderOptions = {}
): Promise<McpToolProviderBuildResult> {
  const providers: CapabilityToolProvider[] = []
  const directProviders: CapabilityToolProvider[] = []
  const diagnostics: McpServerDiagnostic[] = []
  const connected: McpConnectionState[] = []
  const catalogState: McpSearchCatalogState = { records: [] }
  const mcp = config
  const nowIso = options.nowIso ?? (() => new Date().toISOString())
  const clientFactory = options.clientFactory ?? ((serverId, server) =>
    createSdkMcpClient(serverId, server, {
      storageDir: options.oauthStorageDir,
      openExternal: options.openExternal,
      ...(options.oauthEncryptor ? { encryptor: options.oauthEncryptor } : {})
    }))
  if (!mcp?.enabled) {
    return {
      providers,
      diagnostics,
      oauth: [],
      search: mcpSearchDiagnostic({
        config: config?.search ?? {
          enabled: false,
          mode: 'auto',
          autoThresholdToolCount: 24,
          topKDefault: 5,
          topKMax: 10,
          minScore: 0.15,
          bm25: { k1: 1.2, b: 0.75 }
        },
        active: false,
        indexedToolCount: 0,
        advertisedToolCount: 0,
        state: catalogState
      }),
      connectedServers: 0,
      toolCount: 0,
      startBackgroundReconnect: async () => undefined,
      clearOAuthCredentials: async () => ({ cleared: [] }),
      authorizeOAuth: async (serverId) => ({ serverId, status: 'disabled', authorized: false }),
      close: async () => undefined
    }
  }

  // Connect all servers in parallel — startup previously paid the sum of
  // every server's connect + list latency, and a single hung server (e.g.
  // npx resolving a package) blocked the runtime ready signal forever.
  const startupTimeoutMs = options.startupConnectTimeoutMs ?? DEFAULT_MCP_STARTUP_CONNECT_TIMEOUT_MS
  type ConnectOutcome =
    | { serverId: string; server: McpServerConfig; status: 'disabled' }
    | { serverId: string; server: McpServerConfig; status: 'error'; error: unknown }
    | {
        serverId: string
        server: McpServerConfig
        status: 'connected'
        state: McpConnectionState
        listed: McpToolDescriptor[]
      }
  const outcomes = await Promise.all(
    Object.entries(mcp.servers).map(async ([serverId, server]): Promise<ConnectOutcome> => {
      if (!server.enabled) {
        return { serverId, server, status: 'disabled' }
      }
      const attempt = (async () => {
        const client = await clientFactory(serverId, server)
        const state: McpConnectionState = {
          serverId,
          server,
          client,
          clientFactory,
          nowIso,
          status: 'connected',
          reconnectAttempts: 0,
          reconnectBackoffMs: DEFAULT_MCP_RECONNECT_BASE_DELAY_MS,
          toolNames: [],
          lastConnectedAt: nowIso()
        }
        attachMcpClientLifecycle(state)
        const listed = await refreshMcpConnectionCatalog(state)
        return { state, listed }
      })()
      try {
        const result = await raceStartupTimeout(attempt, startupTimeoutMs, serverId)
        return { serverId, server, status: 'connected', ...result }
      } catch (error) {
        return { serverId, server, status: 'error', error }
      }
    })
  )

  for (const outcome of outcomes) {
    if (outcome.status === 'disabled') {
      diagnostics.push(serverDiagnostic({ serverId: outcome.serverId, server: outcome.server }, 'disabled', 0))
      continue
    }
    if (outcome.status === 'error') {
      const authRequired = isMcpAuthorizationRequiredError(outcome.error)
      diagnostics.push(
        serverDiagnostic(
          { serverId: outcome.serverId, server: outcome.server },
          authRequired ? 'authorization_required' : 'error',
          0,
          startupConnectionError(outcome.error, outcome.server)
        )
      )
      continue
    }
    const { state, listed } = outcome
    connected.push(state)
    catalogState.records.push(...listed.map((tool) => createMcpSearchCatalogRecord(state, tool)))
    const tools = listed.map((tool) => createMcpLocalTool(state, tool))
    directProviders.push({
      id: `mcp:${outcome.serverId}`,
      kind: 'mcp',
      enabled: true,
      available: true,
      tools
    })
    diagnostics.push(syncMcpDiagnostic(state, 'connected', tools.length))
  }

  const connectedServers = diagnostics.filter((diagnostic) => diagnostic.status === 'connected').length
  const toolCount = catalogState.records.length
  const oauthDiagnostics = await listMcpOAuthDiagnostics(mcp, {
    storageDir: options.oauthStorageDir,
    encryptor: options.oauthEncryptor
  })
  catalogState.lastRefreshedAt = nowIso()
  catalogState.catalogFingerprint = catalogFingerprint(catalogState.records.map((record) => record.toolId))
  const gatewayActive = Object.keys(mcp.servers).length > 0
  const searchActive = shouldUseMcpSearch(mcp.search, toolCount) && connectedServers > 0
  if (gatewayActive) {
    providers.push(createMcpSearchProvider({
      config: mcp.search,
      state: catalogState,
      refreshCatalog: async () => {
        try {
          const records: McpSearchCatalogRecord[] = []
          const previousFingerprint = catalogState.catalogFingerprint
          for (const state of connected) {
            const listed = await refreshMcpConnectionCatalog(state, 'refresh')
            records.push(...listed.map((tool) => createMcpSearchCatalogRecord(state, tool)))
          }
          catalogState.records = records
          catalogState.lastError = undefined
          catalogState.lastRefreshedAt = nowIso()
          catalogState.catalogFingerprint = catalogFingerprint(records.map((record) => record.toolId))
          catalogState.catalogDrift = Boolean(previousFingerprint && previousFingerprint !== catalogState.catalogFingerprint)
          return records
        } catch (error) {
          catalogState.lastError = redactSecretText(errorMessage(error))
          throw error
        }
      },
      isServerAvailable: canUseMcpServer
    }))
  }
  if (!searchActive) {
    providers.push(...directProviders)
  }
  providers.push(createMcpFacadeProvider(connected))
  const advertisedToolCount = providers.reduce((total, provider) => total + provider.tools.length, 0)

  // Servers that need OAuth authorization are NOT retried by the background
  // reconnect loop — retrying just burns attempts and would re-hit a 401. They
  // wait in `authorization_required` until the user authorizes, after which
  // authorizeOAuth() performs a single live connect + register.
  const failedServers = outcomes.flatMap((outcome) =>
    outcome.status === 'error' && !isMcpAuthorizationRequiredError(outcome.error)
      ? [{ serverId: outcome.serverId, server: outcome.server }]
      : []
  )
  let reconnectAborted = false
  let reconnectStarted = false
  /** Captured from startBackgroundReconnect so authorizeOAuth can register live. */
  let liveRegister: ((provider: CapabilityToolProvider) => void) | null = null
  /** Per-serverId authorization single-flight: concurrent clicks share one run. */
  const authorizeInFlight = new Map<string, Promise<McpOAuthAuthorizeResult>>()

  const refreshOAuthDiagnostics = async (): Promise<void> => {
    const nextDiagnostics = await listMcpOAuthDiagnostics(mcp, {
      storageDir: options.oauthStorageDir,
      encryptor: options.oauthEncryptor
    })
    oauthDiagnostics.splice(0, oauthDiagnostics.length, ...nextDiagnostics)
  }

  /**
   * Connect a server live (using the real/injected client factory), list its
   * tools, register the provider, and flip its diagnostic to `connected` — no
   * runtime restart required after a successful authorization.
   */
  const connectAndRegisterServer = async (serverId: string, server: McpServerConfig): Promise<void> => {
    const client = await clientFactory(serverId, server)
    const state: McpConnectionState = {
      serverId,
      server,
      client,
      clientFactory,
      nowIso,
      status: 'connected',
      reconnectAttempts: 0,
      reconnectBackoffMs: DEFAULT_MCP_RECONNECT_BASE_DELAY_MS,
      toolNames: [],
      lastConnectedAt: nowIso()
    }
    attachMcpClientLifecycle(state)
    let listed: McpToolDescriptor[]
    try {
      listed = await refreshMcpConnectionCatalog(state)
    } catch (error) {
      await client.close().catch(() => undefined)
      throw error
    }
    connected.push(state)
    catalogState.records.push(...listed.map((tool) => createMcpSearchCatalogRecord(state, tool)))
    catalogState.catalogFingerprint = catalogFingerprint(catalogState.records.map((record) => record.toolId))
    catalogState.lastRefreshedAt = nowIso()
    const tools = listed.map((tool) => createMcpLocalTool(state, tool))
    if (!searchActive && liveRegister) {
      try {
        liveRegister({ id: `mcp:${serverId}`, kind: 'mcp', enabled: true, available: true, tools })
      } catch {
        // Registry collision must not break the authorize flow; the diagnostic
        // still flips to connected below.
      }
    }
    const diagnostic = syncMcpDiagnostic(state, 'connected', tools.length)
    const index = diagnostics.findIndex((entry) => entry.id === serverId)
    if (index >= 0) diagnostics[index] = diagnostic
    else diagnostics.push(diagnostic)
  }

  const authorizeOAuth = (serverId: string): Promise<McpOAuthAuthorizeResult> => {
    const inflight = authorizeInFlight.get(serverId)
    if (inflight) return inflight
    const run = (async (): Promise<McpOAuthAuthorizeResult> => {
      const server = mcp.servers[serverId]
      if (!server || !options.oauthStorageDir) {
        return { serverId, status: 'disabled', authorized: false }
      }
      const authorize = options.authorize ??
        ((id: string, srv: McpServerConfig) => authorizeMcpServerOAuth(id, srv, {
          storageDir: options.oauthStorageDir as string,
          openExternal: options.openExternal,
          encryptor: options.oauthEncryptor
        }))
      const result = await authorize(serverId, server)
      await refreshOAuthDiagnostics()
      // On success, connect + register immediately so tools are live without a
      // runtime restart. Skip if the server is already connected.
      if (result.authorized && !connected.some((state) => state.serverId === serverId)) {
        try {
          await connectAndRegisterServer(serverId, server)
        } catch {
          // Leave the server in its prior diagnostic state; the user can retry.
        }
      }
      return result
    })()
    authorizeInFlight.set(serverId, run)
    run.finally(() => {
      if (authorizeInFlight.get(serverId) === run) authorizeInFlight.delete(serverId)
    }).catch(() => undefined)
    return run
  }

  return {
    providers,
    diagnostics,
    oauth: oauthDiagnostics,
    search: mcpSearchDiagnostic({
      config: mcp.search,
      active: gatewayActive,
      indexedToolCount: toolCount,
      advertisedToolCount,
      state: catalogState
    }),
    connectedServers,
    toolCount,
    startBackgroundReconnect: (register) => {
      liveRegister = register
      if (reconnectStarted) return Promise.resolve()
      reconnectStarted = true
      if (failedServers.length === 0) return Promise.resolve()
      if (options.backgroundReconnect?.enabled === false) return Promise.resolve()
      return runMcpBackgroundReconnect({
        failedServers,
        clientFactory,
        nowIso,
        diagnostics,
        connected,
        catalogState,
        searchActive,
        register,
        isAborted: () => reconnectAborted,
        delay: options.delay ?? defaultMcpReconnectDelay,
        options: options.backgroundReconnect
      })
    },
    clearOAuthCredentials: async (serverId) => {
      const result = await clearMcpOAuthCredentials(mcp, {
        storageDir: options.oauthStorageDir,
        serverId
      })
      await refreshOAuthDiagnostics()
      return result
    },
    authorizeOAuth,
    close: async () => {
      reconnectAborted = true
      await Promise.all(connected.map((state) => state.client.close().catch(() => undefined)))
    }
  }
}

/**
 * Turn a startup connect failure into an actionable diagnostic message.
 * Authorization-required failures (a remote OAuth server with no usable token)
 * are expected during startup — the connect is non-interactive — so they get a
 * "use Authorize" hint instead of a raw transport error.
 */

export { McpToolStatusUnknownError } from './mcp-tool-runtime.js'
