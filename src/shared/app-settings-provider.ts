import {
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_IMAGE_GENERATION_PROTOCOL,
  DEFAULT_MUSIC_GENERATION_PROTOCOL,
  DEFAULT_MODEL_ENDPOINT_FORMAT,
  DEFAULT_MODEL_PROVIDER_ID,
  DEFAULT_MODEL_REQUEST_RETRY_HTTP_STATUS_CODES,
  DEFAULT_MODEL_REQUEST_RETRY_INITIAL_DELAY_MS,
  DEFAULT_MODEL_REQUEST_RETRY_MAX_ATTEMPTS,
  NETWORK_PROXY_PROTOCOLS,
  DEFAULT_SPEECH_TO_TEXT_PROTOCOL,
  DEFAULT_TEXT_TO_SPEECH_PROTOCOL,
  DEFAULT_VIDEO_GENERATION_PROTOCOL,
  MODEL_REASONING_EFFORTS,
  MODEL_REASONING_REQUEST_PROTOCOLS,
  MODEL_ROUTE_STRATEGIES,
  CUSTOM_IMAGE_GENERATION_PROVIDER_ID,
  CUSTOM_SPEECH_TO_TEXT_PROVIDER_ID,
  CUSTOM_TEXT_TO_SPEECH_PROVIDER_ID,
  CUSTOM_MUSIC_GENERATION_PROVIDER_ID,
  CUSTOM_VIDEO_GENERATION_PROVIDER_ID,
  type AppSettingsV1,
  type ImageGenerationProtocol,
  type KunImageGenerationSettingsV1,
  type KunMusicGenerationSettingsV1,
  type KunRuntimeSettingsV1,
  type KunRuntimeSettingsPatchV1,
  type KunSpeechToTextSettingsV1,
  type KunTextToSpeechSettingsV1,
  type KunVideoGenerationSettingsV1,
  type MusicGenerationProtocol,
  type ModelProviderImageCapabilityPatchV1,
  type ModelProviderImageCapabilityV1,
  type ModelProviderInputModality,
  type ModelProviderMessagePartSupport,
  type ModelProviderModelProfilePatchV1,
  type ModelProviderModelProfileV1,
  type ModelProviderMusicCapabilityPatchV1,
  type ModelProviderMusicCapabilityV1,
  type ModelProviderReasoningCapabilityV1,
  type ModelProviderProfilePatchV1,
  type ModelProviderProfileV1,
  type ModelProviderPresetSourceV1,
  type ModelRequestRetrySettingsV1,
  type ModelRouteFailurePolicyV1,
  type ModelRouteHealthPolicyV1,
  type ModelRoutePoolV1,
  type ModelRouteTargetResolutionV1,
  type ModelRouteTargetV1,
  type ModelRouteStrategy,
  type ModelProviderSettingsPatchV1,
  type ModelProviderSettingsV1,
  type NetworkProxySettingsV1,
  type ModelProviderSpeechCapabilityPatchV1,
  type ModelProviderSpeechCapabilityV1,
  type ModelProviderTextToSpeechCapabilityPatchV1,
  type ModelProviderTextToSpeechCapabilityV1,
  type ModelProviderVideoCapabilityPatchV1,
  type ModelProviderVideoCapabilityV1,
  type SpeechToTextProtocol,
  type TextToSpeechProtocol,
  type VideoGenerationProtocol
} from './app-settings-types'
import { normalizeModelEndpointFormat, type ModelEndpointFormat } from '../../kun/src/contracts/model-endpoint-format.js'
import { getKunRuntimeSettings } from './app-settings-kun'
import { normalizeDeepseekBaseUrl } from './app-settings-normalizers'
import { DEFAULT_COMPOSER_MODEL_IDS } from './default-composer-models'
import {
  CHATGPT_SUBSCRIPTION_LEGACY_MODEL_IDS,
  CHATGPT_SUBSCRIPTION_LEGACY_NAME,
  CHATGPT_SUBSCRIPTION_MODEL_IDS,
  CHATGPT_SUBSCRIPTION_NAME,
  CHATGPT_SUBSCRIPTION_PROVIDER_ID,
  GEMINI_SUBSCRIPTION_MODEL_IDS,
  TOKEN_PLAN_PROVIDER_ID_SUFFIX,
  getModelProviderPreset,
  modelProviderPresetProfile,
  modelProviderTokenPlanProfile,
  resolveModelProviderPresetSource,
  type ModelProviderPreset
} from './model-provider-presets'

const DEFAULT_MODEL_PROVIDER_NAME = 'DeepSeek'
const DEFAULT_PROVIDER_CONTEXT_WINDOW_TOKENS = 256_000
const DEFAULT_TEXT_MODEL_PROFILE: ModelProviderModelProfileV1 = {
  inputModalities: ['text'],
  outputModalities: ['text'],
  supportsToolCalling: true,
  messageParts: ['text']
}
const SPEECH_TO_TEXT_MODEL_PATTERN =
  /(^|[/_.:-])(asr|stt|whisper|transcription|transcriptions)([/_.:-]|$)|speech[-_.:/]?to[-_.:/]?text|audio[-_.:/]?transcription/i
const TEXT_TO_SPEECH_MODEL_PATTERN =
  /(^|[/_.:-])tts([/_.:-]|$)|(^|[/_.:-])speech[-_.:/]?\d|text[-_.:/]?to[-_.:/]?speech|speech[-_.:/]?synthesis|voiceclone|voicedesign/i
const SPEECH_ONLY_MODEL_PATTERN =
  /(^|[/_.:-])(asr|stt|tts|whisper|transcription|transcriptions|speech)([/_.:-]|$)|voiceclone|voicedesign/i
const IMAGE_GENERATION_MODEL_PATTERN =
  /(^|[/_.:-])(image|images|dall-e|dalle|flux|sdxl|cogview|wanx|kolors|imagen|seedream|seededit|t2i|i2i)([/_.:-]|$)|stable[-_.:/]?diffusion|text[-_.:/]?to[-_.:/]?image/i
const MUSIC_GENERATION_MODEL_PATTERN =
  /(^|[/_.:-])(music|song|cover)([/_.:-]|$)|text[-_.:/]?to[-_.:/]?music|music[-_.:/]?generation/i
const VIDEO_GENERATION_MODEL_PATTERN =
  /(^|[/_.:-])(video|videos|hailuo|sora|veo|kling|seedance|t2v|i2v|s2v)([/_.:-]|$)|text[-_.:/]?to[-_.:/]?video|image[-_.:/]?to[-_.:/]?video/i
const NON_TEXT_MODEL_PATTERN =
  /(^|[/_.:-])(embedding|embeddings|embed|bge|rerank|reranker|moderation|ocr|image|images|video|videos|music|song|audio|dall-e|dalle|flux|sdxl|cogview|cogvideo|wanx|kolors|imagen|seedream|seededit|seedance|sora|veo|kling|hailuo|t2i|i2i|t2v|i2v|s2v)([/_.:-]|$)|stable[-_.:/]?diffusion|text[-_.:/]?to[-_.:/]?image|text[-_.:/]?to[-_.:/]?video|image[-_.:/]?to[-_.:/]?video|text[-_.:/]?to[-_.:/]?music|music[-_.:/]?generation/i

export function defaultModelProviderSettings(): ModelProviderSettingsV1 {
  const defaultProvider = defaultModelProviderProfile('', DEFAULT_DEEPSEEK_BASE_URL)
  return {
    apiKey: defaultProvider.apiKey,
    baseUrl: defaultProvider.baseUrl,
    proxy: defaultNetworkProxySettings(),
    providers: [defaultProvider],
    routePools: [],
    localGateway: { enabled: false, name: 'Kun API' }
  }
}

export function normalizeModelProviderSettings(
  input: ModelProviderSettingsPatchV1 | undefined
): ModelProviderSettingsV1 {
  const defaults = defaultModelProviderSettings()
  const apiKey = typeof input?.apiKey === 'string' ? input.apiKey.trim() : defaults.apiKey
  const baseUrl = normalizeModelProviderBaseUrl(input?.baseUrl, defaults.baseUrl)
  const rawProviders = Array.isArray(input?.providers) ? input.providers : []
  const providersById = new Map<string, ModelProviderProfileV1>()
  const defaultProvider = defaultModelProviderProfile(apiKey, baseUrl)
  providersById.set(defaultProvider.id, defaultProvider)
  for (const rawProvider of rawProviders) {
    const provider = normalizeModelProviderProfile(rawProvider)
    if (!provider) continue
    providersById.set(provider.id, provider.id === DEFAULT_MODEL_PROVIDER_ID
      ? {
          ...defaultProvider,
          ...provider,
          apiKey,
          baseUrl,
          modelProfiles: {
            ...defaultProvider.modelProfiles,
            ...provider.modelProfiles
          }
        }
      : provider)
  }
  const providers = [...providersById.values()]
  const routePools = normalizeModelRoutePools(input?.routePools, providers)
  return {
    apiKey,
    baseUrl,
    proxy: normalizeNetworkProxySettings(input?.proxy),
    providers,
    routePools,
    localGateway: {
      enabled: input?.localGateway?.enabled === true,
      name: typeof input?.localGateway?.name === 'string' && input.localGateway.name.trim()
        ? input.localGateway.name.trim().slice(0, 80)
        : defaults.localGateway.name
    }
  }
}

