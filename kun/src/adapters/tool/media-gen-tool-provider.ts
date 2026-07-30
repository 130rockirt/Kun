import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { KunCapabilitiesConfig } from '../../contracts/capabilities.js'
import { detectImage } from '../../attachments/attachment-store.js'
import type { ToolExecutionUpdate, ToolHostContext } from '../../ports/tool-host.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import { ImageGenHttpError, describeNetworkError } from './image-gen-tool-provider.js'
import { resolveWorkspacePath } from './builtin-tool-utils.js'
import { LocalToolHost } from './local-tool-host.js'

const GENERATED_SPEECH_DIR = '.deepseekgui-audio'
const GENERATED_MUSIC_DIR = '.deepseekgui-music'
const GENERATED_VIDEO_DIR = '.deepseekgui-videos'
const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024
const REFERENCE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const AUDIO_FORMATS = new Set(['mp3', 'wav', 'flac', 'pcm', 'pcm16'])
const VIDEO_RESOLUTIONS = ['768P', '1080P'] as const
const GROK_VIDEO_RESOLUTIONS = ['480P', '720P'] as const
const GROK_VIDEO_DURATIONS = [6, 10] as const
const GROK_VIDEO_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '3:2', '2:3'] as const
const VOLCENGINE_VIDEO_RESOLUTIONS = ['480P', '720P', '1080P', '4K'] as const
const VOLCENGINE_VIDEO_ASPECT_RATIOS = [
  'adaptive',
  '21:9',
  '16:9',
  '4:3',
  '1:1',
  '3:4',
  '9:16'
] as const

export type GeneratedMedia = { data: Buffer; mimeType: string; extension: string }

export type SpeechGenRequest = {
  text: string
  model: string
  voice?: string
  style?: string
  format: string
  timeoutMs: number
  signal: AbortSignal
}

export type MusicGenRequest = {
  prompt?: string
  lyrics?: string
  instrumental?: boolean
  lyricsOptimizer?: boolean
  referenceAudioUrl?: string
  model: string
  format: string
  timeoutMs: number
  signal: AbortSignal
}

export type VideoGenRequest = {
  prompt: string
  model: string
  duration: number
  resolution: string
  aspectRatio?: string
  firstFrameImage?: { mimeType: string; data: Buffer }
  lastFrameImage?: { mimeType: string; data: Buffer }
  timeoutMs: number
  pollIntervalMs: number
  signal: AbortSignal
  onUpdate?: (update: ToolExecutionUpdate) => Promise<void> | void
}

export interface SpeechGenClient {
  id: string
  generate(request: SpeechGenRequest): Promise<GeneratedMedia>
}

export interface MusicGenClient {
  id: string
  generate(request: MusicGenRequest): Promise<GeneratedMedia>
}

export interface VideoGenClient {
  id: string
  generate(request: VideoGenRequest): Promise<GeneratedMedia>
}

export type SpeechGenDiagnostic = {
  id: 'speechGen'
  enabled: boolean
  available: boolean
  model?: string
  reason?: string
}

export type MusicGenDiagnostic = {
  id: 'musicGen'
  enabled: boolean
  available: boolean
  model?: string
  reason?: string
}

export type VideoGenDiagnostic = {
  id: 'videoGen'
  enabled: boolean
  available: boolean
  model?: string
  reason?: string
}

export type MediaGenToolProviderOptions = {
  speechClient?: SpeechGenClient
  musicClient?: MusicGenClient
  videoClient?: VideoGenClient
  nowIso?: () => string
}

export type SpeechGenToolProviderBuildResult = {
  providers: CapabilityToolProvider[]
  diagnostics: SpeechGenDiagnostic[]
  available: boolean
}

export type MusicGenToolProviderBuildResult = {
  providers: CapabilityToolProvider[]
  diagnostics: MusicGenDiagnostic[]
  available: boolean
}

export type VideoGenToolProviderBuildResult = {
  providers: CapabilityToolProvider[]
  diagnostics: VideoGenDiagnostic[]
  available: boolean
}

