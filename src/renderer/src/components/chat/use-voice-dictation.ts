import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CUSTOM_SPEECH_TO_TEXT_PROVIDER_ID,
  resolveKunSpeechToTextSettings,
  type AppSettingsV1,
  type KunPromptOptimizationSettingsV1,
  type KunSpeechToTextSettingsV1
} from '@shared/app-settings'
import { getKunRuntimeSettings } from '@shared/app-settings-kun-defaults'
import { SPEECH_TRANSCRIPTION_MAX_DURATION_MS } from '@shared/speech-to-text'
import { SETTINGS_CHANGED_EVENT } from '../../lib/keyboard-shortcut-settings'
import {
  connectionCredentialStateById,
  fetchSharedModelConnectionCredentialStates,
  providerHasUsableCredential
} from '../../lib/provider-credential-readiness'
import {
  createPcmCaptureWorkletUrl,
  isSilentChunk,
  PCM_CAPTURE_PROCESSOR_NAME,
  PcmChunkAccumulator,
  resampleTo16k,
  SerialTranscriptionQueue,
  VOICE_REALTIME_FLUSH_INTERVAL_MS,
  VOICE_REALTIME_MIN_TAIL_MS,
  VOICE_TRANSCRIPTION_SAMPLE_RATE
} from './voice-dictation-realtime'

export type VoiceDictationStatus = 'idle' | 'recording' | 'transcribing'

/** What to do with the transcript once it lands: insert into the input, or send right away. */
export type VoiceDictationIntent = 'insert' | 'send'

const MIN_RECORDING_MS = 500
const VOICE_ERROR_AUTO_DISMISS_MS = 10_000
const RECORDER_MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']

export type SpeechToTextSettingsState = {
  speechToText: KunSpeechToTextSettingsV1 | null
  /** True when the bound shared provider has usable Registry credentials. */
  credentialReady: boolean
}

function speechProviderCredentialReady(
  speechToText: KunSpeechToTextSettingsV1 | null,
  connectionUsable: boolean
): boolean {
  if (!speechToText) return false
  if (speechToText.apiKey.trim()) return true
  const providerId = speechToText.providerId.trim()
  if (!providerId || providerId === CUSTOM_SPEECH_TO_TEXT_PROVIDER_ID) return false
  if (
    speechToText.protocol === 'local-whisper' ||
    speechToText.protocol === 'gemini-cli-audio'
  ) {
    return false
  }
  return connectionUsable
}

/** Resolved speech-to-text settings, kept in sync with the settings screen. */
export function useSpeechToTextSettings(): SpeechToTextSettingsState {
  const [speechToText, setSpeechToText] = useState<KunSpeechToTextSettingsV1 | null>(null)
  const [credentialReady, setCredentialReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    const refreshCredentialReady = (next: KunSpeechToTextSettingsV1): void => {
      const providerId = next.providerId.trim()
      if (
        !providerId ||
        providerId === CUSTOM_SPEECH_TO_TEXT_PROVIDER_ID ||
        next.protocol === 'local-whisper' ||
        next.protocol === 'gemini-cli-audio' ||
        next.apiKey.trim()
      ) {
        if (!cancelled) {
          setCredentialReady(speechProviderCredentialReady(next, false))
        }
        return
      }
      void fetchSharedModelConnectionCredentialStates()
        .then((states) => {
          if (cancelled) return
          const usable = providerHasUsableCredential(
            { id: providerId, apiKey: next.apiKey },
            connectionCredentialStateById(states, providerId)
          )
          setCredentialReady(speechProviderCredentialReady(next, usable))
        })
        .catch(() => {
          if (!cancelled) setCredentialReady(false)
        })
    }
    const apply = (settings: AppSettingsV1): void => {
      if (cancelled) return
      const resolved = resolveKunSpeechToTextSettings(settings)
      setSpeechToText(resolved)
      refreshCredentialReady(resolved)
    }
    if (typeof window.kunGui?.getSettings === 'function') {
      void window.kunGui.getSettings().then(apply).catch(() => undefined)
    }
    const onSettingsChanged = (event: Event): void => {
      apply((event as CustomEvent<AppSettingsV1>).detail)
    }
    window.addEventListener(SETTINGS_CHANGED_EVENT, onSettingsChanged)
    return () => {
      cancelled = true
      window.removeEventListener(SETTINGS_CHANGED_EVENT, onSettingsChanged)
    }
  }, [])

  return { speechToText, credentialReady }
}

