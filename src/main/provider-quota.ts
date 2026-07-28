import {
  getModelProviderSettings,
  resolveModelProviderProxyUrl,
  type AppSettingsV1,
  type ModelProviderProfileV1
} from '../shared/app-settings'
import type {
  ProviderQuotaEntry,
  ProviderQuotaListResult,
  ProviderQuotaMetric
} from '../shared/provider-quota'
import { fetchWithOptionalProxy } from './proxy-fetch'
import {
  ProviderQuotaMissingCredentialError,
  runSubscriptionQuotaProbe,
  type SubscriptionQuotaProbeKind,
  type SubscriptionQuotaRuntime
} from './provider-subscription-quota'

const PROVIDER_QUOTA_TIMEOUT_MS = 12_000
const PROVIDER_QUOTA_MAX_RESPONSE_BYTES = 256 * 1024
const PROVIDER_QUOTA_CONCURRENCY = 4

type ProviderQuotaFetch = typeof fetchWithOptionalProxy
type ProviderQuotaProbeKind =
  | 'deepseek'
  | 'openrouter'
  | 'moonshot-cn'
  | 'moonshot-global'
  | 'zai'
  | 'bigmodel'
  | 'minimax-global'
  | 'minimax-cn'
  | 'kimi-code'
  | 'openai'
  | SubscriptionQuotaProbeKind

type ProviderQuotaProbe = {
  kind: ProviderQuotaProbeKind
  source: string
  dashboardUrl: string
}

type ProbeContext = {
  fetcher: ProviderQuotaFetch
  proxyUrl: string
  apiKey: string
}

type JsonRecord = Record<string, unknown>

class ProviderQuotaRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'ProviderQuotaRequestError'
  }
}

export async function listProviderQuotas(
  settings: AppSettingsV1,
  fetcher: ProviderQuotaFetch = fetchWithOptionalProxy,
  subscriptionRuntime: Partial<SubscriptionQuotaRuntime> = {}
): Promise<ProviderQuotaListResult> {
  const refreshedAt = new Date().toISOString()
  const providers = getModelProviderSettings(settings).providers
  const proxyUrl = resolveModelProviderProxyUrl(settings)
  const entries = await mapWithConcurrency(
    providers,
    PROVIDER_QUOTA_CONCURRENCY,
    async (provider) => refreshProviderQuota(provider, proxyUrl, fetcher, subscriptionRuntime)
  )
  return { entries, refreshedAt }
}

