import { useCallback, useEffect, useState, type ReactElement } from 'react'
import {
  CUSTOM_SPEECH_TO_TEXT_PROVIDER_ID,
  DEFAULT_SPEECH_TO_TEXT_PROTOCOL,
  SPEECH_TO_TEXT_PROTOCOLS,
  resolveKunSpeechToTextSettings
} from '@shared/app-settings'
import {
  LOCAL_WHISPER_MODELS,
  LOCAL_WHISPER_DEFAULT_MODEL_ID,
  LOCAL_WHISPER_DEFAULT_DOWNLOAD_SOURCE_ID,
  LOCAL_WHISPER_DOWNLOAD_SOURCES,
  LOCAL_WHISPER_PROVIDER_ID,
  localWhisperModelById,
  type LocalWhisperDownloadSourceStatus,
  type LocalWhisperModelId,
  type LocalWhisperModelStatus
} from '@shared/local-whisper'
import { Download, Loader2, PlugZap, Square, Trash2 } from 'lucide-react'
import {
  AdvancedSettingsDisclosure,
  InlineNoticeView,
  ModelSelect,
  SecretInput,
  SettingsCard,
  SettingRow,
  Toggle,
  type InlineNotice
} from './settings-controls'

const SPEECH_LANGUAGE_OPTIONS: readonly string[] = ['', 'zh', 'en', 'ja', 'ko']
const CUSTOM_SPEECH_PROTOCOLS = SPEECH_TO_TEXT_PROTOCOLS.filter(
  (protocol) => protocol !== 'local-whisper' && protocol !== 'gemini-cli-audio'
)

/**
 * 0.5s 440Hz mono 16kHz sine tone — enough for the ASR endpoint to accept the
 * request and prove auth + base URL + model are wired correctly.
 */
function buildTestToneWavBase64(): string {
  const sampleRate = 16_000
  const sampleCount = sampleRate / 2
  const dataBytes = sampleCount * 2
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, dataBytes, true)
  for (let i = 0; i < sampleCount; i++) {
    view.setInt16(44 + i * 2, Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / sampleRate)), true)
  }
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  }
  return btoa(binary)
}

const DEFAULT_SPEECH_TO_TEXT = {
  enabled: false,
  providerId: '',
  protocol: DEFAULT_SPEECH_TO_TEXT_PROTOCOL,
  baseUrl: '',
  apiKey: '',
  model: '',
  localWhisperDownloadSource: LOCAL_WHISPER_DEFAULT_DOWNLOAD_SOURCE_ID,
  language: '',
  timeoutMs: 60000
}

function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return ''
  const mb = bytes / 1024 / 1024
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`
}

function formatTransferBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024) return `${Math.max(1, Math.round(bytes))} B`
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024
    return `${kb >= 10 ? Math.round(kb) : kb.toFixed(1)} KB`
  }
  const mb = bytes / 1024 / 1024
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`
}

function formatTransferRate(bytesPerSecond: number | undefined, pendingLabel: string): string {
  const formatted = formatTransferBytes(bytesPerSecond)
  return formatted ? `${formatted}/s` : pendingLabel
}

function speechProtocolLabel(t: (key: string) => string, protocol: string): string {
  if (protocol === 'mimo-asr') return t('speechProtocolMimoAsr')
  if (protocol === 'xai-stt') return t('speechProtocolXaiStt')
  if (protocol === 'gemini-audio') return t('speechProtocolGeminiAudio')
  if (protocol === 'gemini-cli-audio') return t('speechProtocolGeminiCliAudio')
  if (protocol === 'local-whisper') return t('speechProtocolLocalWhisper')
  return t('speechProtocolOpenAi')
}

function supportsSpeechProvider(item: {
  kind?: string
  speech?: { protocol?: string }
}): boolean {
  if (!item.speech) return false
  if (item.speech.protocol === 'gemini-cli-audio') return item.kind === 'gemini-cli-api'
  return (
    item.kind !== 'cursor-sdk' &&
    item.kind !== 'agent-sdk' &&
    item.kind !== 'antigravity-cli'
  )
}