export function buildSpeechGenToolProviders(
  config: KunCapabilitiesConfig['speechGen'] | undefined,
  options: MediaGenToolProviderOptions = {}
): SpeechGenToolProviderBuildResult {
  if (!config?.enabled) return { providers: [], diagnostics: [], available: false }
  const missing = missingProviderFields(config)
  if (missing.length > 0) {
    const reason = `speech generation provider is not configured (missing ${missing.join(', ')})`
    return {
      providers: [{ id: 'speechGen', kind: 'audio', enabled: true, available: false, reason, tools: [] }],
      diagnostics: [{ id: 'speechGen', enabled: true, available: false, model: config.model, reason }],
      available: false
    }
  }

  const client = options.speechClient ?? createSpeechGenClient(config)
  const model = config.model!

  const tool = LocalToolHost.defineTool({
    name: 'generate_speech',
    toolKind: 'file_change',
    description: [
      'Generate spoken audio from text using the configured text-to-speech provider.',
      `The generated audio is saved under ${GENERATED_SPEECH_DIR}/ in the workspace and returned as a generated file.`,
      'Use voice for a provider voice id/name and style for Xiaomi MiMo voice style instructions when needed.'
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to synthesize into speech' },
        voice: { type: 'string', description: 'Optional provider voice id/name' },
        style: { type: 'string', description: 'Optional voice style instruction for providers that support it' },
        format: { type: 'string', enum: [...AUDIO_FORMATS] }
      },
      required: ['text'],
      additionalProperties: false
    },
    policy: 'untrusted',
    execute: async (args, context) => {
      const startedAt = Date.now()
      const text = pickString(args.text)
      if (!text) return toolError('invalid_text', 'text is required')
      const format = normalizeAudioFormat(pickString(args.format) || config.format)
      const voice = pickString(args.voice) || config.voice
      const style = pickString(args.style)
      try {
        const media = await client.generate({
          text,
          model,
          ...(voice ? { voice } : {}),
          ...(style ? { style } : {}),
          format,
          timeoutMs: config.timeoutMs,
          signal: context.abortSignal
        })
        const file = await writeGeneratedMediaFile({
          context,
          data: media.data,
          mimeType: media.mimeType,
          extension: media.extension,
          dir: GENERATED_SPEECH_DIR,
          prefix: 'speech',
          nowIso: options.nowIso
        })
        return {
          output: {
            files: [file],
            model,
            voice,
            format,
            telemetry: telemetry(startedAt, client.id)
          }
        }
      } catch (error) {
        return toolError('generation_failed', providerErrorMessage(error), telemetry(startedAt, client.id))
      }
    }
  })

  return {
    providers: [{ id: 'speechGen', kind: 'audio', enabled: true, available: true, tools: [tool] }],
    diagnostics: [{ id: 'speechGen', enabled: true, available: true, model }],
    available: true
  }
}

export function buildMusicGenToolProviders(
  config: KunCapabilitiesConfig['musicGen'] | undefined,
  options: MediaGenToolProviderOptions = {}
): MusicGenToolProviderBuildResult {
  if (!config?.enabled) return { providers: [], diagnostics: [], available: false }
  const missing = missingProviderFields(config)
  if (missing.length > 0) {
    const reason = `music generation provider is not configured (missing ${missing.join(', ')})`
    return {
      providers: [{ id: 'musicGen', kind: 'audio', enabled: true, available: false, reason, tools: [] }],
      diagnostics: [{ id: 'musicGen', enabled: true, available: false, model: config.model, reason }],
      available: false
    }
  }

  const client = options.musicClient ?? createMusicGenClient(config)
  const model = config.model!

  const tool = LocalToolHost.defineTool({
    name: 'generate_music',
    toolKind: 'file_change',
    description: [
      'Generate a song or instrumental audio using the configured music provider.',
      `The generated audio is saved under ${GENERATED_MUSIC_DIR}/ in the workspace and returned as a generated file.`,
      'Provide prompt for style/intention, lyrics for sung music, or instrumental=true for instrumental tracks.'
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Musical style, mood, arrangement, or generation prompt' },
        lyrics: { type: 'string', description: 'Optional lyrics for sung music' },
        instrumental: { type: 'boolean', description: 'Generate instrumental music without vocals' },
        lyrics_optimizer: { type: 'boolean', description: 'Ask provider to generate or improve lyrics' },
        reference_audio_url: { type: 'string', description: 'Optional public URL for cover/reference audio' },
        format: { type: 'string', enum: [...AUDIO_FORMATS] }
      },
      additionalProperties: false
    },
    policy: 'untrusted',
    execute: async (args, context) => {
      const startedAt = Date.now()
      const prompt = pickString(args.prompt)
      const lyrics = pickString(args.lyrics)
      const instrumental = pickBoolean(args.instrumental)
      const lyricsOptimizer = pickBoolean(args.lyrics_optimizer)
      if (!prompt && !lyrics && instrumental !== true) {
        return toolError('invalid_music_request', 'provide prompt, lyrics, or instrumental=true')
      }
      const format = normalizeAudioFormat(pickString(args.format) || config.format)
      try {
        const media = await client.generate({
          ...(prompt ? { prompt } : {}),
          ...(lyrics ? { lyrics } : {}),
          ...(instrumental !== undefined ? { instrumental } : {}),
          ...(lyricsOptimizer !== undefined ? { lyricsOptimizer } : {}),
          ...(pickString(args.reference_audio_url) ? { referenceAudioUrl: pickString(args.reference_audio_url) } : {}),
          model,
          format,
          timeoutMs: config.timeoutMs,
          signal: context.abortSignal
        })
        const file = await writeGeneratedMediaFile({
          context,
          data: media.data,
          mimeType: media.mimeType,
          extension: media.extension,
          dir: GENERATED_MUSIC_DIR,
          prefix: 'music',
          nowIso: options.nowIso
        })
        return {
          output: {
            files: [file],
            model,
            format,
            telemetry: telemetry(startedAt, client.id)
          }
        }
      } catch (error) {
        return toolError('generation_failed', providerErrorMessage(error), telemetry(startedAt, client.id))
      }
    }
  })

  return {
    providers: [{ id: 'musicGen', kind: 'audio', enabled: true, available: true, tools: [tool] }],
    diagnostics: [{ id: 'musicGen', enabled: true, available: true, model }],
    available: true
  }
}