export function classifyProviderQuotaProbe(
  provider: ModelProviderProfileV1
): ProviderQuotaProbe | null {
  const presetId = provider.presetSource?.presetId
  const stableId = presetId || provider.id
  if (stableId === 'claude-subscription' && provider.kind === 'agent-sdk') {
    return {
      kind: 'claude-subscription',
      source: 'Claude OAuth usage API',
      dashboardUrl: 'https://claude.ai/settings/usage'
    }
  }
  if (stableId === 'codex' && isHttpQuotaPresetKind(provider.kind)) {
    return {
      kind: 'codex-subscription',
      source: 'ChatGPT Codex usage API',
      dashboardUrl: 'https://chatgpt.com/codex/settings/usage'
    }
  }
  if (stableId === 'grok-subscription' && isHttpQuotaPresetKind(provider.kind)) {
    return {
      kind: 'grok-subscription',
      source: 'Grok web billing API',
      dashboardUrl: 'https://grok.com/?_s=usage'
    }
  }
  if (stableId === 'cursor-subscription' && provider.kind === 'cursor-sdk') {
    return {
      kind: 'cursor-subscription',
      source: 'Cursor usage summary API',
      dashboardUrl: 'https://cursor.com/dashboard?tab=usage'
    }
  }
  if (stableId === 'gemini-subscription' && provider.kind === 'antigravity-cli') {
    return {
      kind: 'antigravity-subscription',
      source: 'Google Antigravity quota API',
      dashboardUrl: 'https://antigravity.google'
    }
  }
  if (stableId === 'gemini-cli-subscription' && provider.kind === 'gemini-cli-api') {
    return {
      kind: 'gemini-cli-subscription',
      source: 'Google Gemini CLI quota API',
      dashboardUrl: 'https://aistudio.google.com/usage'
    }
  }
  const hostname = exactHostname(provider.baseUrl)

  if (
    stableId === 'kimi-code' &&
    isHttpQuotaPresetKind(provider.kind) &&
    hostname === 'api.kimi.com'
  ) {
    return {
      kind: 'kimi-code',
      source: 'Kimi Code usage API',
      dashboardUrl: 'https://www.kimi.com/code/console'
    }
  }
  if (hostname === 'api.deepseek.com') {
    return {
      kind: 'deepseek',
      source: 'DeepSeek balance API',
      dashboardUrl: 'https://platform.deepseek.com/usage'
    }
  }
  if (
    hostname === 'api.moonshot.cn' ||
    hostname === 'api.moonshot.ai'
  ) {
    return {
      kind: hostname === 'api.moonshot.ai'
        ? 'moonshot-global'
        : 'moonshot-cn',
      source: 'Moonshot balance API',
      dashboardUrl: hostname === 'api.moonshot.ai'
        ? 'https://platform.moonshot.ai/'
        : 'https://platform.moonshot.cn/'
    }
  }
  if (
    hostname === 'api.z.ai' ||
    hostname === 'open.bigmodel.cn'
  ) {
    return {
      kind: hostname === 'open.bigmodel.cn'
        ? 'bigmodel'
        : 'zai',
      source: 'Z.ai Coding Plan quota API',
      dashboardUrl: hostname === 'open.bigmodel.cn'
        ? 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys'
        : 'https://z.ai/manage-apikey/apikey-list'
    }
  }
  if (
    hostname === 'api.minimax.io' ||
    hostname === 'api.minimaxi.com'
  ) {
    return {
      kind: hostname === 'api.minimaxi.com' ? 'minimax-cn' : 'minimax-global',
      source: 'MiniMax Coding Plan quota API',
      dashboardUrl: hostname === 'api.minimaxi.com'
        ? 'https://platform.minimaxi.com/'
        : 'https://platform.minimax.io/'
    }
  }
  if (hostname === 'openrouter.ai') {
    return {
      kind: 'openrouter',
      source: 'OpenRouter credits API',
      dashboardUrl: 'https://openrouter.ai/settings/credits'
    }
  }
  if (hostname === 'api.openai.com') {
    return {
      kind: 'openai',
      source: 'OpenAI credit grants API',
      dashboardUrl: 'https://platform.openai.com/settings/organization/billing/overview'
    }
  }
  return null
}

export function parseDeepSeekQuota(payload: unknown): ProviderQuotaMetric[] {
  const root = requireRecord(payload, 'DeepSeek returned an invalid quota response.')
  const balances = Array.isArray(root.balance_infos) ? root.balance_infos : []
  const balance = balances.find(isRecord)
  if (!balance) throw new Error('DeepSeek did not return account balance information.')
  const currency = stringValue(balance.currency) || 'CNY'
  const metrics: ProviderQuotaMetric[] = []
  pushRemainingMetric(metrics, 'balance', 'Account balance', currency, balance.total_balance)
  pushRemainingMetric(metrics, 'paid-balance', 'Paid balance', currency, balance.topped_up_balance)
  pushRemainingMetric(metrics, 'granted-balance', 'Granted balance', currency, balance.granted_balance)
  if (metrics.length === 0) throw new Error('DeepSeek did not return a numeric account balance.')
  return metrics
}