function localWhisperQualityLabel(t: (key: string) => string, tier: string): string {
  return t(`speechToTextLocalQuality_${tier}`)
}

function localWhisperSourceStatusText(
  t: (key: string, values?: Record<string, unknown>) => string,
  status: LocalWhisperDownloadSourceStatus
): string {
  if (status.state === 'available') {
    return t('speechToTextLocalDownloadSourceAvailable', {
      source: status.label,
      ms: status.responseTimeMs ?? 0
    })
  }
  return t('speechToTextLocalDownloadSourceUnavailable', {
    source: status.label,
    message: status.message || (status.httpStatus ? `HTTP ${status.httpStatus}` : t('speechToTextLocalDownloadSourceUnknownError'))
  })
}

function localWhisperModelStateLabel(t: (key: string) => string, state: LocalWhisperModelStatus['state'] | undefined): string {
  if (state === 'ready') return t('speechToTextLocalModelStateReady')
  if (state === 'downloading') return t('speechToTextLocalModelStateDownloading')
  return t('speechToTextLocalModelStateMissing')
}

export function SpeechToTextSettingsSection({ ctx }: { ctx: Record<string, any> }): ReactElement {
  const {
    t,
    form,
    provider,
    kun,
    selectControlClass,
    updateKun
  } = ctx
  const speechToText = {
    ...DEFAULT_SPEECH_TO_TEXT,
    ...(kun.speechToText ?? {})
  }
  const effectiveSpeechToText = form
    ? resolveKunSpeechToTextSettings(form)
    : speechToText
  const speechProviders = (provider?.providers ?? []).filter(supportsSpeechProvider)
  const selectedProviderId = speechToText.protocol === 'local-whisper'
    ? LOCAL_WHISPER_PROVIDER_ID
    : speechToText.providerId || CUSTOM_SPEECH_TO_TEXT_PROVIDER_ID
  const usingLocalWhisper = selectedProviderId === LOCAL_WHISPER_PROVIDER_ID || speechToText.protocol === 'local-whisper'
  const selectedSpeechProvider = speechProviders.find((item: { id: string }) => item.id === selectedProviderId)
  const usingCustomProvider =
    !usingLocalWhisper && (selectedProviderId === CUSTOM_SPEECH_TO_TEXT_PROVIDER_ID || !selectedSpeechProvider)
  const selectedProviderSpeech = selectedSpeechProvider?.speech
  const selectedLocalWhisperModel = localWhisperModelById(
    usingLocalWhisper ? speechToText.model : LOCAL_WHISPER_DEFAULT_MODEL_ID
  )
  const selectedLocalWhisperModelId = selectedLocalWhisperModel.id
  const speechModelOptions = usingLocalWhisper
    ? LOCAL_WHISPER_MODELS.map((model) => model.id)
    : usingCustomProvider
    ? []
    : selectedProviderSpeech?.models ?? []
  const [showSpeechApiKey, setShowSpeechApiKey] = useState(false)
  const [testState, setTestState] = useState<'idle' | 'busy' | InlineNotice>('idle')
  const [localWhisperStatuses, setLocalWhisperStatuses] = useState<Partial<Record<LocalWhisperModelId, LocalWhisperModelStatus>>>({})
  const [localWhisperBusy, setLocalWhisperBusy] = useState<'idle' | 'download' | 'cancel' | 'delete'>('idle')
  const [localWhisperNotice, setLocalWhisperNotice] = useState<InlineNotice | null>(null)
  const [localWhisperSourceStatuses, setLocalWhisperSourceStatuses] = useState<LocalWhisperDownloadSourceStatus[] | null>(null)
  const [localWhisperSourceCheckBusy, setLocalWhisperSourceCheckBusy] = useState(false)
  const localWhisperStatus = localWhisperStatuses[selectedLocalWhisperModelId] ?? null
  const updateSpeechToText = (patch: Record<string, unknown>): void => {
    updateKun({
      speechToText: {
        ...speechToText,
        ...patch
      }
    })
  }

  const setLocalWhisperModelStatus = useCallback((status: LocalWhisperModelStatus): void => {
    setLocalWhisperStatuses((current) => ({
      ...current,
      [status.modelId]: status
    }))
  }, [])

  const refreshLocalWhisperStatus = useCallback(async (
    modelId: LocalWhisperModelId = selectedLocalWhisperModelId
  ): Promise<void> => {
    if (typeof window.kunGui?.getLocalWhisperModelStatus !== 'function') return
    const status = await window.kunGui.getLocalWhisperModelStatus(modelId)
    setLocalWhisperModelStatus(status)
  }, [selectedLocalWhisperModelId, setLocalWhisperModelStatus])

  const refreshLocalWhisperModelStatuses = useCallback(async (): Promise<void> => {
    if (typeof window.kunGui?.getLocalWhisperModelStatus !== 'function') return
    const statuses = await Promise.all(
      LOCAL_WHISPER_MODELS.map((model) => window.kunGui.getLocalWhisperModelStatus(model.id))
    )
    setLocalWhisperStatuses((current) => {
      const next = { ...current }
      for (const status of statuses) next[status.modelId] = status
      return next
    })
  }, [])

  const refreshLocalWhisperSourceStatuses = useCallback(async (): Promise<void> => {
    if (typeof window.kunGui?.checkLocalWhisperDownloadSources !== 'function') return
    setLocalWhisperSourceStatuses(null)
    setLocalWhisperSourceCheckBusy(true)
    try {
      const result = await window.kunGui.checkLocalWhisperDownloadSources({ modelId: selectedLocalWhisperModelId })
      setLocalWhisperSourceStatuses(result.sources)
    } finally {
      setLocalWhisperSourceCheckBusy(false)
    }
  }, [selectedLocalWhisperModelId])

  useEffect(() => {
    if (!usingLocalWhisper) return
    void refreshLocalWhisperModelStatuses().catch(() => undefined)
    void refreshLocalWhisperSourceStatuses().catch(() => undefined)
    if (typeof window.kunGui?.onLocalWhisperModelProgress !== 'function') return
    return window.kunGui.onLocalWhisperModelProgress((progress) => {
      const model = localWhisperModelById(progress.modelId)
      setLocalWhisperStatuses((current) => {
        const existing = current[progress.modelId]
        return {
          ...current,
          [progress.modelId]: {
            modelId: progress.modelId,
            label: existing?.label ?? model.label,
            fileName: existing?.fileName ?? model.fileName,
            source: existing?.source ?? model.source,
            license: existing?.license ?? model.license,
            sha256: existing?.sha256 ?? model.sha256,
            sizeBytes: existing?.sizeBytes ?? model.sizeBytes,
            maxBytes: existing?.maxBytes ?? model.maxBytes,
            resourceTier: existing?.resourceTier ?? model.resourceTier,
            resourceEstimate: existing?.resourceEstimate ?? model.resourceEstimate,
            qualityTier: existing?.qualityTier ?? model.qualityTier,
            recommended: existing?.recommended ?? model.recommended,
            state: 'downloading',
            downloadedBytes: progress.downloadedBytes,
            totalBytes: progress.totalBytes,
            speedBytesPerSecond: progress.speedBytesPerSecond,
            path: existing?.path
          }
        }
      })
    })
  }, [refreshLocalWhisperModelStatuses, refreshLocalWhisperSourceStatuses, usingLocalWhisper])

  useEffect(() => {
    if (!usingLocalWhisper) return
    void refreshLocalWhisperStatus(selectedLocalWhisperModelId).catch(() => undefined)
  }, [refreshLocalWhisperStatus, selectedLocalWhisperModelId, usingLocalWhisper])

  const downloadLocalWhisper = async (): Promise<void> => {
    if (typeof window.kunGui?.downloadLocalWhisperModel !== 'function') return
    setLocalWhisperNotice(null)
    setLocalWhisperBusy('download')
    try {
      const result = await window.kunGui.downloadLocalWhisperModel({
        modelId: selectedLocalWhisperModelId,
        sourceId: speechToText.localWhisperDownloadSource
      })
      if (result.status) setLocalWhisperModelStatus(result.status)
      if (!result.ok) {
        setLocalWhisperNotice({ tone: 'error', message: t('speechToTextLocalDownloadFailed', { message: result.message }) })
      }
    } finally {
      setLocalWhisperBusy('idle')
    }
  }

  const cancelLocalWhisper = async (): Promise<void> => {
    if (typeof window.kunGui?.cancelLocalWhisperModel !== 'function') return
    setLocalWhisperNotice(null)
    setLocalWhisperBusy('cancel')
    try {
      const result = await window.kunGui.cancelLocalWhisperModel(selectedLocalWhisperModelId)
      if (result.status) setLocalWhisperModelStatus(result.status)
      if (!result.ok) {
        setLocalWhisperNotice({ tone: 'error', message: t('speechToTextLocalCancelFailed', { message: result.message }) })
      }
    } finally {
      setLocalWhisperBusy('idle')
    }
  }

  const deleteLocalWhisper = async (): Promise<void> => {
    if (typeof window.kunGui?.deleteLocalWhisperModel !== 'function') return
    if (!window.confirm(t('speechToTextLocalDeleteConfirm', { model: selectedLocalWhisperModel.shortName }))) return
    setLocalWhisperNotice(null)
    setLocalWhisperBusy('delete')
    try {
      const result = await window.kunGui.deleteLocalWhisperModel(selectedLocalWhisperModelId)
      if (result.status) setLocalWhisperModelStatus(result.status)
      if (!result.ok) {
        setLocalWhisperNotice({ tone: 'error', message: t('speechToTextLocalDeleteFailed', { message: result.message }) })
      }
    } finally {
      setLocalWhisperBusy('idle')
    }
  }

  const runSpeechTest = async (): Promise<void> => {
    if (typeof window.kunGui?.transcribeSpeech !== 'function') return
    setTestState('busy')
    try {
      const result = await window.kunGui.transcribeSpeech({
        audioBase64: buildTestToneWavBase64(),
        mimeType: 'audio/wav',
        durationMs: 500,
        speechToText: effectiveSpeechToText
      })
      if (result.ok) {
        setTestState({ tone: 'success', message: t('speechToTextTestSuccess', { text: result.text }) })
      } else if (result.message === 'transcription result is empty') {
        // 测试音是一段正弦音,模型可能返回空转写——鉴权和链路本身是通的。
        setTestState({ tone: 'success', message: t('speechToTextTestEmptyOk') })
      } else {
        setTestState({ tone: 'error', message: t('speechToTextTestFailed', { message: result.message }) })
      }
    } catch (error) {
      setTestState({
        tone: 'error',
        message: t('speechToTextTestFailed', {
          message: error instanceof Error ? error.message : String(error)
        })
      })
    }
  }

  return (
    <SettingsCard title={t('speechToText')}>
      <SettingRow
        title={t('speechToTextEnabled')}
        description={t('speechToTextEnabledDesc')}
        control={
          <Toggle
            checked={speechToText.enabled}
            onChange={(enabled) => {
              // 首次开启时直接选中本地 Whisper,
              // 避免落进字段全空的「自定义」模式。providerId 为空但已填过
              // baseUrl/key/model 说明用户在用隐式自定义配置,不能覆盖。
              const customUntouched =
                !speechToText.baseUrl.trim() && !speechToText.apiKey.trim() && !speechToText.model.trim()
              if (enabled && !speechToText.providerId.trim() && customUntouched) {
                updateSpeechToText({
                  enabled,
                  providerId: LOCAL_WHISPER_PROVIDER_ID,
                  baseUrl: '',
                  apiKey: '',
                  protocol: 'local-whisper',
                  model: LOCAL_WHISPER_DEFAULT_MODEL_ID,
                  localWhisperDownloadSource: LOCAL_WHISPER_DEFAULT_DOWNLOAD_SOURCE_ID
                })
                return
              }
              updateSpeechToText({ enabled })
            }}
          />
        }
      />
      {speechToText.enabled ? (
        <>
          <SettingRow
            title={t('speechToTextProvider')}
            description={t('speechToTextProviderDesc')}
            control={
              <div className="w-full min-w-0 md:max-w-md">
                <select
                  className={selectControlClass}
                  value={usingCustomProvider ? CUSTOM_SPEECH_TO_TEXT_PROVIDER_ID : selectedProviderId}
                  onChange={(e) => {
                    const providerId = e.target.value
                    if (providerId === LOCAL_WHISPER_PROVIDER_ID) {
                      updateSpeechToText({
                        providerId,
                        baseUrl: '',
                        apiKey: '',
                        protocol: 'local-whisper',
                        model: LOCAL_WHISPER_DEFAULT_MODEL_ID,
                        localWhisperDownloadSource: speechToText.localWhisperDownloadSource || LOCAL_WHISPER_DEFAULT_DOWNLOAD_SOURCE_ID
                      })
                      return
                    }
                    const nextProvider = speechProviders.find((item: { id: string }) => item.id === providerId)
                    updateSpeechToText({
                      providerId,
                      baseUrl: providerId === CUSTOM_SPEECH_TO_TEXT_PROVIDER_ID ? speechToText.baseUrl : '',
                      apiKey: providerId === CUSTOM_SPEECH_TO_TEXT_PROVIDER_ID ? speechToText.apiKey : '',
                      protocol: providerId === CUSTOM_SPEECH_TO_TEXT_PROVIDER_ID
                        ? speechToText.protocol
                        : nextProvider?.speech?.protocol ?? DEFAULT_SPEECH_TO_TEXT_PROTOCOL,
                      model: providerId === CUSTOM_SPEECH_TO_TEXT_PROVIDER_ID
                        ? speechToText.model
                        : nextProvider?.speech?.models?.[0] ?? ''
                    })
                  }}
                >
                  <option value={LOCAL_WHISPER_PROVIDER_ID}>{t('speechToTextProviderLocalWhisper')}</option>
                  {speechProviders.map((item: { id: string; name: string }) => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                  <option value={CUSTOM_SPEECH_TO_TEXT_PROVIDER_ID}>{t('speechToTextProviderCustom')}</option>
                </select>
                {!usingLocalWhisper &&
                !usingCustomProvider &&
                selectedProviderSpeech?.protocol !== 'gemini-cli-audio' &&
                !selectedSpeechProvider?.apiKey?.trim() ? (
                  <p className="mt-2 text-[12px] text-amber-700 dark:text-amber-300">
                    {t('speechToTextProviderMissingKey', { provider: selectedSpeechProvider?.name ?? selectedProviderId })}
                  </p>
                ) : null}
              </div>
            }
          />
          {usingCustomProvider ? (
            <>
              <SettingRow
                title={t('speechToTextProtocol')}
                description={t('speechToTextProtocolDesc')}
                control={
                  <select
                    className={selectControlClass}
                    value={speechToText.protocol}
                    onChange={(e) => updateSpeechToText({ protocol: e.target.value })}
                  >
                    {CUSTOM_SPEECH_PROTOCOLS.map((protocol) => (
                      <option key={protocol} value={protocol}>
                        {speechProtocolLabel(t, protocol)}
                      </option>
                    ))}
                  </select>
                }
              />
              <SettingRow
                title={t('speechToTextBaseUrl')}
                description={t('speechToTextBaseUrlDesc')}
                control={
                  <input
                    className="w-full min-w-0 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[14px] text-ds-ink shadow-sm focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30 md:max-w-md"
                    value={speechToText.baseUrl}
                    placeholder={t('speechToTextBaseUrlPlaceholder')}
                    onChange={(e) => updateSpeechToText({ baseUrl: e.target.value })}
                  />
                }
              />
              <SettingRow
                title={t('speechToTextApiKey')}
                description={t('speechToTextApiKeyDesc')}
                control={
                  <SecretInput
                    value={speechToText.apiKey}
                    onChange={(value) => updateSpeechToText({ apiKey: value })}
                    visible={showSpeechApiKey}
                    onToggleVisibility={() => setShowSpeechApiKey((value) => !value)}
                    autoComplete="off"
                    showLabel={t('showSecret')}
                    hideLabel={t('hideSecret')}
                    className="md:max-w-md"
                  />
                }
              />
            </>
          ) : null}
          {usingLocalWhisper ? (
            <SettingRow
              title={t('speechToTextLocalDownloadSource')}
              description={t('speechToTextLocalDownloadSourceDesc')}
              control={
                <div className="flex w-full min-w-0 flex-col gap-2 md:max-w-xl">
                  <select
                    className={selectControlClass}
                    value={speechToText.localWhisperDownloadSource}
                    onChange={(e) => updateSpeechToText({ localWhisperDownloadSource: e.target.value })}
                  >
                    {LOCAL_WHISPER_DOWNLOAD_SOURCES.map((source) => (
                      <option key={source.id} value={source.id}>
                        {t(`speechToTextLocalDownloadSource_${source.id}`)}
                      </option>
                    ))}
                  </select>
                  <div className="grid gap-1.5 text-[12px] text-ds-muted">
                    {localWhisperSourceCheckBusy && !localWhisperSourceStatuses ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.9} />
                        {t('speechToTextLocalDownloadSourceChecking')}
                      </span>
                    ) : null}
                    {(localWhisperSourceStatuses ?? []).map((status) => {
                      const selected = status.sourceId === speechToText.localWhisperDownloadSource
                      const available = status.state === 'available'
                      return (
                        <span
                          key={status.sourceId}
                          className={[
                            'inline-flex min-w-0 items-center gap-1.5 rounded-lg border px-2 py-1',
                            selected ? 'border-accent/35 bg-accent/10' : 'border-ds-border bg-ds-card',
                            available ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'
                          ].join(' ')}
                        >
                          <span
                            className={[
                              'h-2 w-2 shrink-0 rounded-full',
                              available ? 'bg-emerald-500' : 'bg-amber-500'
                            ].join(' ')}
                          />
                          <span className="min-w-0 truncate">{localWhisperSourceStatusText(t, status)}</span>
                        </span>
                      )
                    })}
                  </div>
                </div>
              }
            />
          ) : null}
          {usingLocalWhisper ? (
            <SettingRow
              title={t('speechToTextLocalModel')}
              description={t('speechToTextLocalModelDesc', {
                source: selectedLocalWhisperModel.source,
                license: selectedLocalWhisperModel.license
              })}
              control={
                <div className="flex w-full min-w-0 flex-col gap-3 md:max-w-xl">
                  <div className="grid gap-2">
                    {LOCAL_WHISPER_MODELS.map((model) => {
                      const selected = model.id === selectedLocalWhisperModelId
                      const modelStatus = localWhisperStatuses[model.id]
                      const modelState = modelStatus?.state ?? 'not_downloaded'
                      return (
                        <button
                          key={model.id}
                          type="button"
                          onClick={() => {
                            if (selected) {
                              void refreshLocalWhisperStatus(model.id).catch(() => undefined)
                              return
                            }
                            setLocalWhisperNotice(null)
                            updateSpeechToText({ model: model.id })
                          }}
                          className={[
                            'flex min-w-0 flex-col rounded-xl border px-3 py-2.5 text-left transition',
                            selected
                              ? 'border-accent/60 bg-accent/10 text-ds-ink shadow-sm'
                              : 'border-ds-border bg-ds-card text-ds-muted hover:bg-ds-hover hover:text-ds-ink'
                          ].join(' ')}
                        >
                          <span className="flex min-w-0 flex-wrap items-center gap-2">
                            <span className="text-[13.5px] font-semibold">{model.label}</span>
                            <span
                              className={[
                                'rounded-full px-2 py-0.5 text-[11px] font-medium',
                                modelState === 'ready'
                                  ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                                  : modelState === 'downloading'
                                    ? 'bg-blue-500/15 text-blue-700 dark:text-blue-300'
                                    : 'bg-slate-500/15 text-slate-600 dark:text-slate-300'
                              ].join(' ')}
                            >
                              {localWhisperModelStateLabel(t, modelState)}
                            </span>
                            {model.recommended ? (
                              <span className="rounded-full bg-orange-500/15 px-2 py-0.5 text-[11px] font-medium text-orange-700 dark:text-orange-300">
                                {t('speechToTextLocalRecommended')}
                              </span>
                            ) : null}
                          </span>
                          <span className="mt-1 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-[12px]">
                            <span>{t('speechToTextLocalModelFileSize', { size: formatBytes(model.sizeBytes) })}</span>
                            <span>{t('speechToTextLocalModelMemory', { memory: model.resourceEstimate.memory })}</span>
                            <span>{t('speechToTextLocalModelCpu', { threads: model.resourceEstimate.cpuThreads })}</span>
                            <span>{t('speechToTextLocalModelQuality', {
                              quality: localWhisperQualityLabel(t, model.qualityTier)
                            })}</span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                  <div className="text-[12.5px] text-ds-muted">
                    {localWhisperStatus?.state === 'ready'
                      ? t('speechToTextLocalModelReady', {
                          model: selectedLocalWhisperModel.shortName,
                          size: formatBytes(localWhisperStatus.downloadedBytes)
                        })
                      : localWhisperStatus?.state === 'downloading'
                        ? t('speechToTextLocalModelDownloading', {
                            model: selectedLocalWhisperModel.shortName,
                            percent: Math.round(
                              localWhisperStatus.totalBytes
                                ? ((localWhisperStatus.downloadedBytes ?? 0) / localWhisperStatus.totalBytes) * 100
                                : 0
                            ),
                            size: formatBytes(localWhisperStatus.downloadedBytes),
                            speed: formatTransferRate(
                              localWhisperStatus.speedBytesPerSecond,
                              t('speechToTextLocalDownloadSpeedPending')
                            )
                          })
                        : t('speechToTextLocalModelMissing', {
                            model: selectedLocalWhisperModel.shortName,
                            size: formatBytes(selectedLocalWhisperModel.sizeBytes)
                          })}
                  </div>
                  {localWhisperNotice ? <InlineNoticeView notice={localWhisperNotice} /> : null}
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={localWhisperBusy !== 'idle' || localWhisperStatus?.state === 'ready' || localWhisperStatus?.state === 'downloading'}
                      onClick={() => void downloadLocalWhisper()}
                      className="inline-flex h-9 items-center gap-1.5 rounded-full border border-ds-border bg-ds-card px-3 text-[12.5px] font-medium text-ds-muted shadow-sm transition hover:bg-ds-hover hover:text-ds-ink disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {localWhisperBusy === 'download'
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.9} />
                        : <Download className="h-3.5 w-3.5" strokeWidth={1.9} />}
                      {t('speechToTextLocalModelDownload', { model: selectedLocalWhisperModel.shortName })}
                    </button>
                    {localWhisperStatus?.state === 'downloading' || localWhisperBusy === 'cancel' ? (
                      <button
                        type="button"
                        disabled={localWhisperBusy === 'cancel' || localWhisperBusy === 'delete'}
                        onClick={() => void cancelLocalWhisper()}
                        className="inline-flex h-9 items-center gap-1.5 rounded-full border border-ds-border bg-ds-card px-3 text-[12.5px] font-medium text-ds-muted shadow-sm transition hover:bg-ds-hover hover:text-ds-ink disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {localWhisperBusy === 'cancel'
                          ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.9} />
                          : <Square className="h-3.5 w-3.5" strokeWidth={1.9} />}
                        {t('speechToTextLocalModelCancel')}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={localWhisperBusy !== 'idle' || localWhisperStatus?.state !== 'ready'}
                      onClick={() => void deleteLocalWhisper()}
                      className="inline-flex h-9 items-center gap-1.5 rounded-full border border-ds-border bg-ds-card px-3 text-[12.5px] font-medium text-ds-muted shadow-sm transition hover:bg-ds-hover hover:text-ds-ink disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {localWhisperBusy === 'delete'
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.9} />
                        : <Trash2 className="h-3.5 w-3.5" strokeWidth={1.9} />}
                      {t('speechToTextLocalModelDelete')}
                    </button>
                  </div>
                </div>
              }
            />
          ) : null}
          {!usingLocalWhisper ? (
            <SettingRow
              title={t('speechToTextModel')}
              description={t('speechToTextModelDesc')}
              control={
                <div className="w-full min-w-0 md:max-w-md">
                  {usingCustomProvider ? (
                    <input
                      className="w-full min-w-0 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[14px] text-ds-ink shadow-sm focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30"
                      value={speechToText.model}
                      placeholder={t('speechToTextModelPlaceholder')}
                      onChange={(e) => updateSpeechToText({ model: e.target.value })}
                    />
                  ) : (
                    <ModelSelect
                      value={speechModelOptions.includes(speechToText.model) ? speechToText.model : ''}
                      options={speechModelOptions}
                      defaultLabel={t('modelSelectDefaultOption', {
                        model: speechModelOptions[0] ?? ''
                      })}
                      selectClassName={selectControlClass}
                      onChange={(model) => updateSpeechToText({ model })}
                    />
                  )}
                </div>
              }
            />
          ) : null}
          <SettingRow
            title={t('speechToTextLanguage')}
            description={t('speechToTextLanguageDesc')}
            control={
              <select
                className={selectControlClass}
                value={speechToText.language}
                onChange={(e) => updateSpeechToText({ language: e.target.value })}
              >
                {SPEECH_LANGUAGE_OPTIONS.map((language) => (
                  <option key={language || 'auto'} value={language}>
                    {t(`speechLanguage_${language || 'auto'}`)}
                  </option>
                ))}
                {!SPEECH_LANGUAGE_OPTIONS.includes(speechToText.language) ? (
                  <option value={speechToText.language}>{speechToText.language}</option>
                ) : null}
              </select>
            }
          />
          <div className="px-3 py-4">
            <AdvancedSettingsDisclosure
              title={t('speechToTextAdvanced')}
              description={t('speechToTextAdvancedDesc')}
            >
              <div className="divide-y divide-ds-border-muted">
                <SettingRow
                  title={t('speechToTextTimeout')}
                  description={t('speechToTextTimeoutDesc')}
                  control={
                    <input
                      type="number"
                      min={5000}
                      max={600000}
                      step={5000}
                      className="w-32 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[14px] text-ds-ink shadow-sm focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30"
                      value={speechToText.timeoutMs}
                      onChange={(e) => updateSpeechToText({ timeoutMs: Number(e.target.value) })}
                    />
                  }
                />
              </div>
            </AdvancedSettingsDisclosure>
          </div>
          <SettingRow
            title={t('speechToTextTest')}
            description={t('speechToTextTestDesc')}
            control={
              <div className="flex w-full min-w-0 flex-col gap-2 md:max-w-md">
                <button
                  type="button"
                  disabled={testState === 'busy'}
                  onClick={() => void runSpeechTest()}
                  className="inline-flex h-9 w-fit items-center gap-1.5 rounded-full border border-ds-border bg-ds-card px-3 text-[12.5px] font-medium text-ds-muted shadow-sm transition hover:bg-ds-hover hover:text-ds-ink disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {testState === 'busy'
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.9} />
                    : <PlugZap className="h-3.5 w-3.5" strokeWidth={1.9} />}
                  {testState === 'busy' ? t('speechToTextTesting') : t('speechToTextTestAction')}
                </button>
                {typeof testState === 'object' ? <InlineNoticeView notice={testState} /> : null}
              </div>
            }
          />
        </>
      ) : null}
    </SettingsCard>
  )
}
