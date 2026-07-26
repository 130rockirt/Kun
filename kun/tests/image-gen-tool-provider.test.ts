import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CapabilityRegistry } from '../src/adapters/tool/capability-registry.js'
import { LocalToolHost } from '../src/adapters/tool/local-tool-host.js'
import {
  buildImageGenToolProviders,
  CodexResponsesImageClient,
  codexResponsesImageUrl,
  createImageGenClient,
  mapImageSize,
  GrokImagineImageClient,
  MiniMaxImageClient,
  minimaxImageDimensionFields,
  OpenAiCompatImageClient,
  openAiCompatImageUrl,
  protocolSupportsImageEdit,
  type ImageGenClient
} from '../src/adapters/tool/image-gen-tool-provider.js'
import { FileAttachmentStore } from '../src/attachments/attachment-store.js'
import {
  buildRuntimeCapabilityManifest,
  KunCapabilitiesConfig
} from '../src/contracts/capabilities.js'
import { modelCapabilitiesForModel } from '../src/loop/model-context-profile.js'
import type { ToolHostContext } from '../src/ports/tool-host.js'

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

function imageGenConfig(overrides: Record<string, unknown> = {}) {
  return KunCapabilitiesConfig.parse({
    imageGen: {
      enabled: true,
      baseUrl: 'https://images.example.test/v1',
      apiKey: 'sk-test',
      model: 'test-image-model',
      ...overrides
    }
  }).imageGen
}

function fakeClient(image = png(1024, 576)): ImageGenClient & { generateCalls: unknown[]; editCalls: unknown[] } {
  const calls = { generateCalls: [] as unknown[], editCalls: [] as unknown[] }
  return {
    id: 'fake',
    ...calls,
    async generate(request) {
      calls.generateCalls.push(request)
      return { data: image, mimeType: 'image/png' }
    },
    async edit(request) {
      calls.editCalls.push(request)
      return { data: image, mimeType: 'image/png' }
    }
  }
}

function attachmentStore(rootDir: string, overrides: Record<string, unknown> = {}) {
  return new FileAttachmentStore({
    rootDir,
    config: KunCapabilitiesConfig.parse({ attachments: { enabled: true, ...overrides } }).attachments,
    nowIso: () => '2026-06-10T00:00:00.000Z'
  })
}

function hostFor(client: ImageGenClient, store?: FileAttachmentStore) {
  return new LocalToolHost({
    registry: new CapabilityRegistry(
      buildImageGenToolProviders(imageGenConfig(), {
        client,
        attachmentStore: store,
        nowIso: () => '2026-06-10T00:00:00.000Z'
      }).providers
    )
  })
}

