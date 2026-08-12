import { createServer, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import {
  GROK_CLI_TOKEN_AUTH,
  GROK_CLI_VERSION,
  grokCliMediaHeaders,
  grokCliProxyHeaders
} from '../../kun/src/adapters/model/provider-cli-identity.js'
import { fetchWithOptionalProxy } from './proxy-fetch'

/** Matches the public Grok CLI OAuth client (xai-grok-shell GrokComConfig::default). */
export const GROK_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
export const GROK_OAUTH_ISSUER = 'https://auth.x.ai'
export const GROK_CLI_CHAT_PROXY_BASE_URL = 'https://cli-chat-proxy.grok.com/v1'
export const GROK_TOKEN_AUTH_HEADER = GROK_CLI_TOKEN_AUTH
export const GROK_OAUTH_REFERRER = 'kun'
/** Keep aligned with the Grok Build client whose public OAuth contract we use. */
export const GROK_CLIENT_VERSION = GROK_CLI_VERSION

/** Align with grok-build DEFAULT_EARLY_INVALIDATION_SECS. */
export const GROK_EARLY_INVALIDATION_MS = 5 * 60 * 1000
/** Align with grok-build TOKEN_TTL when IdP omits expires_in. */
export const GROK_TOKEN_TTL_FALLBACK_MS = 30 * 24 * 60 * 60 * 1000

const GROK_OAUTH_HOST = '127.0.0.1'
const GROK_OAUTH_TIMEOUT_MS = 10 * 60 * 1000
const GROK_OAUTH_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'grok-cli:access',
  'api:access',
  'conversations:read',
  'conversations:write',
  'workspaces:read',
  'workspaces:write'
].join(' ')
export type GrokOAuthCredentials = {
  kind: 'grok-oauth'
  accessToken: string
  refreshToken: string
  expiresAt: number
  email?: string
  userId?: string
  issuer?: string
  clientId?: string
}

export type GrokBrowserAuthErrorCode =
  | 'port_in_use'
  | 'discovery_failed'
  | 'callback_failed'
  | 'browser_open_failed'
  | 'token_exchange_failed'
  | 'timeout'
  | 'cancelled'

export type GrokBrowserAuthResult =
  | { ok: true; credentials: GrokOAuthCredentials }
  | {
      ok: false
      message: string
      code?: GrokBrowserAuthErrorCode
    }

export type GrokAuthTransport = {
  fetcher?: typeof fetchWithOptionalProxy
  proxyUrl?: string
}

type OidcDiscovery = {
  authorization_endpoint: string
  token_endpoint: string
}

type PendingBrowserSession = {
  tokenEndpoint: string
  redirectUri: string
  codeVerifier: string
  state: string
  transport: GrokAuthTransport
  server: Server | null
  settled: boolean
  resolve: (result: GrokBrowserAuthResult) => void
  timeout: ReturnType<typeof setTimeout>
}

let pendingBrowserSession: PendingBrowserSession | null = null

export function sanitizeGrokAuthError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[redacted]@')
    .replace(/([?&](?:code|state|token|access_token|refresh_token|code_verifier)=)[^&#\s]*/gi, '$1[redacted]')
    .replace(/(Bearer)\s+[^\s,;]+/gi, '$1 [redacted]')
    .replace(/("(?:access_token|refresh_token|id_token|code|code_verifier|state)"\s*:\s*")[^"]*/gi, '$1[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

function authFetch(
  input: string | URL,
  init: RequestInit | undefined,
  transport: GrokAuthTransport
): Promise<Response> {
  return (transport.fetcher ?? fetchWithOptionalProxy)(input, init, transport.proxyUrl ?? '')
}

function parseJwtClaims(token: string): Record<string, unknown> | undefined {
  const part = token.split('.')[1]
  if (!part) return undefined
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString()) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function extractEmail(idToken?: string, accessToken?: string): string | undefined {
  for (const token of [idToken, accessToken]) {
    if (!token) continue
    const claims = parseJwtClaims(token)
    if (claims && typeof claims.email === 'string') return claims.email
  }
  return undefined
}

function extractUserId(idToken?: string, accessToken?: string): string | undefined {
  for (const token of [idToken, accessToken]) {
    if (!token) continue
    const claims = parseJwtClaims(token)
    if (!claims) continue
    if (typeof claims.sub === 'string' && claims.sub) return claims.sub
    if (typeof claims.user_id === 'string' && claims.user_id) return claims.user_id
  }
  return undefined
}

function summarizeAuthErrorBody(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (!compact) return ''
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const parts = [
      typeof parsed.error === 'string' ? parsed.error : '',
      typeof parsed.error_description === 'string' ? parsed.error_description : '',
      typeof parsed.message === 'string' ? parsed.message : ''
    ].filter(Boolean)
    if (parts.length) return parts.join(': ').slice(0, 300)
  } catch {
    /* fall through */
  }
  return compact.slice(0, 300)
}

async function postForm(
  url: string,
  body: Record<string, string>,
  extraHeaders: Record<string, string> = {},
  transport: GrokAuthTransport = {}
): Promise<Record<string, unknown>> {
  const res = await authFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...extraHeaders
    },
    body: new URLSearchParams(body).toString()
  }, transport)
  const text = await res.text()
  if (!res.ok) {
    const detail = summarizeAuthErrorBody(text)
    throw new Error(`Grok subscription auth: ${url} returned ${res.status}${detail ? `: ${detail}` : ''}`)
  }
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(`Grok subscription auth: unexpected response from ${url}: ${text.slice(0, 200)}`)
  }
}