export function parseOpenRouterQuota(
  creditsPayload: unknown,
  keyPayload?: unknown
): ProviderQuotaMetric[] {
  const creditsRoot = requireRecord(creditsPayload, 'OpenRouter returned an invalid credits response.')
  const creditsData = requireRecord(creditsRoot.data, 'OpenRouter did not return credit information.')
  const totalCredits = numberValue(creditsData.total_credits)
  const totalUsage = numberValue(creditsData.total_usage)
  if (totalCredits === undefined && totalUsage === undefined) {
    throw new Error('OpenRouter did not return numeric credit information.')
  }
  const remaining = totalCredits === undefined || totalUsage === undefined
    ? undefined
    : Math.max(0, totalCredits - totalUsage)
  const metrics: ProviderQuotaMetric[] = [{
    id: 'credits',
    label: 'Credits',
    unit: 'USD',
    ...(totalUsage === undefined ? {} : { used: totalUsage }),
    ...(totalCredits === undefined ? {} : { limit: totalCredits }),
    ...(remaining === undefined ? {} : { remaining }),
    ...percentageFields(totalUsage, totalCredits)
  }]

  const keyRoot = optionalRecord(keyPayload)
  const keyData = optionalRecord(keyRoot?.data)
  const keyLimit = numberValue(keyData?.limit)
  const keyUsage = numberValue(keyData?.usage)
  if (keyLimit !== undefined || keyUsage !== undefined) {
    const keyRemaining = keyLimit === undefined || keyUsage === undefined
      ? undefined
      : Math.max(0, keyLimit - keyUsage)
    metrics.push({
      id: 'key-budget',
      label: 'API key budget',
      unit: 'USD',
      ...(keyUsage === undefined ? {} : { used: keyUsage }),
      ...(keyLimit === undefined ? {} : { limit: keyLimit }),
      ...(keyRemaining === undefined ? {} : { remaining: keyRemaining }),
      ...percentageFields(keyUsage, keyLimit)
    })
  }
  return metrics
}

export function parseMoonshotQuota(payload: unknown): ProviderQuotaMetric[] {
  const root = requireRecord(payload, 'Moonshot returned an invalid balance response.')
  if (numberValue(root.code) !== 0 || root.status !== true) {
    throw new Error('Moonshot rejected the balance request.')
  }
  const data = requireRecord(root.data, 'Moonshot did not return balance information.')
  const metrics: ProviderQuotaMetric[] = []
  pushRemainingMetric(metrics, 'available-balance', 'Available balance', 'USD', data.available_balance)
  pushRemainingMetric(metrics, 'cash-balance', 'Cash balance', 'USD', data.cash_balance)
  pushRemainingMetric(metrics, 'voucher-balance', 'Voucher balance', 'USD', data.voucher_balance)
  if (metrics.length === 0) throw new Error('Moonshot did not return a numeric account balance.')
  return metrics
}

export function parseZaiQuota(payload: unknown): {
  metrics: ProviderQuotaMetric[]
  summary?: string
} {
  const root = requireRecord(payload, 'Z.ai returned an invalid quota response.')
  if (numberValue(root.code) !== 200 || root.success !== true) {
    throw new Error('Z.ai rejected the quota request.')
  }
  const data = requireRecord(root.data, 'Z.ai did not return quota information.')
  const limits = Array.isArray(data.limits) ? data.limits : []
  const metrics = limits.flatMap((item, index) => {
    if (!isRecord(item)) return []
    const type = stringValue(item.type)
    if (type !== 'TOKENS_LIMIT' && type !== 'TIME_LIMIT') return []
    const limit = numberValue(item.usage)
    const explicitUsed = numberValue(item.currentValue)
    const remaining = numberValue(item.remaining)
    const usedFromRemaining = limit === undefined || remaining === undefined
      ? undefined
      : limit - remaining
    const rawUsed = explicitUsed === undefined
      ? usedFromRemaining
      : usedFromRemaining === undefined
        ? explicitUsed
        : Math.max(explicitUsed, usedFromRemaining)
    const used = rawUsed === undefined
      ? undefined
      : limit === undefined
        ? Math.max(0, rawUsed)
        : Math.max(0, Math.min(limit, rawUsed))
    const percentage = numberValue(item.percentage)
    const resetsAt = epochToIso(item.nextResetTime)
    const windowLabel = quotaWindowLabel(item.number, item.unit)
    return [{
      id: `${type.toLowerCase()}-${index}`,
      label: type === 'TOKENS_LIMIT'
        ? `${windowLabel ? `${windowLabel} ` : ''}token quota`
        : `${windowLabel ? `${windowLabel} ` : ''}request quota`,
      unit: type === 'TOKENS_LIMIT' ? 'tokens' : 'requests',
      ...(used === undefined ? {} : { used }),
      ...(limit === undefined ? {} : { limit }),
      ...(remaining === undefined ? {} : { remaining }),
      ...(percentage === undefined
        ? percentageFields(used, limit)
        : { usedPercent: clampPercentage(percentage) }),
      ...(resetsAt ? { resetsAt } : {})
    }]
  })
  if (metrics.length === 0) throw new Error('Z.ai did not return a recognized quota limit.')
  const summary = stringValue(data.planName) ||
    stringValue(data.plan) ||
    stringValue(data.plan_type) ||
    stringValue(data.packageName)
  return { metrics, ...(summary ? { summary } : {}) }
}

