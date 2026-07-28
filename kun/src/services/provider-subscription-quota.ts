import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ProviderQuotaMetric } from '../contracts/provider-quota.js'
import { GeminiCliOAuthSource } from '../adapters/model/gemini-cli-oauth.js'
import { parseStoredCodexOAuthCredentials } from './codex-oauth-credential-refresher.js'

const execFileAsync = promisify(execFile)
const QUOTA_TIMEOUT_MS = 12_000
const MAX_RESPONSE_BYTES = 256 * 1024

export type ProviderQuotaProbeProfile = {
  id: string
  name: string
  presetId?: string
  kind: 'http' | 'agent-sdk' | 'antigravity-cli' | 'cursor-sdk' | 'gemini-cli-api' | 'gemini-code-assist'
  baseUrl?: string
  apiKey: string
  headers?: Record<string, string>
}

export type SubscriptionQuotaProbeKind =
  | 'claude-subscription'
  | 'codex-subscription'
  | 'cursor-subscription'
  | 'antigravity-subscription'
  | 'gemini-cli-subscription'

export type ProviderQuotaFetch = (
  input: string | URL,
  init: RequestInit | undefined,
  proxyUrl: string
) => Promise<Response>

type ProbeContext = {
  fetcher: ProviderQuotaFetch
  proxyUrl: string
}

type CodexCredential = {
  accessToken: string
  accountId?: string
}

type CursorSession = {
  cookieHeader: string
}

type GoogleCredential = {
  accessToken: string
  accountEmail?: string
}

export type SubscriptionQuotaRuntime = {
  resolveClaudeToken(provider: ProviderQuotaProbeProfile): Promise<string | undefined>
  resolveCodexCredential(provider: ProviderQuotaProbeProfile): Promise<CodexCredential | undefined>
  resolveCursorSession(): Promise<CursorSession | undefined>
  resolveAntigravityCredential(context: ProbeContext): Promise<GoogleCredential | undefined>
  resolveGeminiCliToken(context: ProbeContext): Promise<string | undefined>
}

export class ProviderQuotaMissingCredentialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderQuotaMissingCredentialError'
  }
}

export async function runSubscriptionQuotaProbe(
  kind: SubscriptionQuotaProbeKind,
  provider: ProviderQuotaProbeProfile,
  context: ProbeContext,
  runtimeOverrides: Partial<SubscriptionQuotaRuntime> = {}
): Promise<{ metrics: ProviderQuotaMetric[]; summary?: string }> {
  const runtime = { ...defaultRuntime, ...runtimeOverrides }
  if (kind === 'claude-subscription') {
    const accessToken = await runtime.resolveClaudeToken(provider)
    if (!accessToken) {
      throw new ProviderQuotaMissingCredentialError(
        'Sign in with Claude Code or connect the Claude subscription first.'
      )
    }
    return {
      metrics: parseClaudeSubscriptionQuota(await requestJson(
        'https://api.anthropic.com/api/oauth/usage',
        {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${accessToken}`,
            'anthropic-beta': 'oauth-2025-04-20',
            'User-Agent': 'claude-code/2.1.0'
          }
        },
        context
      ))
    }
  }
  if (kind === 'codex-subscription') {
    const credential = await runtime.resolveCodexCredential(provider)
    if (!credential) {
      throw new ProviderQuotaMissingCredentialError(
        'Connect the ChatGPT subscription or sign in with Codex CLI first.'
      )
    }
    return parseCodexSubscriptionQuota(await requestJson(
      'https://chatgpt.com/backend-api/wham/usage',
      {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${credential.accessToken}`,
          'User-Agent': 'Kun',
          ...(credential.accountId ? { 'ChatGPT-Account-Id': credential.accountId } : {})
        }
      },
      context
    ))
  }
  if (kind === 'cursor-subscription') {
    const session = await runtime.resolveCursorSession()
    if (!session) {
      throw new ProviderQuotaMissingCredentialError(
        'Sign in to Cursor.app on this computer before refreshing quota.'
      )
    }
    return parseCursorSubscriptionQuota(await requestJson(
      'https://cursor.com/api/usage-summary',
      { headers: { Accept: 'application/json', Cookie: session.cookieHeader } },
      context
    ))
  }
  if (kind === 'antigravity-subscription') {
    const credential = await runtime.resolveAntigravityCredential(context)
    if (!credential) {
      throw new ProviderQuotaMissingCredentialError(
        'Sign in to the official Antigravity app before refreshing quota.'
      )
    }
    return probeGoogleCodeAssistQuota(credential, context)
  }
  const accessToken = await runtime.resolveGeminiCliToken(context)
  if (!accessToken) {
    throw new ProviderQuotaMissingCredentialError(
      'Run Gemini CLI and sign in with Google before refreshing quota.'
    )
  }
  return probeGoogleCodeAssistQuota({ accessToken }, context)
}