export function mergeModelProviderSettings(
  current: ModelProviderSettingsV1,
  patch: ModelProviderSettingsPatchV1 | undefined
): ModelProviderSettingsV1 {
  return normalizeModelProviderSettings({
    ...current,
    ...(patch ?? {}),
    proxy: patch?.proxy
      ? {
          ...current.proxy,
          ...patch.proxy
        }
      : current.proxy,
    routePools: patch?.routePools ?? current.routePools,
    localGateway: patch?.localGateway
      ? { ...current.localGateway, ...patch.localGateway }
      : current.localGateway
  })
}

export const DEFAULT_MODEL_ROUTE_FAILURE_POLICY: ModelRouteFailurePolicyV1 = {
  failoverHttpStatusCodes: [401, 402, 403, 404, 408, 425, 429, 500, 502, 503, 504],
  failoverOnNetworkError: true,
  failoverOnTimeout: true,
  failoverOnAuthError: true
}

export const DEFAULT_MODEL_ROUTE_HEALTH_POLICY: ModelRouteHealthPolicyV1 = {
  failureThreshold: 3,
  cooldownMs: 60_000,
  halfOpenMaxAttempts: 1
}

export function normalizeModelRoutePools(
  input: readonly Partial<ModelRoutePoolV1>[] | undefined,
  _providers?: readonly ModelProviderProfileV1[]
): ModelRoutePoolV1[] {
  const usedIds = new Set<string>()
  const usedModels = new Set<string>()
  const out: ModelRoutePoolV1[] = []
  for (const raw of Array.isArray(input) ? input.slice(0, 100) : []) {
    const id = normalizeModelProviderId(raw.id)
    const modelId = typeof raw.modelId === 'string' ? raw.modelId.trim().slice(0, 512) : ''
    if (!id || !modelId || usedIds.has(id) || usedModels.has(modelId.toLowerCase())) continue
    const targetIds = new Set<string>()
    const targets = (Array.isArray(raw.targets) ? raw.targets : []).slice(0, 50).flatMap((target: ModelRoutePoolV1['targets'][number], index: number) => {
      const providerId = normalizeModelProviderId(target?.providerId)
      const targetModel = typeof target?.modelId === 'string' ? target.modelId.trim().slice(0, 512) : ''
      if (!providerId || !targetModel) return []
      const targetId = normalizeModelProviderId(target?.id) || `${id}-target-${index + 1}`
      if (targetIds.has(targetId)) return []
      targetIds.add(targetId)
      return [{
        id: targetId,
        providerId,
        modelId: targetModel,
        enabled: target?.enabled !== false,
        weight: Math.min(100, Math.max(1, boundedNonNegativeInteger(target?.weight, 1, 100)))
      }]
    })
    const strategy: ModelRouteStrategy = MODEL_ROUTE_STRATEGIES.includes(raw.strategy as ModelRouteStrategy)
      ? raw.strategy as ModelRouteStrategy
      : 'priority'
    const failureCodes = normalizeRetryHttpStatusCodes(
      raw.failurePolicy?.failoverHttpStatusCodes,
      DEFAULT_MODEL_ROUTE_FAILURE_POLICY.failoverHttpStatusCodes
    )
    const pool: ModelRoutePoolV1 = {
      id,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : modelId,
      modelId,
      // A public route alias may intentionally match a concrete model id
      // (for example, a routed `kimi-k3` backed by several providers). Kun
      // disambiguates the virtual route from a direct provider selection with
      // the request's provider id, so only duplicate route aliases are invalid.
      enabled: raw.enabled !== false,
      strategy,
      targets,
      failurePolicy: {
        failoverHttpStatusCodes: failureCodes,
        failoverOnNetworkError: raw.failurePolicy?.failoverOnNetworkError !== false,
        failoverOnTimeout: raw.failurePolicy?.failoverOnTimeout !== false,
        failoverOnAuthError: raw.failurePolicy?.failoverOnAuthError !== false
      },
      healthPolicy: {
        failureThreshold: Math.min(20, Math.max(1, boundedNonNegativeInteger(raw.healthPolicy?.failureThreshold, 3, 20))),
        cooldownMs: Math.min(3_600_000, Math.max(1_000, boundedNonNegativeInteger(raw.healthPolicy?.cooldownMs, 60_000, 3_600_000))),
        halfOpenMaxAttempts: Math.min(10, Math.max(1, boundedNonNegativeInteger(raw.healthPolicy?.halfOpenMaxAttempts, 1, 10)))
      }
    }
    usedIds.add(id)
    usedModels.add(modelId.toLowerCase())
    out.push(pool)
  }
  return out
}

export function resolveModelRouteTargetReference(
  target: Pick<ModelRouteTargetV1, 'providerId' | 'modelId'>,
  providers: readonly ModelProviderProfileV1[]
): ModelRouteTargetResolutionV1 {
  const providerId = normalizeModelProviderId(target.providerId)
  const provider = providers.find((candidate) => candidate.id.toLowerCase() === providerId)
  if (!provider) return { status: 'provider-missing' }
  const requestedModel = target.modelId.trim().toLowerCase()
  const modelId = provider.models.find((candidate) => candidate.trim().toLowerCase() === requestedModel)
  if (!modelId) return { status: 'model-missing', provider }
  return { status: 'valid', provider, modelId }
}

/**
 * Projects durable user intent into the concrete configuration Kun may run.
 * Missing references remain in settings but never reach the Runtime.
 */
export function projectExecutableModelRoutePools(
  settings: Pick<ModelProviderSettingsV1, 'providers' | 'routePools'>
): ModelRoutePoolV1[] {
  return settings.routePools.map((pool) => {
    const targets = pool.targets.flatMap((target) => {
      const resolved = resolveModelRouteTargetReference(target, settings.providers)
      if (resolved.status !== 'valid' || !resolved.provider || !resolved.modelId) return []
      return [{
        ...target,
        providerId: resolved.provider.id,
        modelId: resolved.modelId
      }]
    })
    return {
      ...pool,
      enabled: pool.enabled && targets.some((target) => target.enabled),
      targets
    }
  })
}

export function getModelProviderSettings(settings: AppSettingsV1): ModelProviderSettingsV1 {
  return normalizeModelProviderSettings((settings as { provider?: ModelProviderSettingsPatchV1 }).provider)
}

export function modelProviderSettingsPatch(
  provider: ModelProviderSettingsPatchV1 | undefined
): ModelProviderSettingsPatchV1 {
  return provider ? { ...provider } : {}
}

export function resolveModelProviderApiKey(settings: AppSettingsV1): string {
  return getDefaultModelProviderProfile(settings).apiKey.trim()
}

export function resolveModelProviderBaseUrl(settings: AppSettingsV1): string {
  return normalizeDeepseekBaseUrl(getDefaultModelProviderProfile(settings).baseUrl)
}

export function resolveModelProviderProxyUrl(settings: AppSettingsV1): string {
  const proxy = getModelProviderSettings(settings).proxy
  if (!proxy.enabled) return ''
  // Validation happens here, at the apply boundary — not while the user types
  // (see `normalizeNetworkProxySettings`). An invalid/incomplete URL simply
  // means "no proxy" for outbound requests instead of wiping the saved value.
  return normalizeProxyUrl(proxy.url)
}

export function getDefaultModelProviderProfile(settings: AppSettingsV1): ModelProviderProfileV1 {
  return getModelProviderProfile(settings, DEFAULT_MODEL_PROVIDER_ID)
}

export function getModelProviderProfile(
  settings: AppSettingsV1,
  providerId: string | undefined
): ModelProviderProfileV1 {
  const provider = getModelProviderSettings(settings)
  const id = normalizeModelProviderId(providerId || DEFAULT_MODEL_PROVIDER_ID)
  return provider.providers.find((profile) => profile.id === id) ?? provider.providers[0] ?? defaultModelProviderProfile(provider.apiKey, provider.baseUrl)
}

export function modelProviderRequiresApiKey(
  provider: Pick<ModelProviderProfileV1, 'id' | 'kind' | 'presetSource'>
): boolean {
  if (
    provider.kind === 'agent-sdk' ||
    provider.kind === 'antigravity-cli' ||
    provider.kind === 'gemini-cli-api' ||
    provider.kind === 'gemini-code-assist'
  ) {
    return false
  }

  const source = resolveModelProviderPresetSource(provider)
  if (source?.preset.id === 'litellm') return false
  if (provider.id === DEFAULT_MODEL_PROVIDER_ID) return true
  return Boolean(source)
}

export function activeModelProviderNeedsApiKey(settings: AppSettingsV1): boolean {
  const runtime = getKunRuntimeSettings(settings)
  const provider = getModelProviderProfile(settings, runtime.providerId)
  return modelProviderRequiresApiKey(provider) && !resolveKunRuntimeSettings(settings).apiKey.trim()
}

export function listModelProviderModelIds(settings: AppSettingsV1): string[] {
  const ids = new Set<string>()
  const providerSettings = getModelProviderSettings(settings)
  for (const provider of providerSettings.providers) {
    for (const model of provider.models) {
      const trimmed = model.trim()
      if (!trimmed || !isProviderComposerChatModelId(provider, trimmed)) continue
      ids.add(trimmed)
    }
  }
  for (const pool of projectExecutableModelRoutePools(providerSettings)) {
    if (pool.enabled && pool.targets.some((target) => target.enabled)) ids.add(pool.modelId)
  }
  return [...ids].sort((a, b) => a.localeCompare(b))
}

/**
 * Media model IDs apply only to the provider that declares them. Different
 * providers can expose the same model ID with different capabilities.
 */
