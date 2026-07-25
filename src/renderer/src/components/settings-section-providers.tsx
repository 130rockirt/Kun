import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode
} from 'react'
import type {
  AppSettingsPatch,
  ImageGenerationProtocol,
  KunRuntimeSettingsPatchV1,
  KunRuntimeSettingsV1,
  MusicGenerationProtocol,
  ModelEndpointFormat,
  ModelProviderImageCapabilityV1,
  ModelProviderModelProfileV1,
  ModelProviderPresetMode,
  ModelProviderMusicCapabilityV1,
  ModelProviderProfileV1,
  ModelProviderSettingsV1,
  ModelProviderSpeechCapabilityV1,
  ModelProviderTextToSpeechCapabilityV1,
  ModelProviderVideoCapabilityV1,
  SpeechToTextProtocol,
  TextToSpeechProtocol,
  VideoGenerationProtocol
} from '@shared/app-settings'
import {
  DEFAULT_IMAGE_GENERATION_PROTOCOL,
  DEFAULT_MUSIC_GENERATION_PROTOCOL,
  DEFAULT_MODEL_PROVIDER_ID,
  DEFAULT_SPEECH_TO_TEXT_PROTOCOL,
  DEFAULT_TEXT_TO_SPEECH_PROTOCOL,
  DEFAULT_VIDEO_GENERATION_PROTOCOL,
  MODEL_ENDPOINT_FORMATS,
  MODEL_PROVIDER_PRESETS,
  defaultMiniMaxMediaGenerationKunPatch,
  defaultModelRequestRetrySettings,
  defaultModelProviderSettings,
  isMultiAccountProviderPreset,
  modelProviderPresetAccountCount,
  modelProviderPresetAccountProfile,
  modelProviderPresetProfile,
  modelProviderRequiresApiKey,
  modelSupportsImageInput,
  modelProviderTokenPlanProfile,
  normalizeModelProviderId,
  resolveModelProviderPresetSource,
  tokenPlanProviderId
} from '@shared/app-settings'
import type {
  ModelProviderPreset,
  ModelProviderSubscriptionRegion
} from '@shared/model-provider-presets'
import type {
  CursorSubscriptionModel,
  ModelsDevCatalogResult,
  ModelProviderProbeResult
} from '@shared/kun-gui-api'
import {
  AlertCircle,
  AudioLines,
  CheckCircle2,
  ChevronDown,
  Clapperboard,
  Download,
  ExternalLink,
  Image as ImageIcon,
  KeyRound,
  Loader2,
  Lock,
  LogIn,
  Mic,
  Music2,
  PlugZap,
  Plus,
  Search,
  SlidersHorizontal,
  Trash2,
  X
} from 'lucide-react'
import {
  InlineNoticeView,
  SecretInput,
  Toggle,
  type InlineNotice
} from './settings-controls'
import { classifyProviderModelIds, providerModelListEntries } from './provider-model-editor'
import { ProviderModelsManager } from './settings-section-provider-models'
import { ModelRoutesSettings } from './settings-section-model-routes'
import { ClaudeSubscriptionSection } from './claude-subscription-section'
import {
  ProviderModelImportDialog,
  type ProviderModelImportResult
} from './provider-model-import-dialog'
import {
  enrichCursorProviderModelProfiles,
  enrichProviderModelProfiles,
  mergeProviderModelIdsCaseInsensitive as mergeProviderModelIds
} from './provider-model-import'

const MODEL_ENDPOINT_FORMAT_LABEL_KEYS: Record<ModelEndpointFormat, string> = {
  chat_completions: 'modelEndpointChatCompletions',
  responses: 'modelEndpointResponses',
  messages: 'modelEndpointMessages',
  custom_endpoint: 'modelEndpointCustomEndpoint'
}

const IMAGE_GENERATION_PROTOCOL_LABEL_KEYS: Record<ImageGenerationProtocol, string> = {
  'openai-images': 'imageGenProtocolOpenAi',
  'minimax-image': 'imageGenProtocolMiniMax',
  'codex-responses-image': 'imageGenProtocolCodex',
  'grok-imagine-image': 'imageGenProtocolGrok'
}

const SPEECH_TO_TEXT_PROTOCOL_LABEL_KEYS: Partial<Record<SpeechToTextProtocol, string>> = {
  'openai-transcriptions': 'speechProtocolOpenAi',
  'mimo-asr': 'speechProtocolMimoAsr',
  'xai-stt': 'speechProtocolXaiStt',
  'gemini-audio': 'speechProtocolGeminiAudio',
  'gemini-cli-audio': 'speechProtocolGeminiCliAudio'
}

const TEXT_TO_SPEECH_PROTOCOL_LABEL_KEYS: Record<TextToSpeechProtocol, string> = {
  'openai-speech': 'textToSpeechProtocolOpenAi',
  'minimax-t2a': 'textToSpeechProtocolMiniMax',
  'mimo-tts': 'textToSpeechProtocolMimo'
}

const MUSIC_GENERATION_PROTOCOL_LABEL_KEYS: Record<MusicGenerationProtocol, string> = {
  'minimax-music': 'musicGenerationProtocolMiniMax'
}

const VIDEO_GENERATION_PROTOCOL_LABEL_KEYS: Record<VideoGenerationProtocol, string> = {
  'minimax-video': 'videoGenerationProtocolMiniMax',
  'grok-imagine-video': 'videoGenerationProtocolGrok'
}

type ProviderTaskTab = 'connection' | 'models' | 'capabilities' | 'advanced'
type ProviderCapability = 'image' | 'speech' | 'tts' | 'music' | 'video'
type SubscriptionRegionFilter = 'all' | ModelProviderSubscriptionRegion

const PROVIDER_TASK_TABS: Array<{ id: ProviderTaskTab; labelKey: string }> = [
  { id: 'connection', labelKey: 'modelProviderTabConnection' },
  { id: 'models', labelKey: 'modelProviderTabModels' },
  { id: 'capabilities', labelKey: 'modelProviderTabCapabilities' },
  { id: 'advanced', labelKey: 'modelProviderTabAdvanced' }
]

const SUBSCRIPTION_REGION_TABS: Array<{
  id: SubscriptionRegionFilter
  labelKey: string
}> = [
  { id: 'all', labelKey: 'modelProviderSubscriptionRegionAll' },
  { id: 'china', labelKey: 'modelProviderSubscriptionRegionChina' },
  { id: 'united-states', labelKey: 'modelProviderSubscriptionRegionUnitedStates' }
]

export function modelProvidersSettingsPatch(input: {
  provider: ModelProviderSettingsV1
  providers: ModelProviderProfileV1[]
  kun?: KunRuntimeSettingsPatchV1
  currentKun?: Partial<KunRuntimeSettingsV1>
}): AppSettingsPatch {
  const defaultProvider = input.providers.find((item) => item.id === DEFAULT_MODEL_PROVIDER_ID)
  const miniMaxMediaDefaults = defaultMiniMaxMediaGenerationKunPatch({
    providers: input.providers,
    currentKun: input.currentKun,
    kunPatch: input.kun
  })
  const baseKunPatch = input.kun?.providerId?.trim()
    ? { ...input.kun, apiKey: '', baseUrl: '' }
    : input.kun ?? {}
  const kunPatch = {
    ...baseKunPatch,
    ...(miniMaxMediaDefaults ?? {})
  }
  return {
    provider: {
      apiKey: defaultProvider?.apiKey ?? input.provider.apiKey,
      baseUrl: defaultProvider?.baseUrl ?? input.provider.baseUrl,
      proxy: input.provider.proxy,
      providers: input.providers,
      routePools: input.provider.routePools,
      localGateway: input.provider.localGateway
    },
    ...(Object.keys(kunPatch).length > 0 ? { agents: { kun: kunPatch } } : {})
  }
}

function tokenPlanPresetForProfile(
  provider: Pick<ModelProviderProfileV1, 'id' | 'presetSource'>
): ModelProviderPreset | null {
  const source = resolveModelProviderPresetSource(provider)
  return source?.mode === 'token-plan' ? source.preset : null
}

// 「套餐订阅」组 = Token Plan 套餐档(<id>-token-plan)或本身就是订阅制的预设(category==='subscription');
// 其余(默认 / 按量预设 / 自定义)归入「按量 API」组,便于一眼分辨两类计费方式。
function isAgentSdkProvider(provider: ModelProviderProfileV1): boolean {
  return provider.kind === 'agent-sdk'
}

function isCursorSubscriptionProvider(provider: ModelProviderProfileV1): boolean {
  return provider.kind === 'cursor-sdk'
}

const CURSOR_SUBSCRIPTION_DISCOVERY_CHANNEL = 'cursor-subscription:discover'

function cursorSubscriptionDiscoveryErrorMessage(
  error: unknown,
  bridgeUnavailableMessage: string
): string {
  const message = error instanceof Error ? error.message : String(error)
  if (
    message.includes(`No handler registered for '${CURSOR_SUBSCRIPTION_DISCOVERY_CHANNEL}'`)
    || message.includes(`No bridge registered for '${CURSOR_SUBSCRIPTION_DISCOVERY_CHANNEL}'`)
    || /cursorSubscriptionDiscover.*not a function/i.test(message)
  ) {
    return bridgeUnavailableMessage
  }
  return message
}

function isDelegatedEndpointProvider(provider: ModelProviderProfileV1): boolean {
  return isAgentSdkProvider(provider)
    || isGeminiSubscriptionProvider(provider)
    || isGeminiCliApiSubscriptionProvider(provider)
    || isCursorSubscriptionProvider(provider)
}

function isSubscriptionProvider(
  provider: Pick<ModelProviderProfileV1, 'id' | 'presetSource'>
): boolean {
  const source = resolveModelProviderPresetSource(provider)
  return source?.mode === 'token-plan' || source?.preset.category === 'subscription'
}

function addedModelCount(current: readonly string[], next: readonly string[]): number {
  const currentIds = new Set(current.map((model) => model.trim().toLowerCase()).filter(Boolean))
  return next.filter((model) => {
    const id = model.trim().toLowerCase()
    return id && !currentIds.has(id)
  }).length
}

function providerModelCount(provider: ModelProviderProfileV1): number {
  return providerModelListEntries(provider).length
}

function defaultImageCapability(baseUrl: string): ModelProviderImageCapabilityV1 {
  return {
    protocol: DEFAULT_IMAGE_GENERATION_PROTOCOL,
    baseUrl: baseUrl.trim(),
    models: []
  }
}

function defaultSpeechCapability(baseUrl: string): ModelProviderSpeechCapabilityV1 {
  return {
    protocol: DEFAULT_SPEECH_TO_TEXT_PROTOCOL,
    baseUrl: baseUrl.trim(),
    models: []
  }
}

function defaultTextToSpeechCapability(baseUrl: string): ModelProviderTextToSpeechCapabilityV1 {
  return {
    protocol: DEFAULT_TEXT_TO_SPEECH_PROTOCOL,
    baseUrl: baseUrl.trim(),
    models: []
  }
}

function defaultMusicCapability(baseUrl: string): ModelProviderMusicCapabilityV1 {
  return {
    protocol: DEFAULT_MUSIC_GENERATION_PROTOCOL,
    baseUrl: baseUrl.trim(),
    models: []
  }
}

function defaultVideoCapability(baseUrl: string): ModelProviderVideoCapabilityV1 {
  return {
    protocol: DEFAULT_VIDEO_GENERATION_PROTOCOL,
    baseUrl: baseUrl.trim(),
    models: []
  }
}

function profileForModel(
  provider: Pick<ModelProviderProfileV1, 'modelProfiles'>,
  model: string
): ModelProviderModelProfileV1 | undefined {
  const trimmed = model.trim()
  if (!trimmed) return undefined
  return provider.modelProfiles[trimmed.toLowerCase()] ?? provider.modelProfiles[trimmed]
}

function cursorProviderNeedsMetadataRepair(provider: ModelProviderProfileV1): boolean {
  if (!isCursorSubscriptionProvider(provider)) return false
  return provider.models.some((model) => {
    if (model.trim().toLowerCase() === 'auto') return false
    const profile = profileForModel(provider, model)
    return !profile || (
      profile.contextWindowTokens === undefined
      && profile.maxOutputTokens === undefined
    ) || !profile.reasoning
  })
}

function presetProfileForProvider(provider: ModelProviderProfileV1): ModelProviderProfileV1 | null {
  const source = resolveModelProviderPresetSource(provider)
  if (!source) return null
  return source.mode === 'token-plan'
    ? modelProviderTokenPlanProfile(source.preset, '', provider.baseUrl)
    : modelProviderPresetProfile(source.preset)
}

function presetImageCapability(provider: ModelProviderProfileV1): ModelProviderImageCapabilityV1 | null {
  return presetProfileForProvider(provider)?.image ?? null
}

function presetSpeechCapability(provider: ModelProviderProfileV1): ModelProviderSpeechCapabilityV1 | null {
  return presetProfileForProvider(provider)?.speech ?? null
}

function presetTextToSpeechCapability(provider: ModelProviderProfileV1): ModelProviderTextToSpeechCapabilityV1 | null {
  return presetProfileForProvider(provider)?.textToSpeech ?? null
}

function presetMusicCapability(provider: ModelProviderProfileV1): ModelProviderMusicCapabilityV1 | null {
  return presetProfileForProvider(provider)?.music ?? null
}

function presetVideoCapability(provider: ModelProviderProfileV1): ModelProviderVideoCapabilityV1 | null {
  return presetProfileForProvider(provider)?.video ?? null
}