export function parseClaudeSubscriptionQuota(payload: unknown): ProviderQuotaMetric[] {
  const root = requireRecord(payload, 'Claude returned an invalid usage response.')
  const metrics: ProviderQuotaMetric[] = []
  const windows: Array<[string, string, unknown]> = [
    ['five-hour', '5-hour usage', root.five_hour],
    ['seven-day', '7-day usage', root.seven_day],
    ['seven-day-sonnet', '7-day Sonnet usage', root.seven_day_sonnet],
    ['seven-day-opus', '7-day Opus usage', root.seven_day_opus],
    ['seven-day-oauth-apps', '7-day OAuth apps usage', root.seven_day_oauth_apps]
  ]
  for (const [id, label, value] of windows) {
    const metric = percentageWindowMetric(id, label, value, 'utilization')
    if (metric) metrics.push(metric)
  }
  const limits = Array.isArray(root.limits) ? root.limits : []
  limits.forEach((value, index) => {
    const limit = optionalRecord(value)
    if (!limit || limit.is_active === false) return
    const model = optionalRecord(optionalRecord(limit.scope)?.model)
    const usedPercent = numberValue(limit.percent)
    if (usedPercent === undefined) return
    const resetsAt = isoDateValue(limit.resets_at)
    metrics.push({
      id: `limit-${index}`,
      label: stringValue(model?.display_name) ||
        stringValue(limit.kind) ||
        stringValue(limit.group) ||
        `Usage limit ${index + 1}`,
      unit: 'percent',
      usedPercent: clampPercentage(usedPercent),
      ...(resetsAt ? { resetsAt } : {})
    })
  })
  if (!metrics.length) throw new Error('Claude did not return a recognized usage window.')
  return metrics
}

export function parseCodexSubscriptionQuota(payload: unknown): {
  metrics: ProviderQuotaMetric[]
  summary?: string
} {
  const root = requireRecord(payload, 'Codex returned an invalid usage response.')
  const rateLimit = optionalRecord(root.rate_limit)
  const metrics: ProviderQuotaMetric[] = []
  const primary = codexWindowMetric('primary', 'Primary usage window', rateLimit?.primary_window)
  const secondary = codexWindowMetric('secondary', 'Weekly usage window', rateLimit?.secondary_window)
  if (primary) metrics.push(primary)
  if (secondary) metrics.push(secondary)
  const additional = Array.isArray(root.additional_rate_limits) ? root.additional_rate_limits : []
  additional.forEach((value, index) => {
    const item = optionalRecord(value)
    const windows = optionalRecord(item?.rate_limit)
    const label = stringValue(item?.limit_name) ||
      stringValue(item?.metered_feature) ||
      `Additional limit ${index + 1}`
    const first = codexWindowMetric(
      `additional-${index}-primary`,
      `${label} primary`,
      windows?.primary_window
    )
    const second = codexWindowMetric(
      `additional-${index}-secondary`,
      `${label} weekly`,
      windows?.secondary_window
    )
    if (first) metrics.push(first)
    if (second) metrics.push(second)
  })
  if (!metrics.length) throw new Error('Codex did not return a recognized rate-limit window.')
  const summary = stringValue(root.plan_type)
  return { metrics, ...(summary ? { summary } : {}) }
}