export function buildVideoGenToolProviders(
  config: KunCapabilitiesConfig['videoGen'] | undefined,
  options: MediaGenToolProviderOptions = {}
): VideoGenToolProviderBuildResult {
  if (!config?.enabled) return { providers: [], diagnostics: [], available: false }
  const missing = missingProviderFields(config)
  if (missing.length > 0) {
    const reason = `video generation provider is not configured (missing ${missing.join(', ')})`
    return {
      providers: [{ id: 'videoGen', kind: 'video', enabled: true, available: false, reason, tools: [] }],
      diagnostics: [{ id: 'videoGen', enabled: true, available: false, model: config.model, reason }],
      available: false
    }
  }

  const client = options.videoClient ?? createVideoGenClient(config)
  const model = config.model!
  const isGrokImagine = config.protocol === 'grok-imagine-video'
  const isVolcengineArk = config.protocol === 'volcengine-ark-video'

  const tool = LocalToolHost.defineTool({
    name: 'generate_video',
    toolKind: 'file_change',
    description: [
      'Generate a video from a text prompt using the configured video provider.',
      isGrokImagine
        ? 'Optionally pass a workspace-relative first_frame_image_path for Grok image-to-video guidance.'
        : 'Optionally pass workspace-relative first_frame_image_path and last_frame_image_path for image-to-video guidance.',
      `The generated video is saved under ${GENERATED_VIDEO_DIR}/ in the workspace and returned as a generated file.`
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed video generation prompt' },
        duration: isGrokImagine
          ? { type: 'integer', enum: [...GROK_VIDEO_DURATIONS] }
          : isVolcengineArk
            ? { type: 'integer', minimum: 4, maximum: 15 }
            : { type: 'integer', minimum: 1, maximum: 30 },
        resolution: {
          type: 'string',
          enum: isGrokImagine
            ? [...GROK_VIDEO_RESOLUTIONS]
            : isVolcengineArk
              ? [...VOLCENGINE_VIDEO_RESOLUTIONS]
              : VIDEO_RESOLUTIONS
        },
        ...(isGrokImagine || isVolcengineArk
          ? {
              aspect_ratio: {
                type: 'string',
                enum: isVolcengineArk
                  ? [...VOLCENGINE_VIDEO_ASPECT_RATIOS]
                  : [...GROK_VIDEO_ASPECT_RATIOS],
                description: isVolcengineArk
                  ? 'Optional Seedance output ratio; adaptive lets the model choose.'
                  : 'Optional aspect ratio for Grok text-to-video generation.'
              }
            }
          : {}),
        first_frame_image_path: { type: 'string', description: 'Workspace-relative png/jpeg/webp first frame' },
        ...(!isGrokImagine
          ? {
              last_frame_image_path: {
                type: 'string',
                description: 'Workspace-relative png/jpeg/webp last frame'
              }
            }
          : {})
      },
      required: ['prompt'],
      additionalProperties: false
    },
    policy: 'untrusted',
    execute: async (args, context, onUpdate) => {
      const startedAt = Date.now()
      const prompt = pickString(args.prompt)
      if (!prompt) return toolError('invalid_prompt', 'prompt is required')
      const firstFrame = await collectFrameImage(args.first_frame_image_path, context, 'first_frame_image_path')
      if ('error' in firstFrame) return firstFrame.error
      const lastFrame = await collectFrameImage(args.last_frame_image_path, context, 'last_frame_image_path')
      if ('error' in lastFrame) return lastFrame.error
      const duration = isGrokImagine
        ? normalizeGrokVideoDuration(args.duration, config.defaultDuration)
        : isVolcengineArk
          ? normalizeVolcengineVideoDuration(args.duration, config.defaultDuration)
        : normalizeDuration(args.duration, config.defaultDuration)
      const resolution = isGrokImagine
        ? normalizeGrokVideoResolution(args.resolution, config.defaultResolution)
        : isVolcengineArk
          ? normalizeVolcengineVideoResolution(args.resolution, config.defaultResolution)
        : pickString(args.resolution) || config.defaultResolution
      const aspectRatio = pickString(args.aspect_ratio)
      try {
        const media = await client.generate({
          prompt,
          model,
          duration,
          resolution,
          ...(aspectRatio ? { aspectRatio } : {}),
          ...(firstFrame.image ? { firstFrameImage: firstFrame.image } : {}),
          ...(lastFrame.image ? { lastFrameImage: lastFrame.image } : {}),
          timeoutMs: config.timeoutMs,
          pollIntervalMs: config.pollIntervalMs,
          signal: context.abortSignal,
          onUpdate
        })
        const file = await writeGeneratedMediaFile({
          context,
          data: media.data,
          mimeType: media.mimeType,
          extension: media.extension,
          dir: GENERATED_VIDEO_DIR,
          prefix: 'video',
          nowIso: options.nowIso
        })
        return {
          output: {
            files: [file],
            model,
            duration,
            resolution,
            telemetry: telemetry(startedAt, client.id)
          }
        }
      } catch (error) {
        return toolError('generation_failed', providerErrorMessage(error), telemetry(startedAt, client.id))
      }
    }
  })

  return {
    providers: [{ id: 'videoGen', kind: 'video', enabled: true, available: true, tools: [tool] }],
    diagnostics: [{ id: 'videoGen', enabled: true, available: true, model }],
    available: true
  }
}

export function createSpeechGenClient(config: {
  protocol?: string
  baseUrl?: string
  apiKey?: string
}): SpeechGenClient {
  if (config.protocol === 'minimax-t2a') return new MiniMaxSpeechClient(config.baseUrl!, config.apiKey!)
  if (config.protocol === 'mimo-tts') return new MimoSpeechClient(config.baseUrl!, config.apiKey!)
  return new OpenAiCompatSpeechClient(config.baseUrl!, config.apiKey!)
}