export function listProviderNonTextModelIds(
  provider: Pick<ModelProviderProfileV1, 'image' | 'speech' | 'textToSpeech' | 'music' | 'video'>
): string[] {
  return [...new Set([
    ...(provider.speech?.models ?? []),
    ...(provider.image?.models ?? []),
    ...(provider.textToSpeech?.models ?? []),
    ...(provider.music?.models ?? []),
    ...(provider.video?.models ?? [])
  ])]
    .map((model) => model.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
}

export function listSpeechToTextModelIds(settings: AppSettingsV1): string[] {
  const ids = new Set<string>()
  for (const provider of getModelProviderSettings(settings).providers) {
    for (const model of provider.speech?.models ?? []) {
      const trimmed = model.trim()
      if (trimmed) ids.add(trimmed)
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b))
}

export function listImageGenerationModelIds(settings: AppSettingsV1): string[] {
  const ids = new Set<string>()
  for (const provider of getModelProviderSettings(settings).providers) {
    for (const model of provider.image?.models ?? []) {
      const trimmed = model.trim()
      if (trimmed) ids.add(trimmed)
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b))
}

export function listTextToSpeechModelIds(settings: AppSettingsV1): string[] {
  const ids = new Set<string>()
  for (const provider of getModelProviderSettings(settings).providers) {
    for (const model of provider.textToSpeech?.models ?? []) {
      const trimmed = model.trim()
      if (trimmed) ids.add(trimmed)
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b))
}

export function listMusicGenerationModelIds(settings: AppSettingsV1): string[] {
  const ids = new Set<string>()
  for (const provider of getModelProviderSettings(settings).providers) {
    for (const model of provider.music?.models ?? []) {
      const trimmed = model.trim()
      if (trimmed) ids.add(trimmed)
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b))
}

export function listVideoGenerationModelIds(settings: AppSettingsV1): string[] {
  const ids = new Set<string>()
  for (const provider of getModelProviderSettings(settings).providers) {
    for (const model of provider.video?.models ?? []) {
      const trimmed = model.trim()
      if (trimmed) ids.add(trimmed)
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b))
}

export function listNonTextModelIds(settings: AppSettingsV1): string[] {
  return [...new Set(
    getModelProviderSettings(settings).providers.flatMap((provider) => listProviderNonTextModelIds(provider))
  )].sort((a, b) => a.localeCompare(b))
}

export function isComposerChatModelId(
  modelId: string,
  nonTextModelIds: readonly string[] = []
): boolean {
  const normalized = modelId.trim().toLowerCase()
  if (!normalized || normalized === 'auto') return false
  const excludedIds = new Set(nonTextModelIds.map((id) => id.trim().toLowerCase()).filter(Boolean))
  if (excludedIds.has(normalized)) return false
  return !SPEECH_ONLY_MODEL_PATTERN.test(normalized) && !NON_TEXT_MODEL_PATTERN.test(normalized)
}

export function isProviderComposerChatModelId(
  provider: ModelProviderProfileV1,
  modelId: string
): boolean {
  const profile = modelProviderModelProfile(provider, modelId)
  if (profile && !modelProfileSupportsTextChat(profile)) return false
  return isComposerChatModelId(
    modelId,
    profile ? [] : listProviderNonTextModelIds(provider)
  )
}

export function isSpeechToTextModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase()
  return Boolean(normalized) && SPEECH_TO_TEXT_MODEL_PATTERN.test(normalized)
}

export function isImageGenerationModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase()
  return Boolean(normalized) && IMAGE_GENERATION_MODEL_PATTERN.test(normalized)
}

export function isTextToSpeechModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase()
  return Boolean(normalized) && TEXT_TO_SPEECH_MODEL_PATTERN.test(normalized)
}

export function isMusicGenerationModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase()
  return Boolean(normalized) && MUSIC_GENERATION_MODEL_PATTERN.test(normalized)
}

export function isVideoGenerationModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase()
  return Boolean(normalized) && VIDEO_GENERATION_MODEL_PATTERN.test(normalized)
}

export function modelProfileSupportsTextChat(
  profile: Pick<ModelProviderModelProfileV1, 'inputModalities' | 'outputModalities'> | undefined
): boolean {
  if (!profile) return true
  return profile.inputModalities.includes('text') && profile.outputModalities.includes('text')
}

export function modelProviderModelProfile(
  provider: Pick<ModelProviderProfileV1, 'modelProfiles'>,
  modelId: string
): ModelProviderModelProfileV1 | undefined {
  const normalized = normalizeModelKey(modelId)
  if (!normalized) return undefined
  return provider.modelProfiles[normalized]
}

export function modelProviderModelProfilesForProvider(
  settings: AppSettingsV1,
  providerId: string
): Record<string, ModelProviderModelProfileV1> {
  const profiles: Record<string, ModelProviderModelProfileV1> = {}
  const provider = getModelProviderProfile(settings, providerId)
  for (const [modelId, profile] of Object.entries(provider.modelProfiles)) {
    const normalized = normalizeModelKey(modelId)
    if (!normalized || !isProviderComposerChatModelId(provider, normalized)) continue
    profiles[normalized] = {
      ...profile,
      contextWindowTokens: profile.contextWindowTokens ?? DEFAULT_PROVIDER_CONTEXT_WINDOW_TOKENS
    }
  }
  return profiles
}

export function modelSupportsImageInput(
  profile: Pick<ModelProviderModelProfileV1, 'inputModalities'> | undefined
): boolean {
  return profile?.inputModalities.includes('image') === true
}

export function modelReasoningEfforts(
  profile: Pick<ModelProviderModelProfileV1, 'reasoning'> | undefined
): ModelProviderReasoningCapabilityV1 | undefined {
  return profile?.reasoning
}

export function listImageGenerationProviderProfiles(settings: AppSettingsV1): ModelProviderProfileV1[] {
  return getModelProviderSettings(settings).providers.filter((provider) => Boolean(provider.image))
}

export function listSpeechToTextProviderProfiles(settings: AppSettingsV1): ModelProviderProfileV1[] {
  return getModelProviderSettings(settings).providers.filter((provider) => Boolean(provider.speech))
}

export function listTextToSpeechProviderProfiles(settings: AppSettingsV1): ModelProviderProfileV1[] {
  return getModelProviderSettings(settings).providers.filter((provider) => Boolean(provider.textToSpeech))
}

export function listMusicGenerationProviderProfiles(settings: AppSettingsV1): ModelProviderProfileV1[] {
  return getModelProviderSettings(settings).providers.filter((provider) => Boolean(provider.music))
}

export function listVideoGenerationProviderProfiles(settings: AppSettingsV1): ModelProviderProfileV1[] {
  return getModelProviderSettings(settings).providers.filter((provider) => Boolean(provider.video))
}

type MiniMaxMediaCapabilityKey = 'textToSpeech' | 'music' | 'video'
type MiniMaxMediaCapability =
  | ModelProviderTextToSpeechCapabilityV1
  | ModelProviderMusicCapabilityV1
  | ModelProviderVideoCapabilityV1
type TokenPlanCapabilityKey = 'image' | 'speech' | 'textToSpeech' | 'music' | 'video'
type ProviderCapabilityWithBaseUrl = {
  protocol: string
  baseUrl: string
  models: readonly string[]
}
type TokenPlanCapabilityWithOptionalBaseUrl = {
  protocol: string
  baseUrl?: string
  models: readonly string[]
}

type KunMediaSettingCore = Partial<{
  enabled: boolean
  providerId: string
  baseUrl: string
  apiKey: string
  model: string
}>

const MINIMAX_PROVIDER_ID = 'minimax'
const MINIMAX_TOKEN_PLAN_PROVIDER_ID = `${MINIMAX_PROVIDER_ID}${TOKEN_PLAN_PROVIDER_ID_SUFFIX}`

export function defaultMiniMaxMediaGenerationKunPatch(input: {
  providers: readonly ModelProviderProfileV1[]
  currentKun?: Partial<KunRuntimeSettingsV1>
  kunPatch?: KunRuntimeSettingsPatchV1
}): KunRuntimeSettingsPatchV1 | undefined {
  const patch: KunRuntimeSettingsPatchV1 = {}
  if (!input.kunPatch?.textToSpeech && isBlankKunMediaSetting(input.currentKun?.textToSpeech)) {
    const match = configuredMiniMaxMediaCapability(input.providers, 'textToSpeech', input.currentKun?.providerId)
    if (match) {
      patch.textToSpeech = {
        enabled: true,
        providerId: match.provider.id,
        protocol: match.capability.protocol as TextToSpeechProtocol,
        baseUrl: '',
        apiKey: '',
        model: match.model
      }
    }
  }
  if (!input.kunPatch?.musicGeneration && isBlankKunMediaSetting(input.currentKun?.musicGeneration)) {
    const match = configuredMiniMaxMediaCapability(input.providers, 'music', input.currentKun?.providerId)
    if (match) {
      patch.musicGeneration = {
        enabled: true,
        providerId: match.provider.id,
        protocol: match.capability.protocol as MusicGenerationProtocol,
        baseUrl: '',
        apiKey: '',
        model: match.model
      }
    }
  }
  if (!input.kunPatch?.videoGeneration && isBlankKunMediaSetting(input.currentKun?.videoGeneration)) {
    const match = configuredMiniMaxMediaCapability(input.providers, 'video', input.currentKun?.providerId)
    if (match) {
      patch.videoGeneration = {
        enabled: true,
        providerId: match.provider.id,
        protocol: match.capability.protocol as VideoGenerationProtocol,
        baseUrl: '',
        apiKey: '',
        model: match.model
      }
    }
  }
  return Object.keys(patch).length > 0 ? patch : undefined
}

function isBlankKunMediaSetting(setting: KunMediaSettingCore | undefined): boolean {
  return setting?.enabled !== true &&
    !setting?.providerId?.trim() &&
    !setting?.baseUrl?.trim() &&
    !setting?.apiKey?.trim() &&
    !setting?.model?.trim()
}