export function parseCursorSubscriptionQuota(payload: unknown): {
  metrics: ProviderQuotaMetric[]
  summary?: string
} {
  const root = requireRecord(payload, 'Cursor returned an invalid usage response.')
  const individual = optionalRecord(root.individualUsage)
  const team = optionalRecord(root.teamUsage)
  const plan = optionalRecord(individual?.plan)
  const overall = optionalRecord(individual?.overall)
  const pooled = optionalRecord(team?.pooled)
  const reset = isoDateValue(root.billingCycleEnd)
  const metrics: ProviderQuotaMetric[] = []
  const primary = firstUsageRecord(plan, overall, pooled)
  const primaryMetric = cursorMoneyMetric('included-plan', 'Included plan usage', primary, reset)
  if (primaryMetric) {
    const explicitPercent = numberValue(plan?.totalPercentUsed)
    metrics.push({
      ...primaryMetric,
      ...(explicitPercent === undefined ? {} : { usedPercent: clampPercentage(explicitPercent) })
    })
  }
  const autoPercent = numberValue(plan?.autoPercentUsed)
  if (autoPercent !== undefined) {
    metrics.push(percentageMetric('auto-composer', 'Auto + Composer usage', autoPercent, reset))
  }
  const apiPercent = numberValue(plan?.apiPercentUsed)
  if (apiPercent !== undefined) {
    metrics.push(percentageMetric('api-models', 'Named model usage', apiPercent, reset))
  }
  const onDemand = cursorMoneyMetric(
    'on-demand',
    'On-demand usage',
    optionalRecord(individual?.onDemand),
    reset
  )
  const teamOnDemand = cursorMoneyMetric(
    'team-on-demand',
    'Team on-demand usage',
    optionalRecord(team?.onDemand),
    reset
  )
  if (onDemand) metrics.push(onDemand)
  if (teamOnDemand) metrics.push(teamOnDemand)
  if (!metrics.length) throw new Error('Cursor did not return a recognized plan allowance.')
  const summary = stringValue(root.membershipType)
  return { metrics, ...(summary ? { summary } : {}) }
}

export function parseGoogleCodeAssistQuota(payload: unknown): ProviderQuotaMetric[] {
  const root = requireRecord(payload, 'Google Code Assist returned an invalid quota response.')
  const metrics: ProviderQuotaMetric[] = []
  if (Array.isArray(root.buckets)) {
    root.buckets.forEach((value, index) => {
      const bucket = optionalRecord(value)
      const remainingFraction = numberValue(bucket?.remainingFraction)
      if (!bucket || remainingFraction === undefined) return
      metrics.push(googleQuotaMetric(
        `bucket-${index}`,
        stringValue(bucket.modelId) || `Model ${index + 1}`,
        remainingFraction,
        bucket.resetTime
      ))
    })
  } else {
    const models = optionalRecord(root.models)
    Object.entries(models ?? {}).forEach(([modelId, value]) => {
      const model = optionalRecord(value)
      const quota = optionalRecord(model?.quotaInfo)
      const remainingFraction = numberValue(quota?.remainingFraction)
      if (remainingFraction === undefined) return
      metrics.push(googleQuotaMetric(
        `model-${modelId}`,
        stringValue(model?.displayName) || stringValue(model?.label) || modelId,
        remainingFraction,
        quota?.resetTime
      ))
    })
  }
  if (!metrics.length) throw new Error('Google Code Assist did not return a recognized model quota.')
  return metrics
}

const defaultRuntime: SubscriptionQuotaRuntime = {
  resolveClaudeToken,
  resolveCodexCredential,
  resolveCursorSession,
  resolveAntigravityCredential,
  async resolveGeminiCliToken(context) {
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit) =>
      context.fetcher(
        typeof input === 'string' || input instanceof URL ? input : input.url,
        init,
        context.proxyUrl
      )) as typeof fetch
    try {
      return await new GeminiCliOAuthSource({ fetchImpl }).accessToken()
    } catch {
      return undefined
    }
  }
}