export function createMusicGenClient(config: {
  protocol?: string
  baseUrl?: string
  apiKey?: string
}): MusicGenClient {
  return new MiniMaxMusicClient(config.baseUrl!, config.apiKey!)
}

export function createVideoGenClient(config: {
  protocol?: string
  baseUrl?: string
  apiKey?: string
  headers?: Record<string, string>
}): VideoGenClient {
  if (config.protocol === 'grok-imagine-video') {
    return new GrokImagineVideoClient(config.baseUrl!, config.apiKey!, config.headers)
  }
  if (config.protocol === 'volcengine-ark-video') {
    return new VolcengineArkVideoClient(config.baseUrl!, config.apiKey!)
  }
  return new MiniMaxVideoClient(config.baseUrl!, config.apiKey!)
}

export class OpenAiCompatSpeechClient implements SpeechGenClient {
  readonly id = 'openai-speech'
  private readonly endpointUrl: string

  constructor(
    baseUrl: string,
    private readonly apiKey: string
  ) {
    this.endpointUrl = apiUrl(baseUrl, '/v1/audio/speech')
  }

  async generate(request: SpeechGenRequest): Promise<GeneratedMedia> {
    const response = await requestResponse(this.endpointUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: request.model,
        input: request.text,
        voice: request.voice || 'alloy',
        response_format: request.format
      }),
      signal: withTimeout(request.signal, request.timeoutMs)
    }, request)
    if (!response.ok) throw new ImageGenHttpError(response.status, await response.text())
    const mimeType = response.headers.get('content-type')?.split(';')[0] || audioMimeType(request.format)
    return {
      data: Buffer.from(await response.arrayBuffer()),
      mimeType,
      extension: audioExtension(request.format)
    }
  }
}

export class MiniMaxSpeechClient implements SpeechGenClient {
  readonly id = 'minimax-t2a'
  private readonly endpointUrl: string

  constructor(
    baseUrl: string,
    private readonly apiKey: string
  ) {
    this.endpointUrl = apiUrl(baseUrl, '/v1/t2a_v2')
  }

  async generate(request: SpeechGenRequest): Promise<GeneratedMedia> {
    const voiceId = request.voice || 'male-qn-qingse'
    const payload = await requestJson<MiniMaxAudioPayload>(this.endpointUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: request.model,
        text: request.text,
        output_format: 'hex',
        voice_setting: {
          voice_id: voiceId,
          speed: 1,
          vol: 1,
          pitch: 0
        },
        audio_setting: {
          format: request.format,
          sample_rate: request.format === 'mp3' ? 32_000 : 44_100,
          bitrate: 128_000,
          channel: 1
        }
      }),
      signal: withTimeout(request.signal, request.timeoutMs)
    }, request)
    assertMiniMaxOk(payload.base_resp, 'MiniMax speech provider')
    const audio = payload.data?.audio
    if (!audio) throw new Error('MiniMax speech provider returned no audio data')
    return {
      data: bufferFromHex(audio),
      mimeType: audioMimeType(request.format),
      extension: audioExtension(request.format)
    }
  }
}

export class MimoSpeechClient implements SpeechGenClient {
  readonly id = 'mimo-tts'
  private readonly endpointUrl: string

  constructor(
    baseUrl: string,
    private readonly apiKey: string
  ) {
    this.endpointUrl = apiUrl(baseUrl, '/v1/chat/completions')
  }

  async generate(request: SpeechGenRequest): Promise<GeneratedMedia> {
    const messages = [
      ...(request.style ? [{ role: 'user', content: request.style }] : []),
      { role: 'assistant', content: request.text }
    ]
    const payload = await requestJson<MimoSpeechPayload>(this.endpointUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'api-key': this.apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: request.model,
        messages,
        audio: {
          format: request.format,
          ...(request.voice ? { voice: request.voice } : {})
        }
      }),
      signal: withTimeout(request.signal, request.timeoutMs)
    }, request)
    const audio = payload.choices?.[0]?.message?.audio?.data
    if (!audio) throw new Error('MiMo speech provider returned no audio data')
    return {
      data: Buffer.from(audio, 'base64'),
      mimeType: audioMimeType(request.format),
      extension: audioExtension(request.format)
    }
  }
}

export class MiniMaxMusicClient implements MusicGenClient {
  readonly id = 'minimax-music'
  private readonly endpointUrl: string

  constructor(
    baseUrl: string,
    private readonly apiKey: string
  ) {
    this.endpointUrl = apiUrl(baseUrl, '/v1/music_generation')
  }

  async generate(request: MusicGenRequest): Promise<GeneratedMedia> {
    const payload = await requestJson<MiniMaxAudioPayload>(this.endpointUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: request.model,
        ...(request.prompt ? { prompt: request.prompt } : {}),
        ...(request.lyrics ? { lyrics: request.lyrics } : {}),
        output_format: 'hex',
        audio_setting: {
          format: request.format,
          sample_rate: 44_100,
          bitrate: 256_000
        },
        lyrics_optimizer: request.lyricsOptimizer ?? (!request.lyrics && request.instrumental !== true),
        ...(request.instrumental !== undefined ? { is_instrumental: request.instrumental } : {}),
        ...(request.referenceAudioUrl ? { audio_url: request.referenceAudioUrl } : {})
      }),
      signal: withTimeout(request.signal, request.timeoutMs)
    }, request)
    assertMiniMaxOk(payload.base_resp, 'MiniMax music provider')
    const audio = payload.data?.audio
    if (!audio) throw new Error('MiniMax music provider returned no audio data')
    return {
      data: bufferFromHex(audio),
      mimeType: audioMimeType(request.format),
      extension: audioExtension(request.format)
    }
  }
}