function configuredMiniMaxMediaCapability(
  providers: readonly ModelProviderProfileV1[],
  key: MiniMaxMediaCapabilityKey,
  currentProviderId: string | undefined
): { provider: ModelProviderProfileV1; capability: MiniMaxMediaCapability; model: string } | null {
  const byId = new Map(providers.map((provider) => [provider.id, providerWithPresetCapabilities(provider)]))
  for (const id of preferredMiniMaxMediaProviderIds(currentProviderId, providers)) {
    const provider = byId.get(id)
    if (!provider?.apiKey.trim()) continue
    const capability = provider[key]
    const model = capability ? firstCapabilityModel(capability.models) : ''
    if (!capability || !model) continue
    return { provider, capability, model }
  }
  return null
}

function preferredMiniMaxMediaProviderIds(
  currentProviderId: string | undefined,
  providers: readonly ModelProviderProfileV1[]
): string[] {
  const normalized = normalizeModelProviderId(currentProviderId)
  const current = providers.find((provider) => provider.id === normalized)
  const currentSource = current ? resolveModelProviderPresetSource(current) : null
  const accountIds = providers.flatMap((provider) => {
    const source = resolveModelProviderPresetSource(provider)
    return source?.preset.id === MINIMAX_PROVIDER_ID ? [provider.id] : []
  })
  const ids = [
    ...(currentSource?.preset.id === MINIMAX_PROVIDER_ID ? [normalized] : []),
    MINIMAX_PROVIDER_ID,
    MINIMAX_TOKEN_PLAN_PROVIDER_ID,
    ...accountIds
  ]
  return ids.filter((id, index) => ids.indexOf(id) === index)
}

function providerWithPresetCapabilities(provider: ModelProviderProfileV1): ModelProviderProfileV1 {
  const tokenPlanPreset = tokenPlanPresetForProvider(provider)
  const presetProfile = tokenPlanPreset?.tokenPlan
    ? modelProviderTokenPlanProfile(tokenPlanPreset, provider.apiKey, provider.baseUrl)
    : modelProviderPresetProfileForProvider(provider)
  if (!presetProfile) return provider
  // Profiles saved before subscription transports moved to their official
  // SDK/CLI paths may have a valid preset identity but no `kind`. Restore the
  // preset transport during normalization so blank-base-URL subscriptions are
  // retained in serve.providers and reach DelegatedTurnRuntime.
  const kind = provider.kind ?? presetProfile.kind
  const presetSource = resolveModelProviderPresetSource(provider)
  const hasFixedSubscriptionCapabilities =
    presetSource?.mode === 'api' && presetSource.preset.category === 'subscription'
  // Subscription/SDK credentials are tied to documented transports. Do not let
  // stale hand-authored media blocks route those credentials through a generic
  // or unrelated protocol. This also upgrades profiles saved before a dedicated
  // subscription image/video transport was introduced.
  const image = hasFixedSubscriptionCapabilities
    ? presetProfile.image
    : mergePresetCapability(provider.image, presetProfile.image)
  const speech = hasFixedSubscriptionCapabilities
    ? presetProfile.speech
    : mergePresetCapability(provider.speech, presetProfile.speech)
  const textToSpeech = mergePresetCapability(provider.textToSpeech, presetProfile.textToSpeech)
  const music = mergePresetCapability(provider.music, presetProfile.music)
  const video = hasFixedSubscriptionCapabilities
    ? presetProfile.video
    : mergePresetCapability(provider.video, presetProfile.video)
  const {
    image: _storedImage,
    speech: _storedSpeech,
    video: _storedVideo,
    ...providerWithoutFixedMedia
  } = provider
  void _storedImage
  void _storedSpeech
  void _storedVideo
  return {
    ...(hasFixedSubscriptionCapabilities ? providerWithoutFixedMedia : provider),
    ...(kind ? { kind } : {}),
    ...(image ? { image } : {}),
    ...(speech ? { speech } : {}),
    ...(textToSpeech ? { textToSpeech } : {}),
    ...(music ? { music } : {}),
    ...(video ? { video } : {})
  }
}

function modelProviderPresetProfileForProvider(provider: ModelProviderProfileV1): ModelProviderProfileV1 | null {
  const source = resolveModelProviderPresetSource(provider)
  return source?.mode === 'api' ? modelProviderPresetProfile(source.preset, provider.apiKey) : null
}

function mergePresetCapability<T extends { baseUrl: string; models: string[] }>(
  stored: T | undefined,
  preset: T | undefined
): T | undefined {
  if (!stored) return preset
  if (!preset) return stored
  return {
    ...preset,
    ...stored,
    baseUrl: stored.baseUrl.trim() || preset.baseUrl,
    models: stored.models.length > 0 ? stored.models : preset.models
  }
}

function firstCapabilityModel(models: readonly string[]): string {
  return models.map((model) => model.trim()).find(Boolean) ?? ''
}

export function resolveKunSpeechToTextSettings(settings: AppSettingsV1): KunSpeechToTextSettingsV1 {
  const runtime = getKunRuntimeSettings(settings)
  const speechToText = runtime.speechToText
  const providerId = normalizeModelProviderId(speechToText.providerId)
  if (!providerId || providerId === CUSTOM_SPEECH_TO_TEXT_PROVIDER_ID) {
    return {
      ...speechToText,
      providerId,
      protocol: normalizeSpeechToTextProtocol(speechToText.protocol)
    }
  }
  const provider = getModelProviderSettings(settings).providers.find((item) => item.id === providerId)
  const speech = provider?.speech
  if (!provider || !speech) {
    return {
      ...speechToText,
      providerId: '',
      apiKey: '',
      protocol: normalizeSpeechToTextProtocol(speechToText.protocol)
    }
  }
  return {
    ...speechToText,
    providerId: provider.id,
    protocol: speech.protocol,
    baseUrl: resolveProviderSpeechBaseUrl(provider, speech),
    apiKey: provider.apiKey.trim(),
    model: resolveProviderSpeechModel(speechToText.model, speech.models)
  }
}

function resolveProviderSpeechBaseUrl(
  provider: ModelProviderProfileV1,
  speech: ModelProviderSpeechCapabilityV1
): string {
  return resolveProviderCapabilityBaseUrl(provider, speech, 'speech')
}

function resolveProviderCapabilityBaseUrl(
  provider: ModelProviderProfileV1,
  capability: ProviderCapabilityWithBaseUrl,
  key: TokenPlanCapabilityKey
): string {
  const tokenPlan = tokenPlanPresetForProvider(provider)
  const tokenPlanConfig = tokenPlan?.tokenPlan
  const tokenPlanCapability = tokenPlanConfig ? tokenPlanCapabilityForKey(tokenPlanConfig, key) : undefined
  if (!tokenPlanConfig || !tokenPlanCapability) return capability.baseUrl
  if (capability.protocol !== tokenPlanCapability.protocol) return capability.baseUrl
  if (!sameModelIds(capability.models, tokenPlanCapability.models)) return capability.baseUrl

  const regularCapability = presetCapabilityForKey(tokenPlan, key)
  const legacyPresetBaseUrl = regularCapability &&
    regularCapability.protocol === tokenPlanCapability.protocol &&
    sameModelIds(regularCapability.models, tokenPlanCapability.models)
    ? regularCapability.baseUrl
    : undefined
  const knownPresetUrls = knownTokenPlanCapabilityBaseUrls(
    tokenPlanConfig,
    tokenPlanCapability.baseUrl,
    legacyPresetBaseUrl
  )
  const capabilityBaseUrl = canonicalBaseUrl(capability.baseUrl)
  if (!capabilityBaseUrl || knownPresetUrls.some((url) => canonicalBaseUrl(url) === capabilityBaseUrl)) {
    return deriveTokenPlanCapabilityBaseUrl(tokenPlanConfig, provider.baseUrl, tokenPlanCapability.baseUrl)
  }
  return capability.baseUrl
}

function tokenPlanCapabilityForKey(
  tokenPlan: NonNullable<ModelProviderPreset['tokenPlan']>,
  key: TokenPlanCapabilityKey
): TokenPlanCapabilityWithOptionalBaseUrl | undefined {
  switch (key) {
    case 'image':
      return tokenPlan.image
    case 'speech':
      return tokenPlan.speech
    case 'textToSpeech':
      return tokenPlan.textToSpeech
    case 'music':
      return tokenPlan.music
    case 'video':
      return tokenPlan.video
  }
}

function presetCapabilityForKey(
  preset: ModelProviderPreset,
  key: TokenPlanCapabilityKey
): ProviderCapabilityWithBaseUrl | undefined {
  switch (key) {
    case 'image':
      return preset.image
    case 'speech':
      return preset.speech
    case 'textToSpeech':
      return preset.textToSpeech
    case 'music':
      return preset.music
    case 'video':
      return preset.video
  }
}

function knownTokenPlanCapabilityBaseUrls(
  tokenPlan: NonNullable<ModelProviderPreset['tokenPlan']>,
  capabilityBaseUrl: string | undefined,
  legacyPresetBaseUrl: string | undefined
): string[] {
  const planBaseUrls = [
    tokenPlan.baseUrl,
    ...(tokenPlan.regions?.map((region) => region.baseUrl) ?? [])
  ]
  const legacyBaseUrls = legacyPresetBaseUrl?.trim() ? [legacyPresetBaseUrl] : []
  if (!capabilityBaseUrl?.trim()) return [...planBaseUrls, ...legacyBaseUrls]
  return planBaseUrls
    .map((baseUrl) => deriveTokenPlanCapabilityBaseUrl(tokenPlan, baseUrl, capabilityBaseUrl))
    .concat(legacyBaseUrls)
    .filter((url): url is string => Boolean(url.trim()))
}