async function discoverOidc(
  issuer: string = GROK_OAUTH_ISSUER,
  transport: GrokAuthTransport = {}
): Promise<OidcDiscovery> {
  const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`
  const res = await authFetch(
    url,
    { method: 'GET', headers: { Accept: 'application/json' } },
    transport
  )
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Grok subscription auth: discovery failed (${res.status}) from ${url}`)
  }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(`Grok subscription auth: invalid discovery document from ${url}`)
  }
  const authorization_endpoint =
    typeof parsed.authorization_endpoint === 'string' ? parsed.authorization_endpoint : ''
  const token_endpoint = typeof parsed.token_endpoint === 'string' ? parsed.token_endpoint : ''
  if (!authorization_endpoint || !token_endpoint) {
    throw new Error('Grok subscription auth: discovery document missing endpoints')
  }
  return { authorization_endpoint, token_endpoint }
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function generatePkce(): { verifier: string; challenge: string } {
  // RFC 7636 requires 43-128 characters. Grok Build encodes 32 random bytes,
  // producing a 43-character base64url verifier without padding.
  const verifier = base64UrlEncode(randomBytes(32))
  const challenge = base64UrlEncode(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

function grokOAuthRedirect(port: number): string {
  return `http://127.0.0.1:${port}/callback`
}

function buildAuthorizeUrl(
  authorizationEndpoint: string,
  pkceChallenge: string,
  state: string,
  nonce: string,
  redirectUri: string
): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: GROK_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: GROK_OAUTH_SCOPES,
    code_challenge: pkceChallenge,
    code_challenge_method: 'S256',
    state,
    nonce,
    referrer: GROK_OAUTH_REFERRER
  })
  const joiner = authorizationEndpoint.includes('?') ? '&' : '?'
  return `${authorizationEndpoint}${joiner}${params.toString()}`
}

function expiresAtFromTokens(tokens: Record<string, unknown>): number {
  const expiresIn = Number(tokens.expires_in)
  if (Number.isFinite(expiresIn) && expiresIn > 0) {
    return Date.now() + expiresIn * 1000
  }
  return Date.now() + GROK_TOKEN_TTL_FALLBACK_MS
}

function credentialsFromTokens(
  tokens: Record<string, unknown>,
  issuer: string = GROK_OAUTH_ISSUER
): GrokOAuthCredentials | null {
  const accessToken = tokens.access_token as string | undefined
  // Browser login should always return a refresh_token (offline_access).
  // Keep refresh optional only if IdP omits it — callers still get a session
  // but ensureFresh will force re-login once access expires.
  const refreshToken = (tokens.refresh_token as string | undefined) ?? ''
  if (!accessToken) return null
  if (!refreshToken) return null
  return {
    kind: 'grok-oauth',
    accessToken,
    refreshToken,
    expiresAt: expiresAtFromTokens(tokens),
    email: extractEmail(tokens.id_token as string | undefined, accessToken),
    userId: extractUserId(tokens.id_token as string | undefined, accessToken),
    issuer,
    clientId: GROK_OAUTH_CLIENT_ID
  }
}

const GROK_BROWSER_SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Grok 订阅</title><style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0a0a0a;color:#e5e5e5}.box{text-align:center;padding:2rem}h1{margin-bottom:.5rem;font-size:18px}p{color:#a3a3a3;font-size:14px}@media(prefers-color-scheme:light){body{background:#fafafa;color:#171717}p{color:#525252}}</style></head><body><div class="box"><h1>登录成功</h1><p>可以关闭此窗口并返回应用。</p></div><script>setTimeout(()=>window.close(),1500)</script></body></html>`

