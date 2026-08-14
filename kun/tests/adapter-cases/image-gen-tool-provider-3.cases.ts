import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'

import { existsSync } from 'node:fs'

import { tmpdir } from 'node:os'

import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CapabilityRegistry } from '../../src/adapters/tool/capability-registry.js'

import { LocalToolHost } from '../../src/adapters/tool/local-tool-host.js'

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
  VolcengineArkImageClient,
  volcengineArkImageUrl,
  type ImageGenClient
} from '../../src/adapters/tool/image-gen-tool-provider.js'

import { FileAttachmentStore } from '../../src/attachments/attachment-store.js'

import {
  buildRuntimeCapabilityManifest,
  KunCapabilitiesConfig
} from '../../src/contracts/capabilities.js'

import { modelCapabilitiesForModel } from '../../src/loop/model-context-profile.js'

import type { ToolHostContext } from '../../src/ports/tool-host.js'

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

describe('Image gen tool provider', () => {

beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'kun-imagegen-'))
  })

afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(workspace, { recursive: true, force: true })
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

it('resolves the current Registry credential for every provider-backed image request', async () => {
    const authorization: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
      authorization.push(new Headers(init?.headers).get('authorization') ?? '')
      return new Response(JSON.stringify({ data: [{ b64_json: png(8, 8).toString('base64') }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }))
    let currentCredential = 'generation-a'
    const resolveCredential = vi.fn(async () => ({ apiKey: currentCredential }))
    const config = imageGenConfig({
      providerId: 'registry-images',
      apiKey: undefined
    })
    const built = buildImageGenToolProviders(config, { resolveCredential })
    const host = new LocalToolHost({ registry: new CapabilityRegistry(built.providers) })

    expect(built.available).toBe(true)
    await host.execute({
      callId: 'call_generation_a',
      toolName: 'generate_image',
      arguments: { prompt: 'first' }
    }, buildContext())
    currentCredential = 'generation-b'
    await host.execute({
      callId: 'call_generation_b',
      toolName: 'generate_image',
      arguments: { prompt: 'second' }
    }, buildContext())

    expect(resolveCredential).toHaveBeenNthCalledWith(1, 'registry-images')
    expect(resolveCredential).toHaveBeenNthCalledWith(2, 'registry-images')
    expect(authorization).toEqual(['Bearer generation-a', 'Bearer generation-b'])
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
    expect(protocolSupportsImageEdit('volcengine-ark-image')).toBe(true)
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
    expect((minimaxTool.inputSchema.properties as Record<string, unknown>)).not.toHaveProperty('reference_attachment_ids')

    const openaiTools = await new LocalToolHost({
      registry: new CapabilityRegistry(buildImageGenToolProviders(imageGenConfig()).providers)
    }).listTools(buildContext())
    const openaiTool = openaiTools.find((tool) => tool.name === 'generate_image')!
    expect(openaiTool.description).toContain('image-to-image')
    expect((openaiTool.inputSchema.properties as Record<string, unknown>)).toHaveProperty('reference_image_paths')
    expect((openaiTool.inputSchema.properties as Record<string, unknown>)).toHaveProperty('reference_attachment_ids')

    const codexTools = await new LocalToolHost({
      registry: new CapabilityRegistry(
        buildImageGenToolProviders(imageGenConfig({ protocol: 'codex-responses-image' })).providers
      )
    }).listTools(buildContext())
    const codexTool = codexTools.find((tool) => tool.name === 'generate_image')!
    expect(codexTool.description).toContain('image-to-image')
    expect((codexTool.inputSchema.properties as Record<string, unknown>)).toHaveProperty('reference_image_paths')
    expect((codexTool.inputSchema.properties as Record<string, unknown>)).toHaveProperty('reference_attachment_ids')
  })

it('edits directly from an authorized attachment and reports the actual mode', async () => {
    const client = fakeClient()
    const attachmentStoreInstance = attachmentStore(join(workspace, 'attachments'))
    const bytes = png(17, 19)
    const attachment = await attachmentStoreInstance.create({
      name: 'clipboard.png',
      data: bytes,
      mimeType: 'image/png',
      threadId: 'thr_1',
      workspace
    })
    const host = hostFor(client, attachmentStoreInstance)

    const result = await host.execute({
      callId: 'call_attachment_edit',
      toolName: 'generate_image',
      arguments: { prompt: 'preserve layout', reference_attachment_ids: [attachment.id] }
    }, buildContext())

    expect(result.item).toMatchObject({ kind: 'tool_result', isError: false })
    if (result.item.kind !== 'tool_result') return
    expect(result.item.output).toMatchObject({
      endpoint: 'edits', mode: 'edit', referenceImageCount: 1
    })
    expect(client.generateCalls).toHaveLength(0)
    expect(client.editCalls).toHaveLength(1)
    const request = client.editCalls[0] as { images: Array<{ name: string; data: Buffer }> }
    expect(request.images[0].name).toBe('clipboard.png')
    expect(request.images[0].data.equals(bytes)).toBe(true)
  })

it('applies the reference limit across paths and attachment IDs', async () => {
    await writeFile(join(workspace, 'ref.png'), png(8, 8))
    const client = fakeClient()
    const attachmentStoreInstance = attachmentStore(join(workspace, 'attachments'))
    const attachment = await attachmentStoreInstance.create({
      name: 'attached.png', data: png(8, 8), mimeType: 'image/png',
      threadId: 'thr_1', workspace
    })
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildImageGenToolProviders(
        imageGenConfig({ maxReferenceImages: 1 }),
        { client, attachmentStore: attachmentStoreInstance }
      ).providers)
    })

    const result = await host.execute({
      callId: 'call_reference_limit',
      toolName: 'generate_image',
      arguments: {
        prompt: 'too many',
        reference_image_paths: ['ref.png'],
        reference_attachment_ids: [attachment.id]
      }
    }, buildContext())

    expect(result.item).toMatchObject({ kind: 'tool_result', isError: true })
    expect(JSON.stringify(result.item)).toContain('invalid_reference_count')
    expect(client.generateCalls).toHaveLength(0)
    expect(client.editCalls).toHaveLength(0)
  })