function deriveTokenPlanCapabilityBaseUrl(
  tokenPlan: NonNullable<ModelProviderPreset['tokenPlan']>,
  providerBaseUrl: string,
  capabilityBaseUrl: string | undefined
): string {
  const providerUrl = providerBaseUrl.trim()
  if (!capabilityBaseUrl?.trim()) return providerUrl
  const providerOrigin = urlOrigin(providerUrl)
  const capabilityOrigin = urlOrigin(capabilityBaseUrl)
  if (!providerOrigin || !capabilityOrigin) return capabilityBaseUrl.trim()
  const planOrigins = [
    tokenPlan.baseUrl,
    ...(tokenPlan.regions?.map((region) => region.baseUrl) ?? [])
  ].map(urlOrigin).filter((origin): origin is string => Boolean(origin))
  if (!planOrigins.includes(capabilityOrigin)) return capabilityBaseUrl.trim()
  return replaceUrlOrigin(capabilityBaseUrl, providerOrigin)
}

function urlOrigin(value: string | undefined): string | null {
  if (!value?.trim()) return null
  try {
    return new URL(value.trim()).origin
  } catch {
    return null
  }
}

function replaceUrlOrigin(value: string, origin: string): string {
  try {
    const url = new URL(value.trim())
    const path = url.pathname.replace(/\/+$/, '')
    return `${origin}${path === '/' ? '' : path}${url.search}`
  } catch {
    return value.trim()
  }
}

function resolveProviderSpeechModel(configuredModel: string, providerModels: readonly string[]): string {
  const model = configuredModel.trim()
  if (!model) return providerModels[0] ?? ''
  if (providerModels.length === 0) return model
  if (providerModels.some((providerModel) => providerModel.trim().toLowerCase() === model.toLowerCase())) {
    return model
  }
  return TEXT_TO_SPEECH_MODEL_PATTERN.test(model) ? providerModels[0] ?? model : model
}

export function resolveKunTextToSpeechSettings(settings: AppSettingsV1): KunTextToSpeechSettingsV1 {
  const runtime = getKunRuntimeSettings(settings)
  const textToSpeech = runtime.textToSpeech
  const providerId = normalizeModelProviderId(textToSpeech.providerId)
  if (!providerId || providerId === CUSTOM_TEXT_TO_SPEECH_PROVIDER_ID) {
    return {
      ...textToSpeech,
      providerId,
      protocol: normalizeTextToSpeechProtocol(textToSpeech.protocol)
    }
  }
  const provider = getModelProviderSettings(settings).providers.find((item) => item.id === providerId)
  const capability = provider?.textToSpeech
  if (!provider || !capability) {
    return {
      ...textToSpeech,
      providerId: '',
      apiKey: '',
      protocol: normalizeTextToSpeechProtocol(textToSpeech.protocol)
    }
  }
  return {
    ...textToSpeech,
    providerId: provider.id,
    protocol: capability.protocol,
    baseUrl: resolveProviderCapabilityBaseUrl(provider, capability, 'textToSpeech'),
    apiKey: provider.apiKey.trim(),
    model: resolveProviderCapabilityModel(textToSpeech.model, capability.models)
  }
}

export function resolveKunMusicGenerationSettings(settings: AppSettingsV1): KunMusicGenerationSettingsV1 {
  const runtime = getKunRuntimeSettings(settings)
  const musicGeneration = runtime.musicGeneration
  const providerId = normalizeModelProviderId(musicGeneration.providerId)
  if (!providerId || providerId === CUSTOM_MUSIC_GENERATION_PROVIDER_ID) {
    return {
      ...musicGeneration,
      providerId,
      protocol: normalizeMusicGenerationProtocol(musicGeneration.protocol)
    }
  }
  const provider = getModelProviderSettings(settings).providers.find((item) => item.id === providerId)
  const capability = provider?.music
  if (!provider || !capability) {
    return {
      ...musicGeneration,
      providerId: '',
      apiKey: '',
      protocol: normalizeMusicGenerationProtocol(musicGeneration.protocol)
    }
  }
  return {
    ...musicGeneration,
    providerId: provider.id,
    protocol: capability.protocol,
    baseUrl: resolveProviderCapabilityBaseUrl(provider, capability, 'music'),
    apiKey: provider.apiKey.trim(),
    model: resolveProviderCapabilityModel(musicGeneration.model, capability.models)
  }
}

export function resolveKunVideoGenerationSettings(settings: AppSettingsV1): KunVideoGenerationSettingsV1 {
  const runtime = getKunRuntimeSettings(settings)
  const videoGeneration = runtime.videoGeneration
  const providerId = normalizeModelProviderId(videoGeneration.providerId)
  if (!providerId || providerId === CUSTOM_VIDEO_GENERATION_PROVIDER_ID) {
    return normalizeResolvedVideoDefaults({
      ...videoGeneration,
      providerId,
      protocol: normalizeVideoGenerationProtocol(videoGeneration.protocol)
    })
  }
  const provider = getModelProviderSettings(settings).providers.find((item) => item.id === providerId)
  const capability = provider?.video
  if (!provider || !capability) {
    return {
      ...videoGeneration,
      providerId: '',
      apiKey: '',
      protocol: normalizeVideoGenerationProtocol(videoGeneration.protocol)
    }
  }
  return normalizeResolvedVideoDefaults({
    ...videoGeneration,
    providerId: provider.id,
    protocol: capability.protocol,
    baseUrl: resolveProviderCapabilityBaseUrl(provider, capability, 'video'),
    apiKey: provider.apiKey.trim(),
    model: resolveVideoProviderCapabilityModel(videoGeneration.model, capability)
  })
}

function resolveVideoProviderCapabilityModel(
  configuredModel: string,
  capability: ModelProviderVideoCapabilityV1
): string {
  const fallback = capability.protocol === 'grok-imagine-video' &&
    capability.models.includes('grok-imagine-video-1.5-preview')
    ? 'grok-imagine-video-1.5-preview'
    : capability.models[0] ?? ''
  const model = configuredModel.trim()
  if (!model) return fallback
  if (capability.models.length === 0) return model
  return capability.models.some((providerModel) => providerModel.trim().toLowerCase() === model.toLowerCase())
    ? model
    : fallback || model
}

function normalizeResolvedVideoDefaults(
  value: KunVideoGenerationSettingsV1
): KunVideoGenerationSettingsV1 {
  const resolution = value.defaultResolution.trim().toUpperCase()
  if (value.protocol === 'volcengine-ark-video') {
    const allowedResolutions = new Set(['480P', '720P', '1080P', '4K'])
    return {
      ...value,
      defaultDuration: Math.min(15, Math.max(4, value.defaultDuration)),
      defaultResolution: allowedResolutions.has(resolution) ? resolution : '720P'
    }
  }
  if (value.protocol !== 'grok-imagine-video') return value
  return {
    ...value,
    defaultDuration: value.defaultDuration === 10 ? 10 : 6,
    defaultResolution: resolution === '720P' ? '720P' : '480P'
  }
}

export function resolveKunMemoryEnabled(settings: AppSettingsV1): boolean {
  const runtime = getKunRuntimeSettings(settings)
  return runtime.memoryEnabled ?? false
}

function resolveProviderCapabilityModel(configuredModel: string, providerModels: readonly string[]): string {
  const model = configuredModel.trim()
  if (!model) return providerModels[0] ?? ''
  if (providerModels.length === 0) return model
  return providerModels.some((providerModel) => providerModel.trim().toLowerCase() === model.toLowerCase())
    ? model
    : providerModels[0] ?? model
}

function resolveImageProviderCapabilityModel(
  configuredModel: string,
  image: ModelProviderImageCapabilityV1
): string {
  const fallback =
    image.protocol === 'codex-responses-image' && image.models.includes('gpt-image-2')
      ? 'gpt-image-2'
      : image.models[0] ?? ''
  const model = configuredModel.trim()
  if (!model) return fallback
  if (image.models.length === 0) return model
  return image.models.some((providerModel) => providerModel.trim().toLowerCase() === model.toLowerCase())
    ? model
    : fallback || model
}

function tokenPlanPresetForProvider(
  provider: Pick<ModelProviderProfileV1, 'id' | 'presetSource'>
) {
  const source = resolveModelProviderPresetSource(provider)
  return source?.mode === 'token-plan' ? source.preset : null
}

function sameModelIds(a: readonly string[], b: readonly string[]): boolean {
  const left = a.map((model) => model.trim().toLowerCase()).filter(Boolean).sort()
  const right = b.map((model) => model.trim().toLowerCase()).filter(Boolean).sort()
  return left.length === right.length && left.every((model, index) => model === right[index])
}

function canonicalBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

export function resolveKunImageGenerationSettings(settings: AppSettingsV1): KunImageGenerationSettingsV1 {
  const runtime = getKunRuntimeSettings(settings)
  const imageGeneration = runtime.imageGeneration
  const providerId = normalizeModelProviderId(imageGeneration.providerId)
  if (!providerId || providerId === CUSTOM_IMAGE_GENERATION_PROVIDER_ID) {
    return normalizeResolvedImageDefaults({
      ...imageGeneration,
      providerId,
      protocol: normalizeImageGenerationProtocol(imageGeneration.protocol)
    })
  }
  const provider = getModelProviderSettings(settings).providers.find((item) => item.id === providerId)
  const image = provider?.image
  if (!provider || !image) {
    return {
      ...imageGeneration,
      providerId: '',
      apiKey: '',
      protocol: normalizeImageGenerationProtocol(imageGeneration.protocol)
    }
  }
  return normalizeResolvedImageDefaults({
    ...imageGeneration,
    providerId: provider.id,
    protocol: image.protocol,
    baseUrl: resolveProviderCapabilityBaseUrl(provider, image, 'image'),
    apiKey: provider.apiKey.trim(),
    model: resolveImageProviderCapabilityModel(imageGeneration.model, image)
  })
}