async function probeGoogleCodeAssistQuota(
  credential: GoogleCredential,
  context: ProbeContext
): Promise<{ metrics: ProviderQuotaMetric[]; summary?: string }> {
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${credential.accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': 'antigravity'
  }
  const setup = requireRecord(await requestJson(
    'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        metadata: {
          ideType: 'ANTIGRAVITY',
          platform: 'PLATFORM_UNSPECIFIED',
          pluginType: 'GEMINI'
        }
      })
    },
    context
  ), 'Google Code Assist returned an invalid setup response.')
  const projectValue = setup.cloudaicompanionProject
  const project = typeof projectValue === 'string'
    ? projectValue.trim()
    : stringValue(optionalRecord(projectValue)?.id) ||
      stringValue(optionalRecord(projectValue)?.projectId)
  const body = JSON.stringify(project ? { project } : {})
  let quotaPayload: unknown
  try {
    quotaPayload = await requestJson(
      'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
      { method: 'POST', headers, body },
      context
    )
    return {
      metrics: parseGoogleCodeAssistQuota(quotaPayload),
      ...googleSetupSummary(setup, credential.accountEmail)
    }
  } catch {
    quotaPayload = await requestJson(
      'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
      { method: 'POST', headers, body },
      context
    )
  }
  return {
    metrics: parseGoogleCodeAssistQuota(quotaPayload),
    ...googleSetupSummary(setup, credential.accountEmail)
  }
}

async function resolveClaudeToken(
  provider: ProviderQuotaProbeProfile
): Promise<string | undefined> {
  if (validClaudeToken(provider.apiKey)) return provider.apiKey.trim()
  const file = await readJsonFile(join(homedir(), '.claude', '.credentials.json'))
  const fromFile = claudeAccessToken(file)
  if (fromFile) return fromFile
  if (process.platform !== 'darwin') return undefined
  try {
    const { stdout } = await execFileAsync('/usr/bin/security', [
      'find-generic-password',
      '-s',
      'Claude Code-credentials',
      '-w'
    ], {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 512 * 1024
    })
    return claudeAccessToken(JSON.parse(stdout.trim()) as unknown)
  } catch {
    return undefined
  }
}

async function resolveCodexCredential(
  provider: ProviderQuotaProbeProfile
): Promise<CodexCredential | undefined> {
  const stored = parseStoredCodexOAuthCredentials(provider.apiKey)
  if (stored) return { accessToken: stored.accessToken, accountId: stored.accountId }
  if (provider.apiKey.trim()) {
    return {
      accessToken: provider.apiKey.trim(),
      ...(headerValue(provider.headers, 'chatgpt-account-id')
        ? { accountId: headerValue(provider.headers, 'chatgpt-account-id') }
        : {})
    }
  }
  const ambient = optionalRecord(await readJsonFile(join(homedir(), '.codex', 'auth.json')))
  const tokens = optionalRecord(ambient?.tokens)
  const accessToken = stringValue(tokens?.access_token) || stringValue(tokens?.accessToken)
  if (!accessToken) return undefined
  const accountId = stringValue(tokens?.account_id) || stringValue(tokens?.accountId)
  return { accessToken, ...(accountId ? { accountId } : {}) }
}

async function resolveCursorSession(): Promise<CursorSession | undefined> {
  const dbPath = appStateDbPath('Cursor')
  if (!dbPath) return undefined
  const accessToken = await readSqliteValue(dbPath, 'cursorAuth/accessToken')
  if (!accessToken) return undefined
  const claims = jwtClaims(accessToken)
  const userId = stringValue(claims?.sub).split('|').filter(Boolean).at(-1) ?? ''
  const expiry = numberValue(claims?.exp)
  if (!/^[\w.-]+$/u.test(userId) || (expiry !== undefined && expiry * 1_000 <= Date.now() + 60_000)) {
    return undefined
  }
  return { cookieHeader: `WorkosCursorSessionToken=${userId}%3A%3A${accessToken}` }
}