function isAcceptableHttpUrl(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return true
  if (!/^https?:\/\//i.test(trimmed)) return false
  try {
    new URL(trimmed)
    return true
  } catch {
    return false
  }
}

function providerConnectionFingerprint(provider: ModelProviderProfileV1): string {
  return [provider.baseUrl, provider.apiKey, provider.endpointFormat].join('\0')
}

type ProbeState = {
  fingerprint: string
  mode: 'test' | 'fetch'
  status: 'busy' | 'ok' | 'error'
  latencyMs?: number
  total?: number
  message?: string
}

function isCodexProvider(provider: Pick<ModelProviderProfileV1, 'id' | 'presetSource'>): boolean {
  return resolveModelProviderPresetSource(provider)?.preset.id === 'codex'
}

function isGrokSubscriptionProvider(provider: Pick<ModelProviderProfileV1, 'id' | 'presetSource'>): boolean {
  return resolveModelProviderPresetSource(provider)?.preset.id === 'grok-subscription'
}

function isGeminiSubscriptionProvider(provider: Pick<ModelProviderProfileV1, 'id' | 'presetSource'>): boolean {
  return resolveModelProviderPresetSource(provider)?.preset.id === 'gemini-subscription'
}

function isGeminiCliApiSubscriptionProvider(
  provider: Pick<ModelProviderProfileV1, 'id' | 'presetSource'>
): boolean {
  return resolveModelProviderPresetSource(provider)?.preset.id === 'gemini-cli-subscription'
}

function isOAuthSubscriptionProvider(provider: Pick<ModelProviderProfileV1, 'id' | 'presetSource'>): boolean {
  return isCodexProvider(provider)
    || isGrokSubscriptionProvider(provider)
    || isGeminiSubscriptionProvider(provider)
    || isGeminiCliApiSubscriptionProvider(provider)
}

function parseCodexEmail(apiKey: string): string | undefined {
  if (!apiKey.startsWith('{')) return undefined
  try {
    const parsed = JSON.parse(apiKey) as Record<string, unknown>
    if (parsed.kind === 'codex-oauth' && typeof parsed.email === 'string') return parsed.email
    if (parsed.kind === 'codex-oauth') return parsed.accountId as string
  } catch { /* ignore */ }
  return undefined
}

function parseGrokIdentity(apiKey: string): string | undefined {
  if (!apiKey.startsWith('{')) return undefined
  try {
    const parsed = JSON.parse(apiKey) as Record<string, unknown>
    if (parsed.kind !== 'grok-oauth') return undefined
    if (typeof parsed.email === 'string' && parsed.email) return parsed.email
    if (typeof parsed.userId === 'string' && parsed.userId) return parsed.userId
  } catch { /* ignore */ }
  return undefined
}

type CodexLoginPhase = 'idle' | 'browser' | 'device-starting' | 'polling' | 'error'

function CodexLoginSection({
  provider,
  onCredentialChange,
  t
}: {
  provider: ModelProviderProfileV1
  onCredentialChange: (apiKey: string) => void
  t: (key: string, params?: Record<string, unknown>) => string
}): ReactElement {
  const [phase, setPhase] = useState<CodexLoginPhase>('idle')
  const [userCode, setUserCode] = useState('')
  const [verifyUrl, setVerifyUrl] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState<InlineNotice | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const loginRunRef = useRef(0)
  const codexEmail = parseCodexEmail(provider.apiKey)
  const connected = Boolean(codexEmail)

  const clearPoll = (): void => {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = null
  }

  const beginLoginRun = (): number => {
    clearPoll()
    loginRunRef.current += 1
    return loginRunRef.current
  }

  const isCurrentLoginRun = (runId: number): boolean => loginRunRef.current === runId

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
      loginRunRef.current += 1
    }
  }, [])

  const startDeviceCodeLogin = async ({
    runId = beginLoginRun(),
    fallbackNotice = null
  }: {
    runId?: number
    fallbackNotice?: InlineNotice | null
  } = {}): Promise<void> => {
    if (typeof window.kunGui?.startCodexAuth !== 'function') {
      if (!isCurrentLoginRun(runId)) return
      setPhase('error')
      setError('ChatGPT 订阅登录不可用，请重启应用')
      setNotice(null)
      return
    }
    setPhase('device-starting')
    setError('')
    setNotice(fallbackNotice)
    try {
      const result = await window.kunGui.startCodexAuth()
      if (!isCurrentLoginRun(runId)) return
      if (!result.ok) {
        setPhase('error')
        setError(result.message)
        setNotice(null)
        return
      }
      setUserCode(result.userCode)
      setVerifyUrl(result.url)
      setPhase('polling')
      const deviceCode = result.deviceCode
      const uc = result.userCode
      const interval = Math.max(result.interval, 2) * 1000
      clearPoll()
      pollRef.current = setInterval(async () => {
        if (!isCurrentLoginRun(runId)) {
          clearPoll()
          return
        }
        if (typeof window.kunGui?.pollCodexAuth !== 'function') return
        try {
          const poll = await window.kunGui.pollCodexAuth(deviceCode, uc)
          if (!isCurrentLoginRun(runId)) return
          if (poll.done) {
            clearPoll()
            setNotice(null)
            onCredentialChange(JSON.stringify(poll.credentials))
            setPhase('idle')
          } else if (poll.error) {
            clearPoll()
            setPhase('error')
            setError(poll.error)
            setNotice(null)
          }
        } catch (pollError) {
          if (!isCurrentLoginRun(runId)) return
          clearPoll()
          setPhase('error')
          setError(pollError instanceof Error ? pollError.message : String(pollError))
          setNotice(null)
        }
      }, interval)
    } catch (err) {
      if (!isCurrentLoginRun(runId)) return
      setPhase('error')
      setError(err instanceof Error ? err.message : String(err))
      setNotice(null)
    }
  }

  const startBrowserLogin = async (): Promise<void> => {
    const runId = beginLoginRun()
    if (typeof window.kunGui?.startCodexBrowserAuth !== 'function') {
      setPhase('error')
      setError('ChatGPT 订阅浏览器登录不可用，请重启应用')
      setNotice(null)
      return
    }
    setPhase('browser')
    setError('')
    setNotice(null)
    try {
      const result = await window.kunGui.startCodexBrowserAuth()
      if (!isCurrentLoginRun(runId)) return
      if (result.ok) {
        setNotice(null)
        onCredentialChange(JSON.stringify(result.credentials))
        setPhase('idle')
      } else if (result.code === 'port_in_use') {
        await startDeviceCodeLogin({
          runId,
          fallbackNotice: {
            tone: 'info',
            message: t('codexLoginPortBusyFallback')
          }
        })
      } else {
        setPhase('error')
        setError(result.message)
      }
    } catch (err) {
      if (!isCurrentLoginRun(runId)) return
      setPhase('error')
      setError(err instanceof Error ? err.message : String(err))
      setNotice(null)
    }
  }

  const cancelLogin = (): void => {
    loginRunRef.current += 1
    clearPoll()
    setPhase('idle')
    setError('')
    setNotice(null)
  }

  const disconnect = (): void => {
    loginRunRef.current += 1
    clearPoll()
    onCredentialChange('')
    setPhase('idle')
    setUserCode('')
    setVerifyUrl('')
    setNotice(null)
  }

  const openVerifyUrl = (): void => {
    if (!verifyUrl) return
    if (typeof window.kunGui?.openExternal === 'function') {
      void window.kunGui.openExternal(verifyUrl).catch(() => {
        window.open(verifyUrl, '_blank', 'noopener,noreferrer')
      })
      return
    }
    window.open(verifyUrl, '_blank', 'noopener,noreferrer')
  }

  if (connected) {
    return (
      <div className="flex items-center gap-2">
        <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
        <span className="text-[13px] text-ds-ink">{codexEmail}</span>
        <button
          type="button"
          className="ml-auto rounded-lg px-3 py-1.5 text-[12px] font-medium text-ds-muted hover:bg-ds-hover"
          onClick={disconnect}
        >
          {t('codexDisconnect')}
        </button>
      </div>
    )
  }

  if (phase === 'browser') {
    return (
      <div className="grid gap-2">
        <p className="text-[13px] text-ds-muted">{t('codexBrowserOpened')}</p>
        <div className="flex items-center gap-1.5 text-[12px] text-ds-muted">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('codexWaitingAuth')}
        </div>
        <button
          type="button"
          className="w-fit text-[12px] font-medium text-ds-muted hover:text-ds-ink"
          onClick={cancelLogin}
        >
          {t('codexCancel')}
        </button>
      </div>
    )
  }

  if (phase === 'device-starting') {
    return (
      <div className="grid gap-2">
        {notice ? <InlineNoticeView notice={notice} /> : null}
        <div className="flex items-center gap-1.5 text-[12px] text-ds-muted">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('codexPreparingDeviceLogin')}
        </div>
        <button
          type="button"
          className="w-fit text-[12px] font-medium text-ds-muted hover:text-ds-ink"
          onClick={cancelLogin}
        >
          {t('codexCancel')}
        </button>
      </div>
    )
  }

  if (phase === 'polling') {
    return (
      <div className="grid gap-2">
        {notice ? <InlineNoticeView notice={notice} /> : null}
        <p className="text-[13px] text-ds-muted">{t('codexEnterCode')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded-lg bg-ds-hover px-3 py-1.5 text-[16px] font-mono font-bold tracking-widest text-ds-ink">
            {userCode}
          </code>
          <button
            type="button"
            className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-accent/10 px-3 py-1.5 text-[12px] font-medium text-accent transition hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
            onClick={openVerifyUrl}
            disabled={!verifyUrl}
          >
            <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.9} />
            {t('codexOpenBrowser')}
          </button>
        </div>
        <div className="flex items-center gap-1.5 text-[12px] text-ds-muted">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('codexWaitingAuth')}
        </div>
        <button
          type="button"
          className="w-fit text-[12px] font-medium text-ds-muted hover:text-ds-ink"
          onClick={cancelLogin}
        >
          {t('codexCancel')}
        </button>
      </div>
    )
  }

  return (
    <div className="grid gap-2">
      <button
        type="button"
        className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-[14px] font-semibold text-white shadow-sm transition hover:bg-accent/90"
        onClick={startBrowserLogin}
      >
        <LogIn className="h-4 w-4" strokeWidth={1.9} />
        {t('codexLoginButton')}
      </button>
      <button
        type="button"
        className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-ds-border bg-ds-card px-4 py-2 text-[12px] font-medium text-ds-muted transition hover:bg-ds-hover"
        onClick={() => void startDeviceCodeLogin()}
      >
        <KeyRound className="h-3.5 w-3.5" strokeWidth={1.9} />
        {t('codexLoginDeviceCodeFallback')}
      </button>
      {phase === 'error' && error ? (
        <InlineNoticeView notice={{ tone: 'error', message: error }} />
      ) : null}
    </div>
  )
}

type GrokLoginPhase = 'idle' | 'browser' | 'error'

function GrokLoginSection({
  provider,
  onCredentialChange,
  t
}: {
  provider: ModelProviderProfileV1
  onCredentialChange: (apiKey: string) => void
  t: (key: string, params?: Record<string, unknown>) => string
}): ReactElement {
  const [phase, setPhase] = useState<GrokLoginPhase>('idle')
  const [error, setError] = useState('')
  const [pasteCode, setPasteCode] = useState('')
  const [pasteBusy, setPasteBusy] = useState(false)
  const loginRunRef = useRef(0)
  const identity = parseGrokIdentity(provider.apiKey)
  const connected = Boolean(identity)

  const beginLoginRun = (): number => {
    loginRunRef.current += 1
    return loginRunRef.current
  }

  const isCurrentLoginRun = (runId: number): boolean => loginRunRef.current === runId

  useEffect(() => {
    return () => {
      loginRunRef.current += 1
      void window.kunGui?.cancelGrokBrowserAuth?.()
    }
  }, [])

  const startBrowserLogin = async (): Promise<void> => {
    const runId = beginLoginRun()
    if (typeof window.kunGui?.startGrokBrowserAuth !== 'function') {
      setPhase('error')
      setError('Grok 订阅浏览器登录不可用，请重启应用')
      return
    }
    setPhase('browser')
    setError('')
    setPasteCode('')
    setPasteBusy(false)
    try {
      // Blocks until loopback callback OR paste completion (Path A + B race).
      const result = await window.kunGui.startGrokBrowserAuth()
      if (!isCurrentLoginRun(runId)) return
      if (result.ok) {
        setPasteCode('')
        onCredentialChange(JSON.stringify(result.credentials))
        setPhase('idle')
      } else if (result.message === '已取消登录') {
        setPhase('idle')
        setError('')
      } else {
        setPhase('error')
        setError(result.message)
      }
    } catch (err) {
      if (!isCurrentLoginRun(runId)) return
      setPhase('error')
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPasteBusy(false)
    }
  }

  const submitPastedCode = async (): Promise<void> => {
    const code = pasteCode.trim()
    if (!code || pasteBusy) return
    if (typeof window.kunGui?.submitGrokBrowserAuthCode !== 'function') {
      setError('Grok 粘贴登录不可用，请重启应用')
      return
    }
    setPasteBusy(true)
    setError('')
    try {
      const result = await window.kunGui.submitGrokBrowserAuthCode(code)
      // On success, startGrokBrowserAuth's promise also resolves and the browser
      // phase handler will store credentials. On failure keep the paste form open.
      if (!result.ok) {
        setError(result.message)
        setPasteBusy(false)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPasteBusy(false)
    }
  }

  const cancelLogin = (): void => {
    loginRunRef.current += 1
    void window.kunGui?.cancelGrokBrowserAuth?.()
    setPhase('idle')
    setError('')
    setPasteCode('')
    setPasteBusy(false)
  }

  const disconnect = (): void => {
    loginRunRef.current += 1
    void window.kunGui?.cancelGrokBrowserAuth?.()
    onCredentialChange('')
    setPhase('idle')
    setPasteCode('')
  }

  if (connected) {
    return (
      <div className="flex items-center gap-2">
        <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
        <span className="text-[13px] text-ds-ink">{identity}</span>
        <button
          type="button"
          className="ml-auto rounded-lg px-3 py-1.5 text-[12px] font-medium text-ds-muted hover:bg-ds-hover"
          onClick={disconnect}
        >
          {t('grokDisconnect')}
        </button>
      </div>
    )
  }

  if (phase === 'browser') {
    return (
      <div className="grid gap-2">
        <p className="text-[13px] text-ds-muted">{t('grokBrowserOpened')}</p>
        <div className="flex items-center gap-1.5 text-[12px] text-ds-muted">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('grokWaitingAuth')}
        </div>
        <div className="grid gap-1.5 rounded-xl border border-ds-border bg-ds-card p-3">
          <p className="text-[12px] leading-5 text-ds-muted">{t('grokPasteCodeHint')}</p>
          <textarea
            className="min-h-[72px] w-full resize-y rounded-lg border border-ds-border bg-ds-main px-3 py-2 font-mono text-[12px] text-ds-ink shadow-sm focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30"
            value={pasteCode}
            spellCheck={false}
            placeholder={t('grokPasteCodePlaceholder')}
            onChange={(e) => setPasteCode(e.target.value)}
            disabled={pasteBusy}
          />
          <button
            type="button"
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[13px] font-semibold text-white transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => void submitPastedCode()}
            disabled={pasteBusy || !pasteCode.trim()}
          >
            {pasteBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {t('grokPasteCodeSubmit')}
          </button>
        </div>
        {error ? <InlineNoticeView notice={{ tone: 'error', message: error }} /> : null}
        <button
          type="button"
          className="w-fit text-[12px] font-medium text-ds-muted hover:text-ds-ink"
          onClick={cancelLogin}
        >
          {t('grokCancel')}
        </button>
      </div>
    )
  }

  return (
    <div className="grid gap-2">
      <button
        type="button"
        className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-[14px] font-semibold text-white shadow-sm transition hover:bg-accent/90"
        onClick={startBrowserLogin}
      >
        <LogIn className="h-4 w-4" strokeWidth={1.9} />
        {t('grokLoginButton')}
      </button>
      {phase === 'error' && error ? (
        <InlineNoticeView notice={{ tone: 'error', message: error }} />
      ) : null}
    </div>
  )
}

type GeminiCliState = 'checking' | 'missing' | 'downloading' | 'ready' | 'syncing'

function GeminiSubscriptionSection({
  onModelsChange,
  t
}: {
  onModelsChange: (models: string[]) => void
  t: (key: string, params?: Record<string, unknown>) => string
}): ReactElement {
  const [state, setState] = useState<GeminiCliState>('checking')
  const [progress, setProgress] = useState<{ received: number; total: number } | null>(null)
  const [notice, setNotice] = useState<InlineNotice | null>(null)

  const applyDownload = useCallback((
    download: { status: string; receivedBytes: number; totalBytes: number; message?: string } | null | undefined
  ): boolean => {
    if (!download) return false
    if (download.status === 'downloading') {
      setState('downloading')
      setProgress({ received: download.receivedBytes, total: download.totalBytes })
      return true
    }
    if (download.status === 'done') {
      setState('ready')
      setProgress(null)
      return true
    }
    if (download.status === 'error') {
      setState('missing')
      setProgress(null)
      setNotice({ tone: 'error', message: download.message ?? t('geminiCliInstallFailed') })
      return true
    }
    return false
  }, [t])

  const refreshStatus = useCallback(async (): Promise<void> => {
    try {
      const status = await window.kunGui.geminiSubscriptionCliStatus()
      if (status.installed) {
        setState('ready')
        setProgress(null)
      } else if (!applyDownload(status.download)) {
        setState('missing')
      }
    } catch (error) {
      setState('missing')
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : t('geminiCliInstallFailed')
      })
    }
  }, [applyDownload, t])

  useEffect(() => {
    void refreshStatus()
    return window.kunGui.onGeminiSubscriptionCliProgress((download) => {
      applyDownload(download)
      if (download.status === 'done') void refreshStatus()
    })
  }, [applyDownload, refreshStatus])

  const install = async (): Promise<void> => {
    setNotice(null)
    setState('downloading')
    setProgress({ received: 0, total: 0 })
    try {
      applyDownload(await window.kunGui.geminiSubscriptionCliInstall())
    } catch (error) {
      setState('missing')
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : t('geminiCliInstallFailed')
      })
    }
  }

  const syncModels = async (): Promise<void> => {
    setState('syncing')
    setNotice(null)
    try {
      const models = await window.kunGui.geminiSubscriptionModels()
      onModelsChange(models)
      setNotice({
        tone: 'success',
        message: t('geminiModelsSynced', { count: models.length })
      })
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : t('geminiModelsSyncFailed')
      })
    } finally {
      setState('ready')
    }
  }

  const percent = progress && progress.total > 0
    ? Math.min(100, Math.round((progress.received / progress.total) * 100))
    : 0
  const busy = state === 'checking' || state === 'downloading' || state === 'syncing'

  return (
    <div className="grid gap-3">
      <div className="grid gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2.5 text-[12px] leading-5 text-ds-muted">
        <p>{t('geminiSubscriptionNote')}</p>
        <p className="text-ds-ink/85">{t('geminiSubscriptionLimitations')}</p>
      </div>
      <div className="flex items-center gap-2 text-[13px] text-ds-ink">
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin text-ds-muted" strokeWidth={1.9} />
        ) : state === 'ready' ? (
          <CheckCircle2 className="h-4 w-4 text-emerald-500" strokeWidth={1.9} />
        ) : (
          <AlertCircle className="h-4 w-4 text-amber-500" strokeWidth={1.9} />
        )}
        <span>{state === 'ready' || state === 'syncing'
          ? t('geminiCliReady')
          : state === 'downloading'
            ? t('geminiCliDownloading')
            : state === 'checking'
              ? t('geminiCliChecking')
              : t('geminiCliMissing')}</span>
      </div>
      {state === 'downloading' ? (
        <div className="grid gap-1">
          <div className="h-1.5 overflow-hidden rounded-full bg-ds-hover">
            <div className="h-full bg-accent transition-all" style={{ width: `${percent}%` }} />
          </div>
          <span className="text-[11px] text-ds-faint">
            {progress?.total ? `${percent}%` : t('geminiCliDownloading')}
          </span>
        </div>
      ) : null}
      {state === 'missing' ? (
        <button
          type="button"
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-[14px] font-semibold text-white shadow-sm transition hover:bg-accent/90"
          onClick={() => void install()}
        >
          <Download className="h-4 w-4" strokeWidth={1.9} />
          {t('geminiCliInstall')}
        </button>
      ) : (
        <button
          type="button"
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-ds-border bg-ds-card px-4 py-2 text-[13px] font-medium text-ds-ink transition hover:bg-ds-hover disabled:opacity-60"
          onClick={() => void syncModels()}
          disabled={busy}
        >
          {state === 'syncing' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          {t('geminiSyncModels')}
        </button>
      )}
      {notice ? <InlineNoticeView notice={notice} /> : null}
    </div>
  )
}