function normalizeResolvedImageDefaults(
  value: KunImageGenerationSettingsV1
): KunImageGenerationSettingsV1 {
  if (value.protocol === 'volcengine-ark-image') {
    return {
      ...value,
      defaultResolution: value.defaultResolution === '3K' || value.defaultResolution === '4K'
        ? value.defaultResolution
        : '2K'
    }
  }
  return value.defaultResolution === '3K' || value.defaultResolution === '4K'
    ? { ...value, defaultResolution: '1K' }
    : value
}

export function resolveKunRuntimeSettings(settings: AppSettingsV1): KunRuntimeSettingsV1 {
  const runtime = getKunRuntimeSettings(settings)
  const provider = getModelProviderProfile(settings, runtime.providerId)
  const providerId = normalizeModelProviderId(runtime.providerId)
  const runtimeApiKey = runtime.apiKey?.trim() ?? ''
  const runtimeBaseUrl = runtime.baseUrl?.trim() ?? ''
  const providerBaseUrl = provider.baseUrl.trim() || DEFAULT_DEEPSEEK_BASE_URL
  const useProviderCredentials = Boolean(providerId)

  return {
    ...runtime,
    // When a provider is selected we prefer that profile's key, but fall back
    // to the agent's own runtime.apiKey if the profile happens to be keyless.
    // A providerId pointing at a keyless profile must NOT resolve to an empty
    // key (issue #329) — that briefly reads as "no API key" and the
    // settings-apply gate then stops a perfectly healthy Kun runtime.
    apiKey: useProviderCredentials
      ? provider.apiKey.trim() || runtimeApiKey
      : runtimeApiKey || provider.apiKey.trim(),
    baseUrl:
      !useProviderCredentials && runtimeBaseUrl && runtimeBaseUrl !== DEFAULT_DEEPSEEK_BASE_URL
        ? normalizeDeepseekBaseUrl(runtimeBaseUrl)
        : normalizeDeepseekBaseUrl(providerBaseUrl),
    endpointFormat: provider.endpointFormat,
    retry: provider.retry ?? defaultModelRequestRetrySettings(),
    imageGeneration: resolveKunImageGenerationSettings(settings),
    speechToText: resolveKunSpeechToTextSettings(settings),
    textToSpeech: resolveKunTextToSpeechSettings(settings),
    musicGeneration: resolveKunMusicGenerationSettings(settings),
    videoGeneration: resolveKunVideoGenerationSettings(settings),
    modelProfiles: modelProviderModelProfilesForProvider(settings, provider.id),
    memoryEnabled: resolveKunMemoryEnabled(settings)
  }
}

function defaultModelProviderProfile(apiKey: string, baseUrl: string): ModelProviderProfileV1 {
  return {
    id: DEFAULT_MODEL_PROVIDER_ID,
    name: DEFAULT_MODEL_PROVIDER_NAME,
    apiKey: apiKey.trim(),
    baseUrl: normalizeModelProviderBaseUrl(baseUrl),
    endpointFormat: DEFAULT_MODEL_ENDPOINT_FORMAT,
    retry: defaultModelRequestRetrySettings(),
    models: [...DEFAULT_COMPOSER_MODEL_IDS],
    modelProfiles: {
      'deepseek-v4-pro': deepseekTextModelProfile(),
      'deepseek-v4-flash': {
        ...deepseekTextModelProfile(),
        aliases: ['deepseek-chat', 'deepseek-reasoner']
      }
    }
  }
}

function normalizeModelProviderProfile(
  input: ModelProviderProfilePatchV1 | undefined
): ModelProviderProfileV1 | null {
  const id = normalizeModelProviderId(input?.id)
  if (!id) return null
  const presetSource = normalizeModelProviderPresetSource(input, id)
  const resolvedPresetSource = presetSource
    ? resolveModelProviderPresetSource({ id, presetSource })
    : null
  const kind =
    input?.kind === 'gemini-code-assist'
      ? 'antigravity-cli'
      : input?.kind ?? (
          resolvedPresetSource?.mode === 'api'
            ? resolvedPresetSource.preset.kind
            : undefined
        )
  const rawName = typeof input?.name === 'string' && input.name.trim() ? input.name.trim() : id
  const baseUrl = normalizeModelProviderBaseUrl(input?.baseUrl)
  const savedModels = normalizeProviderModels(input?.models)
  // Existing builds used `gemini-code-assist` on the legacy Antigravity preset.
  // Keep that one-time migration on Antigravity; the new direct Gemini CLI API
  // preset has its own id and never silently takes ownership of legacy threads.
  const rawModels =
    presetSource?.presetId === 'gemini-subscription' && input?.kind === 'gemini-code-assist'
      ? [...GEMINI_SUBSCRIPTION_MODEL_IDS]
      : savedModels
  const migrated = migrateChatGptSubscriptionProfile(id, rawName, rawModels)
  const name = migrated.name
  const models = migrateProviderPresetModelCatalog(id, migrated.models)
  const modelProfiles = withPresetModelProfiles(
    { id, presetSource },
    models,
    normalizeModelProviderModelProfiles(input?.modelProfiles, models)
  )
  const image = normalizeModelProviderImageCapability(input?.image)
  const speech = normalizeModelProviderSpeechCapability(input?.speech)
  const textToSpeech = normalizeModelProviderTextToSpeechCapability(input?.textToSpeech)
  const music = normalizeModelProviderMusicCapability(input?.music)
  const video = normalizeModelProviderVideoCapability(input?.video)
  return providerWithPresetCapabilities({
    id,
    name,
    ...(presetSource ? { presetSource } : {}),
    apiKey:
      kind === 'antigravity-cli' || kind === 'gemini-cli-api'
        ? ''
        : typeof input?.apiKey === 'string'
          ? input.apiKey.trim()
          : '',
    baseUrl,
    endpointFormat: normalizeModelEndpointFormat(input?.endpointFormat),
    retry: normalizeModelRequestRetrySettings(input?.retry),
    ...(kind ? { kind } : {}),
    models,
    modelProfiles,
    ...(image ? { image } : {}),
    ...(speech ? { speech } : {}),
    ...(textToSpeech ? { textToSpeech } : {}),
    ...(music ? { music } : {}),
    ...(video ? { video } : {})
  })
}

function normalizeModelProviderPresetSource(
  input: ModelProviderProfilePatchV1 | undefined,
  id: string
): ModelProviderPresetSourceV1 | undefined {
  const raw = input?.presetSource
  if (raw !== undefined) {
    if (!raw || typeof raw !== 'object') return undefined
    const presetId = typeof raw.presetId === 'string' ? raw.presetId.trim() : ''
    const mode = raw.mode === 'api' || raw.mode === 'token-plan' ? raw.mode : undefined
    if (!presetId || !mode) return undefined
    const resolved = resolveModelProviderPresetSource({ id, presetSource: { presetId, mode } })
    return resolved ? { presetId: resolved.preset.id, mode: resolved.mode } : undefined
  }
  const inferred = resolveModelProviderPresetSource({ id })
  return inferred ? { presetId: inferred.preset.id, mode: inferred.mode } : undefined
}

function migrateChatGptSubscriptionProfile(
  id: string,
  name: string,
  models: string[]
): { name: string; models: string[] } {
  if (id !== CHATGPT_SUBSCRIPTION_PROVIDER_ID) return { name, models }
  return {
    name: name === CHATGPT_SUBSCRIPTION_LEGACY_NAME ? CHATGPT_SUBSCRIPTION_NAME : name,
    // This is intentionally a precise one-time signature migration. Do not
    // re-add models that a user deliberately removed from a custom list.
    models: sameModelIds(models, CHATGPT_SUBSCRIPTION_LEGACY_MODEL_IDS)
      ? [...CHATGPT_SUBSCRIPTION_MODEL_IDS]
      : models
  }
}

function migrateProviderPresetModelCatalog(id: string, models: string[]): string[] {
  if (id !== 'kimi-code') return models
  const legacyModels = new Set(['kimi-for-coding', 'kimi-for-coding-highspeed'])
  if (models.length === 0 || models.some((model) => !legacyModels.has(model))) return models
  const preset = getModelProviderPreset('kimi-code')
  return preset ? [...preset.models] : models
}

export function defaultModelRequestRetrySettings(): ModelRequestRetrySettingsV1 {
  return {
    maxAttempts: DEFAULT_MODEL_REQUEST_RETRY_MAX_ATTEMPTS,
    initialDelayMs: DEFAULT_MODEL_REQUEST_RETRY_INITIAL_DELAY_MS,
    httpStatusCodes: [...DEFAULT_MODEL_REQUEST_RETRY_HTTP_STATUS_CODES]
  }
}

export function normalizeModelRequestRetrySettings(
  input: Partial<ModelRequestRetrySettingsV1> | undefined
): ModelRequestRetrySettingsV1 {
  const defaults = defaultModelRequestRetrySettings()
  return {
    maxAttempts: boundedNonNegativeInteger(input?.maxAttempts, defaults.maxAttempts, 10),
    initialDelayMs: boundedNonNegativeInteger(input?.initialDelayMs, defaults.initialDelayMs, 600_000),
    httpStatusCodes: normalizeRetryHttpStatusCodes(input?.httpStatusCodes, defaults.httpStatusCodes)
  }
}