async function resolveAntigravityCredential(
  context: ProbeContext
): Promise<GoogleCredential | undefined> {
  const dbPath = appStateDbPath('Antigravity')
  if (!dbPath) return undefined
  const [authStatusValue, unifiedTokenValue] = await Promise.all([
    readSqliteValue(dbPath, 'antigravityAuthStatus'),
    readSqliteValue(dbPath, 'antigravityUnifiedStateSync.oauthToken')
  ])
  if (!authStatusValue && !unifiedTokenValue) return undefined
  let accountEmail = ''
  let fallbackAccessToken = ''
  try {
    const record = requireRecord(JSON.parse(authStatusValue ?? ''), 'Invalid Antigravity login state.')
    fallbackAccessToken = stringValue(record.apiKey)
    accountEmail = stringValue(record.email)
  } catch {
    // The unified OAuth record may still be usable.
  }
  const tokenInfo = decodeAntigravityUnifiedOAuth(unifiedTokenValue)
  let accessToken = tokenInfo?.accessToken || fallbackAccessToken
  if (tokenInfo?.refreshToken) {
    const client = await discoverAntigravityOAuthClient()
    if (client) {
      accessToken = await refreshAntigravityAccessToken(
        tokenInfo.refreshToken,
        client,
        context
      ).catch(() => accessToken)
    }
  }
  return accessToken
    ? { accessToken, ...(accountEmail ? { accountEmail } : {}) }
    : undefined
}

export function decodeAntigravityUnifiedOAuth(value: string | undefined): {
  accessToken?: string
  refreshToken?: string
} | undefined {
  if (!value || !isBase64(value)) return undefined
  const outerFields = protobufLengthFields(Buffer.from(value, 'base64'))
  for (const entry of outerFields.filter((field) => field.number === 1)) {
    const entryFields = protobufLengthFields(entry.value)
    const key = entryFields.find((field) => field.number === 1)?.value.toString('utf8')
    if (key !== 'oauthTokenInfoSentinelKey') continue
    const wrapper = entryFields.find((field) => field.number === 2)?.value
    const encoded = wrapper
      ? protobufLengthFields(wrapper).find((field) => field.number === 1)?.value.toString('utf8')
      : undefined
    if (!encoded || !isBase64(encoded)) return undefined
    const tokenFields = protobufLengthFields(Buffer.from(encoded, 'base64'))
    const accessToken = tokenFields.find((field) => field.number === 1)?.value.toString('utf8').trim()
    const refreshToken = tokenFields.find((field) => field.number === 3)?.value.toString('utf8').trim()
    if (!accessToken && !refreshToken) return undefined
    return {
      ...(accessToken ? { accessToken } : {}),
      ...(refreshToken ? { refreshToken } : {})
    }
  }
  return undefined
}

async function discoverAntigravityOAuthClient(): Promise<{
  clientId: string
  clientSecret: string
} | undefined> {
  const candidates = process.platform === 'darwin'
    ? [
        join('/Applications', 'Antigravity IDE.app', 'Contents', 'Resources', 'app', 'out', 'main.js'),
        join(homedir(), 'Applications', 'Antigravity IDE.app', 'Contents', 'Resources', 'app', 'out', 'main.js')
      ]
    : []
  for (const path of candidates) {
    try {
      const content = await readFile(path, 'utf8')
      const marker = 'vs/platform/cloudCode/common/oauthClient.js'
      const start = Math.max(0, content.indexOf(marker))
      const scope = content.slice(start, start + 4_000)
      const clientId = scope.match(/[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com/u)?.[0]
      const clientSecret = scope.match(/GOCSPX-[A-Za-z0-9_-]{28}/u)?.[0]
      if (clientId && clientSecret) return { clientId, clientSecret }
    } catch {
      // Try the next fixed official-app artifact.
    }
  }
  return undefined
}

async function refreshAntigravityAccessToken(
  refreshToken: string,
  client: { clientId: string; clientSecret: string },
  context: ProbeContext
): Promise<string> {
  const response = await context.fetcher('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    }).toString(),
    signal: AbortSignal.timeout(QUOTA_TIMEOUT_MS)
  }, context.proxyUrl)
  if (!response.ok) throw new Error('Antigravity OAuth refresh was rejected.')
  const payload = optionalRecord(await response.json().catch(() => undefined))
  const accessToken = stringValue(payload?.access_token)
  if (!accessToken) throw new Error('Antigravity OAuth refresh returned no access token.')
  return accessToken
}