function GeminiCliApiSubscriptionSection({
  onModelsChange,
  t
}: {
  onModelsChange: (models: string[]) => void
  t: (key: string, params?: Record<string, unknown>) => string
}): ReactElement {
  const [checking, setChecking] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [status, setStatus] = useState<{
    installed: boolean
    authenticated: boolean
    path?: string
    credentialSource?: 'keychain' | 'file'
  } | null>(null)
  const [notice, setNotice] = useState<InlineNotice | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setChecking(true)
    try {
      setStatus(await window.kunGui.geminiCliSubscriptionStatus())
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : t('geminiCliApiStatusFailed')
      })
    } finally {
      setChecking(false)
    }
  }, [t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const syncModels = async (): Promise<void> => {
    setSyncing(true)
    setNotice(null)
    try {
      const models = await window.kunGui.geminiCliSubscriptionModels()
      onModelsChange(models)
      setNotice({
        tone: 'success',
        message: t('geminiCliApiModelsSynced', { count: models.length })
      })
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : t('geminiCliApiModelsSyncFailed')
      })
    } finally {
      setSyncing(false)
    }
  }

  const ready = status?.authenticated === true
  return (
    <div className="grid gap-3">
      <p className="rounded-lg border border-ds-border bg-ds-main/30 px-3 py-2 text-[12px] leading-5 text-ds-muted">
        {t('geminiCliApiSubscriptionNote')}
      </p>
      <div className="flex items-center gap-2 text-[13px] text-ds-ink">
        {checking ? (
          <Loader2 className="h-4 w-4 animate-spin text-ds-muted" strokeWidth={1.9} />
        ) : ready ? (
          <CheckCircle2 className="h-4 w-4 text-emerald-500" strokeWidth={1.9} />
        ) : (
          <AlertCircle className="h-4 w-4 text-amber-500" strokeWidth={1.9} />
        )}
        <span>
          {checking
            ? t('geminiCliApiChecking')
            : ready
              ? t('geminiCliApiReady')
              : status?.installed
                ? t('geminiCliApiLoginRequired')
                : t('geminiCliApiMissing')}
        </span>
      </div>
      {!checking && !ready ? (
        <p className="text-[12px] leading-5 text-ds-muted">
          {status?.installed
            ? t('geminiCliApiLoginHint')
            : t('geminiCliApiInstallHint')}
        </p>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-2">
        <button
          type="button"
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-ds-border bg-ds-card px-4 py-2 text-[13px] font-medium text-ds-ink transition hover:bg-ds-hover disabled:opacity-60"
          onClick={() => void refresh()}
          disabled={checking}
        >
          {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
          {t('geminiCliApiRecheck')}
        </button>
        <button
          type="button"
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-ds-border bg-ds-card px-4 py-2 text-[13px] font-medium text-ds-ink transition hover:bg-ds-hover disabled:opacity-60"
          onClick={() => void syncModels()}
          disabled={syncing}
        >
          {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          {t('geminiCliApiSyncModels')}
        </button>
      </div>
      {notice ? <InlineNoticeView notice={notice} /> : null}
    </div>
  )
}

const fieldLabelClass = 'grid gap-1.5 text-[12px] font-semibold text-ds-muted'
const textInputClass =
  'w-full min-w-0 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[14px] font-normal text-ds-ink shadow-sm focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30'
const ENABLED_MODEL_REQUEST_RETRY_ATTEMPTS = 3

function retryStatusCodesText(codes: readonly number[] | undefined): string {
  return (codes?.length ? codes : defaultModelRequestRetrySettings().httpStatusCodes).join(',')
}

function providerRetrySettings(provider: ModelProviderProfileV1) {
  return provider.retry ?? defaultModelRequestRetrySettings()
}

function parseRetryStatusCodes(value: string): number[] {
  const codes = new Set<number>()
  for (const part of value.split(/[\s,]+/)) {
    const code = Number(part.trim())
    if (Number.isInteger(code) && code >= 400 && code <= 599) codes.add(code)
  }
  return codes.size > 0
    ? [...codes].sort((a, b) => a - b)
    : defaultModelRequestRetrySettings().httpStatusCodes
}

function DetailSection({
  title,
  action,
  children
}: {
  title: string
  action?: ReactNode
  children?: ReactNode
}): ReactElement {
  return (
    <section className="grid gap-3 border-t border-ds-border-muted pt-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[12.5px] font-semibold text-ds-muted">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

function StatusPill({
  tone,
  icon,
  children,
  title
}: {
  tone: 'success' | 'warning' | 'error' | 'muted'
  icon?: ReactNode
  children: ReactNode
  title?: string
}): ReactElement {
  const toneClass =
    tone === 'success'
      ? 'border-emerald-300/70 bg-emerald-50 text-emerald-700 dark:border-emerald-800/70 dark:bg-emerald-950/30 dark:text-emerald-300'
      : tone === 'warning'
        ? 'border-amber-300/70 bg-amber-50 text-amber-700 dark:border-amber-800/70 dark:bg-amber-950/30 dark:text-amber-300'
        : tone === 'error'
          ? 'border-red-300/70 bg-red-50 text-red-700 dark:border-red-800/70 dark:bg-red-950/30 dark:text-red-300'
          : 'border-ds-border-muted bg-ds-main/50 text-ds-muted'
  return (
    <span
      title={title}
      className={`inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-[11px] font-medium ${toneClass}`}
    >
      {icon}
      {children}
    </span>
  )
}

function CapabilitySection({
  capabilityId,
  icon,
  title,
  description,
  enabled,
  invalid,
  expanded,
  modelCountLabel,
  configureLabel,
  collapseLabel,
  enabledLabel,
  disabledLabel,
  needsConfigurationLabel,
  toggleDisabled = false,
  onToggle,
  onExpandedChange,
  children
}: {
  capabilityId: ProviderCapability
  icon: ReactNode
  title: string
  description: string
  enabled: boolean
  invalid?: boolean
  expanded: boolean
  modelCountLabel?: string
  configureLabel: string
  collapseLabel: string
  enabledLabel: string
  disabledLabel: string
  needsConfigurationLabel: string
  toggleDisabled?: boolean
  onToggle: (enabled: boolean) => void
  onExpandedChange: (expanded: boolean) => void
  children: ReactNode
}): ReactElement {
  return (
    <section className={`rounded-2xl border bg-ds-card transition ${
      enabled ? 'border-ds-border shadow-sm' : 'border-ds-border-muted'
    }`}>
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3.5">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl ${
            enabled ? 'bg-accent/10 text-accent' : 'bg-ds-main text-ds-faint'
          }`}>
            {icon}
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[13px] font-semibold text-ds-ink">{title}</h3>
              <StatusPill tone={invalid ? 'warning' : enabled ? 'success' : 'muted'}>
                {invalid ? needsConfigurationLabel : enabled ? enabledLabel : disabledLabel}
              </StatusPill>
              {modelCountLabel ? (
                <span className="text-[11.5px] text-ds-faint">{modelCountLabel}</span>
              ) : null}
            </div>
            <p className="mt-1 text-[12px] leading-5 text-ds-faint">{description}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            disabled={!enabled}
            aria-expanded={enabled && expanded}
            aria-controls={`provider-capability-${capabilityId}`}
            aria-label={`${expanded ? collapseLabel : configureLabel}: ${title}`}
            onClick={() => onExpandedChange(!expanded)}
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-ds-border bg-ds-card px-3 text-[12px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" strokeWidth={1.9} />
            {expanded ? collapseLabel : configureLabel}
          </button>
          <Toggle
            checked={enabled}
            onChange={onToggle}
            disabled={toggleDisabled}
            ariaLabel={title}
          />
        </div>
      </div>
      {enabled && expanded ? (
        <div id={`provider-capability-${capabilityId}`} className="border-t border-ds-border-muted px-4 py-4">
          {children}
        </div>
      ) : null}
    </section>
  )
}

function ProviderBadge({
  tone,
  children
}: {
  tone: 'accent' | 'warning'
  children: ReactNode
}): ReactElement {
  const toneClass =
    tone === 'accent'
      ? 'border-emerald-300/70 bg-emerald-50 text-emerald-700 dark:border-emerald-800/70 dark:bg-emerald-950/30 dark:text-emerald-300'
      : 'border-amber-300/70 bg-amber-50 text-amber-700 dark:border-amber-800/70 dark:bg-amber-950/30 dark:text-amber-300'
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 ${toneClass}`}>
      {children}
    </span>
  )
}

function ProviderListGroup({
  label,
  count,
  children
}: {
  label: string
  count: number
  children: ReactNode
}): ReactElement {
  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-2 px-1">
        <span className="text-[11.5px] font-semibold text-ds-muted">{label}</span>
        <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-ds-main/60 px-1.5 text-[10.5px] font-medium text-ds-faint">
          {count}
        </span>
      </div>
      {children}
    </div>
  )
}

function ModelChipsInput({
  values,
  onChange,
  placeholder,
  inputAriaLabel,
  removeLabel
}: {
  values: string[]
  onChange: (next: string[]) => void
  placeholder: string
  inputAriaLabel: string
  removeLabel: (model: string) => string
}): ReactElement {
  const [draft, setDraft] = useState('')

  const commit = (raw: string): void => {
    const ids = raw.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean)
    setDraft('')
    if (ids.length === 0) return
    const seen = new Set(values)
    const next = [...values]
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      next.push(id)
    }
    if (next.length !== values.length) onChange(next)
  }

  const removeAt = (index: number): void => {
    onChange(values.filter((_, i) => i !== index))
  }

  return (
    <div className="flex w-full min-w-0 flex-wrap items-center gap-1.5 rounded-xl border border-ds-border bg-ds-card px-2 py-1.5 shadow-sm focus-within:border-accent/40 focus-within:ring-1 focus-within:ring-accent/30">
      {values.map((model, index) => (
        <span
          key={`${model}-${index}`}
          className="inline-flex max-w-full items-center gap-1 rounded-full border border-ds-border-muted bg-ds-main/60 py-0.5 pl-2.5 pr-1 font-mono text-[12px] text-ds-ink"
        >
          <span className="truncate">{model}</span>
          <button
            type="button"
            aria-label={removeLabel(model)}
            onClick={() => removeAt(index)}
            className="rounded-full p-0.5 text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
          >
            <X className="h-3 w-3" strokeWidth={2} />
          </button>
        </span>
      ))}
      <input
        className="min-w-[150px] flex-1 bg-transparent px-1 py-1 font-mono text-[12.5px] font-normal text-ds-ink placeholder:text-ds-faint focus:outline-none"
        value={draft}
        placeholder={placeholder}
        aria-label={inputAriaLabel}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault()
            commit(draft)
          } else if (e.key === 'Backspace' && !draft && values.length > 0) {
            e.preventDefault()
            removeAt(values.length - 1)
          }
        }}
        onBlur={() => commit(draft)}
        onPaste={(e) => {
          const text = e.clipboardData.getData('text')
          if (/[\s,]/.test(text)) {
            e.preventDefault()
            commit(`${draft} ${text}`)
          }
        }}
      />
    </div>
  )
}