function normalizeRetryHttpStatusCodes(input: unknown, fallback: readonly number[]): number[] {
  const values = Array.isArray(input) ? input : fallback
  const codes = new Set<number>()
  for (const raw of values) {
    const code = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isInteger(code) || code < 400 || code > 599) continue
    codes.add(code)
  }
  return codes.size > 0 ? [...codes].sort((a, b) => a - b) : [...fallback]
}

function boundedNonNegativeInteger(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(0, Math.round(num)))
}

function deepseekTextModelProfile(): ModelProviderModelProfileV1 {
  return {
    ...DEFAULT_TEXT_MODEL_PROFILE,
    contextWindowTokens: 1_000_000,
    reasoning: {
      supportedEfforts: ['off', 'high', 'max'],
      defaultEffort: 'max',
      requestProtocol: 'deepseek-chat-completions'
    }
  }
}

/**
 * Stored provider settings may predate the capability metadata in the presets
 * (older saves carry empty modelProfiles). For known preset providers the
 * preset fills missing profiles, while stored profiles win so model edits made
 * in Settings keep surviving normalization.
 */
function withPresetModelProfiles(
  provider: Pick<ModelProviderProfileV1, 'id' | 'presetSource'>,
  models: readonly string[],
  stored: Record<string, ModelProviderModelProfileV1>
): Record<string, ModelProviderModelProfileV1> {
  const presetProfiles = presetModelProfilesForProvider(provider)
  if (!presetProfiles) return stored
  const knownModelKeys = new Set(models.map(normalizeModelKey).filter(Boolean))
  const merged: Record<string, ModelProviderModelProfileV1> = {}
  for (const [rawModelId, presetProfile] of Object.entries(presetProfiles)) {
    const modelId = normalizeModelKey(rawModelId)
    if (!modelId) continue
    if (knownModelKeys.size > 0 && !knownModelKeys.has(modelId)) {
      const aliases = normalizeProviderModels(presetProfile.aliases)
      if (!aliases.some((alias) => knownModelKeys.has(normalizeModelKey(alias)))) continue
    }
    merged[modelId] = normalizeModelProviderModelProfile(presetProfile)
  }
  const profiles = { ...stored }
  for (const [modelId, presetProfile] of Object.entries(merged)) {
    const storedProfile = stored[modelId]
    const usePresetReasoning = shouldUpgradeGeneratedPresetReasoning(
      provider.id,
      modelId,
      storedProfile?.reasoning,
      presetProfile.reasoning
    )
    const repairKnownGrokCapacity = shouldRepairKnownOpenCodeGrokCapacity(
      provider,
      modelId,
      storedProfile,
      presetProfile
    )
    const profile: ModelProviderModelProfileV1 = {
      ...presetProfile,
      ...(storedProfile ?? {}),
      ...(usePresetReasoning && presetProfile.reasoning
        ? { reasoning: presetProfile.reasoning }
        : {}),
      // Service-tier availability is upstream model metadata. Older stored
      // profiles must inherit additions and removals from the preset catalog.
      ...(presetProfile.serviceTiers?.length
        ? { serviceTiers: [...presetProfile.serviceTiers] }
        : {}),
      // Responses Lite is a required transport contract for its matching
      // Codex models, not a user-editable profile choice. Older manually
      // added profiles should inherit it from the preset.
      ...(presetProfile.responsesMode && !storedProfile?.responsesMode
        ? { responsesMode: presetProfile.responsesMode }
        : {}),
      ...(repairKnownGrokCapacity
        ? {
            contextWindowTokens: presetProfile.contextWindowTokens!,
            maxOutputTokens: presetProfile.maxOutputTokens!
          }
        : {})
    }
    if (!presetProfile.serviceTiers?.length) delete profile.serviceTiers
    profiles[modelId] = profile
  }
  return profiles
}

function shouldRepairKnownOpenCodeGrokCapacity(
  provider: Pick<ModelProviderProfileV1, 'id' | 'presetSource'>,
  modelId: string,
  stored: ModelProviderModelProfileV1 | undefined,
  preset: ModelProviderModelProfileV1
): boolean {
  const source = resolveModelProviderPresetSource(provider)
  return source?.preset.id === 'opencode-go' &&
    modelId === 'grok-4.5' &&
    stored?.contextWindowTokens === 256_000 &&
    stored.maxOutputTokens === 500_000 &&
    preset.contextWindowTokens === 500_000 &&
    preset.maxOutputTokens === 64_000
}

function shouldUpgradeGeneratedPresetReasoning(
  providerId: string,
  modelId: string,
  stored: ModelProviderReasoningCapabilityV1 | undefined,
  preset: ModelProviderReasoningCapabilityV1 | undefined
): boolean {
  if (!stored || !preset) return false
  const presetId = providerId.endsWith(TOKEN_PLAN_PROVIDER_ID_SUFFIX)
    ? providerId.slice(0, -TOKEN_PLAN_PROVIDER_ID_SUFFIX.length)
    : providerId
  if (
    presetId === 'kimi-code' &&
    modelId === 'k3' &&
    stored.requestProtocol === 'openai-responses' &&
    preset.requestProtocol === 'openai-chat-completions'
  ) {
    return true
  }
  const generatedPlaceholderProviders = new Set([
    'opencode-go',
    'zhipu-coding-plan',
    'zai-coding-plan',
    'aliyun',
    'tencentcloud',
    'volcengine-coding-plan'
  ])
  if (!generatedPlaceholderProviders.has(presetId)) return false
  return stored.requestProtocol === 'none' &&
    preset.requestProtocol !== 'none' &&
    stored.defaultEffort === 'auto' &&
    stored.supportedEfforts.every((effort) => effort === 'auto' || effort === 'off')
}

function presetModelProfilesForProvider(
  provider: Pick<ModelProviderProfileV1, 'id' | 'presetSource'>
): Record<string, ModelProviderModelProfileV1> | null {
  const source = resolveModelProviderPresetSource(provider)
  if (!source) return null
  const profiles = source.mode === 'token-plan'
    ? source.preset.tokenPlan?.modelProfiles ?? source.preset.modelProfiles
    : source.preset.modelProfiles
  return profiles ?? null
}

function normalizeModelProviderModelProfiles(
  input: Record<string, ModelProviderModelProfilePatchV1 | null> | undefined,
  models: readonly string[]
): Record<string, ModelProviderModelProfileV1> {
  const profiles: Record<string, ModelProviderModelProfileV1> = {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) return profiles
  const knownModelKeys = new Set(models.map(normalizeModelKey).filter(Boolean))
  for (const [rawModelId, rawProfile] of Object.entries(input)) {
    const modelId = normalizeModelKey(rawModelId)
    if (!modelId || rawProfile === null) continue
    if (knownModelKeys.size > 0 && !knownModelKeys.has(modelId)) {
      const aliases = normalizeProviderModels(rawProfile.aliases)
      if (!aliases.some((alias) => knownModelKeys.has(normalizeModelKey(alias)))) continue
    }
    profiles[modelId] = normalizeModelProviderModelProfile(rawProfile)
  }
  return profiles
}

function normalizeModelProviderModelProfile(
  input: ModelProviderModelProfilePatchV1 | undefined
): ModelProviderModelProfileV1 {
  const inputModalities = normalizeModelInputModalities(input?.inputModalities)
  const defaultMessageParts: ModelProviderMessagePartSupport[] = inputModalities.includes('image')
    ? ['text', 'image_url']
    : ['text']
  const contextWindowTokens = boundedPositiveInteger(input?.contextWindowTokens)
  const maxOutputTokens = boundedPositiveInteger(input?.maxOutputTokens)
  const reasoning = normalizeModelReasoningCapability(input?.reasoning)
  const serviceTiers = normalizeModelServiceTiers(input?.serviceTiers)
  const endpointFormat = normalizeOptionalModelEndpointFormat(input?.endpointFormat)
  const responsesMode = input?.responsesMode === 'lite' ? 'lite' : undefined
  return {
    ...(normalizeProviderModels(input?.aliases).length
      ? { aliases: normalizeProviderModels(input?.aliases) }
      : {}),
    ...(contextWindowTokens ? { contextWindowTokens } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    inputModalities,
    outputModalities: normalizeModelInputModalities(input?.outputModalities),
    supportsToolCalling: input?.supportsToolCalling !== false,
    messageParts: normalizeModelMessageParts(input?.messageParts, defaultMessageParts),
    ...(reasoning ? { reasoning } : {}),
    ...(serviceTiers.length ? { serviceTiers } : {}),
    ...(endpointFormat ? { endpointFormat } : {}),
    ...(responsesMode ? { responsesMode } : {})
  }
}

function normalizeModelServiceTiers(
  value: unknown
): NonNullable<ModelProviderModelProfileV1['serviceTiers']> {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter(
    (tier): tier is NonNullable<ModelProviderModelProfileV1['serviceTiers']>[number] =>
      tier === 'priority' || tier === 'flex'
  ))]
}

/**
 * A per-model wire-format override is only meaningful when explicitly set;
 * an absent value means "inherit the provider's endpointFormat". Returns
 * undefined for blank/missing input instead of coercing to the default, so
 * inheritance is preserved end-to-end.
 */
function normalizeOptionalModelEndpointFormat(
  value: unknown
): ModelEndpointFormat | undefined {
  return typeof value === 'string' && value.trim()
    ? normalizeModelEndpointFormat(value)
    : undefined
}