export function parseMiniMaxQuota(payload: unknown): {
  metrics: ProviderQuotaMetric[]
  summary?: string
} {
  const root = requireRecord(payload, 'MiniMax returned an invalid quota response.')
  const baseResponse = optionalRecord(root.base_resp) ?? optionalRecord(optionalRecord(root.data)?.base_resp)
  const statusCode = numberValue(baseResponse?.status_code)
  if (statusCode !== undefined && statusCode !== 0) {
    throw new Error('MiniMax rejected the quota request.')
  }
  const data = optionalRecord(root.data) ?? root
  const remains = Array.isArray(data.model_remains) ? data.model_remains : []
  const metrics = remains.flatMap((item, index) => parseMiniMaxModelMetrics(item, index))
  if (metrics.length === 0) throw new Error('MiniMax did not return a recognized coding-plan quota.')
  const comboCard = optionalRecord(data.current_combo_card)
  const summary = stringValue(data.current_subscribe_title) ||
    stringValue(data.plan_name) ||
    stringValue(data.combo_title) ||
    stringValue(data.current_plan_title) ||
    stringValue(comboCard?.title) ||
    stringValue(root.current_subscribe_title)
  return { metrics, ...(summary ? { summary } : {}) }
}

export function parseOpenAiQuota(payload: unknown): ProviderQuotaMetric[] {
  const root = requireRecord(payload, 'OpenAI returned an invalid credit response.')
  const limit = numberValue(root.total_granted)
  const used = numberValue(root.total_used)
  const remaining = numberValue(root.total_available)
  if (limit === undefined && used === undefined && remaining === undefined) {
    throw new Error('OpenAI did not return credit grant information.')
  }
  const grants = optionalRecord(root.grants)
  const grantItems = Array.isArray(grants?.data) ? grants.data : []
  const futureExpiries = grantItems
    .flatMap((item) => {
      if (!isRecord(item)) return []
      const seconds = numberValue(item.expires_at)
      return seconds !== undefined && seconds * 1000 > Date.now() ? [seconds * 1000] : []
    })
    .sort((a, b) => a - b)
  return [{
    id: 'credits',
    label: 'Credits',
    unit: 'USD',
    ...(used === undefined ? {} : { used }),
    ...(limit === undefined ? {} : { limit }),
    ...(remaining === undefined ? {} : { remaining }),
    ...percentageFields(used, limit),
    ...(futureExpiries[0] === undefined ? {} : { resetsAt: new Date(futureExpiries[0]).toISOString() })
  }]
}

export function parseKimiCodeQuota(payload: unknown): ProviderQuotaMetric[] {
  const root = requireRecord(payload, 'Kimi Code returned an invalid usage response.')
  const metrics: ProviderQuotaMetric[] = []
  const weekly = kimiUsageMetric('weekly', 'Weekly request quota', root.usage)
  if (weekly) metrics.push(weekly)

  const limits = Array.isArray(root.limits) ? root.limits : []
  for (const [index, value] of limits.entries()) {
    const limit = optionalRecord(value)
    const window = optionalRecord(limit?.window)
    const duration = numberValue(window?.duration)
    const unit = stringValue(window?.timeUnit).toLowerCase()
    const label = duration === 300 && unit.includes('minute')
      ? '5-hour rate limit'
      : `Rate limit ${index + 1}`
    const metric = kimiUsageMetric(`rate-limit-${index}`, label, limit?.detail)
    if (metric) metrics.push(metric)
  }

  if (metrics.length === 0) {
    throw new Error('Kimi Code did not return a recognized usage limit.')
  }
  return metrics
}