it('rejects missing, unauthorized, non-image, and oversized reference attachments', async () => {
    const client = fakeClient()
    const attachmentStoreInstance = attachmentStore(join(workspace, 'attachments'), {
      maxImageBytes: 12 * 1024 * 1024
    })
    const unauthorized = await attachmentStoreInstance.create({
      name: 'private.png', data: png(8, 8), mimeType: 'image/png', threadId: 'other_thread'
    })
    const notImage = await attachmentStoreInstance.create({
      name: 'notes.txt', data: Buffer.from('not an image'), mimeType: 'text/plain', threadId: 'thr_1'
    })
    const oversized = await attachmentStoreInstance.create({
      name: 'large.png',
      data: Buffer.concat([png(8, 8), Buffer.alloc(10 * 1024 * 1024)]),
      mimeType: 'image/png',
      threadId: 'thr_1'
    })
    const host = hostFor(client, attachmentStoreInstance)

    for (const id of [
      'att_000000000000000000000000',
      unauthorized.id,
      notImage.id,
      oversized.id
    ]) {
      const result = await host.execute({
        callId: `call_${id}`,
        toolName: 'generate_image',
        arguments: { prompt: 'invalid ref', reference_attachment_ids: [id] }
      }, buildContext())
      expect(result.item).toMatchObject({ kind: 'tool_result', isError: true })
      expect(JSON.stringify(result.item)).toContain('invalid_reference_attachment')
    }
    expect(client.generateCalls).toHaveLength(0)
    expect(client.editCalls).toHaveLength(0)
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
      imageGen: { available: built.available, supportsReferenceEdit: true }
    })

    expect(manifest.imageGen.available).toBe(true)
    expect(manifest.imageGen.model).toBe('test-image-model')
    expect(manifest.imageGen.supportsReferenceEdit).toBe(true)
  })

})