function renderGrokErrorHtml(message: string): string {
  const safe = message.replace(/[&<>"]/g, (ch) =>
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : '&quot;'
  )
  return `<!doctype html><html><head><meta charset="utf-8"><title>Grok 订阅</title></head><body style="font-family:system-ui;padding:2rem;color:#b91c1c"><h1>登录失败</h1><p>${safe}</p></body></html>`
}

function closeServer(server: Server | null): void {
  if (!server) return
  try {
    server.close(() => {})
  } catch {
    /* ignore */
  }
}

function settleBrowserSession(result: GrokBrowserAuthResult): void {
  const session = pendingBrowserSession
  if (!session || session.settled) return
  session.settled = true
  clearTimeout(session.timeout)
  closeServer(session.server)
  pendingBrowserSession = null
  session.resolve(result)
}

/**
 * Parse pasted input the same way grok-build does:
 * - full callback URL with ?code=
 * - bare authorization code
 */
export function parseGrokPastedAuthInput(input: string): { code: string; state: string } | { error: string } {
  const trimmed = input.trim()
  if (!trimmed) return { error: 'empty input' }
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed)
      const code = url.searchParams.get('code')
      if (code) {
        return { code, state: url.searchParams.get('state') ?? '' }
      }
      const oauthError = url.searchParams.get('error')
      if (oauthError) {
        const desc = url.searchParams.get('error_description')
        return { error: desc ? `${oauthError}: ${desc}` : oauthError }
      }
      return { error: 'URL has no code query parameter' }
    } catch {
      return { error: 'invalid URL' }
    }
  }
  return { code: trimmed, state: '' }
}

async function exchangeAuthorizationCode(
  session: Pick<PendingBrowserSession, 'tokenEndpoint' | 'redirectUri' | 'codeVerifier' | 'transport'>,
  code: string
): Promise<GrokOAuthCredentials> {
  const tokens = await postForm(
    session.tokenEndpoint,
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: session.redirectUri,
      client_id: GROK_OAUTH_CLIENT_ID,
      code_verifier: session.codeVerifier
    },
    { 'x-grok-client-version': GROK_CLIENT_VERSION },
    session.transport
  )
  const creds = credentialsFromTokens(tokens)
  if (!creds) throw new Error('令牌交换返回的数据不完整')
  return creds
}

/**
 * Browser OAuth (authorization code + PKCE).
 * Races loopback callback against manual paste (submitGrokBrowserAuthCode),
 * matching grok-build's Path A + Path B design.
 */