export function usePromptOptimizationSettings(): KunPromptOptimizationSettingsV1 | null {
  const [promptOptimization, setPromptOptimization] = useState<KunPromptOptimizationSettingsV1 | null>(null)

  useEffect(() => {
    let cancelled = false
    const apply = (settings: AppSettingsV1): void => {
      if (!cancelled) setPromptOptimization(getKunRuntimeSettings(settings).promptOptimization)
    }
    if (typeof window.kunGui?.getSettings === 'function') {
      void window.kunGui.getSettings().then(apply).catch(() => undefined)
    }
    const onSettingsChanged = (event: Event): void => {
      apply((event as CustomEvent<AppSettingsV1>).detail)
    }
    window.addEventListener(SETTINGS_CHANGED_EVENT, onSettingsChanged)
    return () => {
      cancelled = true
      window.removeEventListener(SETTINGS_CHANGED_EVENT, onSettingsChanged)
    }
  }, [])

  return promptOptimization
}

export function useVoiceDictation({
  onText,
  speechToText
}: {
  onText: (text: string, intent: VoiceDictationIntent) => void
  speechToText?: KunSpeechToTextSettingsV1 | null
}): {
  status: VoiceDictationStatus
  error: string | null
  clearError: () => void
  startedAtMs: number
  start: () => void
  stop: (intent?: VoiceDictationIntent) => void
  toggle: () => void
  /** Current microphone level (0..1) for waveform rendering. Safe to call every frame. */
  getLevel: () => number
} {
  const { t } = useTranslation('common')
  const [status, setStatus] = useState<VoiceDictationStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [startedAtMs, setStartedAtMs] = useState(0)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const levelDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null)
  const workletNodeRef = useRef<AudioWorkletNode | null>(null)
  const pcmAccumulatorRef = useRef<PcmChunkAccumulator | null>(null)
  const chunkFlushTimerRef = useRef<number | null>(null)
  const transcriptionQueueRef = useRef<SerialTranscriptionQueue | null>(null)
  const sourceSampleRateRef = useRef(0)
  const producedTextRef = useRef(false)
  /** Incremented per dictation so stale async results from a previous run are dropped. */
  const sessionIdRef = useRef(0)
  const stopIntentRef = useRef<VoiceDictationIntent>('insert')
  const maxDurationTimerRef = useRef<number | null>(null)
  const errorTimerRef = useRef<number | null>(null)
  const startedAtRef = useRef(0)
  const onTextRef = useRef(onText)
  const stopRef = useRef<(intent?: VoiceDictationIntent) => void>(() => undefined)
  const mountedRef = useRef(true)

  useEffect(() => {
    onTextRef.current = onText
  }, [onText])

  const clearError = useCallback((): void => {
    if (errorTimerRef.current != null) {
      window.clearTimeout(errorTimerRef.current)
      errorTimerRef.current = null
    }
    setError(null)
  }, [])

  // 错误条不允许永久驻留:可手动关闭,超时也会自动消失。
  const showError = useCallback((message: string): void => {
    setError(message)
    if (errorTimerRef.current != null) window.clearTimeout(errorTimerRef.current)
    errorTimerRef.current = window.setTimeout(() => {
      errorTimerRef.current = null
      if (mountedRef.current) setError(null)
    }, VOICE_ERROR_AUTO_DISMISS_MS)
  }, [])

  const releaseStream = useCallback((): void => {
    if (maxDurationTimerRef.current != null) {
      window.clearTimeout(maxDurationTimerRef.current)
      maxDurationTimerRef.current = null
    }
    if (chunkFlushTimerRef.current != null) {
      window.clearInterval(chunkFlushTimerRef.current)
      chunkFlushTimerRef.current = null
    }
    workletNodeRef.current?.disconnect()
    workletNodeRef.current = null
    pcmAccumulatorRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    recorderRef.current = null
    analyserRef.current = null
    levelDataRef.current = null
    void audioContextRef.current?.close().catch(() => undefined)
    audioContextRef.current = null
  }, [])

  const getLevel = useCallback((): number => {
    const analyser = analyserRef.current
    const data = levelDataRef.current
    if (!analyser || !data) return 0
    analyser.getByteTimeDomainData(data)
    let sumSquares = 0
    for (let i = 0; i < data.length; i += 1) {
      const value = (data[i] - 128) / 128
      sumSquares += value * value
    }
    return Math.min(1, Math.sqrt(sumSquares / data.length) * 3)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      recorderRef.current?.stop()
      transcriptionQueueRef.current?.abort()
      sessionIdRef.current += 1
      releaseStream()
      if (errorTimerRef.current != null) {
        window.clearTimeout(errorTimerRef.current)
        errorTimerRef.current = null
      }
    }
  }, [releaseStream])

  /** True only for async work belonging to the live dictation run. */
  const isLiveSession = useCallback((sessionId: number): boolean => (
    mountedRef.current && sessionIdRef.current === sessionId
  ), [])

  const abortSession = useCallback((message: string, sessionId: number): void => {
    if (!isLiveSession(sessionId)) return
    showError(t('composerVoiceFailed', { message }))
    transcriptionQueueRef.current?.abort()
    sessionIdRef.current += 1
    // 转写链路出错后继续录只会产生带断层的文本,直接结束本次听写;
    // 已经插入输入框的分片文本保留,由用户决定去留。
    releaseStream()
    setStatus('idle')
  }, [isLiveSession, releaseStream, showError, t])

  const runChunkTranscription = useCallback(async (
    pcm16k: Float32Array,
    durationMs: number,
    sessionId: number
  ): Promise<void> => {
    try {
      const wavBytes = encodeWavPcm16(pcm16k, VOICE_TRANSCRIPTION_SAMPLE_RATE)
      const result = await window.kunGui.transcribeSpeech({
        audioBase64: bytesToBase64(wavBytes),
        mimeType: 'audio/wav',
        durationMs,
        ...(speechToText ? { speechToText } : {})
      })
      if (!isLiveSession(sessionId)) return
      if (result.ok) {
        const text = result.text.trim()
        if (text) {
          producedTextRef.current = true
          onTextRef.current(text, 'insert')
        }
      } else {
        abortSession(result.message, sessionId)
      }
    } catch (cause) {
      abortSession(cause instanceof Error ? cause.message : String(cause), sessionId)
    }
  }, [abortSession, isLiveSession, speechToText])

  const enqueueSpeechChunk = useCallback((samples: Float32Array, sessionId: number): void => {
    const queue = transcriptionQueueRef.current
    const sourceRate = sourceSampleRateRef.current
    if (!queue || sourceRate <= 0) return
    const pcm16k = resampleTo16k(samples, sourceRate)
    // 整段静音的分片直接跳过:省配额,也避免提供方对背景噪声幻觉出文本。
    if (isSilentChunk(pcm16k)) return
    const durationMs = Math.round((pcm16k.length / VOICE_TRANSCRIPTION_SAMPLE_RATE) * 1000)
    queue.enqueue(() => runChunkTranscription(pcm16k, durationMs, sessionId))
  }, [runChunkTranscription])

  const flushFullChunks = useCallback((sessionId: number): void => {
    const accumulator = pcmAccumulatorRef.current
    if (!accumulator) return
    for (const chunk of accumulator.takeFullChunks()) {
      enqueueSpeechChunk(chunk, sessionId)
    }
  }, [enqueueSpeechChunk])

  /**
   * Runs after every queued chunk resolves. A "send" intent fires exactly once
   * here (with empty text) so the composer sends whatever the stream inserted,
   * mirroring the single-shot batch flow even when the tail chunk was silent.
   */
  const enqueueSessionFinalizer = useCallback((intent: VoiceDictationIntent, sessionId: number): void => {
    const queue = transcriptionQueueRef.current
    if (!queue) return
    queue.enqueue(async () => {
      if (!isLiveSession(sessionId)) return
      if (!producedTextRef.current) {
        if (Date.now() - startedAtRef.current < MIN_RECORDING_MS) {
          showError(t('composerVoiceTooShort'))
        }
        // 全程静音:静默结束,不触碰输入框。
        return
      }
      if (intent === 'send') onTextRef.current('', 'send')
    })
  }, [isLiveSession, showError, t])

  const transcribeBlob = useCallback(async (blob: Blob, durationMs: number, intent: VoiceDictationIntent): Promise<void> => {
    try {
      const wav = await encodeBlobAsWav(blob)
      const result = await window.kunGui.transcribeSpeech({
        audioBase64: wav.base64,
        mimeType: 'audio/wav',
        durationMs: Math.min(durationMs, SPEECH_TRANSCRIPTION_MAX_DURATION_MS),
        ...(speechToText ? { speechToText } : {})
      })
      if (!mountedRef.current) return
      if (result.ok) {
        onTextRef.current(result.text, intent)
      } else {
        showError(t('composerVoiceFailed', { message: result.message }))
      }
    } catch (cause) {
      if (mountedRef.current) {
        showError(t('composerVoiceFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
      }
    } finally {
      if (mountedRef.current) setStatus('idle')
    }
  }, [showError, speechToText, t])

  const start = useCallback((): void => {
    if (recorderRef.current || workletNodeRef.current) return
    clearError()
    void (async () => {
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      } catch (cause) {
        const denied = cause instanceof DOMException &&
          (cause.name === 'NotAllowedError' || cause.name === 'SecurityError')
        if (mountedRef.current) {
          showError(denied
            ? t('composerVoiceMicDenied')
            : t('composerVoiceFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
        }
        return
      }
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      const sessionId = sessionIdRef.current + 1
      sessionIdRef.current = sessionId
      producedTextRef.current = false
      transcriptionQueueRef.current = new SerialTranscriptionQueue()

      let audioContext: AudioContext | null = null
      let source: MediaStreamAudioSourceNode | null = null
      try {
        audioContext = new AudioContext()
        const analyser = audioContext.createAnalyser()
        analyser.fftSize = 512
        analyser.smoothingTimeConstant = 0.55
        source = audioContext.createMediaStreamSource(stream)
        source.connect(analyser)
        audioContextRef.current = audioContext
        analyserRef.current = analyser
        levelDataRef.current = new Uint8Array(new ArrayBuffer(analyser.fftSize))
        sourceSampleRateRef.current = audioContext.sampleRate
      } catch {
        // 波形只是视觉反馈,拿不到 analyser 也不影响录音本身。
      }

      let realtimeReady = false
      if (audioContext && source) {
        try {
          const workletUrl = createPcmCaptureWorkletUrl()
          try {
            await audioContext.audioWorklet.addModule(workletUrl)
          } finally {
            URL.revokeObjectURL(workletUrl)
          }
          const workletNode = new AudioWorkletNode(audioContext, PCM_CAPTURE_PROCESSOR_NAME)
          const accumulator = PcmChunkAccumulator.forSourceRate(audioContext.sampleRate)
          workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
            if (event.data instanceof Float32Array) accumulator.push(event.data)
          }
          source.connect(workletNode)
          // The processor never writes its outputs, so this edge plays silence;
          // connecting to the destination keeps the graph pulled everywhere.
          workletNode.connect(audioContext.destination)
          void audioContext.resume().catch(() => undefined)
          workletNodeRef.current = workletNode
          pcmAccumulatorRef.current = accumulator
          realtimeReady = true
        } catch {
          // AudioWorklet 不可用时回退到整段录制,停止后一次性转写依旧可用。
          realtimeReady = false
        }
      }

      startedAtRef.current = Date.now()
      setStartedAtMs(startedAtRef.current)
      streamRef.current = stream
      setStatus('recording')

      if (realtimeReady) {
        chunkFlushTimerRef.current = window.setInterval(() => {
          flushFullChunks(sessionId)
        }, VOICE_REALTIME_FLUSH_INTERVAL_MS)
      } else {
        const mimeType = RECORDER_MIME_CANDIDATES.find((candidate) =>
          MediaRecorder.isTypeSupported(candidate)
        )
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
        const chunks: Blob[] = []
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) chunks.push(event.data)
        }
        recorder.onstop = () => {
          const durationMs = Date.now() - startedAtRef.current
          const intent = stopIntentRef.current
          const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
          releaseStream()
          if (!mountedRef.current) return
          if (durationMs < MIN_RECORDING_MS || blob.size === 0) {
            setStatus('idle')
            showError(t('composerVoiceTooShort'))
            return
          }
          setStatus('transcribing')
          void transcribeBlob(blob, durationMs, intent)
        }
        recorderRef.current = recorder
        stopIntentRef.current = 'insert'
        recorder.start()
      }

      maxDurationTimerRef.current = window.setTimeout(() => {
        stopRef.current('insert')
      }, SPEECH_TRANSCRIPTION_MAX_DURATION_MS)
    })()
  }, [clearError, flushFullChunks, releaseStream, showError, t, transcribeBlob])

  const stop = useCallback((intent: VoiceDictationIntent = 'insert'): void => {
    // Batch fallback: MediaRecorder.onstop carries on with the single-shot flow.
    if (recorderRef.current?.state === 'recording') {
      stopIntentRef.current = intent
      recorderRef.current.stop()
      return
    }
    if (!workletNodeRef.current) return
    const sessionId = sessionIdRef.current
    const queue = transcriptionQueueRef.current
    // Flush complete windows still sitting in the accumulator, then cut the tail.
    flushFullChunks(sessionId)
    const remainder = pcmAccumulatorRef.current?.takeRemainder() ?? null
    const sourceRate = sourceSampleRateRef.current
    releaseStream()
    if (!queue) {
      setStatus('idle')
      return
    }
    if (remainder && sourceRate > 0) {
      const tailDurationMs = Math.round((remainder.length / sourceRate) * 1000)
      if (tailDurationMs >= VOICE_REALTIME_MIN_TAIL_MS) {
        enqueueSpeechChunk(remainder, sessionId)
      }
    }
    enqueueSessionFinalizer(intent, sessionId)
    if (queue.pending > 0) {
      setStatus('transcribing')
      void queue.drain().then(() => {
        if (isLiveSession(sessionId)) setStatus('idle')
      })
    } else {
      setStatus('idle')
    }
  }, [enqueueSessionFinalizer, enqueueSpeechChunk, flushFullChunks, isLiveSession, releaseStream])

  useEffect(() => {
    stopRef.current = stop
  }, [stop])

  const toggle = useCallback((): void => {
    if (status === 'recording') {
      stop()
    } else if (status === 'idle') {
      start()
    }
  }, [start, status, stop])

  return { status, error, clearError, startedAtMs, start, stop, toggle, getLevel }
}