export class MiniMaxVideoClient implements VideoGenClient {
  readonly id = 'minimax-video'
  private readonly rootUrl: string

  constructor(
    baseUrl: string,
    private readonly apiKey: string
  ) {
    this.rootUrl = minimaxRootUrl(baseUrl)
  }

  async generate(request: VideoGenRequest): Promise<GeneratedMedia> {
    const signal = withTimeout(request.signal, request.timeoutMs)
    const createPayload = await requestJson<MiniMaxVideoCreatePayload>(`${this.rootUrl}/v1/video_generation`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: request.model,
        prompt: request.prompt,
        duration: request.duration,
        resolution: request.resolution,
        ...(request.firstFrameImage
          ? { first_frame_image: dataUri(request.firstFrameImage.mimeType, request.firstFrameImage.data) }
          : {}),
        ...(request.lastFrameImage
          ? { last_frame_image: dataUri(request.lastFrameImage.mimeType, request.lastFrameImage.data) }
          : {})
      }),
      signal
    }, request)
    assertMiniMaxOk(createPayload.base_resp, 'MiniMax video provider')
    const taskId = createPayload.task_id
    if (!taskId) throw new Error('MiniMax video provider returned no task_id')
    await request.onUpdate?.({
      output: { status: 'submitted', taskId, provider: this.id }
    })

    const deadline = Date.now() + request.timeoutMs
    let lastStatus = 'submitted'
    while (Date.now() < deadline) {
      await delay(request.pollIntervalMs, signal)
      const queryUrl = new URL(`${this.rootUrl}/v1/query/video_generation`)
      queryUrl.searchParams.set('task_id', taskId)
      const queryPayload = await requestJson<MiniMaxVideoQueryPayload>(queryUrl.toString(), {
        method: 'GET',
        headers: this.headers(),
        signal
      }, request)
      assertMiniMaxOk(queryPayload.base_resp, 'MiniMax video provider')
      lastStatus = queryPayload.status || lastStatus
      await request.onUpdate?.({
        output: { status: lastStatus, taskId, provider: this.id }
      })
      if (isFailureStatus(lastStatus)) {
        throw new Error(`MiniMax video generation failed with status ${lastStatus}`)
      }
      if (!isSuccessStatus(lastStatus)) continue
      const fileId = queryPayload.file_id
      if (!fileId) throw new Error('MiniMax video provider finished without file_id')
      const downloadUrl = await this.retrieveDownloadUrl(fileId, request)
      const response = await requestResponse(downloadUrl, { method: 'GET', signal }, request)
      if (!response.ok) throw new ImageGenHttpError(response.status, await response.text())
      const mimeType = response.headers.get('content-type')?.split(';')[0] || 'video/mp4'
      return {
        data: Buffer.from(await response.arrayBuffer()),
        mimeType,
        extension: videoExtension(mimeType)
      }
    }
    throw new Error(`MiniMax video generation timed out after ${request.timeoutMs}ms (last status: ${lastStatus})`)
  }

  private async retrieveDownloadUrl(fileId: string, request: { timeoutMs: number; signal: AbortSignal }): Promise<string> {
    const retrieveUrl = new URL(`${this.rootUrl}/v1/files/retrieve`)
    retrieveUrl.searchParams.set('file_id', fileId)
    const payload = await requestJson<MiniMaxFileRetrievePayload>(retrieveUrl.toString(), {
      method: 'GET',
      headers: this.headers(),
      signal: withTimeout(request.signal, request.timeoutMs)
    }, request)
    assertMiniMaxOk(payload.base_resp, 'MiniMax video provider')
    const downloadUrl = payload.file?.download_url
    if (!downloadUrl) throw new Error('MiniMax video provider returned no download_url')
    return downloadUrl
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json'
    }
  }
}

export class VolcengineArkVideoClient implements VideoGenClient {
  readonly id = 'volcengine-ark-video'
  private readonly tasksUrl: string

  constructor(
    baseUrl: string,
    private readonly apiKey: string
  ) {
    this.tasksUrl = volcengineArkVideoTasksUrl(baseUrl)
  }