export async function startGrokBrowserAuth(
  openBrowser: (url: string) => void | Promise<void>,
  transport: GrokAuthTransport = {}
): Promise<GrokBrowserAuthResult> {
  cancelGrokBrowserAuth()

  try {
    let discovery: OidcDiscovery
    try {
      discovery = await discoverOidc(GROK_OAUTH_ISSUER, transport)
    } catch (error) {
      return {
        ok: false,
        code: 'discovery_failed',
        message: sanitizeGrokAuthError(error)
      }
    }
    const pkce = generatePkce()
    const state = base64UrlEncode(randomBytes(32))
    const nonce = base64UrlEncode(randomBytes(16))

    return await new Promise<GrokBrowserAuthResult>((resolve) => {
      let activePort = 0
      let server: Server | null = null

      const timeout = setTimeout(() => {
        settleBrowserSession({
          ok: false,
          code: 'timeout',
          message: '授权超时，请重试'
        })
      }, GROK_OAUTH_TIMEOUT_MS)

      const sessionShell: PendingBrowserSession = {
        tokenEndpoint: discovery.token_endpoint,
        redirectUri: '',
        codeVerifier: pkce.verifier,
        state,
        transport,
        server: null,
        settled: false,
        resolve,
        timeout
      }
      pendingBrowserSession = sessionShell

      server = createServer((req, res) => {
        const current = pendingBrowserSession
        if (!current || current.settled) {
          res.writeHead(404).end('Not found')
          return
        }
        const url = new URL(req.url || '/', `http://127.0.0.1:${activePort}`)
        if (url.pathname !== '/callback') {
          res.writeHead(404).end('Not found')
          return
        }
        const code = url.searchParams.get('code')
        const returnedState = url.searchParams.get('state')
        const oauthError = url.searchParams.get('error')
        if (oauthError) {
          const message = url.searchParams.get('error_description') || oauthError
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(renderGrokErrorHtml(message))
          settleBrowserSession({ ok: false, code: 'callback_failed', message })
          return
        }
        if (!code || returnedState !== state) {
          const message = !code ? '缺少授权码' : '状态校验失败（可能的 CSRF）'
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(renderGrokErrorHtml(message))
          settleBrowserSession({ ok: false, code: 'callback_failed', message })
          return
        }
        void exchangeAuthorizationCode(current, code)
          .then((creds) => {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(GROK_BROWSER_SUCCESS_HTML)
            settleBrowserSession({ ok: true, credentials: creds })
          })
          .catch((err: unknown) => {
            const message = sanitizeGrokAuthError(err)
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(renderGrokErrorHtml(message))
            settleBrowserSession({ ok: false, code: 'token_exchange_failed', message })
          })
      })

      const onListenError = (err: NodeJS.ErrnoException): void => {
        server?.off('error', onListenError)
        const message =
          err.code === 'EADDRINUSE' ? '本地回调端口被占用，无法完成登录' : err.message
        settleBrowserSession(
          err.code === 'EADDRINUSE'
            ? { ok: false, message, code: 'port_in_use' }
            : { ok: false, message: sanitizeGrokAuthError(err), code: 'callback_failed' }
        )
      }

      server.once('error', onListenError)
      server.listen(0, GROK_OAUTH_HOST, () => {
        server?.off('error', onListenError)
        const addr = server?.address()
        if (!addr || typeof addr === 'string') {
          settleBrowserSession({
            ok: false,
            code: 'callback_failed',
            message: '无法绑定本地回调端口'
          })
          return
        }
        activePort = addr.port
        const redirectUri = grokOAuthRedirect(activePort)
        if (pendingBrowserSession) {
          pendingBrowserSession.redirectUri = redirectUri
          pendingBrowserSession.server = server
        }
        const authorizeUrl = buildAuthorizeUrl(
          discovery.authorization_endpoint,
          pkce.challenge,
          state,
          nonce,
          redirectUri
        )
        void Promise.resolve(openBrowser(authorizeUrl)).catch((err: unknown) => {
          settleBrowserSession({
            ok: false,
            code: 'browser_open_failed',
            message: sanitizeGrokAuthError(err)
          })
        })
      })
    })
  } catch (error) {
    cancelGrokBrowserAuth()
    return { ok: false, code: 'callback_failed', message: sanitizeGrokAuthError(error) }
  }
}

/**
 * Path B: user pastes the authorization code (or callback URL) shown by
 * accounts.x.ai when loopback delivery is unavailable.
 */
export async function submitGrokBrowserAuthCode(pasted: string): Promise<GrokBrowserAuthResult> {
  const session = pendingBrowserSession
  if (!session || session.settled) {
    return { ok: false, message: '当前没有进行中的 Grok 登录，请重新点击登录' }
  }
  if (!session.redirectUri || !session.codeVerifier) {
    return { ok: false, message: '登录会话尚未就绪，请稍候再试' }
  }

  const parsed = parseGrokPastedAuthInput(pasted)
  if ('error' in parsed) {
    return { ok: false, message: `无效的授权码: ${parsed.error}` }
  }
  if (parsed.state && parsed.state !== session.state) {
    return { ok: false, message: '状态校验失败（可能的 CSRF），请重新登录' }
  }

  try {
    const credentials = await exchangeAuthorizationCode(session, parsed.code)
    settleBrowserSession({ ok: true, credentials })
    return { ok: true, credentials }
  } catch (error) {
    const message = sanitizeGrokAuthError(error)
    // Do not settle on paste exchange failure — user can retry paste or wait for loopback.
    return { ok: false, code: 'token_exchange_failed', message }
  }
}

export function cancelGrokBrowserAuth(): void {
  if (!pendingBrowserSession) return
  settleBrowserSession({ ok: false, code: 'cancelled', message: '已取消登录' })
}

export function isGrokBrowserAuthPending(): boolean {
  return Boolean(pendingBrowserSession && !pendingBrowserSession.settled)
}