describe('Image gen tool provider', () => {
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'kun-imagegen-'))
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(workspace, { recursive: true, force: true })
  })

  it('does not build providers when image generation is disabled', () => {
    const config = KunCapabilitiesConfig.parse({})
    const built = buildImageGenToolProviders(config.imageGen)
    expect(built.providers).toEqual([])
    expect(built.diagnostics).toEqual([])
    expect(built.available).toBe(false)
  })

  it('reports an unavailable provider without tools when configuration is incomplete', async () => {
    const config = KunCapabilitiesConfig.parse({
      imageGen: { enabled: true, baseUrl: 'https://images.example.test/v1', model: 'test-image-model' }
    })
    const built = buildImageGenToolProviders(config.imageGen)
    expect(built.available).toBe(false)
    expect(built.providers).toHaveLength(1)
    expect(built.providers[0]).toMatchObject({ id: 'imageGen', enabled: true, available: false })
    expect(built.providers[0].reason).toMatch(/missing apiKey/)
    expect(built.providers[0].tools).toHaveLength(0)
    expect(built.diagnostics[0]).toMatchObject({ enabled: true, available: false })
  })

  it('maps aspect ratio and size tier to provider sizes', () => {
    expect(mapImageSize(undefined, undefined, undefined, '1K')).toBe('1024x1024')
    expect(mapImageSize(undefined, undefined, undefined, '2K')).toBe('2048x2048')
    expect(mapImageSize(undefined, undefined, undefined, 'auto')).toBe('auto')
    expect(mapImageSize('16:9', undefined, undefined, 'auto')).toBe('1024x576')
    expect(mapImageSize(undefined, undefined, '1536x1024', '2K')).toBe('1536x1024')
    expect(mapImageSize('3:2', undefined, '1536x1024', '2K')).toBe('1536x1024')
    expect(mapImageSize(undefined, undefined, 'auto', '2K')).toBe('auto')
    expect(mapImageSize('16:9', undefined, 'auto', '2K')).toBe('2048x1152')
    expect(mapImageSize('1:1', undefined, undefined, '1K')).toBe('1024x1024')
    expect(mapImageSize('1:1', '2K', undefined, '1K')).toBe('2048x2048')
    expect(mapImageSize('16:9', '1K', undefined, '2K')).toBe('1024x576')
    expect(mapImageSize('9:16', '2K', undefined, '1K')).toBe('1152x2048')
    expect(mapImageSize('21:9', '1K', undefined, '2K')).toBe('1024x448')
    expect(mapImageSize('3:2', '1K', undefined, '2K')).toBe('1024x704')
    // An explicit tool override wins over both configured size fields.
    expect(mapImageSize('16:9', '2K', '1536x1024', '1K')).toBe('2048x1152')
    // Unknown ratios fall back to a square at the requested tier.
    expect(mapImageSize('7:5', '2K', undefined, '1K')).toBe('2048x2048')
    expect(mapImageSize(undefined, '2K', undefined, '1K')).toBe('2048x2048')
  })

  it('defaults image resolution to 1K and validates configured tiers', () => {
    expect(imageGenConfig().defaultResolution).toBe('1K')
    expect(imageGenConfig({ defaultResolution: 'auto' }).defaultResolution).toBe('auto')
    expect(imageGenConfig({ defaultResolution: '2K' }).defaultResolution).toBe('2K')
    expect(() => imageGenConfig({ defaultResolution: '4K' })).toThrow()
  })

  it('advertises settings-backed quality and resolution semantics without dynamic values', () => {
    const oneKTool = buildImageGenToolProviders(imageGenConfig({
      defaultResolution: '1K',
      quality: 'low'
    }), { client: fakeClient() }).providers[0].tools[0]
    const twoKTool = buildImageGenToolProviders(imageGenConfig({
      defaultResolution: '2K',
      quality: 'high'
    }), { client: fakeClient() }).providers[0].tools[0]

    expect(oneKTool.description).toContain('Image quality is applied automatically from Settings')
    const properties = oneKTool.inputSchema.properties as Record<string, { description?: string }>
    expect(properties.aspect_ratio.description).toContain('preserving the selected or default resolution')
    expect(properties.image_size.description).toContain('only when the user explicitly requests 1K or 2K')
    expect(properties.image_size.description).toContain('Settings default resolution')
    expect(properties.image_size.description).toContain('independent of image quality')
    expect(properties.image_size.description).not.toContain('defaults to 1K')
    expect(twoKTool.description).toBe(oneKTool.description)
    expect(twoKTool.inputSchema).toEqual(oneKTool.inputSchema)
  })

  it('advertises the verified Grok aspect ratios and both resolution tiers', () => {
    const tool = buildImageGenToolProviders(imageGenConfig({
      protocol: 'grok-imagine-image'
    }), { client: fakeClient() }).providers[0].tools[0]
    const properties = tool.inputSchema.properties as Record<string, { enum?: string[] }>

    expect(properties.aspect_ratio.enum).toEqual([
      '1:1',
      '16:9',
      '9:16',
      '4:3',
      '3:4',
      '3:2',
      '2:3',
      '2:1',
      '1:2',
      '19.5:9',
      '9:19.5',
      '20:9',
      '9:20'
    ])
    expect(properties.image_size.enum).toEqual(['1K', '2K'])
  })

  it('keeps explicit width/height for MiniMax image-01 only', () => {
    expect(minimaxImageDimensionFields('image-01', '768x1024')).toEqual({ width: 768, height: 1024 })
    expect(minimaxImageDimensionFields(' image-01 ', '1024x576')).toEqual({ width: 1024, height: 576 })
  })

  it('maps sizes to the nearest aspect_ratio for other MiniMax models', () => {
    // image-01-live rejects width/height with status 2013.
    expect(minimaxImageDimensionFields('image-01-live', '768x1024')).toEqual({ aspect_ratio: '3:4' })
    expect(minimaxImageDimensionFields('image-01-live', '1024x1024')).toEqual({ aspect_ratio: '1:1' })
    expect(minimaxImageDimensionFields('image-01-live', '1024x576')).toEqual({ aspect_ratio: '16:9' })
    // mapImageSize rounds edges to multiples of 64, so snap to the nearest ratio.
    expect(minimaxImageDimensionFields('image-01-live', '1024x704')).toEqual({ aspect_ratio: '3:2' })
    expect(minimaxImageDimensionFields('image-01-live', '1152x2048')).toEqual({ aspect_ratio: '9:16' })
    // 21:9 is image-01 only; ultra-wide degrades to the closest supported ratio.
    expect(minimaxImageDimensionFields('image-01-live', '1024x448')).toEqual({ aspect_ratio: '16:9' })
  })

  it('omits MiniMax dimension fields for non-WxH sizes', () => {
    expect(minimaxImageDimensionFields('image-01-live', undefined)).toEqual({})
    expect(minimaxImageDimensionFields('image-01-live', 'auto')).toEqual({})
    expect(minimaxImageDimensionFields('image-01', '0x0')).toEqual({})
  })

  it('enables MiniMax prompt optimization for image requests', async () => {
    const requests: Array<{ url: string; body: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      requests.push({ url: String(url), body: String(init?.body) })
      return new Response(JSON.stringify({
        data: { image_base64: [png(8, 8).toString('base64')] },
        base_resp: { status_code: 0 }
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }))
    const client = new MiniMaxImageClient('https://api.minimaxi.com', 'sk-test')

    await client.generate({
      prompt: 'short prompt',
      model: 'image-01',
      size: '1024x768',
      timeoutMs: 1_000,
      signal: new AbortController().signal
    })

    expect(requests[0].url).toBe('https://api.minimaxi.com/v1/image_generation')
    expect(JSON.parse(requests[0].body)).toMatchObject({
      model: 'image-01',
      prompt: 'short prompt',
      width: 1024,
      height: 768,
      prompt_optimizer: true,
      response_format: 'base64',
      n: 1
    })
  })

  it('inserts /v1 into unversioned OpenAI-compat image base urls like the chat client', () => {
    // ZenMux-style API root without a version segment.
    expect(openAiCompatImageUrl('https://zenmux.ai/api', 'generations'))
      .toBe('https://zenmux.ai/api/v1/images/generations')
    expect(openAiCompatImageUrl('https://zenmux.ai/api/', 'edits'))
      .toBe('https://zenmux.ai/api/v1/images/edits')
    expect(openAiCompatImageUrl('https://example.test', 'generations'))
      .toBe('https://example.test/v1/images/generations')
  })

  it('keeps versioned and fully-qualified OpenAI-compat image base urls', () => {
    expect(openAiCompatImageUrl('https://api.openai.com/v1', 'generations'))
      .toBe('https://api.openai.com/v1/images/generations')
    expect(openAiCompatImageUrl('https://ark.example.test/api/v3', 'edits'))
      .toBe('https://ark.example.test/api/v3/images/edits')
    expect(openAiCompatImageUrl('https://x.test/v1/images/generations', 'generations'))
      .toBe('https://x.test/v1/images/generations')
    // A fully-qualified generations URL still routes the edits call.
    expect(openAiCompatImageUrl('https://x.test/v1/images/generations', 'edits'))
      .toBe('https://x.test/v1/images/edits')
  })

  it('posts Codex subscription image requests through responses image_generation SSE', async () => {
    expect(codexResponsesImageUrl('https://chatgpt.com/backend-api/codex'))
      .toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(codexResponsesImageUrl('https://chatgpt.com/backend-api/codex/responses'))
      .toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(createImageGenClient({
      protocol: 'codex-responses-image',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      apiKey: 'codex-access'
    }).id).toBe('codex-responses-image')

    const requests: Array<{ url: string; headers: Record<string, string>; body: string }> = []
    const resultBase64 = png(8, 8).toString('base64')
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      requests.push({
        url: String(url),
        headers: init?.headers as Record<string, string>,
        body: String(init?.body)
      })
      return new Response([
        `data: ${JSON.stringify({
          type: 'response.output_item.done',
          item: { type: 'image_generation_call', result: resultBase64 }
        })}`,
        'data: [DONE]'
      ].join('\n\n'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
    }))
    const client = new CodexResponsesImageClient('https://chatgpt.com/backend-api/codex', 'codex-access', {
      'ChatGPT-Account-Id': 'acct_123',
      originator: 'codex_cli_rs'
    })

    const image = await client.generate({
      prompt: 'tiny square',
      model: 'gpt-image-2',
      size: '1024x1024',
      timeoutMs: 1_000,
      signal: new AbortController().signal
    })

    expect(image).toMatchObject({ mimeType: 'image/png' })
    expect(image.data.byteLength).toBeGreaterThan(0)
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(requests[0].headers).toMatchObject({
      Authorization: 'Bearer codex-access',
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      'ChatGPT-Account-Id': 'acct_123',
      originator: 'codex_cli_rs'
    })
    expect(JSON.parse(requests[0].body)).toMatchObject({
      model: 'gpt-5.5',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'tiny square' }] }],
      instructions: 'You must fulfill image generation requests by using the image_generation tool.',
      tools: [{
        type: 'image_generation',
        action: 'generate',
        model: 'gpt-image-2',
        quality: 'auto',
        output_format: 'png',
        background: 'opaque',
        partial_images: 1,
        size: '1024x1024'
      }],
      tool_choice: {
        type: 'allowed_tools',
        mode: 'required',
        tools: [{ type: 'image_generation' }]
      },
      stream: true,
      store: false
    })
  })

  it('posts Grok subscription image requests with native ratios and 1K/2K resolutions', async () => {
    expect(createImageGenClient({
      protocol: 'grok-imagine-image',
      baseUrl: 'https://api.x.ai/v1',
      apiKey: 'grok-access'
    }).id).toBe('grok-imagine-image')

    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      requests.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>
      })
      return new Response(JSON.stringify({
        data: [{ b64_json: png(8, 8).toString('base64') }]
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const client = new GrokImagineImageClient('https://api.x.ai/v1', 'grok-access', {
      'x-grok-client-version': '0.2.112',
      'x-grok-client-identifier': 'grok-shell'
    })

    const oneKImage = await client.generate({
      prompt: 'cinematic mountain lake',
      model: 'grok-imagine-image-quality',
      aspectRatio: '16:9',
      size: '1024x576',
      timeoutMs: 1_000,
      signal: new AbortController().signal
    })
    const twoKImage = await client.generate({
      prompt: 'ultra-wide city skyline',
      model: 'grok-imagine-image-quality',
      aspectRatio: '20:9',
      size: '2048x896',
      timeoutMs: 1_000,
      signal: new AbortController().signal
    })

    expect(oneKImage.data.byteLength).toBeGreaterThan(0)
    expect(twoKImage.data.byteLength).toBeGreaterThan(0)
    expect(requests).toHaveLength(2)
    expect(requests[0].url).toBe('https://api.x.ai/v1/images/generations')
    expect(requests[0].headers.get('authorization')).toBe('Bearer grok-access')
    expect(requests[0].headers.get('x-grok-client-version')).toBe('0.2.112')
    expect(requests[0].headers.get('x-grok-client-identifier')).toBe('grok-shell')
    expect(requests[0].body).toEqual({
      model: 'grok-imagine-image-quality',
      prompt: 'cinematic mountain lake',
      n: 1,
      aspect_ratio: '16:9',
      resolution: '1k',
      response_format: 'b64_json'
    })
    expect(requests[0].body).not.toHaveProperty('size')
    expect(requests[1].body).toEqual({
      model: 'grok-imagine-image-quality',
      prompt: 'ultra-wide city skyline',
      n: 1,
      aspect_ratio: '20:9',
      resolution: '2k',
      response_format: 'b64_json'
    })
    expect(requests[1].body).not.toHaveProperty('size')
  })

  it('posts Codex subscription image edits with input images and edit action', async () => {
    const requests: Array<{ body: string }> = []
    const resultBase64 = png(8, 8).toString('base64')
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
      requests.push({ body: String(init?.body) })
      return new Response([
        `data: ${JSON.stringify({
          type: 'response.output_item.done',
          item: { type: 'image_generation_call', result: resultBase64 }
        })}`,
        'data: [DONE]'
      ].join('\n\n'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
    }))
    const client = new CodexResponsesImageClient('https://chatgpt.com/backend-api/codex', 'codex-access')

    const image = await client.edit({
      prompt: 'put basketball shoes on the character',
      model: 'gpt-image-2',
      images: [{ name: 'annotated.png', mimeType: 'image/png', data: png(16, 16) }],
      timeoutMs: 1_000,
      signal: new AbortController().signal
    })

    expect(image).toMatchObject({ mimeType: 'image/png' })
    expect(requests).toHaveLength(1)
    const body = JSON.parse(requests[0].body)
    expect(body.input[0].content).toEqual([
      { type: 'input_text', text: 'put basketball shoes on the character' },
      {
        type: 'input_image',
        image_url: expect.stringMatching(/^data:image\/png;base64,/),
        detail: 'auto'
      }
    ])
    expect(body.tools[0]).toMatchObject({
      type: 'image_generation',
      action: 'edit',
      model: 'gpt-image-2'
    })
  })

  it('uses the latest Codex partial image when the final image item is absent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response([
      `data: ${JSON.stringify({
        type: 'response.image_generation_call.partial_image',
        partial_image_b64: png(8, 8).toString('base64')
      })}`,
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: { status: 'completed', output: [] }
      })}`,
      'data: [DONE]'
    ].join('\n\n'), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })))
    const client = new CodexResponsesImageClient('https://chatgpt.com/backend-api/codex', 'codex-access')

    const image = await client.generate({
      prompt: 'tiny square',
      model: 'gpt-image-2',
      timeoutMs: 1_000,
      signal: new AbortController().signal
    })

    expect(image).toMatchObject({ mimeType: 'image/png' })
    expect(image.data.byteLength).toBeGreaterThan(0)
  })

  it('retries Codex image requests when a deployment rejects preferred tool_choice shapes', async () => {
    const requests: string[] = []
    const resultBase64 = png(8, 8).toString('base64')
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
      requests.push(String(init?.body))
      if (requests.length === 1) {
        return new Response('Tool choice allowed_tools not found in tools parameter.', { status: 400 })
      }
      if (requests.length === 2) {
        return new Response([
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: { status: 'completed', output: [{ type: 'message', content: [] }] }
          })}`,
          'data: [DONE]'
        ].join('\n\n'), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' }
        })
      }
      return new Response([
        `data: ${JSON.stringify({
          type: 'response.output_item.done',
          item: { type: 'image_generation_call', result: resultBase64 }
        })}`,
        'data: [DONE]'
      ].join('\n\n'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
    }))
    const client = new CodexResponsesImageClient('https://chatgpt.com/backend-api/codex', 'codex-access')

    const image = await client.generate({
      prompt: 'tiny square',
      model: 'gpt-image-2',
      timeoutMs: 1_000,
      signal: new AbortController().signal
    })

    expect(image.data.byteLength).toBeGreaterThan(0)
    expect(requests).toHaveLength(3)
    expect(JSON.parse(requests[0]).tool_choice).toMatchObject({ type: 'allowed_tools' })
    expect(JSON.parse(requests[1]).tool_choice).toBe('required')
    expect(JSON.parse(requests[2]).tool_choice).toBeUndefined()
  })

  it('summarizes Codex responses that complete without image data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response([
      `data: ${JSON.stringify({
        type: 'response.output_text.delta',
        delta: 'I can help with that.'
      })}`,
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          status: 'completed',
          output: [{
            type: 'message',
            content: [{ type: 'output_text', text: 'I can help with that.' }]
          }]
        }
      })}`,
      'data: [DONE]'
    ].join('\n\n'), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })))
    const client = new CodexResponsesImageClient('https://chatgpt.com/backend-api/codex', 'codex-access')

    await expect(client.generate({
      prompt: 'tiny square',
      model: 'gpt-image-2',
      timeoutMs: 1_000,
      signal: new AbortController().signal
    })).rejects.toThrow(/events: response\.output_text\.delta, response\.completed; output: message; text: I can help with that/)
  })

  it('generates an image, saves it to the workspace, and scopes the attachment', async () => {
    const client = fakeClient()
    const store = attachmentStore(join(workspace, 'attachments'))
    const host = hostFor(client, store)

    const tools = await host.listTools(buildContext())
    expect(tools.map((tool) => tool.name)).toEqual(['generate_image'])

    const result = await host.execute({
      callId: 'call_1',
      toolName: 'generate_image',
      arguments: { prompt: 'a sunset over the sea', aspect_ratio: '16:9', image_size: '1K' }
    }, buildContext())

    expect(result.item).toMatchObject({ kind: 'tool_result', isError: false })
    if (result.item.kind !== 'tool_result') return
    const output = result.item.output as {
      files: Array<{ relativePath: string; absolutePath: string; mimeType: string; width: number; height: number }>
      attachments: Array<{ id: string; mimeType: string }>
      model: string
      size: string
      endpoint: string
      quality: string
      warnings: string[]
    }
    expect(output.endpoint).toBe('generations')
    expect(output.model).toBe('test-image-model')
    expect(output.size).toBe('1024x576')
    expect(output.quality).toBe('auto')
    expect(output.warnings).toEqual([])
    expect(output.files[0]).toMatchObject({ mimeType: 'image/png', width: 1024, height: 576 })
    expect(output.files[0].relativePath.startsWith('.deepseekgui-images/')).toBe(true)
    expect(existsSync(output.files[0].absolutePath)).toBe(true)
    expect(JSON.stringify(output)).not.toMatch(/base64|b64_json/)
    expect(client.generateCalls[0]).toMatchObject({
      prompt: 'a sunset over the sea',
      quality: 'auto',
      size: '1024x576'
    })

    expect(output.attachments).toHaveLength(1)
    const id = output.attachments[0].id
    await expect(store.resolveContent(id, { threadId: 'thr_1' })).resolves.toMatchObject({ mimeType: 'image/png' })
    await expect(store.resolveContent(id, { threadId: 'thr_other' })).rejects.toThrow(/not authorized/)
  })

  it('uses the configured default resolution unless the user explicitly overrides it', async () => {
    const client = fakeClient()
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(
        buildImageGenToolProviders(imageGenConfig({ defaultResolution: '2K' }), {
          client,
          nowIso: () => '2026-06-10T00:00:00.000Z'
        }).providers
      )
    })

    await host.execute({
      callId: 'call_default_resolution',
      toolName: 'generate_image',
      arguments: { prompt: 'wide landscape', aspect_ratio: '16:9' }
    }, buildContext())
    await host.execute({
      callId: 'call_explicit_resolution',
      toolName: 'generate_image',
      arguments: { prompt: 'smaller wide landscape', aspect_ratio: '16:9', image_size: '1K' }
    }, buildContext())

    expect(client.generateCalls[0]).toMatchObject({ size: '2048x1152' })
    expect(client.generateCalls[1]).toMatchObject({ size: '1024x576' })
  })

  it('lets the provider choose dimensions when default resolution is auto and no ratio is requested', async () => {
    const client = fakeClient()
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(
        buildImageGenToolProviders(imageGenConfig({ defaultResolution: 'auto' }), {
          client,
          nowIso: () => '2026-06-10T00:00:00.000Z'
        }).providers
      )
    })

    await host.execute({
      callId: 'call_auto_resolution',
      toolName: 'generate_image',
      arguments: { prompt: 'provider-sized image' }
    }, buildContext())

    expect(client.generateCalls[0]).not.toHaveProperty('size')
  })

  it('rejects generated-image writes through an escaping workspace symlink', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'kun-imagegen-outside-'))
    try {
      await symlink(outside, join(workspace, '.deepseekgui-images'), process.platform === 'win32' ? 'junction' : 'dir')
      const client = fakeClient()
      const host = hostFor(client)

      const result = await host.execute({
        callId: 'call_escape',
        toolName: 'generate_image',
        arguments: { prompt: 'must stay in workspace' }
      }, { ...buildContext(), sandboxMode: 'workspace-write' })

      expect(result.item).toMatchObject({ kind: 'tool_result', isError: true })
      expect(JSON.stringify(result.item)).toContain('workspace_path_escape')
      expect(client.generateCalls).toHaveLength(1)
      await expect(readdir(outside)).resolves.toEqual([])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('does not read a reference image through an escaping workspace symlink', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'kun-imagegen-reference-outside-'))
    try {
      await mkdir(join(workspace, 'refs'))
      await writeFile(join(outside, 'secret.png'), png(8, 8))
      await symlink(join(outside, 'secret.png'), join(workspace, 'refs', 'linked.png'), 'file')
      const client = fakeClient()
      const host = hostFor(client)

      const result = await host.execute({
        callId: 'call_reference_escape',
        toolName: 'generate_image',
        arguments: { prompt: 'use reference', reference_image_paths: ['refs/linked.png'] }
      }, { ...buildContext(), sandboxMode: 'workspace-write' })

      expect(result.item).toMatchObject({ kind: 'tool_result', isError: true })
      expect(JSON.stringify(result.item)).toContain('invalid_reference_path')
      expect(client.generateCalls).toHaveLength(0)
      expect(client.editCalls).toHaveLength(0)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('passes configured image quality through tool execution', async () => {
    const client = fakeClient()
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(
        buildImageGenToolProviders(imageGenConfig({ quality: 'high', defaultResolution: '2K' }), {
          client,
          nowIso: () => '2026-06-10T00:00:00.000Z'
        }).providers
      )
    })

    const result = await host.execute({
      callId: 'call_1',
      toolName: 'generate_image',
      arguments: { prompt: 'a detailed product render' }
    }, buildContext())

    expect(result.item).toMatchObject({ kind: 'tool_result', isError: false })
    if (result.item.kind !== 'tool_result') return
    expect(result.item.output).toMatchObject({ quality: 'high' })
    expect(client.generateCalls[0]).toMatchObject({ quality: 'high', size: '2048x2048' })
  })

  it('posts generations as JSON and decodes b64_json responses', async () => {
    const requests: Array<{ url: string; body: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      requests.push({ url: String(url), body: String(init?.body) })
      return new Response(JSON.stringify({ data: [{ b64_json: png(8, 8).toString('base64') }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }))
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildImageGenToolProviders(imageGenConfig()).providers)
    })

    const result = await host.execute({
      callId: 'call_1',
      toolName: 'generate_image',
      arguments: { prompt: 'tiny square' }
    }, buildContext())

    expect(result.item).toMatchObject({ kind: 'tool_result', isError: false })
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('https://images.example.test/v1/images/generations')
    expect(JSON.parse(requests[0].body)).toMatchObject({
      model: 'test-image-model',
      prompt: 'tiny square',
      n: 1,
      response_format: 'b64_json'
    })
    expect(JSON.parse(requests[0].body).quality).toBeUndefined()
  })

  it('sends OpenAI-compatible quality when configured and retries without it if rejected', async () => {
    const requests: Array<{ url: string; body: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      requests.push({ url: String(url), body: String(init?.body) })
      if (requests.length === 1) {
        return new Response(JSON.stringify({ error: { message: 'Unknown parameter: quality' } }), { status: 400 })
      }
      return new Response(JSON.stringify({ data: [{ b64_json: png(8, 8).toString('base64') }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }))
    const client = new OpenAiCompatImageClient('https://images.example.test/v1', 'sk-test')

    const image = await client.generate({
      prompt: 'high fidelity icon',
      model: 'gpt-image-2',
      quality: 'high',
      timeoutMs: 1_000,
      signal: new AbortController().signal
    })

    expect(image).toMatchObject({ mimeType: 'image/png' })
    expect(requests).toHaveLength(2)
    expect(JSON.parse(requests[0].body)).toMatchObject({
      model: 'gpt-image-2',
      prompt: 'high fidelity icon',
      quality: 'high',
      response_format: 'b64_json'
    })
    expect(JSON.parse(requests[1].body).quality).toBeUndefined()
    expect(JSON.parse(requests[1].body).response_format).toBe('b64_json')
  })

  it('downloads url responses and retries once without response_format when rejected', async () => {
    let posts = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url)
      if (href.endsWith('/images/generations')) {
        posts += 1
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        if (posts === 1) {
          expect(body.response_format).toBe('b64_json')
          return new Response(JSON.stringify({ error: { message: 'Unknown parameter: response_format' } }), { status: 400 })
        }
        expect(body.response_format).toBeUndefined()
        return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example.test/img.png' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      expect(href).toBe('https://cdn.example.test/img.png')
      return new Response(new Uint8Array(png(8, 8)), { status: 200, headers: { 'content-type': 'image/png' } })
    }))
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildImageGenToolProviders(imageGenConfig()).providers)
    })

    const result = await host.execute({
      callId: 'call_1',
      toolName: 'generate_image',
      arguments: { prompt: 'legacy provider' }
    }, buildContext())

    expect(result.item).toMatchObject({ kind: 'tool_result', isError: false })
    expect(posts).toBe(2)
  })

  it('sends reference images as multipart form data to /images/edits', async () => {
    await writeFile(join(workspace, 'ref.png'), png(16, 16))
    await writeFile(join(workspace, 'ref2.png'), png(16, 16))
    const captured: Array<{ url: string; body: FormData }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      captured.push({ url: String(url), body: init?.body as FormData })
      return new Response(JSON.stringify({ data: [{ b64_json: png(8, 8).toString('base64') }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }))
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildImageGenToolProviders(imageGenConfig()).providers)
    })

    const single = await host.execute({
      callId: 'call_1',
      toolName: 'generate_image',
      arguments: { prompt: 'restyle', reference_image_paths: ['ref.png'] }
    }, buildContext())
    expect(single.item).toMatchObject({ kind: 'tool_result', isError: false })
    if (single.item.kind === 'tool_result') {
      expect((single.item.output as { endpoint: string }).endpoint).toBe('edits')
    }
    expect(captured[0].url).toBe('https://images.example.test/v1/images/edits')
    expect(captured[0].body).toBeInstanceOf(FormData)
    expect(captured[0].body.get('prompt')).toBe('restyle')
    expect(captured[0].body.get('model')).toBe('test-image-model')
    expect(captured[0].body.get('image')).toBeInstanceOf(Blob)
    expect(captured[0].body.getAll('image[]')).toHaveLength(0)

    const multi = await host.execute({
      callId: 'call_2',
      toolName: 'generate_image',
      arguments: { prompt: 'restyle', reference_image_paths: ['ref.png', 'ref2.png'] }
    }, buildContext())
    expect(multi.item).toMatchObject({ kind: 'tool_result', isError: false })
    expect(captured[1].body.getAll('image[]')).toHaveLength(2)
  })

  it('allowlists only real-edit protocols in protocolSupportsImageEdit', () => {
    expect(protocolSupportsImageEdit('openai-images')).toBe(true)
    expect(protocolSupportsImageEdit('codex-responses-image')).toBe(true)
    expect(protocolSupportsImageEdit(undefined)).toBe(true)
    expect(protocolSupportsImageEdit('minimax-image')).toBe(false)
    expect(protocolSupportsImageEdit('grok-imagine-image')).toBe(false)
  })

  it('returns edits_unsupported BEFORE any network call when references are passed on a non-edit protocol (MiniMax)', async () => {
    await writeFile(join(workspace, 'ref.png'), png(16, 16))
    const client = fakeClient()
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(
        buildImageGenToolProviders(imageGenConfig({ protocol: 'minimax-image' }), { client }).providers
      )
    })
    const result = await host.execute({
      callId: 'call_edit',
      toolName: 'generate_image',
      arguments: { prompt: 'restyle this', reference_image_paths: ['ref.png'] }
    }, buildContext())
    expect(result.item).toMatchObject({ kind: 'tool_result', isError: true })
    if (result.item.kind === 'tool_result') {
      expect((result.item.output as { error?: { code?: string } }).error?.code).toBe('edits_unsupported')
    }
    expect(client.editCalls).toHaveLength(0) // never reached the provider
  })

  it('does not advertise image-to-image (reference_image_paths) on a non-edit protocol', async () => {
    const minimaxTools = await new LocalToolHost({
      registry: new CapabilityRegistry(buildImageGenToolProviders(imageGenConfig({ protocol: 'minimax-image' })).providers)
    }).listTools(buildContext())
    const minimaxTool = minimaxTools.find((tool) => tool.name === 'generate_image')!
    expect(minimaxTool.description).not.toContain('image-to-image')
    expect((minimaxTool.inputSchema.properties as Record<string, unknown>)).not.toHaveProperty('reference_image_paths')

    const openaiTools = await new LocalToolHost({
      registry: new CapabilityRegistry(buildImageGenToolProviders(imageGenConfig()).providers)
    }).listTools(buildContext())
    const openaiTool = openaiTools.find((tool) => tool.name === 'generate_image')!
    expect(openaiTool.description).toContain('image-to-image')
    expect((openaiTool.inputSchema.properties as Record<string, unknown>)).toHaveProperty('reference_image_paths')

    const codexTools = await new LocalToolHost({
      registry: new CapabilityRegistry(
        buildImageGenToolProviders(imageGenConfig({ protocol: 'codex-responses-image' })).providers
      )
    }).listTools(buildContext())
    const codexTool = codexTools.find((tool) => tool.name === 'generate_image')!
    expect(codexTool.description).toContain('image-to-image')
    expect((codexTool.inputSchema.properties as Record<string, unknown>)).toHaveProperty('reference_image_paths')
  })

  it('rejects reference paths that escape the workspace or are not images', async () => {
    const client = fakeClient()
    const host = hostFor(client)

    for (const badPath of ['../outside.png', '/etc/hosts']) {
      const result = await host.execute({
        callId: 'call_1',
        toolName: 'generate_image',
        arguments: { prompt: 'escape', reference_image_paths: [badPath] }
      }, buildContext())
      expect(result.item).toMatchObject({ kind: 'tool_result', isError: true })
      if (result.item.kind === 'tool_result') {
        expect(result.item.output).toMatchObject({ error: { code: 'invalid_reference_path' } })
      }
    }

    const missing = await host.execute({
      callId: 'call_2',
      toolName: 'generate_image',
      arguments: { prompt: 'missing', reference_image_paths: ['nope.png'] }
    }, buildContext())
    expect(missing.item).toMatchObject({ kind: 'tool_result', isError: true })

    await writeFile(join(workspace, 'notes.txt'), 'plain text')
    const wrongType = await host.execute({
      callId: 'call_3',
      toolName: 'generate_image',
      arguments: { prompt: 'wrong type', reference_image_paths: ['notes.txt'] }
    }, buildContext())
    expect(wrongType.item).toMatchObject({ kind: 'tool_result', isError: true })
    if (wrongType.item.kind === 'tool_result') {
      expect(wrongType.item.output).toMatchObject({
        error: { code: 'invalid_reference_path', message: expect.stringContaining('png, jpeg, or webp') }
      })
    }
    expect(client.editCalls).toHaveLength(0)
  })

  it('maps 404 from /images/edits to an actionable edits_unsupported error', async () => {
    await writeFile(join(workspace, 'ref.png'), png(16, 16))
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Not Found', { status: 404 })))
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildImageGenToolProviders(imageGenConfig()).providers)
    })

    const result = await host.execute({
      callId: 'call_1',
      toolName: 'generate_image',
      arguments: { prompt: 'restyle', reference_image_paths: ['ref.png'] }
    }, buildContext())

    expect(result.item).toMatchObject({ kind: 'tool_result', isError: true })
    if (result.item.kind === 'tool_result') {
      expect(result.item.output).toMatchObject({
        error: {
          code: 'edits_unsupported',
          message: expect.stringContaining('reference image edits; retry generate_image without reference_image_paths')
        }
      })
    }
  })

  it('keeps the full provider HTTP error body in image generation errors', async () => {
    const providerMessage = `Not supported model ${'mimo-v2.5-pro-ultraspeed'.repeat(40)}`
    const body = JSON.stringify({ error: { code: '400', message: providerMessage } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 400 })))
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildImageGenToolProviders(imageGenConfig()).providers)
    })

    const result = await host.execute({
      callId: 'call_1',
      toolName: 'generate_image',
      arguments: { prompt: 'draw a poster' }
    }, buildContext())

    expect(result.item).toMatchObject({ kind: 'tool_result', isError: true })
    if (result.item.kind === 'tool_result') {
      const output = result.item.output as { error: { message: string } }
      expect(output.error.message).toBe(`HTTP 400: ${body}`)
      expect(output.error.message).toContain(providerMessage)
    }
  })

  it('keeps the generated file and degrades to a warning when the attachment store rejects', async () => {
    const client = fakeClient()
    const store = attachmentStore(join(workspace, 'attachments'), { maxImageBytes: 16 })
    const host = hostFor(client, store)

    const result = await host.execute({
      callId: 'call_1',
      toolName: 'generate_image',
      arguments: { prompt: 'too large for previews' }
    }, buildContext())

    expect(result.item).toMatchObject({ kind: 'tool_result', isError: false })
    if (result.item.kind !== 'tool_result') return
    const output = result.item.output as { files: Array<{ absolutePath: string }>; attachments: unknown[]; warnings: string[] }
    expect(output.files).toHaveLength(1)
    expect(existsSync(output.files[0].absolutePath)).toBe(true)
    expect(output.attachments).toEqual([])
    expect(output.warnings[0]).toMatch(/inline preview unavailable/)
  })

  it('reports image generation availability in the runtime capability manifest', () => {
    const config = KunCapabilitiesConfig.parse({
      imageGen: {
        enabled: true,
        baseUrl: 'https://images.example.test/v1',
        apiKey: 'sk-test',
        model: 'test-image-model'
      }
    })
    const built = buildImageGenToolProviders(config.imageGen, { client: fakeClient() })
    const manifest = buildRuntimeCapabilityManifest({
      config,
      model: modelCapabilitiesForModel('deepseek-chat'),
      imageGen: { available: built.available }
    })

    expect(manifest.imageGen.available).toBe(true)
    expect(manifest.imageGen.model).toBe('test-image-model')
  })
})

function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24)
  buffer[0] = 0x89
  buffer[1] = 0x50
  buffer[2] = 0x4e
  buffer[3] = 0x47
  buffer[4] = 0x0d
  buffer[5] = 0x0a
  buffer[6] = 0x1a
  buffer[7] = 0x0a
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}