function normalizeModelReasoningCapability(
  input: ModelProviderModelProfilePatchV1['reasoning'] | undefined
): ModelProviderReasoningCapabilityV1 | undefined {
  if (!input || typeof input !== 'object') return undefined
  const supportedEfforts = normalizeReasoningEfforts(input.supportedEfforts)
  if (supportedEfforts.length === 0) return undefined
  const defaultEffort = normalizeReasoningEffort(input.defaultEffort)
  const resolvedDefault = defaultEffort && supportedEfforts.includes(defaultEffort)
    ? defaultEffort
    : supportedEfforts[0]
  const requestProtocol = normalizeReasoningRequestProtocol(input.requestProtocol)
  if (!requestProtocol) return undefined
  return {
    supportedEfforts,
    defaultEffort: resolvedDefault,
    requestProtocol
  }
}

function normalizeReasoningEfforts(value: unknown): ModelProviderReasoningCapabilityV1['supportedEfforts'] {
  if (!Array.isArray(value)) return []
  const out: ModelProviderReasoningCapabilityV1['supportedEfforts'] = []
  for (const item of value) {
    const effort = normalizeReasoningEffort(item)
    if (effort && !out.includes(effort)) out.push(effort)
  }
  return out
}

function normalizeReasoningEffort(value: unknown): ModelProviderReasoningCapabilityV1['defaultEffort'] | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  return MODEL_REASONING_EFFORTS.includes(normalized as ModelProviderReasoningCapabilityV1['defaultEffort'])
    ? normalized as ModelProviderReasoningCapabilityV1['defaultEffort']
    : undefined
}

function normalizeReasoningRequestProtocol(
  value: unknown
): ModelProviderReasoningCapabilityV1['requestProtocol'] | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  return MODEL_REASONING_REQUEST_PROTOCOLS.includes(normalized as ModelProviderReasoningCapabilityV1['requestProtocol'])
    ? normalized as ModelProviderReasoningCapabilityV1['requestProtocol']
    : undefined
}

function normalizeModelInputModalities(value: unknown): ModelProviderInputModality[] {
  if (!Array.isArray(value)) return ['text']
  const out: ModelProviderInputModality[] = []
  for (const item of value) {
    if ((item === 'text' || item === 'image') && !out.includes(item)) out.push(item)
  }
  return out.length > 0 ? out : ['text']
}

function normalizeModelMessageParts(
  value: unknown,
  fallback: ModelProviderMessagePartSupport[]
): ModelProviderMessagePartSupport[] {
  if (!Array.isArray(value)) return [...fallback]
  const out: ModelProviderMessagePartSupport[] = []
  for (const item of value) {
    if (
      (item === 'text' || item === 'image_url' || item === 'input_image') &&
      !out.includes(item)
    ) {
      out.push(item)
    }
  }
  return out.length > 0 ? out : [...fallback]
}

function boundedPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function normalizeModelProviderImageCapability(
  input: ModelProviderImageCapabilityPatchV1 | null | undefined
): ModelProviderImageCapabilityV1 | undefined {
  if (!input || typeof input !== 'object') return undefined
  const baseUrl = typeof input.baseUrl === 'string' && input.baseUrl.trim()
    ? normalizeDeepseekBaseUrl(input.baseUrl)
    : ''
  const models = normalizeProviderModels(input.models)
  if (!baseUrl && models.length === 0) return undefined
  return {
    protocol: normalizeImageGenerationProtocol(input.protocol),
    baseUrl,
    models
  }
}

export function normalizeImageGenerationProtocol(value: unknown): ImageGenerationProtocol {
  if (value === 'minimax-image') return 'minimax-image'
  if (value === 'codex-responses-image') return 'codex-responses-image'
  if (value === 'grok-imagine-image') return 'grok-imagine-image'
  if (value === 'volcengine-ark-image') return 'volcengine-ark-image'
  return DEFAULT_IMAGE_GENERATION_PROTOCOL
}

function normalizeModelProviderSpeechCapability(
  input: ModelProviderSpeechCapabilityPatchV1 | null | undefined
): ModelProviderSpeechCapabilityV1 | undefined {
  if (!input || typeof input !== 'object') return undefined
  const baseUrl = typeof input.baseUrl === 'string' && input.baseUrl.trim()
    ? normalizeDeepseekBaseUrl(input.baseUrl)
    : ''
  const models = normalizeProviderModels(input.models)
  if (!baseUrl && models.length === 0) return undefined
  return {
    protocol: normalizeSpeechToTextProtocol(input.protocol),
    baseUrl,
    models
  }
}

export function normalizeSpeechToTextProtocol(value: unknown): SpeechToTextProtocol {
  if (value === 'local-whisper') return 'local-whisper'
  if (value === 'mimo-asr') return 'mimo-asr'
  if (value === 'xai-stt') return 'xai-stt'
  if (value === 'gemini-audio') return 'gemini-audio'
  if (value === 'gemini-cli-audio') return 'gemini-cli-audio'
  return DEFAULT_SPEECH_TO_TEXT_PROTOCOL
}

function normalizeModelProviderTextToSpeechCapability(
  input: ModelProviderTextToSpeechCapabilityPatchV1 | null | undefined
): ModelProviderTextToSpeechCapabilityV1 | undefined {
  if (!input || typeof input !== 'object') return undefined
  const baseUrl = typeof input.baseUrl === 'string' && input.baseUrl.trim()
    ? normalizeDeepseekBaseUrl(input.baseUrl)
    : ''
  const models = normalizeProviderModels(input.models)
  if (!baseUrl && models.length === 0) return undefined
  return {
    protocol: normalizeTextToSpeechProtocol(input.protocol),
    baseUrl,
    models
  }
}

export function normalizeTextToSpeechProtocol(value: unknown): TextToSpeechProtocol {
  return value === 'minimax-t2a' || value === 'mimo-tts'
    ? value
    : DEFAULT_TEXT_TO_SPEECH_PROTOCOL
}

function normalizeModelProviderMusicCapability(
  input: ModelProviderMusicCapabilityPatchV1 | null | undefined
): ModelProviderMusicCapabilityV1 | undefined {
  if (!input || typeof input !== 'object') return undefined
  const baseUrl = typeof input.baseUrl === 'string' && input.baseUrl.trim()
    ? normalizeDeepseekBaseUrl(input.baseUrl)
    : ''
  const models = normalizeProviderModels(input.models)
  if (!baseUrl && models.length === 0) return undefined
  return {
    protocol: normalizeMusicGenerationProtocol(input.protocol),
    baseUrl,
    models
  }
}

export function normalizeMusicGenerationProtocol(value: unknown): MusicGenerationProtocol {
  return value === 'minimax-music' ? 'minimax-music' : DEFAULT_MUSIC_GENERATION_PROTOCOL
}

function normalizeModelProviderVideoCapability(
  input: ModelProviderVideoCapabilityPatchV1 | null | undefined
): ModelProviderVideoCapabilityV1 | undefined {
  if (!input || typeof input !== 'object') return undefined
  const baseUrl = typeof input.baseUrl === 'string' && input.baseUrl.trim()
    ? normalizeDeepseekBaseUrl(input.baseUrl)
    : ''
  const models = normalizeProviderModels(input.models)
  if (!baseUrl && models.length === 0) return undefined
  return {
    protocol: normalizeVideoGenerationProtocol(input.protocol),
    baseUrl,
    models
  }
}

export function normalizeVideoGenerationProtocol(value: unknown): VideoGenerationProtocol {
  if (value === 'grok-imagine-video') return 'grok-imagine-video'
  if (value === 'volcengine-ark-video') return 'volcengine-ark-video'
  return value === 'minimax-video' ? 'minimax-video' : DEFAULT_VIDEO_GENERATION_PROTOCOL
}

function normalizeModelProviderBaseUrl(value: unknown, fallback = DEFAULT_DEEPSEEK_BASE_URL): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed ? normalizeDeepseekBaseUrl(trimmed) : ''
}

function normalizeProviderModels(models: unknown): string[] {
  if (!Array.isArray(models)) return []
  const ids = new Set<string>()
  for (const model of models) {
    if (typeof model !== 'string') continue
    const trimmed = model.trim()
    if (trimmed) ids.add(trimmed)
  }
  return [...ids].sort((a, b) => a.localeCompare(b))
}

export function normalizeModelProviderId(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
    : ''
}

export function defaultNetworkProxySettings(): NetworkProxySettingsV1 {
  return {
    enabled: false,
    url: ''
  }
}

export function normalizeNetworkProxySettings(
  input: Partial<NetworkProxySettingsV1> | undefined
): NetworkProxySettingsV1 {
  // Keep the user's raw (only-trimmed) URL and the enable toggle exactly as
  // given. This normalizer runs on every keystroke (renderer `mergeSettings`),
  // so it must NOT validate/blank the URL here — doing so wiped each
  // half-typed value and made the proxy impossible to set (issue #600).
  // Validity is enforced lazily in `resolveModelProviderProxyUrl`.
  return {
    enabled: input?.enabled === true,
    url: typeof input?.url === 'string' ? input.url.trim() : ''
  }
}

export function normalizeProxyUrl(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return ''
  try {
    const parsed = new URL(raw)
    const protocol = parsed.protocol.replace(/:$/, '').toLowerCase()
    if (!NETWORK_PROXY_PROTOCOLS.includes(protocol as typeof NETWORK_PROXY_PROTOCOLS[number])) return ''
    // A hostname is required; the port is optional (the proxy agent falls back
    // to the protocol's default port) so URLs like `http://proxy.lan` work.
    if (!parsed.hostname) return ''
    return parsed.toString()
  } catch {
    return ''
  }
}

function normalizeModelKey(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}
