import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CapabilityRegistry } from '../src/adapters/tool/capability-registry.js'
import { LocalToolHost } from '../src/adapters/tool/local-tool-host.js'
import {
  buildMusicGenToolProviders,
  buildSpeechGenToolProviders,
  buildVideoGenToolProviders,
  createVideoGenClient,
  GrokImagineVideoClient,
  MimoSpeechClient,
  MiniMaxMusicClient,
  MiniMaxSpeechClient,
  MiniMaxVideoClient,
  VolcengineArkVideoClient,
  volcengineArkVideoTasksUrl,
  type MusicGenClient,
  type SpeechGenClient,
  type VideoGenClient
} from '../src/adapters/tool/media-gen-tool-provider.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import type { ToolExecutionUpdate, ToolHostContext } from '../src/ports/tool-host.js'

let workspace: string

function buildContext(): ToolHostContext {
  return {
    threadId: 'thr_1',
    turnId: 'turn_1',
    workspace,
    threadMode: 'agent',
    approvalPolicy: 'auto',
    abortSignal: new AbortController().signal,
    awaitApproval: async () => 'allow'
  }
}

function fixedNow() {
  return '2026-06-10T00:00:00.000Z'
}

describe('Media gen tool provider', () => {
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'kun-mediagen-'))
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(workspace, { recursive: true, force: true })
  })

  it('reports unavailable media providers without tools when configuration is incomplete', () => {
    const config = KunCapabilitiesConfig.parse({
      speechGen: { enabled: true, baseUrl: 'https://media.example.test/v1', model: 'speech-test' },
      musicGen: { enabled: true, baseUrl: 'https://media.example.test/v1', model: 'music-test' },
      videoGen: { enabled: true, baseUrl: 'https://media.example.test/v1', model: 'video-test' }
    })

    const speech = buildSpeechGenToolProviders(config.speechGen)
    const music = buildMusicGenToolProviders(config.musicGen)
    const video = buildVideoGenToolProviders(config.videoGen)

    expect(speech.available).toBe(false)
    expect(music.available).toBe(false)
    expect(video.available).toBe(false)
    expect(speech.providers[0]).toMatchObject({ id: 'speechGen', available: false, tools: [] })
    expect(music.providers[0]).toMatchObject({ id: 'musicGen', available: false, tools: [] })
    expect(video.providers[0]).toMatchObject({ id: 'videoGen', available: false, tools: [] })
    expect(speech.diagnostics[0].reason).toMatch(/missing apiKey/)
    expect(music.diagnostics[0].reason).toMatch(/missing apiKey/)
    expect(video.diagnostics[0].reason).toMatch(/missing apiKey/)
  })

  it('keeps provider-backed media available and resolves rotated credentials per request', async () => {
    const authorization: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
      authorization.push(new Headers(init?.headers).get('authorization') ?? '')
      return new Response(Buffer.from('speech'), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' }
      })
    }))
    let currentCredential = 'generation-a'
    const resolveCredential = vi.fn(async () => ({ apiKey: currentCredential }))
    const config = KunCapabilitiesConfig.parse({
      speechGen: {
        enabled: true,
        providerId: 'registry-speech',
        baseUrl: 'https://media.example.test/v1',
        model: 'speech-test'
      }
    })
    const built = buildSpeechGenToolProviders(config.speechGen, {
      resolveCredential,
      nowIso: fixedNow
    })
    const host = new LocalToolHost({ registry: new CapabilityRegistry(built.providers) })

    expect(built.available).toBe(true)
    await host.execute({
      callId: 'call_generation_a',
      toolName: 'generate_speech',
      arguments: { text: 'first' }
    }, buildContext())
    currentCredential = 'generation-b'
    await host.execute({
      callId: 'call_generation_b',
      toolName: 'generate_speech',
      arguments: { text: 'second' }
    }, buildContext())

    expect(resolveCredential).toHaveBeenNthCalledWith(1, 'registry-speech')
    expect(resolveCredential).toHaveBeenNthCalledWith(2, 'registry-speech')
    expect(authorization).toEqual(['Bearer generation-a', 'Bearer generation-b'])
  })

  it('generates speech, music, and video files through configured media tools', async () => {
    const speechCalls: unknown[] = []
    const musicCalls: unknown[] = []
    const videoCalls: unknown[] = []
    const speechClient: SpeechGenClient = {
      id: 'fake-speech',
      async generate(request) {
        speechCalls.push(request)
        return { data: Buffer.from('speech-bytes'), mimeType: 'audio/mpeg', extension: 'mp3' }
      }
    }
    const musicClient: MusicGenClient = {
      id: 'fake-music',
      async generate(request) {
        musicCalls.push(request)
        return { data: Buffer.from('music-bytes'), mimeType: 'audio/mpeg', extension: 'mp3' }
      }
    }
    const videoClient: VideoGenClient = {
      id: 'fake-video',
      async generate(request) {
        videoCalls.push(request)
        await request.onUpdate?.({ output: { status: 'submitted', provider: 'fake-video' } })
        return { data: Buffer.from('video-bytes'), mimeType: 'video/mp4', extension: 'mp4' }
      }
    }
    const config = KunCapabilitiesConfig.parse({
      speechGen: {
        enabled: true,
        baseUrl: 'https://media.example.test/v1',
        apiKey: 'sk-speech',
        model: 'speech-test',
        voice: 'voice-1',
        format: 'mp3'
      },
      musicGen: {
        enabled: true,
        baseUrl: 'https://media.example.test/v1',
        apiKey: 'sk-music',
        model: 'music-test',
        format: 'mp3'
      },
      videoGen: {
        enabled: true,
        baseUrl: 'https://media.example.test/v1',
        apiKey: 'sk-video',
        model: 'video-test',
        defaultDuration: 6,
        defaultResolution: '1080P'
      }
    })
    const providers = [
      ...buildSpeechGenToolProviders(config.speechGen, { speechClient, nowIso: fixedNow }).providers,
      ...buildMusicGenToolProviders(config.musicGen, { musicClient, nowIso: fixedNow }).providers,
      ...buildVideoGenToolProviders(config.videoGen, { videoClient, nowIso: fixedNow }).providers
    ]
    const host = new LocalToolHost({ registry: new CapabilityRegistry(providers) })
    const context = buildContext()

    expect((await host.listTools(context)).map((tool) => tool.name)).toEqual([
      'generate_speech',
      'generate_music',
      'generate_video'
    ])

    const speech = await host.execute({
      callId: 'call_speech',
      toolName: 'generate_speech',
      arguments: { text: 'hello world' }
    }, context)
    const music = await host.execute({
      callId: 'call_music',
      toolName: 'generate_music',
      arguments: { prompt: 'bright synth pop', instrumental: true }
    }, context)
    const updates: ToolExecutionUpdate[] = []
    const video = await host.execute({
      callId: 'call_video',
      toolName: 'generate_video',
      arguments: { prompt: 'a product demo', duration: 8, resolution: '768P' }
    }, context, (item) => {
      if (item.kind === 'tool_result') updates.push({ output: item.output, isError: item.isError })
    })

    const speechOutput = outputFor(speech.item)
    const musicOutput = outputFor(music.item)
    const videoOutput = outputFor(video.item)
    expect(speechOutput).toMatchObject({ model: 'speech-test', voice: 'voice-1', format: 'mp3' })
    expect(musicOutput).toMatchObject({ model: 'music-test', format: 'mp3' })
    expect(videoOutput).toMatchObject({ model: 'video-test', duration: 8, resolution: '768P' })
    await expectFile(speechOutput, '.deepseekgui-audio/', 'audio/mpeg', 'speech-bytes')
    await expectFile(musicOutput, '.deepseekgui-music/', 'audio/mpeg', 'music-bytes')
    await expectFile(videoOutput, '.deepseekgui-videos/', 'video/mp4', 'video-bytes')
    expect(speechCalls[0]).toMatchObject({ text: 'hello world', model: 'speech-test', voice: 'voice-1' })
    expect(musicCalls[0]).toMatchObject({ prompt: 'bright synth pop', instrumental: true, model: 'music-test' })
    expect(videoCalls[0]).toMatchObject({ prompt: 'a product demo', duration: 8, resolution: '768P', model: 'video-test' })
    expect(updates[0]).toMatchObject({ output: { status: 'submitted', provider: 'fake-video' } })
  })

  it('treats generated media as a file change and blocks it in read-only mode', async () => {
    const calls: unknown[] = []
    const speechClient: SpeechGenClient = {
      id: 'fake-speech',
      async generate(request) {
        calls.push(request)
        return { data: Buffer.from('speech-bytes'), mimeType: 'audio/mpeg', extension: 'mp3' }
      }
    }
    const config = KunCapabilitiesConfig.parse({
      speechGen: {
        enabled: true,
        baseUrl: 'https://media.example.test/v1',
        apiKey: 'sk-speech',
        model: 'speech-test'
      }
    })
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(
        buildSpeechGenToolProviders(config.speechGen, { speechClient, nowIso: fixedNow }).providers
      )
    })

    const result = await host.execute({
      callId: 'call_read_only_speech',
      toolName: 'generate_speech',
      arguments: { text: 'must not run' }
    }, { ...buildContext(), sandboxMode: 'read-only' })

    expect(result.item).toMatchObject({ kind: 'tool_result', isError: true })
    expect(calls).toEqual([])
  })

  it('posts MiniMax speech and music requests to the documented endpoints and decodes hex audio', async () => {
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      requests.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>
      })
      return new Response(JSON.stringify({
        base_resp: { status_code: 0, status_msg: 'success' },
        data: { audio: Buffer.from(requests.length === 1 ? 'speech' : 'music').toString('hex') }
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }))
    const signal = new AbortController().signal

    const speech = await new MiniMaxSpeechClient('https://api.minimax.io', 'sk-test').generate({
      text: 'Hello from MiniMax',
      model: 'speech-2.8-hd',
      voice: 'female-shaonv',
      format: 'mp3',
      timeoutMs: 120000,
      signal
    })
    const music = await new MiniMaxMusicClient('https://api.minimax.io', 'sk-test').generate({
      prompt: 'Pop, bright, upbeat',
      lyrics: 'hello\nworld',
      model: 'music-2.6',
      format: 'mp3',
      timeoutMs: 300000,
      signal
    })

    expect(speech.data.toString('utf8')).toBe('speech')
    expect(music.data.toString('utf8')).toBe('music')
    expect(requests[0].url).toBe('https://api.minimax.io/v1/t2a_v2')
    expect(requests[0].headers.get('authorization')).toBe('Bearer sk-test')
    expect(requests[0].body).toMatchObject({
      model: 'speech-2.8-hd',
      text: 'Hello from MiniMax',
      output_format: 'hex',
      voice_setting: { voice_id: 'female-shaonv' },
      audio_setting: { format: 'mp3' }
    })
    expect(requests[1].url).toBe('https://api.minimax.io/v1/music_generation')
    expect(requests[1].body).toMatchObject({
      model: 'music-2.6',
      prompt: 'Pop, bright, upbeat',
      lyrics: 'hello\nworld',
      output_format: 'hex',
      audio_setting: { format: 'mp3' }
    })
  })

  it('posts MiMo TTS as a chat completion with assistant speech text and decodes base64 audio', async () => {
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      requests.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>
      })
      return new Response(JSON.stringify({
        choices: [{
          message: {
            audio: { data: Buffer.from('mimo-audio').toString('base64') }
          }
        }]
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }))

    const media = await new MimoSpeechClient('https://api.xiaomimimo.com/v1', 'sk-mimo').generate({
      text: 'The target text is in the assistant message.',
      model: 'mimo-v2.5-tts',
      voice: 'Chloe',
      style: 'Bright and upbeat.',
      format: 'wav',
      timeoutMs: 120000,
      signal: new AbortController().signal
    })

    expect(media.data.toString('utf8')).toBe('mimo-audio')
    expect(media.mimeType).toBe('audio/wav')
    expect(requests[0].url).toBe('https://api.xiaomimimo.com/v1/chat/completions')
    expect(requests[0].headers.get('api-key')).toBe('sk-mimo')
    expect(requests[0].body).toEqual({
      model: 'mimo-v2.5-tts',
      messages: [
        { role: 'user', content: 'Bright and upbeat.' },
        { role: 'assistant', content: 'The target text is in the assistant message.' }
      ],
      audio: {
        format: 'wav',
        voice: 'Chloe'
      }
    })
  })

  it('polls MiniMax video generation and downloads the finished file', async () => {
    const requests: Array<{ url: string; method?: string; body?: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url)
      requests.push({
        url: href,
        method: init?.method,
        ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {})
      })
      if (href.endsWith('/v1/video_generation')) {
        return new Response(JSON.stringify({
          base_resp: { status_code: 0, status_msg: 'success' },
          task_id: 'task-1'
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      if (href.includes('/v1/query/video_generation')) {
        return new Response(JSON.stringify({
          base_resp: { status_code: 0, status_msg: 'success' },
          status: 'success',
          file_id: 'file-1'
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      if (href.includes('/v1/files/retrieve')) {
        return new Response(JSON.stringify({
          base_resp: { status_code: 0, status_msg: 'success' },
          file: { download_url: 'https://cdn.example.test/video.mp4' }
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      expect(href).toBe('https://cdn.example.test/video.mp4')
      return new Response(new Uint8Array(Buffer.from('video')), {
        status: 200,
        headers: { 'content-type': 'video/mp4' }
      })
    }))
    const updates: ToolExecutionUpdate[] = []

    const media = await new MiniMaxVideoClient('https://api.minimax.io', 'sk-video').generate({
      prompt: 'A calm product reveal',
      model: 'MiniMax-Hailuo-2.3',
      duration: 6,
      resolution: '1080P',
      timeoutMs: 120000,
      pollIntervalMs: 1,
      signal: new AbortController().signal,
      onUpdate: (update) => {
        updates.push(update)
      }
    })

    expect(media.data.toString('utf8')).toBe('video')
    expect(requests[0]).toMatchObject({
      url: 'https://api.minimax.io/v1/video_generation',
      method: 'POST',
      body: {
        model: 'MiniMax-Hailuo-2.3',
        prompt: 'A calm product reveal',
        duration: 6,
        resolution: '1080P'
      }
    })
    expect(requests[1].url).toBe('https://api.minimax.io/v1/query/video_generation?task_id=task-1')
    expect(requests[2].url).toBe('https://api.minimax.io/v1/files/retrieve?file_id=file-1')
    expect(updates).toEqual([
      { output: { status: 'submitted', taskId: 'task-1', provider: 'minimax-video' } },
      { output: { status: 'success', taskId: 'task-1', provider: 'minimax-video' } }
    ])
  })

  it('exposes native Seedance controls and builds API or Agent Plan task endpoints', () => {
    expect(volcengineArkVideoTasksUrl('https://ark.cn-beijing.volces.com/api/v3'))
      .toBe('https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks')
    expect(volcengineArkVideoTasksUrl('https://ark.cn-beijing.volces.com/api/plan/v3/'))
      .toBe('https://ark.cn-beijing.volces.com/api/plan/v3/contents/generations/tasks')
    expect(volcengineArkVideoTasksUrl(
      'https://ark.cn-beijing.volces.com/api/plan/v3/contents/generations/tasks'
    )).toBe('https://ark.cn-beijing.volces.com/api/plan/v3/contents/generations/tasks')
    expect(createVideoGenClient({
      protocol: 'volcengine-ark-video',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: 'ark-access'
    }).id).toBe('volcengine-ark-video')

    const config = KunCapabilitiesConfig.parse({
      videoGen: {
        enabled: true,
        protocol: 'volcengine-ark-video',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        apiKey: 'ark-access',
        model: 'doubao-seedance-2-0-260128',
        defaultDuration: 8,
        defaultResolution: '1080P'
      }
    })
    const tool = buildVideoGenToolProviders(config.videoGen, {
      videoClient: {
        id: 'fake-seedance',
        async generate() {
          return { data: Buffer.from('video'), mimeType: 'video/mp4', extension: 'mp4' }
        }
      }
    }).providers[0].tools[0]
    const properties = tool.inputSchema.properties as Record<string, {
      enum?: Array<string | number>
      minimum?: number
      maximum?: number
    }>

    expect(properties.duration).toMatchObject({ minimum: 4, maximum: 15 })
    expect(properties.resolution.enum).toEqual(['480P', '720P', '1080P', '4K'])
    expect(properties.aspect_ratio.enum).toEqual([
      'adaptive',
      '21:9',
      '16:9',
      '4:3',
      '1:1',
      '3:4',
      '9:16'
    ])
    expect(properties.last_frame_image_path).toBeDefined()
  })

  it('creates, polls, and downloads a native Seedance video task', async () => {
    const requests: Array<{
      url: string
      method?: string
      headers: Headers
      body?: Record<string, unknown>
    }> = []
    let pollCount = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url)
      requests.push({
        url: href,
        method: init?.method,
        headers: new Headers(init?.headers),
        ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {})
      })
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'seedance-task-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      if (href.endsWith('/seedance-task-1')) {
        pollCount += 1
        return new Response(JSON.stringify(pollCount === 1
          ? { id: 'seedance-task-1', status: 'queued' }
          : {
              id: 'seedance-task-1',
              status: 'succeeded',
              content: { video_url: 'https://cdn.example.test/seedance.mp4' }
            }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      expect(href).toBe('https://cdn.example.test/seedance.mp4')
      return new Response(new Uint8Array(Buffer.from('seedance-video')), {
        status: 200,
        headers: { 'content-type': 'video/mp4' }
      })
    }))
    const updates: ToolExecutionUpdate[] = []
    const client = new VolcengineArkVideoClient(
      'https://ark.cn-beijing.volces.com/api/plan/v3',
      'agent-plan-key'
    )

    const media = await client.generate({
      prompt: '镜头缓慢推进，海浪拍打礁石',
      model: 'doubao-seedance-2.0',
      duration: 8,
      resolution: '1080P',
      aspectRatio: '16:9',
      firstFrameImage: { mimeType: 'image/png', data: Buffer.from('first-frame') },
      lastFrameImage: { mimeType: 'image/jpeg', data: Buffer.from('last-frame') },
      timeoutMs: 1_000,
      pollIntervalMs: 1,
      signal: new AbortController().signal,
      onUpdate: (update) => {
        updates.push(update)
      }
    })

    expect(media).toMatchObject({
      data: Buffer.from('seedance-video'),
      mimeType: 'video/mp4',
      extension: 'mp4'
    })
    expect(requests[0].url).toBe(
      'https://ark.cn-beijing.volces.com/api/plan/v3/contents/generations/tasks'
    )
    expect(requests[0].headers.get('authorization')).toBe('Bearer agent-plan-key')
    expect(requests[0].body).toEqual({
      model: 'doubao-seedance-2.0',
      content: [
        { type: 'text', text: '镜头缓慢推进，海浪拍打礁石' },
        {
          type: 'image_url',
          image_url: {
            url: `data:image/png;base64,${Buffer.from('first-frame').toString('base64')}`
          },
          role: 'first_frame'
        },
        {
          type: 'image_url',
          image_url: {
            url: `data:image/jpeg;base64,${Buffer.from('last-frame').toString('base64')}`
          },
          role: 'last_frame'
        }
      ],
      generate_audio: true,
      ratio: '16:9',
      duration: 8,
      resolution: '1080p',
      watermark: false
    })
    expect(requests[1].url).toBe(
      'https://ark.cn-beijing.volces.com/api/plan/v3/contents/generations/tasks/seedance-task-1'
    )
    expect(requests[2].url).toBe(requests[1].url)
    expect(requests[3].headers.get('authorization')).toBeNull()
    expect(updates).toEqual([
      { output: { status: 'submitted', taskId: 'seedance-task-1', provider: 'volcengine-ark-video' } },
      { output: { status: 'queued', taskId: 'seedance-task-1', provider: 'volcengine-ark-video' } },
      { output: { status: 'succeeded', taskId: 'seedance-task-1', provider: 'volcengine-ark-video' } }
    ])
  })

  it('surfaces Seedance task failure details and obeys its timeout', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'seedance-failed' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      return new Response(JSON.stringify({
        id: 'seedance-failed',
        status: 'failed',
        error: { code: 'ContentRisk', message: 'prompt rejected' }
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }))
    const client = new VolcengineArkVideoClient(
      'https://ark.cn-beijing.volces.com/api/v3',
      'ark-key'
    )
    const baseRequest = {
      prompt: 'test',
      model: 'doubao-seedance-2-0-260128',
      duration: 6,
      resolution: '720P',
      pollIntervalMs: 1,
      signal: new AbortController().signal
    }

    await expect(client.generate({
      ...baseRequest,
      timeoutMs: 1_000
    })).rejects.toThrow(
      /Volcano Ark video generation failed \(task_id=seedance-failed\): prompt rejected/
    )

    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'seedance-running' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      return new Response(JSON.stringify({
        id: 'seedance-running',
        status: 'running'
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }))
    await expect(client.generate({
      ...baseRequest,
      timeoutMs: 20
    })).rejects.toThrow(
      /timed out after 20ms \(last status: running\)/
    )
  })

  it('rejects a successful Seedance task without an output URL and stops on caller abort', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'seedance-no-url' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      return new Response(JSON.stringify({
        id: 'seedance-no-url',
        status: 'succeeded',
        content: {}
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }))
    const client = new VolcengineArkVideoClient(
      'https://ark.cn-beijing.volces.com/api/v3',
      'ark-key'
    )
    const request = {
      prompt: 'test',
      model: 'doubao-seedance-2-0-260128',
      duration: 6,
      resolution: '720P',
      timeoutMs: 1_000,
      pollIntervalMs: 1
    }

    await expect(client.generate({
      ...request,
      signal: new AbortController().signal
    })).rejects.toThrow(
      /finished without content\.video_url/
    )

    let fetchCount = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      fetchCount += 1
      return new Response(JSON.stringify({ id: 'seedance-aborted' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }))
    const controller = new AbortController()
    const generation = client.generate({
      ...request,
      pollIntervalMs: 1_000,
      signal: controller.signal
    })
    setTimeout(() => controller.abort(), 5)

    await expect(generation).rejects.toThrow(/Aborted/)
    expect(fetchCount).toBe(1)
  })

  it('polls Grok Imagine video generation and downloads the finished file', async () => {
    expect(createVideoGenClient({
      protocol: 'grok-imagine-video',
      baseUrl: 'https://api.x.ai/v1',
      apiKey: 'grok-access'
    }).id).toBe('grok-imagine-video')

    const requests: Array<{
      url: string
      method?: string
      headers: Headers
      body?: Record<string, unknown>
    }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url)
      requests.push({
        url: href,
        method: init?.method,
        headers: new Headers(init?.headers),
        ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {})
      })
      if (href.endsWith('/videos/generations')) {
        return new Response(JSON.stringify({ request_id: 'video-request-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      if (href.endsWith('/videos/video-request-1')) {
        return new Response(JSON.stringify({
          status: 'done',
          video: { url: 'https://cdn.example.test/grok-video.mp4' }
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      expect(href).toBe('https://cdn.example.test/grok-video.mp4')
      return new Response(new Uint8Array(Buffer.from('grok-video')), {
        status: 200,
        headers: { 'content-type': 'video/mp4' }
      })
    }))
    const updates: ToolExecutionUpdate[] = []
    const client = new GrokImagineVideoClient('https://api.x.ai/v1', 'grok-access', {
      'x-grok-client-version': '0.2.112',
      'x-grok-client-identifier': 'grok-shell'
    })

    const media = await client.generate({
      prompt: 'Animate the clouds',
      model: 'grok-imagine-video-1.5-preview',
      duration: 6,
      resolution: '720P',
      firstFrameImage: { mimeType: 'image/png', data: Buffer.from('source-image') },
      timeoutMs: 1_000,
      pollIntervalMs: 1,
      signal: new AbortController().signal,
      onUpdate: (update) => {
        updates.push(update)
      }
    })

    expect(media.data.toString('utf8')).toBe('grok-video')
    expect(requests[0].url).toBe('https://api.x.ai/v1/videos/generations')
    expect(requests[0].headers.get('authorization')).toBe('Bearer grok-access')
    expect(requests[0].headers.get('x-grok-client-identifier')).toBe('grok-shell')
    expect(requests[0].body).toEqual({
      model: 'grok-imagine-video-1.5-preview',
      prompt: 'Animate the clouds',
      duration: 6,
      resolution: '720p',
      image: { url: `data:image/png;base64,${Buffer.from('source-image').toString('base64')}` },
      reference_images: []
    })
    expect(requests[1].url).toBe('https://api.x.ai/v1/videos/video-request-1')
    expect(requests[2].headers.get('authorization')).toBeNull()
    expect(updates).toEqual([
      { output: { status: 'submitted', taskId: 'video-request-1', provider: 'grok-imagine-video' } },
      { output: { status: 'done', taskId: 'video-request-1', provider: 'grok-imagine-video' } }
    ])
  })
})

function outputFor(item: unknown): {
  files: Array<{ relativePath: string; absolutePath: string; mimeType: string; byteSize: number }>
  model: string
  voice?: string
  format?: string
  duration?: number
  resolution?: string
} {
  expect(item).toMatchObject({ kind: 'tool_result', isError: false })
  const output = (item as { output: unknown }).output
  expect(output).toMatchObject({ files: expect.any(Array) })
  return output as {
    files: Array<{ relativePath: string; absolutePath: string; mimeType: string; byteSize: number }>
    model: string
    voice?: string
    format?: string
    duration?: number
    resolution?: string
  }
}

async function expectFile(
  output: { files: Array<{ relativePath: string; absolutePath: string; mimeType: string; byteSize: number }> },
  prefix: string,
  mimeType: string,
  contents: string
) {
  expect(output.files).toHaveLength(1)
  const file = output.files[0]
  expect(file.relativePath.startsWith(prefix)).toBe(true)
  expect(file.mimeType).toBe(mimeType)
  expect(file.byteSize).toBe(Buffer.byteLength(contents))
  expect(existsSync(file.absolutePath)).toBe(true)
  await expect(readFile(file.absolutePath, 'utf8')).resolves.toBe(contents)
}