async function refreshProviderQuota(
  provider: ModelProviderProfileV1,
  proxyUrl: string,
  fetcher: ProviderQuotaFetch,
  subscriptionRuntime: Partial<SubscriptionQuotaRuntime>
): Promise<ProviderQuotaEntry> {
  const baseEntry = {
    providerId: provider.id,
    providerName: provider.name,
    ...(provider.presetSource?.presetId ? { presetId: provider.presetSource.presetId } : {})
  }
  const probe = classifyProviderQuotaProbe(provider)
  if (!probe) {
    return {
      ...baseEntry,
      status: 'unsupported',
      metrics: [],
      message: 'This provider does not expose a supported quota API in this version.'
    }
  }
  const apiKey = provider.apiKey.trim()
  if (!isSubscriptionQuotaProbe(probe.kind) && !apiKey) {
    return {
      ...baseEntry,
      status: 'missing_credentials',
      source: probe.source,
      dashboardUrl: probe.dashboardUrl,
      metrics: [],
      message: 'Add a provider credential in Settings before refreshing quota.'
    }
  }

  try {
    const result = await runProbe(
      probe.kind,
      provider,
      { fetcher, proxyUrl, apiKey },
      subscriptionRuntime
    )
    return {
      ...baseEntry,
      status: 'available',
      source: probe.source,
      dashboardUrl: probe.dashboardUrl,
      metrics: result.metrics,
      ...(result.summary ? { summary: result.summary } : {}),
      updatedAt: new Date().toISOString()
    }
  } catch (error) {
    if (error instanceof ProviderQuotaMissingCredentialError) {
      return {
        ...baseEntry,
        status: 'missing_credentials',
        source: probe.source,
        dashboardUrl: probe.dashboardUrl,
        metrics: [],
        message: error.message
      }
    }
    return {
      ...baseEntry,
      status: 'error',
      source: probe.source,
      dashboardUrl: probe.dashboardUrl,
      metrics: [],
      message: quotaErrorMessage(error),
      updatedAt: new Date().toISOString()
    }
  }
}

async function runProbe(
  kind: ProviderQuotaProbeKind,
  provider: ModelProviderProfileV1,
  context: ProbeContext,
  subscriptionRuntime: Partial<SubscriptionQuotaRuntime>
): Promise<{ metrics: ProviderQuotaMetric[]; summary?: string }> {
  if (isSubscriptionQuotaProbe(kind)) {
    return runSubscriptionQuotaProbe(kind, provider, context, subscriptionRuntime)
  }
  if (kind === 'deepseek') {
    return {
      metrics: parseDeepSeekQuota(
        await requestJson('https://api.deepseek.com/user/balance', context)
      )
    }
  }
  if (kind === 'openrouter') {
    const credits = await requestJson('https://openrouter.ai/api/v1/credits', context)
    let keyPayload: unknown
    try {
      keyPayload = await requestJson('https://openrouter.ai/api/v1/key', context)
    } catch {
      // Credits are useful on their own; key-budget permissions vary by credential.
    }
    return { metrics: parseOpenRouterQuota(credits, keyPayload) }
  }
  if (kind === 'moonshot-cn' || kind === 'moonshot-global') {
    return {
      metrics: parseMoonshotQuota(
        await requestJson(
          kind === 'moonshot-global'
            ? 'https://api.moonshot.ai/v1/users/me/balance'
            : 'https://api.moonshot.cn/v1/users/me/balance',
          context
        )
      )
    }
  }
  if (kind === 'zai' || kind === 'bigmodel') {
    return parseZaiQuota(
      await requestJson(
        kind === 'bigmodel'
          ? 'https://open.bigmodel.cn/api/monitor/usage/quota/limit'
          : 'https://api.z.ai/api/monitor/usage/quota/limit',
        context
      )
    )
  }
  if (kind === 'openai') {
    return {
      metrics: parseOpenAiQuota(
        await requestJson('https://api.openai.com/v1/dashboard/billing/credit_grants', context)
      )
    }
  }
  if (kind === 'kimi-code') {
    return {
      metrics: parseKimiCodeQuota(
        await requestJson('https://api.kimi.com/coding/v1/usages', context)
      )
    }
  }
  return probeMiniMax(kind, context)
}

function isSubscriptionQuotaProbe(
  kind: ProviderQuotaProbeKind
): kind is SubscriptionQuotaProbeKind {
  return kind === 'claude-subscription' ||
    kind === 'codex-subscription' ||
    kind === 'grok-subscription' ||
    kind === 'cursor-subscription' ||
    kind === 'antigravity-subscription' ||
    kind === 'gemini-cli-subscription'
}