export function ProvidersSettingsSection({ ctx }: { ctx: Record<string, any> }): ReactElement {
  const {
    t,
    form,
    provider: providerFromContext,
    kun,
    update,
    showApiKey,
    setShowApiKey,
    selectControlClass,
    saveStatus,
    saveError,
    retrySave
  } = ctx
  const provider = providerFromContext ?? defaultModelProviderSettings()
  const modelProviders = provider.providers as ModelProviderProfileV1[]
  const [selectedProviderId, setSelectedProviderId] = useState<string>(
    kun.providerId?.trim() || modelProviders[0]?.id || DEFAULT_MODEL_PROVIDER_ID
  )
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [addProviderQuery, setAddProviderQuery] = useState('')
  const [subscriptionRegion, setSubscriptionRegion] = useState<SubscriptionRegionFilter>('all')
  const [providerListQuery, setProviderListQuery] = useState('')
  const [activeTab, setActiveTab] = useState<ProviderTaskTab>('connection')
  const [workspaceMode, setWorkspaceMode] = useState<'providers' | 'routes'>('providers')
  const [expandedCapabilities, setExpandedCapabilities] = useState<Set<ProviderCapability>>(new Set())
  const addProviderButtonRef = useRef<HTMLButtonElement>(null)
  const addProviderDialogRef = useRef<HTMLElement>(null)
  const previousProviderSelectionRef = useRef<string | null>(null)
  useEffect(() => {
    if (!addMenuOpen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setAddMenuOpen(false)
        addProviderButtonRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [addMenuOpen])
  const [probeStates, setProbeStates] = useState<Record<string, ProbeState>>({})
  const [cursorAccounts, setCursorAccounts] = useState<Record<string, {
    fingerprint: string
    label: string
    apiKeyName: string
  }>>({})
  // Pending import dialog: when /v1/models returns hundreds of entries we want
  // the user to choose which ones to keep instead of dropping the whole list
  // into settings and forcing them to delete unwanted models one-by-one (#397).
  const [pendingImport, setPendingImport] = useState<
    | {
        providerId: string
        providerModelIds: string[]
        modelAliases?: Record<string, string[]>
        catalogResult: ModelsDevCatalogResult
        providerError?: string
        authoritative?: boolean
      }
    | null
  >(null)
  const cursorMetadataRepairAttempts = useRef(new Set<string>())
  // 新增供应商先停留在本地草稿,点「添加」才写入设置,避免半配置状态被持久化。
  const [draftProvider, setDraftProvider] = useState<ModelProviderProfileV1 | null>(null)
  const displayProviders = draftProvider ? [...modelProviders, draftProvider] : modelProviders
  const activeProvider =
    displayProviders.find((item) => item.id === selectedProviderId) ??
    modelProviders[0]
  const activeRetry = activeProvider ? providerRetrySettings(activeProvider) : defaultModelRequestRetrySettings()
  const isDraftActive = Boolean(draftProvider && activeProvider?.id === draftProvider.id)
  const canEditActiveProviderId = Boolean(
    activeProvider &&
    activeProvider.id !== DEFAULT_MODEL_PROVIDER_ID &&
    !resolveModelProviderPresetSource(activeProvider)
  )
  const activeKunProviderId: string = kun.providerId?.trim() || DEFAULT_MODEL_PROVIDER_ID
  const providerProxy = provider.proxy ?? { enabled: false, url: '' }

  const updateProviderProxy = (patch: Partial<typeof providerProxy>): void => {
    update({
      provider: {
        proxy: {
          ...providerProxy,
          ...patch
        }
      }
    })
  }

  const setCapabilityExpanded = (capability: ProviderCapability, expanded: boolean): void => {
    setExpandedCapabilities((current) => {
      const next = new Set(current)
      if (expanded) next.add(capability)
      else next.delete(capability)
      return next
    })
  }

  const openAddProviderDialog = (): void => {
    setAddProviderQuery('')
    setSubscriptionRegion('all')
    setAddMenuOpen(true)
  }

  const closeAddProviderDialog = (): void => {
    setAddMenuOpen(false)
    window.setTimeout(() => addProviderButtonRef.current?.focus(), 0)
  }

  const handleAddProviderDialogKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Tab' || !addProviderDialogRef.current) return
    const focusable = Array.from(addProviderDialogRef.current.querySelectorAll<HTMLElement>([
      'button:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      'a[href]'
    ].join(','))).filter((element) => element.getClientRects().length > 0)
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const handleSubscriptionRegionTabKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    currentRegion: SubscriptionRegionFilter
  ): void => {
    const currentIndex = SUBSCRIPTION_REGION_TABS.findIndex((tab) => tab.id === currentRegion)
    let nextIndex = currentIndex
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % SUBSCRIPTION_REGION_TABS.length
    else if (event.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + SUBSCRIPTION_REGION_TABS.length) % SUBSCRIPTION_REGION_TABS.length
    } else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = SUBSCRIPTION_REGION_TABS.length - 1
    else return

    event.preventDefault()
    setSubscriptionRegion(SUBSCRIPTION_REGION_TABS[nextIndex].id)
    const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    tabs?.[nextIndex]?.focus()
  }

  const handleProviderTabKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    currentTab: ProviderTaskTab
  ): void => {
    const currentIndex = PROVIDER_TASK_TABS.findIndex((tab) => tab.id === currentTab)
    let nextIndex = currentIndex
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % PROVIDER_TASK_TABS.length
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + PROVIDER_TASK_TABS.length) % PROVIDER_TASK_TABS.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = PROVIDER_TASK_TABS.length - 1
    else return

    event.preventDefault()
    setActiveTab(PROVIDER_TASK_TABS[nextIndex].id)
    const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    tabs?.[nextIndex]?.focus()
  }

  const confirmAction = async (options: {
    message: string
    detail?: string
    confirmLabel?: string
    cancelLabel?: string
  }): Promise<boolean> => {
    if (typeof window.kunGui?.confirmDialog === 'function') {
      return window.kunGui.confirmDialog(options)
    }
    return true
  }

  const updateModelProviders = (
    providers: ModelProviderProfileV1[],
    kunPatch?: KunRuntimeSettingsPatchV1
  ): void => {
    update(modelProvidersSettingsPatch({
      provider,
      providers,
      kun: kunPatch,
      currentKun: kun
    }))
  }

  const patchProviderProfile = (
    item: ModelProviderProfileV1,
    transform: (item: ModelProviderProfileV1) => ModelProviderProfileV1
  ): void => {
    if (draftProvider && item.id === draftProvider.id) {
      setDraftProvider(transform(draftProvider))
      return
    }
    updateModelProviders(modelProviders.map((existing) => existing.id === item.id ? transform(existing) : existing))
  }

  const updateModelProvider = (id: string, patch: Partial<ModelProviderProfileV1>): void => {
    const target = displayProviders.find((item) => item.id === id)
    if (!target) return
    patchProviderProfile(target, (item) => ({ ...item, ...patch }))
  }

  const updateModelProviderImage = (id: string, patch: Partial<ModelProviderImageCapabilityV1>): void => {
    const target = displayProviders.find((item) => item.id === id)
    if (!target) return
    patchProviderProfile(target, (item) => ({
      ...item,
      image: {
        ...(item.image ?? defaultImageCapability(item.baseUrl)),
        ...patch
      }
    }))
  }

  const removeModelProviderImage = (id: string): void => {
    const target = displayProviders.find((item) => item.id === id)
    if (!target) return
    patchProviderProfile(target, (item) => {
      const { image: _image, ...rest } = item
      void _image
      return rest
    })
  }

  const updateModelProviderSpeech = (id: string, patch: Partial<ModelProviderSpeechCapabilityV1>): void => {
    const target = displayProviders.find((item) => item.id === id)
    if (!target) return
    patchProviderProfile(target, (item) => ({
      ...item,
      speech: {
        ...(item.speech ?? defaultSpeechCapability(item.baseUrl)),
        ...patch
      }
    }))
  }

  const removeModelProviderSpeech = (id: string): void => {
    const target = displayProviders.find((item) => item.id === id)
    if (!target) return
    patchProviderProfile(target, (item) => {
      const { speech: _speech, ...rest } = item
      void _speech
      return rest
    })
  }

  const updateModelProviderTextToSpeech = (id: string, patch: Partial<ModelProviderTextToSpeechCapabilityV1>): void => {
    const target = displayProviders.find((item) => item.id === id)
    if (!target) return
    patchProviderProfile(target, (item) => ({
      ...item,
      textToSpeech: {
        ...(item.textToSpeech ?? defaultTextToSpeechCapability(item.baseUrl)),
        ...patch
      }
    }))
  }

  const removeModelProviderTextToSpeech = (id: string): void => {
    const target = displayProviders.find((item) => item.id === id)
    if (!target) return
    patchProviderProfile(target, (item) => {
      const { textToSpeech: _textToSpeech, ...rest } = item
      void _textToSpeech
      return rest
    })
  }

  const updateModelProviderMusic = (id: string, patch: Partial<ModelProviderMusicCapabilityV1>): void => {
    const target = displayProviders.find((item) => item.id === id)
    if (!target) return
    patchProviderProfile(target, (item) => ({
      ...item,
      music: {
        ...(item.music ?? defaultMusicCapability(item.baseUrl)),
        ...patch
      }
    }))
  }

  const removeModelProviderMusic = (id: string): void => {
    const target = displayProviders.find((item) => item.id === id)
    if (!target) return
    patchProviderProfile(target, (item) => {
      const { music: _music, ...rest } = item
      void _music
      return rest
    })
  }

  const updateModelProviderVideo = (id: string, patch: Partial<ModelProviderVideoCapabilityV1>): void => {
    const target = displayProviders.find((item) => item.id === id)
    if (!target) return
    patchProviderProfile(target, (item) => ({
      ...item,
      video: {
        ...(item.video ?? defaultVideoCapability(item.baseUrl)),
        ...patch
      }
    }))
  }

  const removeModelProviderVideo = (id: string): void => {
    const target = displayProviders.find((item) => item.id === id)
    if (!target) return
    patchProviderProfile(target, (item) => {
      const { video: _video, ...rest } = item
      void _video
      return rest
    })
  }

  const updateModelProviderId = (id: string, value: string): void => {
    if (id === DEFAULT_MODEL_PROVIDER_ID) return
    const nextId = normalizeModelProviderId(value)
    if (!nextId || nextId === id) return
    if (displayProviders.some((item) => item.id === nextId && item.id !== id)) return
    if (draftProvider && id === draftProvider.id) {
      setSelectedProviderId(nextId)
      setDraftProvider({ ...draftProvider, id: nextId })
      return
    }
    setSelectedProviderId(nextId)
    updateModelProviders(
      modelProviders.map((item) => item.id === id ? { ...item, id: nextId } : item),
      kun.providerId === id ? { providerId: nextId } : undefined
    )
  }

  const startProviderDraft = (profile: ModelProviderProfileV1): void => {
    previousProviderSelectionRef.current = selectedProviderId
    setDraftProvider(profile)
    setSelectedProviderId(profile.id)
    setActiveTab('connection')
  }

  const commitProviderDraft = (): void => {
    if (!draftProvider) return
    const hasKey = Boolean(draftProvider.apiKey.trim())
    updateModelProviders(
      [...modelProviders, draftProvider],
      hasKey
        ? { providerId: draftProvider.id, model: draftProvider.models[0] ?? kun.model }
        : undefined
    )
    previousProviderSelectionRef.current = null
    setDraftProvider(null)
    setSelectedProviderId(draftProvider.id)
  }

  const cancelProviderDraft = (): void => {
    if (!draftProvider) return
    const previousProviderId = previousProviderSelectionRef.current
    const fallbackProviderId = modelProviders.some((item) => item.id === activeKunProviderId)
      ? activeKunProviderId
      : modelProviders[0]?.id ?? DEFAULT_MODEL_PROVIDER_ID
    setDraftProvider(null)
    setSelectedProviderId(
      previousProviderId && modelProviders.some((item) => item.id === previousProviderId)
        ? previousProviderId
        : fallbackProviderId
    )
    previousProviderSelectionRef.current = null
  }

  const addModelProvider = (): void => {
    const baseId = 'custom-provider'
    let index = modelProviders.length + 1
    let id = `${baseId}-${index}`
    const used = new Set(displayProviders.map((item) => item.id))
    while (used.has(id)) {
      index += 1
      id = `${baseId}-${index}`
    }
    startProviderDraft({
      id,
      name: t('modelProviderNewName', { index }),
      apiKey: '',
      baseUrl: 'https://api.example.com/v1',
      endpointFormat: 'chat_completions',
      retry: defaultModelRequestRetrySettings(),
      models: [],
      modelProfiles: {}
    })
  }

  const addPresetModelProvider = async (
    preset: ModelProviderPreset,
    mode: ModelProviderPresetMode = 'api'
  ): Promise<void> => {
    if (isMultiAccountProviderPreset(preset, mode)) {
      const accountProvider = modelProviderPresetAccountProfile(preset, mode, displayProviders)
      if (accountProvider) startProviderDraft(accountProvider)
      return
    }
    const presetProvider = mode === 'token-plan'
      ? modelProviderTokenPlanProfile(preset)
      : modelProviderPresetProfile(preset)
    if (!presetProvider) return
    const existingProvider = modelProviders.find((item) => item.id === presetProvider.id)
    if (existingProvider) {
      const confirmed = await confirmAction({
        message: t('modelProviderUpdatePresetTitle', { name: presetProvider.name }),
        detail: t('modelProviderUpdatePresetDetail'),
        confirmLabel: t('modelProviderUpdatePresetAction'),
        cancelLabel: t('modelProviderCancel')
      })
      if (!confirmed) {
        setSelectedProviderId(presetProvider.id)
        return
      }
    }
    if (!existingProvider) {
      startProviderDraft(presetProvider)
      return
    }
    const nextProvider: ModelProviderProfileV1 = {
      ...presetProvider,
      name: existingProvider.name.trim() || presetProvider.name,
      apiKey: existingProvider.apiKey,
      models: mergeProviderModelIds(presetProvider.models, existingProvider.models),
      modelProfiles: {
        ...existingProvider.modelProfiles,
        ...presetProvider.modelProfiles
      },
      image: presetProvider.image ?? existingProvider.image,
      speech: presetProvider.speech ?? existingProvider.speech,
      textToSpeech: presetProvider.textToSpeech ?? existingProvider.textToSpeech,
      music: presetProvider.music ?? existingProvider.music,
      video: presetProvider.video ?? existingProvider.video
    }
    const nextProviders = modelProviders.map((item) => item.id === presetProvider.id ? nextProvider : item)
    setSelectedProviderId(nextProvider.id)
    updateModelProviders(
      nextProviders,
      nextProvider.apiKey.trim()
        ? { providerId: nextProvider.id, model: nextProvider.models[0] ?? kun.model }
        : undefined
    )
  }

  const removeModelProvider = async (id: string): Promise<void> => {
    if (id === DEFAULT_MODEL_PROVIDER_ID) return
    const target = modelProviders.find((item) => item.id === id)
    if (!target) return
    const usedByChat = activeKunProviderId === id
    const usedByImage = (kun.imageGeneration?.providerId ?? '').trim() === id
    const usedBySpeech = (kun.speechToText?.providerId ?? '').trim() === id
    const usedByTextToSpeech = (kun.textToSpeech?.providerId ?? '').trim() === id
    const usedByMusic = (kun.musicGeneration?.providerId ?? '').trim() === id
    const usedByVideo = (kun.videoGeneration?.providerId ?? '').trim() === id
    const writeInline = form?.write?.inlineCompletion
    const usedByWrite = Boolean(
      writeInline && !writeInline.inheritProvider && writeInline.providerId === id
    )
    const references = [
      ...(usedByChat ? [t('modelProviderDeleteInUseChat')] : []),
      ...(usedByImage ? [t('modelProviderDeleteInUseImage')] : []),
      ...(usedBySpeech ? [t('modelProviderDeleteInUseSpeech')] : []),
      ...(usedByTextToSpeech ? [t('modelProviderDeleteInUseTextToSpeech')] : []),
      ...(usedByMusic ? [t('modelProviderDeleteInUseMusic')] : []),
      ...(usedByVideo ? [t('modelProviderDeleteInUseVideo')] : []),
      ...(usedByWrite ? [t('modelProviderDeleteInUseWrite')] : [])
    ]
    const confirmed = await confirmAction({
      message: t('modelProviderDeleteConfirmTitle', { name: target.name.trim() || target.id }),
      detail: [t('modelProviderDeleteConfirmDetail'), ...references].join('\n'),
      confirmLabel: t('modelProviderDeleteAction'),
      cancelLabel: t('modelProviderCancel')
    })
    if (!confirmed) return
    const nextProviders = modelProviders.filter((item) => item.id !== id)
    const kunPatch: KunRuntimeSettingsPatchV1 | undefined =
      usedByChat || usedByImage || usedBySpeech || usedByTextToSpeech || usedByMusic || usedByVideo
        ? {
            ...(usedByChat ? { providerId: DEFAULT_MODEL_PROVIDER_ID } : {}),
            ...(usedByImage ? { imageGeneration: { providerId: '' } } : {}),
            ...(usedBySpeech ? { speechToText: { providerId: '' } } : {}),
            ...(usedByTextToSpeech ? { textToSpeech: { providerId: '' } } : {}),
            ...(usedByMusic ? { musicGeneration: { providerId: '' } } : {}),
            ...(usedByVideo ? { videoGeneration: { providerId: '' } } : {})
          }
        : undefined
    const patch = modelProvidersSettingsPatch({
      provider,
      providers: nextProviders,
      kun: kunPatch,
      currentKun: kun
    })
    if (usedByWrite) {
      patch.write = { inlineCompletion: { inheritProvider: true, providerId: '' } }
    }
    setSelectedProviderId(DEFAULT_MODEL_PROVIDER_ID)
    update(patch)
  }

  const fetchModelsDevCatalogFor = async (
    target: ModelProviderProfileV1,
    modelHints?: CursorSubscriptionModel[],
    forceRefresh = true
  ): Promise<ModelsDevCatalogResult> => {
    if (typeof window.kunGui?.fetchModelsDevCatalog !== 'function') {
      return { status: 'error', message: 'models.dev catalog bridge is unavailable.', models: [] }
    }
    try {
      const source = resolveModelProviderPresetSource(target)
      return await window.kunGui.fetchModelsDevCatalog({
        // Multi-account profiles keep a unique runtime id, while catalog
        // matching must use the canonical preset id understood by models.dev.
        providerId: source
          ? source.mode === 'token-plan'
            ? tokenPlanProviderId(source.preset.id)
            : source.preset.id
          : target.id,
        baseUrl: target.baseUrl,
        forceRefresh,
        ...(modelHints?.length
          ? {
              modelHints: modelHints.map((model) => ({
                id: model.id,
                ...(model.aliases?.length ? { aliases: model.aliases } : {})
              }))
            }
          : {})
      })
    } catch (error) {
      return {
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
        models: []
      }
    }
  }

  const patchProviderProfileRef = useRef(patchProviderProfile)
  patchProviderProfileRef.current = patchProviderProfile
  const fetchModelsDevCatalogForRef = useRef(fetchModelsDevCatalogFor)
  fetchModelsDevCatalogForRef.current = fetchModelsDevCatalogFor

  useEffect(() => {
    if (
      activeTab !== 'models'
      || !activeProvider
      || !cursorProviderNeedsMetadataRepair(activeProvider)
    ) return

    const repairKey = [
      activeProvider.id,
      ...activeProvider.models.map((model) => model.trim().toLowerCase()).filter(Boolean)
    ].join('\u0001')
    if (cursorMetadataRepairAttempts.current.has(repairKey)) return
    cursorMetadataRepairAttempts.current.add(repairKey)

    void fetchModelsDevCatalogForRef.current(
      activeProvider,
      activeProvider.models.map((model) => ({
        id: model,
        displayName: model
      })),
      false
    ).then((catalogResult) => {
      if (catalogResult.status !== 'ok' || catalogResult.models.length === 0) return
      patchProviderProfileRef.current(activeProvider, (item) => {
        const modelProfiles = enrichCursorProviderModelProfiles(
          item,
          item.models,
          catalogResult.models
        )
        return modelProfiles === item.modelProfiles
          ? item
          : { ...item, modelProfiles }
      })
    })
  }, [activeProvider, activeTab])

  const openModelImport = (input: {
    target: ModelProviderProfileV1
    fingerprint: string
    providerModelIds: string[]
    modelAliases?: Record<string, string[]>
    catalogResult: ModelsDevCatalogResult
    providerError?: string
    latencyMs?: number
    authoritative?: boolean
  }): void => {
    const catalogOnlyIds = input.catalogResult.status === 'ok' && input.catalogResult.matchMode === 'catalog'
      ? input.catalogResult.models.map((model) => model.id)
      : []
    const total = mergeProviderModelIds(input.providerModelIds, catalogOnlyIds).length
    const hasUsableEntries = input.providerModelIds.length > 0 || catalogOnlyIds.length > 0
    if (!hasUsableEntries) {
      const catalogMessage = input.catalogResult.status === 'error'
        ? input.catalogResult.message
        : input.catalogResult.status === 'unmapped'
          ? t('providerModelImportCatalogUnmapped')
          : t('modelProviderFetchEmpty')
      const message = [input.providerError, catalogMessage].filter(Boolean).join(' · ')
      setProbeStates((previous) => ({
        ...previous,
        [input.target.id]: {
          fingerprint: input.fingerprint,
          mode: 'fetch',
          status: 'error',
          message: message || t('modelProviderFetchEmpty')
        }
      }))
      return
    }

    setProbeStates((previous) => ({
      ...previous,
      [input.target.id]: {
        fingerprint: input.fingerprint,
        mode: 'fetch',
        status: 'ok',
        latencyMs: input.latencyMs ?? 0,
        total
      }
    }))
    setPendingImport({
      providerId: input.target.id,
      providerModelIds: input.providerModelIds,
      ...(input.modelAliases ? { modelAliases: input.modelAliases } : {}),
      catalogResult: input.catalogResult,
      ...(input.providerError ? { providerError: input.providerError } : {}),
      ...(input.authoritative ? { authoritative: true } : {})
    })
  }

  const runProbe = async (target: ModelProviderProfileV1, mode: 'test' | 'fetch'): Promise<void> => {
    const fingerprint = providerConnectionFingerprint(target)
    if (isCursorSubscriptionProvider(target)) {
      if (!target.apiKey.trim()) {
        setProbeStates((previous) => ({
          ...previous,
          [target.id]: {
            fingerprint,
            mode,
            status: 'error',
            message: t('modelProviderPresetMissingKeyForProbe')
          }
        }))
        return
      }
      setProbeStates((previous) => ({
        ...previous,
        [target.id]: { fingerprint, mode, status: 'busy' }
      }))
      try {
        const discover = window.kunGui?.cursorSubscriptionDiscover
        if (typeof discover !== 'function') {
          throw new Error(`No bridge registered for '${CURSOR_SUBSCRIPTION_DISCOVERY_CHANNEL}'`)
        }
        const discovery = await discover(target.apiKey)
        const accountName = [
          discovery.account.userFirstName,
          discovery.account.userLastName
        ].filter(Boolean).join(' ')
        setCursorAccounts((previous) => ({
          ...previous,
          [target.id]: {
            fingerprint,
            label: discovery.account.userEmail || accountName || discovery.account.apiKeyName,
            apiKeyName: discovery.account.apiKeyName
          }
        }))
        if (mode === 'fetch') {
          const modelIds = discovery.models.map((model) => model.id)
          const modelAliases = Object.fromEntries(
            discovery.models
              .filter((model) => model.aliases?.length)
              .map((model) => [model.id, [...(model.aliases ?? [])]])
          )
          openModelImport({
            target,
            fingerprint,
            providerModelIds: modelIds,
            modelAliases,
            catalogResult: await fetchModelsDevCatalogFor(target, discovery.models),
            providerError: modelIds.length === 0
              ? t('providerModelImportProviderReturnedEmpty')
              : undefined,
            latencyMs: 0,
            authoritative: true
          })
          return
        }
        setProbeStates((previous) => ({
          ...previous,
          [target.id]: {
            fingerprint,
            mode,
            status: 'ok',
            latencyMs: 0,
            total: discovery.models.length
          }
        }))
      } catch (error) {
        setProbeStates((previous) => ({
          ...previous,
          [target.id]: {
            fingerprint,
            mode,
            status: 'error',
            message: cursorSubscriptionDiscoveryErrorMessage(
              error,
              t('cursorSubscriptionRestartRequired')
            )
          }
        }))
      }
      return
    }
    // The official Antigravity CLI owns subscription auth and model discovery.
    if (isGeminiSubscriptionProvider(target)) {
      setProbeStates((previous) => ({
        ...previous,
        [target.id]: { fingerprint, mode, status: 'busy' }
      }))
      const [providerResult, catalogResult] = await Promise.all([
        window.kunGui.geminiSubscriptionModels()
          .then((modelIds) => ({ modelIds, error: undefined as string | undefined }))
          .catch((error: unknown) => ({
            modelIds: [] as string[],
            error: error instanceof Error ? error.message : String(error)
          })),
        fetchModelsDevCatalogFor(target)
      ])
      if (mode === 'fetch') {
        openModelImport({
          target,
          fingerprint,
          providerModelIds: providerResult.modelIds,
          catalogResult,
          providerError: providerResult.error,
          latencyMs: 0,
          authoritative: true
        })
        return
      }
      setProbeStates((previous) => ({
        ...previous,
        [target.id]: providerResult.error
          ? { fingerprint, mode, status: 'error', message: providerResult.error }
          : { fingerprint, mode, status: 'ok', latencyMs: 0, total: providerResult.modelIds.length }
      }))
      return
    }
    if (isGeminiCliApiSubscriptionProvider(target)) {
      setProbeStates((previous) => ({
        ...previous,
        [target.id]: { fingerprint, mode, status: 'busy' }
      }))
      const [statusResult, modelResult, catalogResult] = await Promise.all([
        window.kunGui.geminiCliSubscriptionStatus()
          .catch(() => ({ installed: false, authenticated: false })),
        window.kunGui.geminiCliSubscriptionModels()
          .then((modelIds) => ({ modelIds, error: undefined as string | undefined }))
          .catch((error: unknown) => ({
            modelIds: [] as string[],
            error: error instanceof Error ? error.message : String(error)
          })),
        fetchModelsDevCatalogFor(target)
      ])
      const authError = statusResult.authenticated
        ? undefined
        : t('geminiCliApiLoginHint')
      if (mode === 'fetch') {
        openModelImport({
          target,
          fingerprint,
          providerModelIds: modelResult.modelIds,
          catalogResult,
          providerError: modelResult.error ?? authError,
          latencyMs: 0,
          authoritative: true
        })
        return
      }
      setProbeStates((previous) => ({
        ...previous,
        [target.id]: statusResult.authenticated
          ? {
              fingerprint,
              mode,
              status: 'ok',
              latencyMs: 0,
              total: modelResult.modelIds.length
            }
          : {
              fingerprint,
              mode,
              status: 'error',
              message: authError
            }
      }))
      return
    }
    // Subscription (agent-sdk) providers have no HTTP /models endpoint. Model
    // enumeration remains a catalog operation, while Test makes a bounded real
    // request through the official Claude transport so a non-empty/revoked token
    // can never produce a false success state.
    if (isAgentSdkProvider(target)) {
      setProbeStates((previous) => ({
        ...previous,
        [target.id]: { fingerprint, mode, status: 'busy' }
      }))
      if (mode === 'fetch') {
        const [providerResult, catalogResult] = await Promise.all([
          window.kunGui.claudeSubscriptionModels(target.apiKey.trim() || undefined)
            .then((modelIds) => ({ modelIds, error: undefined as string | undefined }))
            .catch((error: unknown) => ({
              modelIds: [] as string[],
              error: error instanceof Error ? error.message : String(error)
            })),
          fetchModelsDevCatalogFor(target)
        ])
        openModelImport({
          target,
          fingerprint,
          providerModelIds: [...providerResult.modelIds],
          catalogResult,
          providerError: providerResult.error
            ?? (providerResult.modelIds.length === 0 ? t('claudeSubProbeNotReady') : undefined),
          latencyMs: 0
        })
        return
      }
      const result = await window.kunGui.claudeSubscriptionProbe(
        target.apiKey.trim() || undefined
      ).catch((error: unknown) => ({
        ok: false as const,
        message: error instanceof Error ? error.message : String(error)
      }))
      setProbeStates((previous) => ({
        ...previous,
        [target.id]: result.ok
          ? {
              fingerprint,
              mode,
              status: 'ok',
              latencyMs: result.latencyMs,
              total: target.models.length
            }
          : {
              fingerprint,
              mode,
              status: 'error',
              message: result.message === 'invalid-token-format'
                ? t('claudeSubTokenInvalid')
                : result.message === 'probe-timeout'
                  ? t('claudeSubProbeTimeout')
                  : result.message === 'claude-cli-not-found'
                    ? t('claudeSubLoginFailedCli')
                    : result.message || t('claudeSubProbeNotReady')
            }
      }))
      return
    }
    if (modelProviderRequiresApiKey(target) && !target.apiKey.trim()) {
      setProbeStates((previous) => ({
        ...previous,
        [target.id]: {
          fingerprint,
          mode,
          status: 'error',
          message: t('modelProviderPresetMissingKeyForProbe')
        }
      }))
      return
    }
    if (typeof window.kunGui?.probeModelProvider !== 'function') return
    setProbeStates((previous) => ({
      ...previous,
      [target.id]: { fingerprint, mode, status: 'busy' }
    }))

    const probe = async (): Promise<ModelProviderProbeResult> => {
      try {
        return await window.kunGui.probeModelProvider({
          baseUrl: target.baseUrl,
          apiKey: target.apiKey,
          endpointFormat: target.endpointFormat
        })
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    }

    if (mode === 'fetch') {
      const [result, catalogResult] = await Promise.all([
        probe(),
        fetchModelsDevCatalogFor(target)
      ])
      openModelImport({
        target,
        fingerprint,
        providerModelIds: result.ok ? [...result.modelIds] : [],
        catalogResult,
        providerError: result.ok
          ? (result.modelIds.length === 0 ? t('providerModelImportProviderReturnedEmpty') : undefined)
          : result.message,
        latencyMs: result.ok ? result.latencyMs : 0
      })
      return
    }

    const result = await probe()
    if (!result.ok) {
      setProbeStates((previous) => ({
        ...previous,
        [target.id]: { fingerprint, mode, status: 'error', message: result.message }
      }))
      return
    }
    setProbeStates((previous) => ({
      ...previous,
      [target.id]: {
        fingerprint,
        mode,
        status: 'ok',
        latencyMs: result.latencyMs,
        total: result.modelIds.length
      }
    }))
  }

  const importPickedModels = (
    target: ModelProviderProfileV1,
    picked: ProviderModelImportResult,
    authoritative = false,
    modelAliases: Readonly<Record<string, readonly string[]>> = {}
  ): void => {
    const nextChatModels = authoritative
      ? [...picked.chat]
      : mergeProviderModelIds(target.models, picked.chat)
    const nextImageModels = target.image
      ? mergeProviderModelIds(target.image.models, picked.image)
      : picked.image
    const nextSpeechModels = target.speech
      ? mergeProviderModelIds(target.speech.models, picked.speech)
      : picked.speech
    const nextTextToSpeechModels = target.textToSpeech
      ? mergeProviderModelIds(target.textToSpeech.models, picked.tts)
      : picked.tts
    const nextMusicModels = target.music
      ? mergeProviderModelIds(target.music.models, picked.music)
      : picked.music
    const nextVideoModels = target.video
      ? mergeProviderModelIds(target.video.models, picked.video)
      : picked.video
    const nextModelProfiles = isCursorSubscriptionProvider(target)
      ? enrichCursorProviderModelProfiles(
          target,
          nextChatModels,
          picked.catalogModels,
          modelAliases
        )
      : enrichProviderModelProfiles(
          target,
          nextChatModels,
          picked.catalogModels,
          modelAliases
        )
    const added =
      addedModelCount(target.models, nextChatModels)
      + addedModelCount(target.image?.models ?? [], nextImageModels)
      + addedModelCount(target.speech?.models ?? [], nextSpeechModels)
      + addedModelCount(target.textToSpeech?.models ?? [], nextTextToSpeechModels)
      + addedModelCount(target.music?.models ?? [], nextMusicModels)
      + addedModelCount(target.video?.models ?? [], nextVideoModels)
    if (authoritative || added > 0 || nextModelProfiles !== target.modelProfiles) {
      patchProviderProfile(target, (item) => ({
        ...item,
        models: nextChatModels,
        modelProfiles: nextModelProfiles,
        ...(nextImageModels.length > 0
          ? { image: { ...(item.image ?? presetImageCapability(item) ?? defaultImageCapability(item.baseUrl)), models: nextImageModels } }
          : {}),
        ...(nextSpeechModels.length > 0
          ? { speech: { ...(item.speech ?? presetSpeechCapability(item) ?? defaultSpeechCapability(item.baseUrl)), models: nextSpeechModels } }
          : {}),
        ...(nextTextToSpeechModels.length > 0
          ? { textToSpeech: { ...(item.textToSpeech ?? presetTextToSpeechCapability(item) ?? defaultTextToSpeechCapability(item.baseUrl)), models: nextTextToSpeechModels } }
          : {}),
        ...(nextMusicModels.length > 0
          ? { music: { ...(item.music ?? presetMusicCapability(item) ?? defaultMusicCapability(item.baseUrl)), models: nextMusicModels } }
          : {}),
        ...(nextVideoModels.length > 0
          ? { video: { ...(item.video ?? presetVideoCapability(item) ?? defaultVideoCapability(item.baseUrl)), models: nextVideoModels } }
          : {})
      }))
    }
    setProbeStates((prev) => {
      const previous = prev[target.id]
      if (!previous) return prev
      return {
        ...prev,
        [target.id]: { ...previous, total: added }
      }
    })
  }

  const providerKindLabel = (item: ModelProviderProfileV1): string => {
    if (item.id === DEFAULT_MODEL_PROVIDER_ID) return t('modelProviderDefaultBadge')
    const source = resolveModelProviderPresetSource(item)
    if (source?.mode === 'token-plan') return t('modelProviderTokenPlanBadge')
    if (source?.preset.category === 'subscription') return t('modelProviderPlanBadge')
    if (source) return t('modelProviderPresetBadge')
    return t('modelProviderCustomBadge')
  }

  const activeProbe = activeProvider ? probeStates[activeProvider.id] : undefined
  const activeProbeFresh = Boolean(
    activeProvider &&
    activeProbe &&
    activeProbe.fingerprint === providerConnectionFingerprint(activeProvider)
  )
  const probeBusy = Boolean(activeProbeFresh && activeProbe?.status === 'busy')
  const probeNotice: InlineNotice | null = (() => {
    if (!activeProbeFresh || !activeProbe) return null
    if (activeProbe.status === 'busy') {
      return { tone: 'info', message: t('modelProviderTesting') }
    }
    if (activeProbe.status === 'error') {
      return { tone: 'error', message: t('modelProviderTestFailed', { message: activeProbe.message ?? '' }) }
    }
    return {
      tone: 'success',
      message: activeProbe.mode === 'fetch'
        ? t('modelProviderFetchedModels', { total: activeProbe.total ?? 0 })
        : t('modelProviderTestSuccess', { latency: activeProbe.latencyMs ?? 0, total: activeProbe.total ?? 0 })
    }
  })()
  const activeBaseUrlInvalid = Boolean(activeProvider && !isAcceptableHttpUrl(activeProvider.baseUrl))
  const activeImageBaseUrlInvalid = Boolean(
    activeProvider?.image && !isAcceptableHttpUrl(activeProvider.image.baseUrl)
  )
  const activeSpeechBaseUrlInvalid = Boolean(
    activeProvider?.speech &&
    activeProvider.speech.protocol !== 'gemini-cli-audio' &&
    activeProvider.speech.protocol !== 'local-whisper' &&
    !isAcceptableHttpUrl(activeProvider.speech.baseUrl)
  )
  const activePresetSpeechCapability = activeProvider
    ? presetSpeechCapability(activeProvider)
    : null
  const activeSpeechToggleDisabled = Boolean(
    activePresetSpeechCapability ||
    (
      activeProvider &&
      !activeProvider.speech &&
      (isDelegatedEndpointProvider(activeProvider) || isOAuthSubscriptionProvider(activeProvider))
    )
  )
  const activeTextToSpeechBaseUrlInvalid = Boolean(
    activeProvider?.textToSpeech && !isAcceptableHttpUrl(activeProvider.textToSpeech.baseUrl)
  )
  const activeMusicBaseUrlInvalid = Boolean(
    activeProvider?.music && !isAcceptableHttpUrl(activeProvider.music.baseUrl)
  )
  const activeVideoBaseUrlInvalid = Boolean(
    activeProvider?.video && !isAcceptableHttpUrl(activeProvider.video.baseUrl)
  )
  const activeMissingCredential = Boolean(
    activeProvider &&
    modelProviderRequiresApiKey(activeProvider) &&
    !activeProvider.apiKey.trim()
  )
  const activeProbeBlocked = activeBaseUrlInvalid || activeMissingCredential
  const activeCursorAccount = activeProvider
    ? cursorAccounts[activeProvider.id]
    : undefined
  const activeCursorAccountFresh = Boolean(
    activeProvider
    && activeCursorAccount
    && activeCursorAccount.fingerprint === providerConnectionFingerprint(activeProvider)
  )
  const activeCursorApiKeyUrl = activeProvider && isCursorSubscriptionProvider(activeProvider)
    ? resolveModelProviderPresetSource(activeProvider)?.preset.apiKeyUrl
    : undefined
  const activeTokenPlanRegions = activeProvider
    ? tokenPlanPresetForProfile(activeProvider)?.tokenPlan?.regions ?? []
    : []

  const normalizedProviderListQuery = providerListQuery.trim().toLowerCase()
  const filteredProviders = normalizedProviderListQuery
    ? displayProviders.filter((item) =>
        `${item.name} ${item.id}`.toLowerCase().includes(normalizedProviderListQuery)
      )
    : displayProviders
  const planProviders = filteredProviders.filter((item) => isSubscriptionProvider(item))
  const apiProviders = filteredProviders.filter((item) => !isSubscriptionProvider(item))
  // 只要存在任一套餐类供应商就分组展示;否则(通常只有默认 DeepSeek)保持单一平铺列表。
  const grouped = displayProviders.some((item) => isSubscriptionProvider(item))

  const renderProviderButton = (item: ModelProviderProfileV1): ReactElement => {
    const selected = activeProvider?.id === item.id
    const isDraft = draftProvider?.id === item.id
    const inUse = !isDraft && activeKunProviderId === item.id
    const missingKey = modelProviderRequiresApiKey(item) && !item.apiKey.trim()
    return (
      <button
        key={item.id}
        type="button"
        aria-pressed={selected}
        onClick={() => setSelectedProviderId(item.id)}
        className={`w-full min-w-0 overflow-hidden rounded-xl border px-3 py-2.5 text-left transition ${
          selected
            ? 'border-accent/60 bg-ds-main/45 ring-1 ring-accent/30'
            : 'border-ds-border bg-ds-card hover:bg-ds-hover'
        }`}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ds-ink">
            {item.name.trim() || item.id}
          </span>
          {isDraft ? <ProviderBadge tone="warning">{t('modelProviderDraftBadge')}</ProviderBadge> : null}
          {inUse ? <ProviderBadge tone="accent">{t('modelProviderInUse')}</ProviderBadge> : null}
          {!isDraft && missingKey ? <ProviderBadge tone="warning">{t('modelProviderMissingKey')}</ProviderBadge> : null}
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-x-1.5 overflow-hidden whitespace-nowrap text-[12px] text-ds-faint">
          <span>{t('modelProviderModelCount', { total: providerModelCount(item) })}</span>
          <span aria-hidden="true">·</span>
          <span>{providerKindLabel(item)}</span>
          {item.apiKey.trim() ? <KeyRound className="h-3 w-3" strokeWidth={1.9} /> : null}
          {item.image ? <ImageIcon className="h-3 w-3" strokeWidth={1.9} /> : null}
          {item.models.some((model) =>
            modelSupportsImageInput(profileForModel(item, model))
          ) ? <span className="text-[11px] font-semibold text-ds-muted">{t('modelProviderVisionBadge')}</span> : null}
          {item.speech ? <Mic className="h-3 w-3" strokeWidth={1.9} /> : null}
          {item.textToSpeech ? <AudioLines className="h-3 w-3" strokeWidth={1.9} /> : null}
          {item.music ? <Music2 className="h-3 w-3" strokeWidth={1.9} /> : null}
          {item.video ? <Clapperboard className="h-3 w-3" strokeWidth={1.9} /> : null}
        </div>
      </button>
    )
  }

  const addMenuEntries = MODEL_PROVIDER_PRESETS.flatMap((preset) => {
    const entries: {
      preset: ModelProviderPreset
      mode: ModelProviderPresetMode
      profileId: string
      label: string
      group: 'subscription' | 'api'
      region?: ModelProviderSubscriptionRegion
    }[] = [
      {
        preset,
        mode: 'api',
        profileId: preset.id,
        label: preset.name,
        group: preset.category === 'subscription' ? 'subscription' : 'api',
        region: preset.subscriptionRegion
      }
    ]
    if (preset.tokenPlan) {
      entries.push({
        preset,
        mode: 'token-plan',
        profileId: tokenPlanProviderId(preset.id),
        label: `${preset.name} · Token Plan`,
        group: 'subscription',
        region: preset.subscriptionRegion
      })
    }
    return entries
  })
  const normalizedAddProviderQuery = addProviderQuery.trim().toLowerCase()
  const visibleAddEntries = normalizedAddProviderQuery
    ? addMenuEntries.filter((entry) =>
        `${entry.label} ${entry.profileId}`.toLowerCase().includes(normalizedAddProviderQuery)
      )
    : addMenuEntries
  const queriedPlanAddEntries = visibleAddEntries.filter((entry) => entry.group === 'subscription')
  const planAddEntries = subscriptionRegion === 'all'
    ? queriedPlanAddEntries
    : queriedPlanAddEntries.filter((entry) => entry.region === subscriptionRegion)
  const apiAddEntries = visibleAddEntries.filter((entry) => entry.group === 'api')
  const showPlanAddGroup = queriedPlanAddEntries.length > 0 || !normalizedAddProviderQuery
  const renderAddEntry = (entry: (typeof addMenuEntries)[number]): ReactElement => {
    const multiAccount = isMultiAccountProviderPreset(entry.preset, entry.mode)
    const accountCount = multiAccount
      ? modelProviderPresetAccountCount(entry.preset, entry.mode, modelProviders)
      : 0
    const exists = !multiAccount && modelProviders.some((item) => item.id === entry.profileId)
    return (
      <button
        key={entry.profileId}
        type="button"
        onClick={() => {
          closeAddProviderDialog()
          void addPresetModelProvider(entry.preset, entry.mode)
        }}
        className="group grid min-h-20 w-full gap-2 rounded-xl border border-ds-border bg-ds-card px-3.5 py-3 text-left transition hover:border-accent/45 hover:bg-ds-hover"
      >
        <span className="flex min-w-0 items-start justify-between gap-2">
          <span className="truncate text-[13.5px] font-semibold text-ds-ink">{entry.label}</span>
          <StatusPill tone={exists ? 'warning' : accountCount > 0 ? 'success' : 'muted'}>
            {accountCount > 0
              ? t('modelProviderAccountCount', { count: accountCount })
              : exists
              ? t('modelProviderPresetUpdateTag')
              : entry.group === 'subscription'
                ? t('modelProviderPlanBadge')
                : t('modelProviderPresetBadge')}
          </StatusPill>
        </span>
        <span className="truncate font-mono text-[11.5px] text-ds-faint">
          {entry.profileId}{multiAccount ? ` · ${t('modelProviderAddAccountHint')}` : ''}
        </span>
      </button>
    )
  }

  const pendingImportProvider = pendingImport
    ? displayProviders.find((item) => item.id === pendingImport.providerId)
    : null

  return (
    <>
      <section className="overflow-hidden rounded-2xl border border-ds-border bg-ds-card/95 shadow-sm shadow-black/5 dark:shadow-black/25">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-ds-border-muted px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-[16px] font-semibold text-ds-ink">{t('providers')}</h2>
            <p className="mt-1 max-w-3xl text-[13px] leading-5 text-ds-muted">{t('providersDesc')}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-xl border border-ds-border bg-ds-main p-1 text-[12px]">
              <button type="button" onClick={() => setWorkspaceMode('providers')} className={`rounded-lg px-3 py-1.5 ${workspaceMode === 'providers' ? 'bg-ds-card font-semibold text-ds-ink shadow-sm' : 'text-ds-muted'}`}>模型供应商</button>
              <button type="button" onClick={() => setWorkspaceMode('routes')} className={`rounded-lg px-3 py-1.5 ${workspaceMode === 'routes' ? 'bg-ds-card font-semibold text-accent shadow-sm' : 'text-ds-muted'}`}>高级本地中转站</button>
            </div>
          {workspaceMode === 'providers' ? <button
            ref={addProviderButtonRef}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={addMenuOpen}
            onClick={openAddProviderDialog}
            className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full bg-accent px-4 text-[12.5px] font-semibold text-white shadow-sm transition hover:opacity-90"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2} />
            {t('modelProviderAdd')}
          </button> : null}
          </div>
        </header>
        {workspaceMode === 'routes' ? (
          <ModelRoutesSettings
            settings={provider}
            onChange={(next) => update({ provider: { routePools: next.routePools, localGateway: next.localGateway } })}
            saveStatus={saveStatus}
            saveError={saveError}
            onRetrySave={retrySave}
            publicBaseUrl={`http://127.0.0.1:${kun.port}`}
          />
        ) : <div className="grid gap-4 p-4">
          <label className="grid gap-1.5 lg:hidden">
            <span className="text-[12px] font-semibold text-ds-muted">{t('modelProviderCompactSelect')}</span>
            <select
              className={selectControlClass}
              value={activeProvider?.id ?? ''}
              onChange={(event) => setSelectedProviderId(event.target.value)}
            >
              {displayProviders.map((item) => (
                <option key={item.id} value={item.id}>{item.name.trim() || item.id}</option>
              ))}
            </select>
          </label>
          <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
            <aside className="hidden min-w-0 content-start gap-3 lg:grid">
              {displayProviders.length > 5 ? (
                <label className="relative block">
                  <Search
                    className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ds-faint"
                    strokeWidth={1.9}
                  />
                  <input
                    value={providerListQuery}
                    onChange={(event) => setProviderListQuery(event.target.value)}
                    placeholder={t('modelProviderSearchPlaceholder')}
                    aria-label={t('modelProviderSearchPlaceholder')}
                    className="w-full rounded-xl border border-ds-border bg-ds-card py-2 pl-9 pr-3 text-[12.5px] text-ds-ink shadow-sm focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30"
                  />
                </label>
              ) : null}
              {grouped ? (
                <>
                  {planProviders.length > 0 ? (
                    <ProviderListGroup label={t('modelProviderGroupPlans')} count={planProviders.length}>
                      {planProviders.map(renderProviderButton)}
                    </ProviderListGroup>
                  ) : null}
                  {apiProviders.length > 0 ? (
                    <ProviderListGroup label={t('modelProviderGroupApi')} count={apiProviders.length}>
                      {apiProviders.map(renderProviderButton)}
                    </ProviderListGroup>
                  ) : null}
                </>
              ) : (
                <div className="grid gap-2">{apiProviders.map(renderProviderButton)}</div>
              )}
              {filteredProviders.length === 0 ? (
                <p className="rounded-xl border border-dashed border-ds-border-muted px-3 py-6 text-center text-[12px] text-ds-faint">
                  {t('modelProviderSearchEmpty', { query: providerListQuery.trim() })}
                </p>
              ) : null}
            </aside>
            {activeProvider ? (
              <div className="grid min-w-0 content-start gap-4 rounded-2xl border border-ds-border-muted bg-ds-main/30 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 truncate text-[15px] font-semibold text-ds-ink">
                        {activeProvider.name.trim() || activeProvider.id}
                      </span>
                      <span className="truncate font-mono text-[11.5px] text-ds-faint">{activeProvider.id}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {isDraftActive ? (
                        <StatusPill tone="warning">{t('modelProviderDraftBadge')}</StatusPill>
                      ) : activeKunProviderId === activeProvider.id ? (
                        <StatusPill tone="success" icon={<CheckCircle2 className="h-3 w-3" strokeWidth={2} />}>
                          {t('modelProviderInUse')}
                        </StatusPill>
                      ) : null}
                      <StatusPill
                        tone={activeProbeBlocked ? 'warning' : 'success'}
                        icon={activeProbeBlocked ? <AlertCircle className="h-3 w-3" /> : undefined}
                      >
                        {activeProbeBlocked ? t('modelProviderNeedsConfiguration') : t('modelProviderReady')}
                      </StatusPill>
                      {!isDraftActive ? (
                        <StatusPill
                          tone={saveStatus === 'error' ? 'error' : saveStatus === 'saved' ? 'success' : 'muted'}
                          title={saveStatus === 'error' ? saveError : undefined}
                        >
                          {saveStatus === 'saving'
                            ? t('applying')
                            : saveStatus === 'error'
                              ? t('applyFailed')
                              : saveStatus === 'saved'
                                ? t('applied')
                                : t('autoApplyHint')}
                        </StatusPill>
                      ) : null}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={probeBusy || activeProbeBlocked}
                    title={activeMissingCredential
                      ? t('modelProviderPresetMissingKeyForProbe')
                      : activeBaseUrlInvalid
                        ? t('modelProviderInvalidUrl')
                        : undefined}
                    onClick={() => void runProbe(activeProvider, 'test')}
                    className="inline-flex h-8 items-center gap-1.5 rounded-full border border-ds-border bg-ds-card px-3 text-[12px] font-medium text-ds-muted shadow-sm transition hover:bg-ds-hover hover:text-ds-ink disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {probeBusy && activeProbe?.mode === 'test'
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.9} />
                      : <PlugZap className="h-3.5 w-3.5" strokeWidth={1.9} />}
                    {t('modelProviderTestConnection')}
                  </button>
                </div>
                <div
                  role="tablist"
                  aria-label={t('modelProviderWorkspaceTabs')}
                  className="flex min-w-0 gap-1 overflow-x-auto rounded-xl border border-ds-border-muted bg-ds-card/70 p-1"
                >
                  {PROVIDER_TASK_TABS.map((tab) => {
                    const selected = activeTab === tab.id
                    return (
                      <button
                        key={tab.id}
                        id={`provider-settings-tab-${tab.id}`}
                        type="button"
                        role="tab"
                        aria-selected={selected}
                        aria-controls={`provider-settings-panel-${tab.id}`}
                        tabIndex={selected ? 0 : -1}
                        onClick={() => setActiveTab(tab.id)}
                        onKeyDown={(event) => handleProviderTabKeyDown(event, tab.id)}
                        className={`h-8 min-w-fit flex-1 rounded-lg px-3 text-[12.5px] font-medium transition ${
                          selected
                            ? 'bg-ds-card text-ds-ink shadow-sm ring-1 ring-ds-border-muted'
                            : 'text-ds-muted hover:bg-ds-hover hover:text-ds-ink'
                        }`}
                      >
                        {t(tab.labelKey)}
                      </button>
                    )
                  })}
                </div>
                {probeNotice ? <InlineNoticeView notice={probeNotice} /> : null}
                {activeTab === 'connection' ? (
                  <div
                    id="provider-settings-panel-connection"
                    role="tabpanel"
                    aria-labelledby="provider-settings-tab-connection"
                    className="grid gap-4"
                  >
                <DetailSection title={t('modelProviderSectionBasics')}>
                  <div className="grid gap-3">
                    <label className={fieldLabelClass}>
                      {t('modelProviderName')}
                      <input
                        className={textInputClass}
                        value={activeProvider.name}
                        onChange={(e) => updateModelProvider(activeProvider.id, { name: e.target.value })}
                      />
                    </label>
                  </div>
                </DetailSection>
                <DetailSection title={t('modelProviderSectionConnection')}>
                  {isCodexProvider(activeProvider) ? (
                    <CodexLoginSection
                      provider={activeProvider}
                      onCredentialChange={(apiKey) => updateModelProvider(activeProvider.id, { apiKey })}
                      t={t}
                    />
                  ) : isGeminiSubscriptionProvider(activeProvider) ? (
                    <GeminiSubscriptionSection
                      onModelsChange={(models) => updateModelProvider(activeProvider.id, { models })}
                      t={t}
                    />
                  ) : isGeminiCliApiSubscriptionProvider(activeProvider) ? (
                    <GeminiCliApiSubscriptionSection
                      onModelsChange={(models) => updateModelProvider(activeProvider.id, { models })}
                      t={t}
                    />
                  ) : isCursorSubscriptionProvider(activeProvider) ? (
                    <div className="grid gap-3">
                      <div className="grid gap-2 rounded-lg border border-ds-border bg-ds-main/30 px-3 py-2 text-[12px] leading-5 text-ds-muted sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                        <p>{t('cursorSubscriptionNote')}</p>
                        {activeCursorApiKeyUrl ? (
                          <button
                            type="button"
                            className="inline-flex w-fit shrink-0 items-center gap-1.5 rounded-lg border border-accent/20 bg-accent/5 px-3 py-1.5 font-medium text-accent transition hover:bg-accent/10"
                            onClick={() => {
                              if (typeof window.kunGui?.openExternal !== 'function') return
                              void window.kunGui.openExternal(activeCursorApiKeyUrl).catch(() => undefined)
                            }}
                          >
                            {t('cursorSubscriptionGetApiKey')}
                            <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.9} />
                          </button>
                        ) : null}
                      </div>
                      <label className={fieldLabelClass}>
                        {t('modelProviderApiKey')}
                        <SecretInput
                          value={activeProvider.apiKey}
                          onChange={(value) => updateModelProvider(activeProvider.id, { apiKey: value })}
                          visible={showApiKey}
                          onToggleVisibility={() => setShowApiKey((value: boolean) => !value)}
                          placeholder={t('modelProviderApiKeyPlaceholder')}
                          autoComplete="off"
                          showLabel={t('showSecret')}
                          hideLabel={t('hideSecret')}
                        />
                      </label>
                      {activeCursorAccountFresh && activeCursorAccount ? (
                        <p className="text-[12px] leading-5 text-ds-muted">
                          {t('cursorSubscriptionAccount', {
                            account: activeCursorAccount.label,
                            keyName: activeCursorAccount.apiKeyName
                          })}
                        </p>
                      ) : null}
                    </div>
                  ) : isGrokSubscriptionProvider(activeProvider) ? (
                    <GrokLoginSection
                      provider={activeProvider}
                      onCredentialChange={(apiKey) => updateModelProvider(activeProvider.id, { apiKey })}
                      t={t}
                    />
                  ) : isAgentSdkProvider(activeProvider) ? (
                    <ClaudeSubscriptionSection
                      provider={activeProvider}
                      onTokenChange={(token) => updateModelProvider(activeProvider.id, { apiKey: token })}
                      onModelsChange={(models) => updateModelProvider(activeProvider.id, { models })}
                      t={t}
                    />
                  ) : (
                    <>
                      <label className={fieldLabelClass}>
                        {t('modelProviderApiKey')}
                        <SecretInput
                          value={activeProvider.apiKey}
                          onChange={(value) => updateModelProvider(activeProvider.id, { apiKey: value })}
                          visible={showApiKey}
                          onToggleVisibility={() => setShowApiKey((value: boolean) => !value)}
                          placeholder={t('modelProviderApiKeyPlaceholder')}
                          autoComplete="off"
                          showLabel={t('showSecret')}
                          hideLabel={t('hideSecret')}
                        />
                      </label>
                      <label className={fieldLabelClass}>
                        {t('modelProviderBaseUrl')}
                        <input
                          className={textInputClass}
                          value={activeProvider.baseUrl}
                          placeholder={t('baseUrlPlaceholder')}
                          spellCheck={false}
                          onChange={(e) => updateModelProvider(activeProvider.id, { baseUrl: e.target.value })}
                        />
                        {activeBaseUrlInvalid ? (
                          <span className="text-[12px] font-normal text-amber-600 dark:text-amber-300">
                            {t('modelProviderInvalidUrl')}
                          </span>
                        ) : null}
                      </label>
                    </>
                  )}
                  {activeTokenPlanRegions.length > 0 ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[12px] font-semibold text-ds-muted">
                        {t('modelProviderTokenPlanRegion')}
                      </span>
                      {activeTokenPlanRegions.map((region) => {
                        const active = activeProvider.baseUrl.trim() === region.baseUrl
                        return (
                          <button
                            key={region.id}
                            type="button"
                            onClick={() => {
                              const patch: Partial<ModelProviderProfileV1> = { baseUrl: region.baseUrl }
                              const speech = activeProvider.speech
                              if (speech && activeTokenPlanRegions.some((item) => item.baseUrl === speech.baseUrl.trim())) {
                                patch.speech = { ...speech, baseUrl: region.baseUrl }
                              }
                              const textToSpeech = activeProvider.textToSpeech
                              if (
                                textToSpeech &&
                                activeTokenPlanRegions.some((item) => item.baseUrl === textToSpeech.baseUrl.trim())
                              ) {
                                patch.textToSpeech = { ...textToSpeech, baseUrl: region.baseUrl }
                              }
                              updateModelProvider(activeProvider.id, patch)
                            }}
                            className={`inline-flex h-7 items-center rounded-full border px-2.5 text-[12px] font-medium transition ${
                              active
                                ? 'border-accent/60 bg-ds-main/45 text-ds-ink ring-1 ring-accent/30'
                                : 'border-ds-border bg-ds-card text-ds-muted hover:bg-ds-hover hover:text-ds-ink'
                            }`}
                          >
                            {t(`firstRunRegion_${region.id}`)}
                          </button>
                        )
                      })}
                    </div>
                  ) : null}
                  <label className={fieldLabelClass}>
                    {t('modelProviderEndpointFormat')}
                    <select
                      className={selectControlClass}
                      value={activeProvider.endpointFormat}
                      disabled={isOAuthSubscriptionProvider(activeProvider) || isDelegatedEndpointProvider(activeProvider)}
                      onChange={(e) => updateModelProvider(activeProvider.id, {
                        endpointFormat: e.target.value as ModelEndpointFormat
                      })}
                    >
                      {MODEL_ENDPOINT_FORMATS.map((format) => (
                        <option key={format} value={format}>
                          {t(MODEL_ENDPOINT_FORMAT_LABEL_KEYS[format])}
                        </option>
                      ))}
                    </select>
                  </label>
                  {isCodexProvider(activeProvider) ? (
                    <p className="text-[12px] leading-5 text-ds-muted">
                      {t('codexEndpointLocked')}
                    </p>
                  ) : isGeminiSubscriptionProvider(activeProvider) ? (
                    <p className="text-[12px] leading-5 text-ds-muted">
                      {t('geminiEndpointLocked')}
                    </p>
                  ) : isGeminiCliApiSubscriptionProvider(activeProvider) ? (
                    <p className="text-[12px] leading-5 text-ds-muted">
                      {t('geminiCliApiEndpointLocked')}
                    </p>
                  ) : isCursorSubscriptionProvider(activeProvider) ? (
                    <p className="text-[12px] leading-5 text-ds-muted">
                      {t('cursorEndpointLocked')}
                    </p>
                  ) : isGrokSubscriptionProvider(activeProvider) ? (
                    <p className="text-[12px] leading-5 text-ds-muted">
                      {t('grokEndpointLocked')}
                    </p>
                  ) : isAgentSdkProvider(activeProvider) ? (
                    <p className="text-[12px] leading-5 text-ds-muted">
                      {t('claudeEndpointLocked')}
                    </p>
                  ) : activeProvider.endpointFormat === 'custom_endpoint' ? (
                    <p className="text-[12px] leading-5 text-ds-muted">
                      {t('modelEndpointCustomEndpointDesc')}
                    </p>
                  ) : null}
                </DetailSection>
                  </div>
                ) : null}
                {activeTab === 'advanced' ? (
                  <div
                    id="provider-settings-panel-advanced"
                    role="tabpanel"
                    aria-labelledby="provider-settings-tab-advanced"
                    className="grid gap-4"
                  >
                    <DetailSection title={t('modelProviderIdentitySection')}>
                      <label className={fieldLabelClass}>
                        {t('modelProviderId')}
                        <span className="relative block">
                          <input
                            className={`w-full min-w-0 rounded-xl border border-ds-border bg-ds-card px-3 py-2 font-mono text-[13px] font-normal shadow-sm ${
                              canEditActiveProviderId
                                ? 'text-ds-ink focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30'
                                : 'pr-9 text-ds-faint'
                            }`}
                            value={activeProvider.id}
                            readOnly={!canEditActiveProviderId}
                            spellCheck={false}
                            onChange={(e) => updateModelProviderId(activeProvider.id, e.target.value)}
                          />
                          {!canEditActiveProviderId ? (
                            <span
                              title={t('modelProviderIdLocked')}
                              className="absolute right-3 top-1/2 -translate-y-1/2 text-ds-faint"
                            >
                              <Lock className="h-3.5 w-3.5" strokeWidth={1.9} />
                            </span>
                          ) : null}
                        </span>
                        <span className="text-[12px] font-normal leading-5 text-ds-faint">
                          {t('modelProviderIdentityHint')}
                        </span>
                      </label>
                    </DetailSection>
                <DetailSection
                  title={t('modelProviderRetrySection')}
                  action={
                    <Toggle
                      ariaLabel={t('modelProviderRetrySection')}
                      checked={activeRetry.maxAttempts > 0}
                      onChange={(enabled) => updateModelProvider(activeProvider.id, {
                        retry: {
                          ...activeRetry,
                          maxAttempts: enabled ? ENABLED_MODEL_REQUEST_RETRY_ATTEMPTS : 0
                        }
                      })}
                    />
                  }
                >
                  {activeRetry.maxAttempts > 0 ? (
                    <div className="grid gap-3">
                      <p className="text-[12px] leading-5 text-ds-faint">
                        {t('modelProviderRetryStatusCodesHint')}
                      </p>
                      <div className="grid gap-3 md:grid-cols-3">
                        <label className={fieldLabelClass}>
                          {t('modelProviderRetryMaxAttempts')}
                          <input
                            type="number"
                            min={1}
                            max={10}
                            step={1}
                            className={textInputClass}
                            value={activeRetry.maxAttempts}
                            onChange={(e) => updateModelProvider(activeProvider.id, {
                              retry: {
                                ...activeRetry,
                                maxAttempts: Math.min(10, Math.max(1, Math.round(Number(e.target.value) || 1)))
                              }
                            })}
                          />
                        </label>
                        <label className={fieldLabelClass}>
                          {t('modelProviderRetryInitialDelayMs')}
                          <input
                            type="number"
                            min={0}
                            max={600000}
                            step={100}
                            className={textInputClass}
                            value={activeRetry.initialDelayMs}
                            onChange={(e) => updateModelProvider(activeProvider.id, {
                              retry: {
                                ...activeRetry,
                                initialDelayMs: Math.min(600_000, Math.max(0, Math.round(Number(e.target.value) || 0)))
                              }
                            })}
                          />
                        </label>
                        <label className={fieldLabelClass}>
                          {t('modelProviderRetryStatusCodes')}
                          <input
                            className={textInputClass}
                            value={retryStatusCodesText(activeRetry.httpStatusCodes)}
                            onChange={(e) => updateModelProvider(activeProvider.id, {
                              retry: {
                                ...activeRetry,
                                httpStatusCodes: parseRetryStatusCodes(e.target.value)
                              }
                            })}
                          />
                        </label>
                      </div>
                    </div>
                  ) : null}
                </DetailSection>
                  </div>
                ) : null}
                {activeTab === 'models' ? (
                  <div
                    id="provider-settings-panel-models"
                    role="tabpanel"
                    aria-labelledby="provider-settings-tab-models"
                    className="grid gap-4"
                  >
                <DetailSection
                  title={`${t('modelProviderModels')} · ${providerModelCount(activeProvider)}`}
                  action={
                    <button
                      type="button"
                      disabled={probeBusy || activeProbeBlocked}
                      onClick={() => void runProbe(activeProvider, 'fetch')}
                      className="inline-flex h-7 items-center gap-1.5 rounded-full border border-ds-border bg-ds-card px-2.5 text-[12px] font-medium text-ds-muted shadow-sm transition hover:bg-ds-hover hover:text-ds-ink disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {probeBusy && activeProbe?.mode === 'fetch'
                        ? <Loader2 className="h-3 w-3 animate-spin" strokeWidth={1.9} />
                        : <Download className="h-3 w-3" strokeWidth={1.9} />}
                      {t('modelProviderFetchModels')}
                    </button>
                  }
                >
                  <ProviderModelsManager
                    key={activeProvider.id}
                    provider={activeProvider}
                    t={t}
                    selectControlClass={selectControlClass}
                    onChange={(next) => patchProviderProfile(activeProvider, () => next)}
                  />
                </DetailSection>
                  </div>
                ) : null}
                {activeTab === 'capabilities' ? (
                  <div
                    id="provider-settings-panel-capabilities"
                    role="tabpanel"
                    aria-labelledby="provider-settings-tab-capabilities"
                    className="grid gap-3"
                  >
                <CapabilitySection
                  capabilityId="image"
                  icon={<ImageIcon className="h-4 w-4" strokeWidth={1.9} />}
                  title={t('modelProviderImageCapability')}
                  description={t('modelProviderImageCapabilityDesc')}
                  enabled={Boolean(activeProvider.image)}
                  invalid={activeImageBaseUrlInvalid}
                  expanded={expandedCapabilities.has('image')}
                  modelCountLabel={activeProvider.image?.models.length
                    ? t('modelProviderModelCount', { total: activeProvider.image.models.length })
                    : undefined}
                  configureLabel={t('modelProviderCapabilityConfigure')}
                  collapseLabel={t('modelProviderCapabilityCollapse')}
                  enabledLabel={t('modelProviderCapabilityEnabled')}
                  disabledLabel={t('modelProviderCapabilityDisabled')}
                  needsConfigurationLabel={t('modelProviderNeedsConfiguration')}
                  onExpandedChange={(expanded) => setCapabilityExpanded('image', expanded)}
                  onToggle={(value) => {
                    if (value) {
                      updateModelProvider(activeProvider.id, {
                        image: presetImageCapability(activeProvider) ?? defaultImageCapability(activeProvider.baseUrl)
                      })
                      setCapabilityExpanded('image', true)
                    } else {
                      removeModelProviderImage(activeProvider.id)
                      setCapabilityExpanded('image', false)
                    }
                  }}
                >
                  {activeProvider.image ? (
                    <div className="grid gap-3 md:grid-cols-2">
                      <label className={fieldLabelClass}>
                        {t('imageGenProtocol')}
                        <select
                          className={selectControlClass}
                          value={activeProvider.image.protocol}
                          onChange={(e) => updateModelProviderImage(activeProvider.id, {
                            protocol: e.target.value as ImageGenerationProtocol
                          })}
                        >
                          {Object.entries(IMAGE_GENERATION_PROTOCOL_LABEL_KEYS).map(([protocol, key]) => (
                            <option key={protocol} value={protocol}>{t(key)}</option>
                          ))}
                        </select>
                      </label>
                      <label className={fieldLabelClass}>
                        {t('imageGenBaseUrl')}
                        <input
                          className={textInputClass}
                          value={activeProvider.image.baseUrl}
                          placeholder={t('imageGenBaseUrlPlaceholder')}
                          spellCheck={false}
                          onChange={(e) => updateModelProviderImage(activeProvider.id, { baseUrl: e.target.value })}
                        />
                        {activeImageBaseUrlInvalid ? (
                          <span className="text-[12px] font-normal text-amber-600 dark:text-amber-300">
                            {t('modelProviderInvalidUrl')}
                          </span>
                        ) : null}
                      </label>
                      <label className={`${fieldLabelClass} md:col-span-2`}>
                        {t('imageGenModel')}
                        <ModelChipsInput
                          key={`${activeProvider.id}-image`}
                          values={activeProvider.image.models}
                          onChange={(models) => updateModelProviderImage(activeProvider.id, { models })}
                          placeholder={t('modelProviderModelsPlaceholder')}
                          inputAriaLabel={t('imageGenModel')}
                          removeLabel={(model) => t('modelProviderModelRemove', { model })}
                        />
                      </label>
                    </div>
                  ) : null}
                </CapabilitySection>
                <CapabilitySection
                  capabilityId="speech"
                  icon={<Mic className="h-4 w-4" strokeWidth={1.9} />}
                  title={t('modelProviderSpeechCapability')}
                  description={t('modelProviderSpeechCapabilityDesc')}
                  enabled={Boolean(activeProvider.speech)}
                  invalid={activeSpeechBaseUrlInvalid}
                  expanded={expandedCapabilities.has('speech')}
                  modelCountLabel={activeProvider.speech?.models.length
                    ? t('modelProviderModelCount', { total: activeProvider.speech.models.length })
                    : undefined}
                  configureLabel={t('modelProviderCapabilityConfigure')}
                  collapseLabel={t('modelProviderCapabilityCollapse')}
                  enabledLabel={t('modelProviderCapabilityEnabled')}
                  disabledLabel={t('modelProviderCapabilityDisabled')}
                  needsConfigurationLabel={t('modelProviderNeedsConfiguration')}
                  toggleDisabled={activeSpeechToggleDisabled}
                  onExpandedChange={(expanded) => setCapabilityExpanded('speech', expanded)}
                  onToggle={(value) => {
                    if (value) {
                      updateModelProvider(activeProvider.id, {
                        speech: presetSpeechCapability(activeProvider) ?? defaultSpeechCapability(activeProvider.baseUrl)
                      })
                      setCapabilityExpanded('speech', true)
                    } else {
                      removeModelProviderSpeech(activeProvider.id)
                      setCapabilityExpanded('speech', false)
                    }
                  }}
                >
                  {activeProvider.speech ? (
                    <div className="grid gap-3 md:grid-cols-2">
                      <label className={fieldLabelClass}>
                        {t('speechToTextProtocol')}
                        <select
                          className={selectControlClass}
                          value={activeProvider.speech.protocol}
                          onChange={(e) => updateModelProviderSpeech(activeProvider.id, {
                            protocol: e.target.value as SpeechToTextProtocol
                          })}
                        >
                          {Object.entries(SPEECH_TO_TEXT_PROTOCOL_LABEL_KEYS).map(([protocol, key]) => (
                            <option key={protocol} value={protocol}>{t(key)}</option>
                          ))}
                        </select>
                      </label>
                      <label className={fieldLabelClass}>
                        {t('speechToTextBaseUrl')}
                        <input
                          className={textInputClass}
                          value={activeProvider.speech.baseUrl}
                          placeholder={t('baseUrlPlaceholder')}
                          spellCheck={false}
                          onChange={(e) => updateModelProviderSpeech(activeProvider.id, { baseUrl: e.target.value })}
                        />
                        {activeSpeechBaseUrlInvalid ? (
                          <span className="text-[12px] font-normal text-amber-600 dark:text-amber-300">
                            {t('modelProviderInvalidUrl')}
                          </span>
                        ) : null}
                      </label>
                      <label className={`${fieldLabelClass} md:col-span-2`}>
                        {t('speechToTextModels')}
                        <ModelChipsInput
                          key={`${activeProvider.id}-speech`}
                          values={activeProvider.speech.models}
                          onChange={(models) => updateModelProviderSpeech(activeProvider.id, { models })}
                          placeholder={t('modelProviderModelsPlaceholder')}
                          inputAriaLabel={t('speechToTextModels')}
                          removeLabel={(model) => t('modelProviderModelRemove', { model })}
                        />
                      </label>
                    </div>
                  ) : null}
                </CapabilitySection>
                <CapabilitySection
                  capabilityId="tts"
                  icon={<AudioLines className="h-4 w-4" strokeWidth={1.9} />}
                  title={t('modelProviderTextToSpeechCapability')}
                  description={t('modelProviderTextToSpeechCapabilityDesc')}
                  enabled={Boolean(activeProvider.textToSpeech)}
                  invalid={activeTextToSpeechBaseUrlInvalid}
                  expanded={expandedCapabilities.has('tts')}
                  modelCountLabel={activeProvider.textToSpeech?.models.length
                    ? t('modelProviderModelCount', { total: activeProvider.textToSpeech.models.length })
                    : undefined}
                  configureLabel={t('modelProviderCapabilityConfigure')}
                  collapseLabel={t('modelProviderCapabilityCollapse')}
                  enabledLabel={t('modelProviderCapabilityEnabled')}
                  disabledLabel={t('modelProviderCapabilityDisabled')}
                  needsConfigurationLabel={t('modelProviderNeedsConfiguration')}
                  onExpandedChange={(expanded) => setCapabilityExpanded('tts', expanded)}
                  onToggle={(value) => {
                    if (value) {
                      updateModelProvider(activeProvider.id, {
                        textToSpeech: presetTextToSpeechCapability(activeProvider) ??
                          defaultTextToSpeechCapability(activeProvider.baseUrl)
                      })
                      setCapabilityExpanded('tts', true)
                    } else {
                      removeModelProviderTextToSpeech(activeProvider.id)
                      setCapabilityExpanded('tts', false)
                    }
                  }}
                >
                  {activeProvider.textToSpeech ? (
                    <div className="grid gap-3 md:grid-cols-2">
                      <label className={fieldLabelClass}>
                        {t('textToSpeechProtocol')}
                        <select
                          className={selectControlClass}
                          value={activeProvider.textToSpeech.protocol}
                          onChange={(e) => updateModelProviderTextToSpeech(activeProvider.id, {
                            protocol: e.target.value as TextToSpeechProtocol
                          })}
                        >
                          {Object.entries(TEXT_TO_SPEECH_PROTOCOL_LABEL_KEYS).map(([protocol, key]) => (
                            <option key={protocol} value={protocol}>{t(key)}</option>
                          ))}
                        </select>
                      </label>
                      <label className={fieldLabelClass}>
                        {t('textToSpeechBaseUrl')}
                        <input
                          className={textInputClass}
                          value={activeProvider.textToSpeech.baseUrl}
                          placeholder={t('textToSpeechBaseUrlPlaceholder')}
                          spellCheck={false}
                          onChange={(e) => updateModelProviderTextToSpeech(activeProvider.id, { baseUrl: e.target.value })}
                        />
                        {activeTextToSpeechBaseUrlInvalid ? (
                          <span className="text-[12px] font-normal text-amber-600 dark:text-amber-300">
                            {t('modelProviderInvalidUrl')}
                          </span>
                        ) : null}
                      </label>
                      <label className={`${fieldLabelClass} md:col-span-2`}>
                        {t('textToSpeechModel')}
                        <ModelChipsInput
                          key={`${activeProvider.id}-tts`}
                          values={activeProvider.textToSpeech.models}
                          onChange={(models) => updateModelProviderTextToSpeech(activeProvider.id, { models })}
                          placeholder={t('modelProviderModelsPlaceholder')}
                          inputAriaLabel={t('textToSpeechModel')}
                          removeLabel={(model) => t('modelProviderModelRemove', { model })}
                        />
                      </label>
                    </div>
                  ) : null}
                </CapabilitySection>
                <CapabilitySection
                  capabilityId="music"
                  icon={<Music2 className="h-4 w-4" strokeWidth={1.9} />}
                  title={t('modelProviderMusicCapability')}
                  description={t('modelProviderMusicCapabilityDesc')}
                  enabled={Boolean(activeProvider.music)}
                  invalid={activeMusicBaseUrlInvalid}
                  expanded={expandedCapabilities.has('music')}
                  modelCountLabel={activeProvider.music?.models.length
                    ? t('modelProviderModelCount', { total: activeProvider.music.models.length })
                    : undefined}
                  configureLabel={t('modelProviderCapabilityConfigure')}
                  collapseLabel={t('modelProviderCapabilityCollapse')}
                  enabledLabel={t('modelProviderCapabilityEnabled')}
                  disabledLabel={t('modelProviderCapabilityDisabled')}
                  needsConfigurationLabel={t('modelProviderNeedsConfiguration')}
                  onExpandedChange={(expanded) => setCapabilityExpanded('music', expanded)}
                  onToggle={(value) => {
                    if (value) {
                      updateModelProvider(activeProvider.id, {
                        music: presetMusicCapability(activeProvider) ?? defaultMusicCapability(activeProvider.baseUrl)
                      })
                      setCapabilityExpanded('music', true)
                    } else {
                      removeModelProviderMusic(activeProvider.id)
                      setCapabilityExpanded('music', false)
                    }
                  }}
                >
                  {activeProvider.music ? (
                    <div className="grid gap-3 md:grid-cols-2">
                      <label className={fieldLabelClass}>
                        {t('musicGenerationProtocol')}
                        <select
                          className={selectControlClass}
                          value={activeProvider.music.protocol}
                          onChange={(e) => updateModelProviderMusic(activeProvider.id, {
                            protocol: e.target.value as MusicGenerationProtocol
                          })}
                        >
                          {Object.entries(MUSIC_GENERATION_PROTOCOL_LABEL_KEYS).map(([protocol, key]) => (
                            <option key={protocol} value={protocol}>{t(key)}</option>
                          ))}
                        </select>
                      </label>
                      <label className={fieldLabelClass}>
                        {t('musicGenerationBaseUrl')}
                        <input
                          className={textInputClass}
                          value={activeProvider.music.baseUrl}
                          placeholder={t('musicGenerationBaseUrlPlaceholder')}
                          spellCheck={false}
                          onChange={(e) => updateModelProviderMusic(activeProvider.id, { baseUrl: e.target.value })}
                        />
                        {activeMusicBaseUrlInvalid ? (
                          <span className="text-[12px] font-normal text-amber-600 dark:text-amber-300">
                            {t('modelProviderInvalidUrl')}
                          </span>
                        ) : null}
                      </label>
                      <label className={`${fieldLabelClass} md:col-span-2`}>
                        {t('musicGenerationModel')}
                        <ModelChipsInput
                          key={`${activeProvider.id}-music`}
                          values={activeProvider.music.models}
                          onChange={(models) => updateModelProviderMusic(activeProvider.id, { models })}
                          placeholder={t('modelProviderModelsPlaceholder')}
                          inputAriaLabel={t('musicGenerationModel')}
                          removeLabel={(model) => t('modelProviderModelRemove', { model })}
                        />
                      </label>
                    </div>
                  ) : null}
                </CapabilitySection>
                <CapabilitySection
                  capabilityId="video"
                  icon={<Clapperboard className="h-4 w-4" strokeWidth={1.9} />}
                  title={t('modelProviderVideoCapability')}
                  description={t('modelProviderVideoCapabilityDesc')}
                  enabled={Boolean(activeProvider.video)}
                  invalid={activeVideoBaseUrlInvalid}
                  expanded={expandedCapabilities.has('video')}
                  modelCountLabel={activeProvider.video?.models.length
                    ? t('modelProviderModelCount', { total: activeProvider.video.models.length })
                    : undefined}
                  configureLabel={t('modelProviderCapabilityConfigure')}
                  collapseLabel={t('modelProviderCapabilityCollapse')}
                  enabledLabel={t('modelProviderCapabilityEnabled')}
                  disabledLabel={t('modelProviderCapabilityDisabled')}
                  needsConfigurationLabel={t('modelProviderNeedsConfiguration')}
                  onExpandedChange={(expanded) => setCapabilityExpanded('video', expanded)}
                  onToggle={(value) => {
                    if (value) {
                      updateModelProvider(activeProvider.id, {
                        video: presetVideoCapability(activeProvider) ?? defaultVideoCapability(activeProvider.baseUrl)
                      })
                      setCapabilityExpanded('video', true)
                    } else {
                      removeModelProviderVideo(activeProvider.id)
                      setCapabilityExpanded('video', false)
                    }
                  }}
                >
                  {activeProvider.video ? (
                    <div className="grid gap-3 md:grid-cols-2">
                      <label className={fieldLabelClass}>
                        {t('videoGenerationProtocol')}
                        <select
                          className={selectControlClass}
                          value={activeProvider.video.protocol}
                          onChange={(e) => updateModelProviderVideo(activeProvider.id, {
                            protocol: e.target.value as VideoGenerationProtocol
                          })}
                        >
                          {Object.entries(VIDEO_GENERATION_PROTOCOL_LABEL_KEYS).map(([protocol, key]) => (
                            <option key={protocol} value={protocol}>{t(key)}</option>
                          ))}
                        </select>
                      </label>
                      <label className={fieldLabelClass}>
                        {t('videoGenerationBaseUrl')}
                        <input
                          className={textInputClass}
                          value={activeProvider.video.baseUrl}
                          placeholder={t('videoGenerationBaseUrlPlaceholder')}
                          spellCheck={false}
                          onChange={(e) => updateModelProviderVideo(activeProvider.id, { baseUrl: e.target.value })}
                        />
                        {activeVideoBaseUrlInvalid ? (
                          <span className="text-[12px] font-normal text-amber-600 dark:text-amber-300">
                            {t('modelProviderInvalidUrl')}
                          </span>
                        ) : null}
                      </label>
                      <label className={`${fieldLabelClass} md:col-span-2`}>
                        {t('videoGenerationModel')}
                        <ModelChipsInput
                          key={`${activeProvider.id}-video`}
                          values={activeProvider.video.models}
                          onChange={(models) => updateModelProviderVideo(activeProvider.id, { models })}
                          placeholder={t('modelProviderModelsPlaceholder')}
                          inputAriaLabel={t('videoGenerationModel')}
                          removeLabel={(model) => t('modelProviderModelRemove', { model })}
                        />
                      </label>
                    </div>
                  ) : null}
                </CapabilitySection>
                  </div>
                ) : null}
                {!isDraftActive && activeTab === 'advanced' && activeProvider.id !== DEFAULT_MODEL_PROVIDER_ID ? (
                  <DetailSection title={t('modelProviderSectionDanger')}>
                    <div className="flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        onClick={() => void removeModelProvider(activeProvider.id)}
                        className="inline-flex h-9 w-fit items-center gap-2 rounded-full border border-red-200/70 bg-red-50 px-3 text-[12.5px] font-medium text-red-700 transition hover:bg-red-100 dark:border-red-900/70 dark:bg-red-950/25 dark:text-red-200 dark:hover:bg-red-950/40"
                      >
                        <Trash2 className="h-3.5 w-3.5" strokeWidth={1.9} />
                        {t('modelProviderRemove')}
                      </button>
                      <span className="text-[12px] text-ds-faint">{t('modelProviderDangerHint')}</span>
                    </div>
                  </DetailSection>
                ) : null}
                {isDraftActive ? (
                  <div className="sticky bottom-0 z-10 -mx-1 mt-2 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-accent/30 bg-ds-card/95 px-4 py-3 shadow-lg backdrop-blur">
                    <div className="min-w-0">
                      <div className="text-[12.5px] font-semibold text-ds-ink">{t('modelProviderDraftSection')}</div>
                      <p className="mt-0.5 text-[12px] text-ds-faint">
                        {activeProvider.apiKey.trim()
                          ? t('modelProviderDraftHintReady')
                          : t('modelProviderDraftHintNoKey')}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={cancelProviderDraft}
                        className="inline-flex h-9 items-center rounded-full border border-ds-border bg-ds-card px-3 text-[12.5px] font-medium text-ds-muted shadow-sm transition hover:bg-ds-hover hover:text-ds-ink"
                      >
                        {t('modelProviderDraftDiscard')}
                      </button>
                      <button
                        type="button"
                        onClick={commitProviderDraft}
                        className="inline-flex h-9 items-center gap-2 rounded-full bg-accent px-4 text-[12.5px] font-semibold text-white shadow-sm transition hover:opacity-90"
                      >
                        <Plus className="h-3.5 w-3.5" strokeWidth={2} />
                        {t('modelProviderDraftConfirm')}
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>}
      </section>
      <details className="group rounded-2xl border border-ds-border bg-ds-card/95 shadow-sm">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 [&::-webkit-details-marker]:hidden">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[14px] font-semibold text-ds-ink">{t('modelProviderGlobalNetwork')}</h2>
              <StatusPill tone={providerProxy.enabled ? 'success' : 'muted'}>
                {providerProxy.enabled ? t('proxyEnabled') : t('modelProviderCapabilityDisabled')}
              </StatusPill>
            </div>
            <p className="mt-1 text-[12.5px] leading-5 text-ds-muted">{t('proxyUrlDesc')}</p>
          </div>
          <ChevronDown className="h-4 w-4 shrink-0 text-ds-faint transition group-open:rotate-180" strokeWidth={1.9} />
        </summary>
        <div className="grid gap-3 border-t border-ds-border-muted px-5 py-4 md:grid-cols-[220px_minmax(0,1fr)]">
            <label className="flex items-center justify-between gap-3 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[13px] text-ds-muted shadow-sm">
              <span>{t('proxyEnabled')}</span>
              <Toggle
                ariaLabel={t('proxyEnabled')}
                checked={providerProxy.enabled === true}
                onChange={(enabled) => updateProviderProxy({ enabled })}
              />
            </label>
            <input
              className={textInputClass}
              placeholder={t('proxyUrlPlaceholder')}
              value={providerProxy.url}
              spellCheck={false}
              onChange={(e) => updateProviderProxy({ url: e.target.value })}
            />
        </div>
      </details>
      {addMenuOpen ? (
        <div
          className="ds-no-drag fixed inset-0 z-50 grid place-items-center overscroll-none bg-slate-950/40 p-4 backdrop-blur-md dark:bg-black/65"
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-provider-dialog-title"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeAddProviderDialog()
          }}
        >
          <section
            ref={addProviderDialogRef}
            onKeyDown={handleAddProviderDialogKeyDown}
            className="flex max-h-[min(720px,calc(100dvh-2rem))] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-ds-border bg-ds-card shadow-panel"
          >
            <header className="flex shrink-0 items-start justify-between gap-3 border-b border-ds-border px-5 py-4">
              <div>
                <h2 id="add-provider-dialog-title" className="text-[15px] font-semibold text-ds-ink">
                  {t('modelProviderAddDialogTitle')}
                </h2>
                <p className="mt-1 text-[12.5px] text-ds-faint">{t('modelProviderAddDialogDesc')}</p>
              </div>
              <button
                type="button"
                aria-label={t('modelProviderAddDialogCancel')}
                onClick={closeAddProviderDialog}
                className="rounded-full p-1.5 text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
              >
                <X className="h-4 w-4" strokeWidth={1.9} />
              </button>
            </header>
            <div className="shrink-0 border-b border-ds-border px-5 py-3">
              <label className="relative block">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ds-faint"
                  strokeWidth={1.9}
                />
                <input
                  autoFocus
                  value={addProviderQuery}
                  onChange={(event) => setAddProviderQuery(event.target.value)}
                  placeholder={t('modelProviderAddDialogSearch')}
                  aria-label={t('modelProviderAddDialogSearch')}
                  className="w-full rounded-xl border border-ds-border bg-ds-card py-2 pl-9 pr-3 text-[13px] text-ds-ink shadow-sm focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30"
                />
              </label>
            </div>
            <div className="min-h-0 flex-1 overscroll-contain overflow-y-auto px-5 py-4">
              <button
                type="button"
                onClick={() => {
                  closeAddProviderDialog()
                  addModelProvider()
                }}
                className="mb-4 flex w-full items-center justify-between gap-3 rounded-xl border border-dashed border-accent/45 bg-accent/5 px-4 py-3 text-left transition hover:bg-accent/10"
              >
                <span>
                  <span className="block text-[13.5px] font-semibold text-ds-ink">{t('modelProviderAddMenuCustom')}</span>
                  <span className="mt-0.5 block text-[12px] text-ds-faint">{t('modelProviderAddCustomDesc')}</span>
                </span>
                <Plus className="h-4 w-4 shrink-0 text-accent" strokeWidth={2} />
              </button>
              {showPlanAddGroup ? (
                <div className="mb-5 grid gap-2">
                  <div className="flex flex-wrap items-center gap-2 px-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-[12px] font-semibold text-ds-muted">{t('modelProviderGroupPlans')}</h3>
                      <span className="text-[11px] text-ds-faint">{planAddEntries.length}</span>
                    </div>
                    <div
                      role="tablist"
                      aria-label={t('modelProviderSubscriptionRegions')}
                      className="inline-flex items-center rounded-lg border border-ds-border-muted bg-ds-main/70 p-0.5"
                    >
                      {SUBSCRIPTION_REGION_TABS.map((tab) => {
                        const selected = subscriptionRegion === tab.id
                        return (
                          <button
                            key={tab.id}
                            type="button"
                            role="tab"
                            aria-selected={selected}
                            tabIndex={selected ? 0 : -1}
                            onClick={() => setSubscriptionRegion(tab.id)}
                            onKeyDown={(event) => handleSubscriptionRegionTabKeyDown(event, tab.id)}
                            className={`min-w-12 rounded-md border px-2.5 py-1 text-[11.5px] font-medium leading-none transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 ${
                              selected
                                ? 'border-accent/25 bg-accent/10 text-accent shadow-sm'
                                : 'border-transparent text-ds-faint hover:bg-ds-card hover:text-ds-muted'
                            }`}
                          >
                            {t(tab.labelKey)}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                  {planAddEntries.length > 0 ? (
                    <div className="grid gap-2 sm:grid-cols-2">{planAddEntries.map(renderAddEntry)}</div>
                  ) : null}
                </div>
              ) : null}
              {apiAddEntries.length > 0 ? (
                <div className="grid gap-2">
                  <div className="flex items-center gap-2 px-1">
                    <h3 className="text-[12px] font-semibold text-ds-muted">{t('modelProviderGroupApi')}</h3>
                    <span className="text-[11px] text-ds-faint">{apiAddEntries.length}</span>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">{apiAddEntries.map(renderAddEntry)}</div>
                </div>
              ) : null}
              {planAddEntries.length === 0 && apiAddEntries.length === 0 ? (
                <p className="rounded-xl border border-dashed border-ds-border-muted px-4 py-8 text-center text-[12.5px] text-ds-faint">
                  {t('modelProviderAddDialogEmpty', { query: addProviderQuery.trim() })}
                </p>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
      {pendingImport && pendingImportProvider ? (
      <ProviderModelImportDialog
        provider={pendingImportProvider}
        providerModelIds={pendingImport.providerModelIds}
        catalogResult={pendingImport.catalogResult}
        providerError={pendingImport.providerError}
        authoritative={pendingImport.authoritative}
        t={t}
        onCancel={() => setPendingImport(null)}
        onConfirm={(picked) => {
          importPickedModels(
            pendingImportProvider,
            picked,
            pendingImport.authoritative,
            pendingImport.modelAliases
          )
          setPendingImport(null)
        }}
      />
    ) : null}
    </>
  )
}