  async generate(request: VideoGenRequest): Promise<GeneratedMedia> {
    const signal = withTimeout(request.signal, request.timeoutMs)
    const content: VolcengineArkVideoContent[] = [
      { type: 'text', text: request.prompt }
    ]
    if (request.firstFrameImage) {
      content.push({
        type: 'image_url',
        image_url: {
          url: dataUri(request.firstFrameImage.mimeType, request.firstFrameImage.data)
        },
        role: 'first_frame'
      })
    }
    if (request.lastFrameImage) {
      content.push({
        type: 'image_url',
        image_url: {
          url: dataUri(request.lastFrameImage.mimeType, request.lastFrameImage.data)
        },
        role: 'last_frame'
      })
    }

    const createPayload = await requestJson<VolcengineArkVideoCreatePayload>(this.tasksUrl, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: request.model,
        content,
        generate_audio: true,
        ...(request.aspectRatio ? { ratio: request.aspectRatio } : {}),
        duration: request.duration,
        resolution: request.resolution.toLowerCase(),
        watermark: false
      }),
      signal
    }, request)
    const taskId = createPayload.id?.trim()
    if (!taskId) throw new Error('Volcano Ark video provider returned no task id')
    await request.onUpdate?.({
      output: { status: 'submitted', taskId, provider: this.id }
    })

    const deadline = Date.now() + request.timeoutMs
    let lastStatus = 'submitted'
    try {
      while (Date.now() < deadline) {
        await delay(request.pollIntervalMs, signal)
        const pollPayload = await requestJson<VolcengineArkVideoTaskPayload>(
          `${this.tasksUrl}/${encodeURIComponent(taskId)}`,
          {
            method: 'GET',
            headers: this.headers(),
            signal
          },
          request
        )
        lastStatus = pollPayload.status?.trim().toLowerCase() || lastStatus
        await request.onUpdate?.({
          output: { status: lastStatus, taskId, provider: this.id }
        })
        if (['failed', 'expired', 'cancelled', 'canceled'].includes(lastStatus)) {
          const detail = pollPayload.error?.message?.trim() || pollPayload.error?.code?.trim()
          throw new Error(
            `Volcano Ark video generation ${lastStatus} (task_id=${taskId})${detail ? `: ${detail}` : ''}`
          )
        }
        if (lastStatus !== 'succeeded') continue
        const downloadUrl = pollPayload.content?.video_url?.trim()
        if (!downloadUrl) {
          throw new Error('Volcano Ark video provider finished without content.video_url')
        }
        const response = await requestResponse(downloadUrl, { method: 'GET', signal }, request)
        if (!response.ok) throw new ImageGenHttpError(response.status, await response.text())
        const mimeType = response.headers.get('content-type')?.split(';')[0] || 'video/mp4'
        return {
          data: Buffer.from(await response.arrayBuffer()),
          mimeType,
          extension: videoExtension(mimeType)
        }
      }
    } catch (error) {
      const signalReasonName = signal.reason instanceof Error ? signal.reason.name : ''
      if (!request.signal.aborted && signal.aborted && signalReasonName === 'TimeoutError') {
        throw new Error(
          `Volcano Ark video generation timed out after ${request.timeoutMs}ms (last status: ${lastStatus})`
        )
      }
      throw error
    }
    throw new Error(
      `Volcano Ark video generation timed out after ${request.timeoutMs}ms (last status: ${lastStatus})`
    )
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json'
    }
  }
}

export class GrokImagineVideoClient implements VideoGenClient {
  readonly id = 'grok-imagine-video'
  private readonly rootUrl: string

  constructor(
    baseUrl: string,
    private readonly apiKey: string,
    private readonly extraHeaders: Record<string, string> = {}
  ) {
    this.rootUrl = trimTrailingSlashes(baseUrl)
  }

  async generate(request: VideoGenRequest): Promise<GeneratedMedia> {
    if (request.lastFrameImage) {
      throw new Error('Grok Imagine video does not support an explicit last frame')
    }
    const signal = withTimeout(request.signal, request.timeoutMs)
    const createPayload = await requestJson<GrokVideoCreatePayload>(`${this.rootUrl}/videos/generations`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: request.model,
        prompt: request.prompt,
        duration: request.duration,
        resolution: request.resolution.toLowerCase(),
        ...(request.firstFrameImage
          ? { image: { url: dataUri(request.firstFrameImage.mimeType, request.firstFrameImage.data) } }
          : request.aspectRatio
            ? { aspect_ratio: request.aspectRatio }
            : {}),
        reference_images: []
      }),
      signal
    }, request)
    const requestId = createPayload.request_id?.trim()
    if (!requestId) throw new Error('Grok Imagine video provider returned no request_id')
    await request.onUpdate?.({
      output: { status: 'submitted', taskId: requestId, provider: this.id }
    })

    const deadline = Date.now() + request.timeoutMs
    let lastStatus = 'submitted'
    while (Date.now() < deadline) {
      await delay(request.pollIntervalMs, signal)
      const pollPayload = await requestJson<GrokVideoPollPayload>(
        `${this.rootUrl}/videos/${encodeURIComponent(requestId)}`,
        { method: 'GET', headers: this.headers(), signal },
        request
      )
      lastStatus = pollPayload.status?.trim().toLowerCase() || lastStatus
      await request.onUpdate?.({
        output: { status: lastStatus, taskId: requestId, provider: this.id }
      })
      if (lastStatus === 'failed' || lastStatus === 'expired') {
        throw new Error(`Grok Imagine video generation ${lastStatus} (request_id=${requestId})`)
      }
      if (lastStatus !== 'done') continue
      const downloadUrl = pollPayload.video?.url?.trim()
      if (!downloadUrl) throw new Error('Grok Imagine video provider finished without a download URL')
      const response = await requestResponse(downloadUrl, { method: 'GET', signal }, request)
      if (!response.ok) throw new ImageGenHttpError(response.status, await response.text())
      const mimeType = response.headers.get('content-type')?.split(';')[0] || 'video/mp4'
      return {
        data: Buffer.from(await response.arrayBuffer()),
        mimeType,
        extension: videoExtension(mimeType)
      }
    }
    throw new Error(`Grok Imagine video generation timed out after ${request.timeoutMs}ms (last status: ${lastStatus})`)
  }

  private headers(): Record<string, string> {
    return {
      ...this.extraHeaders,
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json'
    }
  }
}