export async function refreshGrokToken(
  credentials: GrokOAuthCredentials,
  transport: GrokAuthTransport = {}
): Promise<GrokOAuthCredentials | null> {
  try {
    const issuer = (credentials.issuer || GROK_OAUTH_ISSUER).replace(/\/$/, '')
    let tokenEndpoint = `${issuer}/oauth2/token`
    try {
      const discovery = await discoverOidc(issuer, transport)
      tokenEndpoint = discovery.token_endpoint
    } catch {
      /* fall back to /oauth2/token */
    }
    const tokens = await postForm(
      tokenEndpoint,
      {
        grant_type: 'refresh_token',
        refresh_token: credentials.refreshToken,
        client_id: credentials.clientId || GROK_OAUTH_CLIENT_ID
      },
      { 'x-grok-client-version': GROK_CLIENT_VERSION },
      transport
    )
    // Refresh responses sometimes omit refresh_token — keep the previous one.
    if (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token) {
      tokens.refresh_token = credentials.refreshToken
    }
    const next = credentialsFromTokens(tokens, issuer)
    if (!next) return null
    return {
      ...next,
      email: next.email ?? credentials.email,
      userId: next.userId ?? credentials.userId
    }
  } catch {
    return null
  }
}

/** True when access token is past the early-invalidation window (default 5 min). */
export function isGrokCredentialExpired(
  credentials: GrokOAuthCredentials,
  earlyInvalidationMs: number = GROK_EARLY_INVALIDATION_MS,
  nowMs: number = Date.now()
): boolean {
  const expiresAt =
    typeof credentials.expiresAt === 'number' && credentials.expiresAt > 0
      ? credentials.expiresAt
      : nowMs + GROK_TOKEN_TTL_FALLBACK_MS
  return nowMs >= expiresAt - earlyInvalidationMs
}

/**
 * Refresh when within the early-invalidation window. Returns updated encoded
 * credentials when refreshed; otherwise the original raw string.
 */
export async function ensureFreshGrokCredentials(
  rawApiKey: string,
  transport: GrokAuthTransport = {}
): Promise<{
  apiKey: string
  refreshed: boolean
  credentials: GrokOAuthCredentials | null
}> {
  const key = rawApiKey.trim()
  const credentials = parseGrokCredentials(key)
  if (!credentials) {
    return { apiKey: key, refreshed: false, credentials: null }
  }
  if (!isGrokCredentialExpired(credentials)) {
    return { apiKey: key, refreshed: false, credentials }
  }
  const next = await refreshGrokToken(credentials, transport)
  if (!next) {
    return { apiKey: key, refreshed: false, credentials }
  }
  return {
    apiKey: encodeGrokCredentials(next),
    refreshed: true,
    credentials: next
  }
}

export function isGrokOAuthCredentials(apiKey: string): boolean {
  if (!apiKey.startsWith('{')) return false
  try {
    return (JSON.parse(apiKey) as Record<string, unknown>).kind === 'grok-oauth'
  } catch {
    return false
  }
}

export function parseGrokCredentials(apiKey: string): GrokOAuthCredentials | null {
  if (!isGrokOAuthCredentials(apiKey)) return null
  const parsed = JSON.parse(apiKey) as GrokOAuthCredentials
  if (!parsed.accessToken || !parsed.refreshToken) return null
  return parsed
}

export function encodeGrokCredentials(creds: GrokOAuthCredentials): string {
  return JSON.stringify(creds)
}

export function grokRequestHeaders(): Record<string, string> {
  return grokCliProxyHeaders()
}

/**
 * Headers used by Grok Build when Imagine requests go directly to api.x.ai.
 * Proxy-only authentication headers must not be forwarded to this endpoint.
 */
export function grokMediaRequestHeaders(): Record<string, string> {
  return grokCliMediaHeaders()
}

/**
 * Unwrap JSON-encoded Grok (or pass-through plain) credentials for runtime
 * clients. Codex credentials are handled separately by resolveCodexOAuthApiKey.
 */
export function resolveGrokOAuthApiKey(rawApiKey: string): { apiKey: string; headers?: Record<string, string> } {
  const key = rawApiKey.trim()
  const grok = isGrokOAuthCredentials(key) ? parseGrokCredentials(key) : null
  if (grok) return { apiKey: grok.accessToken, headers: grokRequestHeaders() }
  return { apiKey: key }
}

export function resolveGrokMediaOAuthApiKey(rawApiKey: string): { apiKey: string; headers?: Record<string, string> } {
  const key = rawApiKey.trim()
  const grok = isGrokOAuthCredentials(key) ? parseGrokCredentials(key) : null
  if (grok) return { apiKey: grok.accessToken, headers: grokMediaRequestHeaders() }
  return { apiKey: key }
}