async function requestJson(
  url: string,
  input: {
    method?: string
    headers: Record<string, string>
    body?: string
  },
  context: ProbeContext
): Promise<unknown> {
  let response: Response
  try {
    response = await context.fetcher(url, {
      method: input.method ?? 'GET',
      headers: input.headers,
      ...(input.body === undefined ? {} : { body: input.body }),
      signal: AbortSignal.timeout(QUOTA_TIMEOUT_MS)
    }, context.proxyUrl)
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || /abort|timeout/iu.test(error.message))) {
      throw new Error('The subscription quota request timed out.')
    }
    throw new Error('The subscription quota request could not reach the provider.')
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('The provider did not authorize quota access for the existing login.')
    }
    throw new Error(`The provider quota endpoint returned HTTP ${response.status}.`)
  }
  const text = await boundedResponseText(response)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('The provider returned malformed quota data.')
  }
}

async function boundedResponseText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error('The provider quota response was too large.')
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let output = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error('The provider quota response was too large.')
      }
      output += decoder.decode(value, { stream: true })
    }
    return output + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

function codexWindowMetric(
  id: string,
  fallbackLabel: string,
  value: unknown
): ProviderQuotaMetric | null {
  const window = optionalRecord(value)
  const usedPercent = numberValue(window?.used_percent)
  if (usedPercent === undefined) return null
  const seconds = numberValue(window?.limit_window_seconds)
  const resetsAt = epochToIso(window?.reset_at)
  return {
    id,
    label: seconds === undefined ? fallbackLabel : `${formatWindowSeconds(seconds)} usage`,
    unit: 'percent',
    usedPercent: clampPercentage(usedPercent),
    ...(resetsAt ? { resetsAt } : {})
  }
}

function percentageWindowMetric(
  id: string,
  label: string,
  value: unknown,
  percentKey: string
): ProviderQuotaMetric | null {
  const window = optionalRecord(value)
  const usedPercent = numberValue(window?.[percentKey])
  if (usedPercent === undefined) return null
  const resetsAt = isoDateValue(window?.resets_at)
  return {
    id,
    label,
    unit: 'percent',
    usedPercent: clampPercentage(usedPercent),
    ...(resetsAt ? { resetsAt } : {})
  }
}

function cursorMoneyMetric(
  id: string,
  label: string,
  value: JsonRecord | undefined,
  resetsAt?: string
): ProviderQuotaMetric | null {
  if (!value || value.enabled === false) return null
  const usedCents = numberValue(value.used)
  const limitCents = numberValue(value.limit)
  const remainingCents = numberValue(value.remaining)
  if (usedCents === undefined && limitCents === undefined && remainingCents === undefined) return null
  const used = usedCents === undefined ? undefined : usedCents / 100
  const limit = limitCents === undefined ? undefined : limitCents / 100
  const remaining = remainingCents === undefined ? undefined : remainingCents / 100
  return {
    id,
    label,
    unit: 'USD',
    ...(used === undefined ? {} : { used }),
    ...(limit === undefined ? {} : { limit }),
    ...(remaining === undefined ? {} : { remaining }),
    ...percentageFields(used, limit),
    ...(resetsAt ? { resetsAt } : {})
  }
}

function percentageMetric(
  id: string,
  label: string,
  usedPercent: number,
  resetsAt?: string
): ProviderQuotaMetric {
  return {
    id,
    label,
    unit: 'percent',
    usedPercent: clampPercentage(usedPercent),
    ...(resetsAt ? { resetsAt } : {})
  }
}

function firstUsageRecord(...values: Array<JsonRecord | undefined>): JsonRecord | undefined {
  return values.find((value) => value && (
    numberValue(value.used) !== undefined ||
    numberValue(value.limit) !== undefined ||
    numberValue(value.remaining) !== undefined
  ))
}

function googleQuotaMetric(
  id: string,
  label: string,
  remainingFraction: number,
  resetTime: unknown
): ProviderQuotaMetric {
  const remainingPercent = clampPercentage(remainingFraction * 100)
  const resetsAt = isoDateValue(resetTime)
  return {
    id,
    label,
    unit: 'percent',
    usedPercent: 100 - remainingPercent,
    ...(resetsAt ? { resetsAt } : {})
  }
}

function googleSetupSummary(
  setup: JsonRecord,
  accountEmail?: string
): { summary?: string } {
  const tier = optionalRecord(setup.currentTier)
  const paidTier = optionalRecord(setup.paidTier)
  const plan = stringValue(tier?.name) ||
    stringValue(tier?.id) ||
    stringValue(paidTier?.name) ||
    stringValue(paidTier?.id)
  const parts = [plan, accountEmail].filter(Boolean)
  return parts.length ? { summary: parts.join(' · ') } : {}
}

