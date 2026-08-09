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

import {
  normalizeModelProviderId,
  normalizeMusicGenerationProtocol,
  normalizeSpeechToTextProtocol,
  normalizeTextToSpeechProtocol,
  normalizeVideoGenerationProtocol
} from './app-settings-provider-capabilities'
import {
  TEXT_TO_SPEECH_MODEL_PATTERN,
  getModelProviderSettings
} from './app-settings-provider-core'
import {
  canonicalBaseUrl,
  resolveProviderCapabilityModel,
  sameModelIds,
  tokenPlanPresetForProvider
} from './app-settings-provider-runtime'

export type MiniMaxMediaCapabilityKey = 'textToSpeech' | 'music' | 'video'

export type MiniMaxMediaCapability =
  | ModelProviderTextToSpeechCapabilityV1
  | ModelProviderMusicCapabilityV1
  | ModelProviderVideoCapabilityV1

export type TokenPlanCapabilityKey = 'image' | 'speech' | 'textToSpeech' | 'music' | 'video'

export type ProviderCapabilityWithBaseUrl = {
  protocol: string
  baseUrl: string
  models: readonly string[]
}

export type TokenPlanCapabilityWithOptionalBaseUrl = {
  protocol: string
  baseUrl?: string
  models: readonly string[]
}

export type KunMediaSettingCore = Partial<{
  enabled: boolean
  providerId: string
  baseUrl: string
  apiKey: string
  model: string
}>

export const MINIMAX_PROVIDER_ID = 'minimax'

export const MINIMAX_TOKEN_PLAN_PROVIDER_ID = `${MINIMAX_PROVIDER_ID}${TOKEN_PLAN_PROVIDER_ID_SUFFIX}`

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

export function isBlankKunMediaSetting(setting: KunMediaSettingCore | undefined): boolean {
  return setting?.enabled !== true &&
    !setting?.providerId?.trim() &&
    !setting?.baseUrl?.trim() &&
    !setting?.apiKey?.trim() &&
    !setting?.model?.trim()
}

export function configuredMiniMaxMediaCapability(
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

export function preferredMiniMaxMediaProviderIds(
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

export function providerWithPresetCapabilities(provider: ModelProviderProfileV1): ModelProviderProfileV1 {
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

export function modelProviderPresetProfileForProvider(provider: ModelProviderProfileV1): ModelProviderProfileV1 | null {
  const source = resolveModelProviderPresetSource(provider)
  return source?.mode === 'api' ? modelProviderPresetProfile(source.preset, provider.apiKey) : null
}

export function mergePresetCapability<T extends { baseUrl: string; models: string[] }>(
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

export function firstCapabilityModel(models: readonly string[]): string {
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

export function resolveProviderSpeechBaseUrl(
  provider: ModelProviderProfileV1,
  speech: ModelProviderSpeechCapabilityV1
): string {
  return resolveProviderCapabilityBaseUrl(provider, speech, 'speech')
}

export function resolveProviderCapabilityBaseUrl(
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

export function tokenPlanCapabilityForKey(
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

export function presetCapabilityForKey(
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

export function knownTokenPlanCapabilityBaseUrls(
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

export function deriveTokenPlanCapabilityBaseUrl(
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

export function urlOrigin(value: string | undefined): string | null {
  if (!value?.trim()) return null
  try {
    return new URL(value.trim()).origin
  } catch {
    return null
  }
}

export function replaceUrlOrigin(value: string, origin: string): string {
  try {
    const url = new URL(value.trim())
    const path = url.pathname.replace(/\/+$/, '')
    return `${origin}${path === '/' ? '' : path}${url.search}`
  } catch {
    return value.trim()
  }
}

export function resolveProviderSpeechModel(configuredModel: string, providerModels: readonly string[]): string {
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

export function resolveVideoProviderCapabilityModel(
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

export function normalizeResolvedVideoDefaults(
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