type MiniMaxAudioPayload = {
  data?: { audio?: string }
  base_resp?: MiniMaxBaseResponse
}

type MiniMaxVideoCreatePayload = {
  task_id?: string
  base_resp?: MiniMaxBaseResponse
}

type MiniMaxVideoQueryPayload = {
  status?: string
  file_id?: string
  base_resp?: MiniMaxBaseResponse
}

type MiniMaxFileRetrievePayload = {
  file?: { download_url?: string }
  base_resp?: MiniMaxBaseResponse
}

type MiniMaxBaseResponse = {
  status_code?: number
  status_msg?: string
}

type GrokVideoCreatePayload = {
  request_id?: string
}

type GrokVideoPollPayload = {
  status?: string
  video?: { url?: string }
}

type VolcengineArkVideoContent =
  | { type: 'text'; text: string }
  | {
      type: 'image_url'
      image_url: { url: string }
      role: 'first_frame' | 'last_frame'
    }

type VolcengineArkVideoCreatePayload = {
  id?: string
}

type VolcengineArkVideoTaskPayload = {
  status?: string
  content?: { video_url?: string }
  error?: { code?: string; message?: string }
}

type MimoSpeechPayload = {
  choices?: Array<{
    message?: {
      audio?: {
        data?: string
      }
    }
  }>
}

function missingProviderFields(config: { baseUrl?: string; apiKey?: string; model?: string }): string[] {
  return [
    !config.baseUrl ? 'baseUrl' : undefined,
    !config.apiKey ? 'apiKey' : undefined,
    !config.model ? 'model' : undefined
  ].filter((field): field is string => Boolean(field))
}

async function writeGeneratedMediaFile(input: {
  context: ToolHostContext
  data: Buffer
  mimeType: string
  extension: string
  dir: string
  prefix: string
  nowIso?: () => string
}): Promise<{
  relativePath: string
  absolutePath: string
  mimeType: string
  byteSize: number
}> {
  const stamp = (input.nowIso?.() ?? new Date().toISOString()).replace(/\D/g, '').slice(0, 14)
  const fileName = `${input.prefix}-${stamp}-${randomBytes(2).toString('hex')}.${input.extension}`
  const relativePath = `${input.dir}/${fileName}`
  const target = await resolveWorkspacePath(relativePath, input.context, { enforceWorkspaceBoundary: true })
  await mkdir(dirname(target.absolutePath), { recursive: true })
  const absolutePath = (await resolveWorkspacePath(relativePath, input.context, {
    enforceWorkspaceBoundary: true
  })).absolutePath
  await writeFile(absolutePath, input.data)
  return {
    relativePath,
    absolutePath,
    mimeType: input.mimeType,
    byteSize: input.data.byteLength
  }
}

type FrameImageResult = { image?: { mimeType: string; data: Buffer } }
type FrameImageError = { error: { output: unknown; isError: true } }

async function collectFrameImage(
  value: unknown,
  context: ToolHostContext,
  fieldName: string
): Promise<FrameImageResult | FrameImageError> {
  const rawPath = pickString(value)
  if (!rawPath) return {}
  let resolved: string
  try {
    resolved = (await resolveWorkspacePath(rawPath, context, { enforceWorkspaceBoundary: true })).absolutePath
  } catch {
    return { error: toolError('invalid_reference_path', `${fieldName} must be inside the workspace: ${rawPath}`) }
  }
  let data: Buffer
  try {
    data = await readFile(resolved)
  } catch {
    return { error: toolError('invalid_reference_path', `${fieldName} not found: ${rawPath}`) }
  }
  if (data.byteLength > MAX_REFERENCE_IMAGE_BYTES) {
    return { error: toolError('invalid_reference_path', `${fieldName} exceeds ${MAX_REFERENCE_IMAGE_BYTES} byte limit: ${rawPath}`) }
  }
  const detected = detectImage(data)
  if (!detected || !REFERENCE_MIME_TYPES.has(detected.mimeType)) {
    return { error: toolError('invalid_reference_path', `${fieldName} must be png, jpeg, or webp: ${rawPath}`) }
  }
  return { image: { mimeType: detected.mimeType, data } }
}

async function requestJson<T>(
  url: string,
  init: RequestInit,
  request: { timeoutMs: number; signal: AbortSignal }
): Promise<T> {
  const response = await requestResponse(url, init, request)
  const text = await response.text()
  if (!response.ok) throw new ImageGenHttpError(response.status, text)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`provider returned invalid JSON from ${url.split('?')[0]}`)
  }
}

async function requestResponse(
  url: string,
  init: RequestInit,
  request: { timeoutMs: number; signal: AbortSignal }
): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (error) {
    throw mediaFetchFailure(url, error, request)
  }
}

function mediaFetchFailure(
  url: string,
  error: unknown,
  request: { timeoutMs: number }
): Error {
  const target = url.split('?')[0]
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return new Error(`media request to ${target} timed out after ${request.timeoutMs}ms`, { cause: error })
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new Error(`media request to ${target} was canceled`, { cause: error })
  }
  return new Error(`media request to ${target} failed: ${describeNetworkError(error)}`, { cause: error })
}