function claudeAccessToken(value: unknown): string | undefined {
  const oauth = optionalRecord(optionalRecord(value)?.claudeAiOauth)
  const token = stringValue(oauth?.accessToken)
  return validClaudeToken(token) ? token : undefined
}

function validClaudeToken(value: string): boolean {
  return /^sk-ant-oat[\w-]+$/u.test(value.trim())
}

function appStateDbPath(app: 'Cursor' | 'Antigravity'): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', app, 'User', 'globalStorage', 'state.vscdb')
  }
  if (process.platform === 'linux') {
    return join(homedir(), '.config', app, 'User', 'globalStorage', 'state.vscdb')
  }
  return ''
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

async function readSqliteValue(dbPath: string, key: string): Promise<string | undefined> {
  const binary = process.platform === 'darwin' ? '/usr/bin/sqlite3' : 'sqlite3'
  try {
    const escapedKey = key.replaceAll("'", "''")
    const { stdout } = await execFileAsync(binary, [
      dbPath,
      `SELECT value FROM ItemTable WHERE key='${escapedKey}' LIMIT 1;`
    ], {
      encoding: 'utf8',
      timeout: 2_000,
      maxBuffer: 512 * 1024
    })
    return stdout.trim() || undefined
  } catch {
    return undefined
  }
}

function headerValue(headers: Record<string, string> | undefined, name: string): string {
  const match = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())
  return match?.[1]?.trim() ?? ''
}

function jwtClaims(token: string): JsonRecord | undefined {
  const payload = token.split('.')[1]
  if (!payload) return undefined
  try {
    return optionalRecord(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
  } catch {
    return undefined
  }
}

function protobufLengthFields(buffer: Buffer): Array<{ number: number; value: Buffer }> {
  const fields: Array<{ number: number; value: Buffer }> = []
  let offset = 0
  while (offset < buffer.length) {
    const tag = protobufVarint(buffer, offset)
    if (!tag) return []
    offset = tag.offset
    const number = Math.floor(tag.value / 8)
    const wireType = tag.value % 8
    if (number <= 0 || wireType !== 2) return []
    const length = protobufVarint(buffer, offset)
    if (!length) return []
    offset = length.offset
    const end = offset + length.value
    if (length.value < 0 || end > buffer.length) return []
    fields.push({ number, value: buffer.subarray(offset, end) })
    offset = end
  }
  return fields
}

function protobufVarint(
  buffer: Buffer,
  initialOffset: number
): { value: number; offset: number } | undefined {
  let value = 0
  let shift = 0
  let offset = initialOffset
  while (offset < buffer.length && shift <= 49) {
    const byte = buffer[offset]!
    offset += 1
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return { value, offset }
    shift += 7
  }
  return undefined
}

function isBase64(value: string): boolean {
  return value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/u.test(value)
}

function formatWindowSeconds(seconds: number): string {
  if (seconds % 604_800 === 0) return `${seconds / 604_800}-week`
  if (seconds % 86_400 === 0) return `${seconds / 86_400}-day`
  if (seconds % 3_600 === 0) return `${seconds / 3_600}-hour`
  return `${seconds}-second`
}

function percentageFields(
  used: number | undefined,
  limit: number | undefined
): { usedPercent?: number } {
  if (used === undefined || limit === undefined || limit <= 0) return {}
  return { usedPercent: clampPercentage((used / limit) * 100) }
}

function epochToIso(value: unknown): string | undefined {
  const numeric = numberValue(value)
  if (numeric === undefined || numeric <= 0) return undefined
  const date = new Date(numeric < 100_000_000_000 ? numeric * 1_000 : numeric)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function isoDateValue(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

type JsonRecord = Record<string, unknown>

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string' || !value.trim()) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function optionalRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : undefined
}

function requireRecord(value: unknown, message: string): JsonRecord {
  const record = optionalRecord(value)
  if (!record) throw new Error(message)
  return record
}

function clampPercentage(value: number): number {
  return Math.min(100, Math.max(0, value))
}