async function probeMiniMax(
  kind: 'minimax-global' | 'minimax-cn',
  context: ProbeContext
): Promise<{ metrics: ProviderQuotaMetric[]; summary?: string }> {
  const hosts = kind === 'minimax-cn'
    ? ['https://api.minimaxi.com']
    : ['https://api.minimax.io', 'https://api.minimaxi.com']
  let lastError: unknown
  for (const host of hosts) {
    for (const path of ['/v1/token_plan/remains', '/v1/api/openplatform/coding_plan/remains']) {
      try {
        return parseMiniMaxQuota(await requestJson(`${host}${path}`, context))
      } catch (error) {
        lastError = error
      }
    }
  }
  throw lastError ?? new Error('MiniMax quota is unavailable.')
}

async function requestJson(url: string, context: ProbeContext): Promise<unknown> {
  let response: Response
  try {
    response = await context.fetcher(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${context.apiKey}`
      },
      signal: AbortSignal.timeout(PROVIDER_QUOTA_TIMEOUT_MS)
    }, context.proxyUrl)
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || /abort|timeout/i.test(error.message))) {
      throw new ProviderQuotaRequestError('The quota request timed out.')
    }
    throw new ProviderQuotaRequestError('The quota request could not reach the provider.')
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new ProviderQuotaRequestError(
        'The provider did not authorize quota access for this credential.',
        response.status
      )
    }
    throw new ProviderQuotaRequestError(
      `The provider quota endpoint returned HTTP ${response.status}.`,
      response.status
    )
  }
  const text = await readBoundedResponseText(response, PROVIDER_QUOTA_MAX_RESPONSE_BYTES)
  try {
    return JSON.parse(text)
  } catch {
    throw new ProviderQuotaRequestError('The provider returned malformed quota data.')
  }
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ProviderQuotaRequestError('The provider quota response was too large.')
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let totalBytes = 0
  let output = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel()
        throw new ProviderQuotaRequestError('The provider quota response was too large.')
      }
      output += decoder.decode(value, { stream: true })
    }
    output += decoder.decode()
    return output
  } finally {
    reader.releaseLock()
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (true) {
        const index = nextIndex
        nextIndex += 1
        if (index >= items.length) return
        results[index] = await mapper(items[index])
      }
    }
  )
  await Promise.all(workers)
  return results
}

function parseMiniMaxModelMetrics(item: unknown, index: number): ProviderQuotaMetric[] {
  if (!isRecord(item)) return []
  const model = stringValue(item.model_name) || `Model ${index + 1}`
  const metrics: ProviderQuotaMetric[] = []
  const intervalMetric = miniMaxWindowMetric({
    id: `interval-${index}`,
    label: `${model} interval quota`,
    total: item.current_interval_total_count,
    remaining: item.current_interval_usage_count,
    remainingPercent: item.current_interval_remaining_percent,
    status: item.current_interval_status,
    endTime: item.end_time
  })
  if (intervalMetric) metrics.push(intervalMetric)
  if (isMiniMaxTextModel(model)) {
    const weeklyMetric = miniMaxWindowMetric({
      id: `weekly-${index}`,
      label: `${model} weekly quota`,
      total: item.current_weekly_total_count ?? item.weekly_total_count,
      remaining: item.current_weekly_usage_count ?? item.weekly_usage_count,
      remainingPercent: item.current_weekly_remaining_percent ?? item.weekly_remaining_percent,
      status: item.current_weekly_status ?? item.weekly_status,
      endTime: item.weekly_end_time
    })
    if (weeklyMetric) metrics.push(weeklyMetric)
  }
  return metrics
}

function miniMaxWindowMetric(input: {
  id: string
  label: string
  total: unknown
  remaining: unknown
  remainingPercent: unknown
  status: unknown
  endTime: unknown
}): ProviderQuotaMetric | null {
  let limit = numberValue(input.total)
  let remaining = numberValue(input.remaining)
  const remainingPercent = numberValue(input.remainingPercent)
  if (limit === undefined && remaining === undefined && remainingPercent === undefined) return null
  if (
    numberValue(input.status) === 3 &&
    (limit ?? 0) === 0 &&
    (remaining ?? 0) === 0 &&
    (remainingPercent ?? 0) >= 100
  ) {
    return null
  }
  if (remainingPercent !== undefined && limit === 0 && remaining === 0) {
    limit = undefined
    remaining = undefined
  }
  const used = limit === undefined || remaining === undefined
    ? undefined
    : Math.max(0, limit - remaining)
  const resetsAt = epochToIso(input.endTime)
  return {
    id: input.id,
    label: input.label,
    unit: 'requests',
    ...(used === undefined ? {} : { used }),
    ...(limit === undefined ? {} : { limit }),
    ...(remaining === undefined ? {} : { remaining }),
    ...(remainingPercent === undefined
      ? percentageFields(used, limit)
      : { usedPercent: clampPercentage(100 - remainingPercent) }),
    ...(resetsAt ? { resetsAt } : {})
  }
}

function isMiniMaxTextModel(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  return normalized === 'general' ||
    normalized.includes('minimax-m') ||
    normalized.startsWith('m2.')
}

function percentageFields(
  used: number | undefined,
  limit: number | undefined
): { usedPercent?: number } {
  if (used === undefined || limit === undefined || limit <= 0) return {}
  return { usedPercent: clampPercentage((used / limit) * 100) }
}

function pushRemainingMetric(
  metrics: ProviderQuotaMetric[],
  id: string,
  label: string,
  unit: string,
  rawRemaining: unknown
): void {
  const remaining = numberValue(rawRemaining)
  if (remaining === undefined) return
  metrics.push({ id, label, unit, remaining })
}

function isHttpQuotaPresetKind(
  kind: ModelProviderProfileV1['kind']
): boolean {
  return kind === undefined || kind === 'http'
}

function kimiUsageMetric(
  id: string,
  label: string,
  value: unknown
): ProviderQuotaMetric | null {
  const detail = optionalRecord(value)
  if (!detail) return null
  const limit = numberValue(detail.limit)
  const remaining = numberValue(detail.remaining)
  const explicitUsed = numberValue(detail.used)
  const used = explicitUsed ?? (
    limit === undefined || remaining === undefined
      ? undefined
      : Math.max(0, limit - remaining)
  )
  if (limit === undefined && remaining === undefined && used === undefined) return null
  const resetsAt = isoDateValue(
    detail.resetTime ??
    detail.resetAt ??
    detail.reset_time ??
    detail.reset_at
  )
  return {
    id,
    label,
    unit: 'requests',
    ...(used === undefined ? {} : { used }),
    ...(limit === undefined ? {} : { limit }),
    ...(remaining === undefined ? {} : { remaining }),
    ...percentageFields(used, limit),
    ...(resetsAt ? { resetsAt } : {})
  }
}

function quotaWindowLabel(number: unknown, unit: unknown): string {
  const numeric = numberValue(number)
  const numericUnit = numberValue(unit)
  const textUnit = stringValue(unit) || (
    numericUnit === 1
      ? 'day'
      : numericUnit === 3
        ? 'hour'
        : numericUnit === 5
          ? 'minute'
          : numericUnit === 6
            ? 'week'
            : ''
  )
  if (numeric === undefined || !textUnit) return ''
  return `${numeric}-${textUnit.toLowerCase()}`
}

function epochToIso(value: unknown): string | undefined {
  const numeric = numberValue(value)
  if (numeric === undefined || numeric <= 0) return undefined
  const milliseconds = numeric < 100_000_000_000 ? numeric * 1000 : numeric
  const date = new Date(milliseconds)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function isoDateValue(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const normalized = value.trim().replace(
    /(\.\d{3})\d+(Z|[+-]\d{2}:\d{2})$/,
    '$1$2'
  )
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function exactHostname(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string' || !value.trim()) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalRecord(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined
}

function requireRecord(value: unknown, message: string): JsonRecord {
  if (!isRecord(value)) throw new Error(message)
  return value
}

function clampPercentage(value: number): number {
  return Math.min(100, Math.max(0, value))
}

function quotaErrorMessage(error: unknown): string {
  if (error instanceof ProviderQuotaRequestError) return error.message
  if (error instanceof Error && error.message) return error.message
  return 'The provider quota request failed.'
}