function apiUrl(baseUrl: string, v1Path: string): string {
  const normalized = trimTrailingSlashes(baseUrl.trim())
  const lower = normalized.toLowerCase()
  const path = v1Path.startsWith('/') ? v1Path : `/${v1Path}`
  const pathWithoutV1 = path.startsWith('/v1/') ? path.slice('/v1'.length) : path
  if (!normalized) return path
  if (lower.endsWith(path.toLowerCase()) || lower.endsWith(pathWithoutV1.toLowerCase())) return normalized
  if (lower.endsWith('/v1')) return `${normalized}${pathWithoutV1}`
  return `${normalized}${path}`
}

function minimaxRootUrl(baseUrl: string): string {
  const normalized = trimTrailingSlashes(baseUrl.trim())
  if (!normalized) return ''
  for (const suffix of ['/v1/video_generation', '/video_generation', '/v1/query/video_generation']) {
    if (normalized.toLowerCase().endsWith(suffix)) {
      return trimTrailingSlashes(normalized.slice(0, -suffix.length))
    }
  }
  if (normalized.toLowerCase().endsWith('/v1')) return trimTrailingSlashes(normalized.slice(0, -3))
  return normalized
}

export function volcengineArkVideoTasksUrl(baseUrl: string): string {
  const normalized = trimTrailingSlashes(baseUrl.trim())
  if (!normalized) return '/contents/generations/tasks'
  if (normalized.toLowerCase().endsWith('/contents/generations/tasks')) return normalized
  return `${normalized}/contents/generations/tasks`
}

function trimTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1
  return end === value.length ? value : value.slice(0, end)
}

function assertMiniMaxOk(baseResp: MiniMaxBaseResponse | undefined, label: string): void {
  const statusCode = baseResp?.status_code
  if (typeof statusCode === 'number' && statusCode !== 0) {
    throw new Error(`${label} failed (${statusCode}): ${baseResp?.status_msg ?? 'unknown error'}`)
  }
}

function bufferFromHex(value: string): Buffer {
  const normalized = value.replace(/\s+/g, '')
  if (!normalized || normalized.length % 2 !== 0 || /[^0-9a-f]/i.test(normalized)) {
    throw new Error('provider returned invalid hex audio data')
  }
  return Buffer.from(normalized, 'hex')
}

function withTimeout(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
}

function dataUri(mimeType: string, data: Buffer): string {
  return `data:${mimeType};base64,${data.toString('base64')}`
}

function normalizeAudioFormat(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase()
  return normalized && AUDIO_FORMATS.has(normalized) ? normalized : 'mp3'
}

function audioMimeType(format: string): string {
  switch (normalizeAudioFormat(format)) {
    case 'wav':
      return 'audio/wav'
    case 'flac':
      return 'audio/flac'
    case 'pcm':
    case 'pcm16':
      return 'audio/L16'
    case 'mp3':
    default:
      return 'audio/mpeg'
  }
}

function audioExtension(format: string): string {
  const normalized = normalizeAudioFormat(format)
  return normalized === 'pcm16' ? 'pcm' : normalized
}

function videoExtension(mimeType: string): string {
  if (mimeType.includes('webm')) return 'webm'
  if (mimeType.includes('quicktime')) return 'mov'
  return 'mp4'
}

function normalizeDuration(value: unknown, fallback: number): number {
  const candidate = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(30, Math.max(1, candidate))
}

function normalizeGrokVideoDuration(value: unknown, fallback: number): number {
  const candidate = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return GROK_VIDEO_DURATIONS.includes(candidate as 6 | 10) ? candidate : 6
}

function normalizeGrokVideoResolution(value: unknown, fallback: string): string {
  const candidate = (pickString(value) || fallback).toUpperCase()
  return GROK_VIDEO_RESOLUTIONS.includes(candidate as '480P' | '720P') ? candidate : '480P'
}

function normalizeVolcengineVideoDuration(value: unknown, fallback: number): number {
  const candidate = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(15, Math.max(4, candidate))
}

function normalizeVolcengineVideoResolution(value: unknown, fallback: string): string {
  const candidate = (pickString(value) || fallback).toUpperCase()
  return VOLCENGINE_VIDEO_RESOLUTIONS.includes(
    candidate as (typeof VOLCENGINE_VIDEO_RESOLUTIONS)[number]
  )
    ? candidate
    : '720P'
}

function isSuccessStatus(status: string): boolean {
  return ['success', 'succeeded', 'completed', 'complete'].includes(status.trim().toLowerCase())
}

function isFailureStatus(status: string): boolean {
  return ['fail', 'failed', 'error', 'canceled', 'cancelled'].includes(status.trim().toLowerCase())
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  return new Promise((resolveDelay, rejectDelay) => {
    const timer = setTimeout(resolveDelay, ms)
    const abort = () => {
      clearTimeout(timer)
      rejectDelay(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

function telemetry(startedAt: number, provider: string): Record<string, unknown> {
  return { provider, durationMs: Date.now() - startedAt }
}

function toolError(code: string, message: string, toolTelemetry?: Record<string, unknown>): { output: unknown; isError: true } {
  return {
    output: {
      error: { code, message },
      ...(toolTelemetry ? { telemetry: toolTelemetry } : {})
    },
    isError: true
  }
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function pickBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function providerErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