/**
 * MediaRecorder yields webm/opus, but speech providers expect a plain
 * audio file. Decode and resample to mono 16 kHz 16-bit WAV, the common
 * denominator for OpenAI transcriptions and MiMo ASR.
 */
async function encodeBlobAsWav(blob: Blob): Promise<{ base64: string }> {
  const compressed = await blob.arrayBuffer()
  const decodeContext = new AudioContext()
  let decoded: AudioBuffer
  try {
    decoded = await decodeContext.decodeAudioData(compressed)
  } finally {
    void decodeContext.close()
  }
  const frameCount = Math.max(1, Math.ceil(decoded.duration * VOICE_TRANSCRIPTION_SAMPLE_RATE))
  const offline = new OfflineAudioContext(1, frameCount, VOICE_TRANSCRIPTION_SAMPLE_RATE)
  const source = offline.createBufferSource()
  source.buffer = decoded
  source.connect(offline.destination)
  source.start()
  const rendered = await offline.startRendering()
  const wavBytes = encodeWavPcm16(rendered.getChannelData(0), VOICE_TRANSCRIPTION_SAMPLE_RATE)
  return { base64: bytesToBase64(wavBytes) }
}

function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataLength = samples.length * 2
  const buffer = new ArrayBuffer(44 + dataLength)
  const view = new DataView(buffer)
  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
  }
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataLength, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, dataLength, true)
  let offset = 44
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
    offset += 2
  }
  return new Uint8Array(buffer)
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}
