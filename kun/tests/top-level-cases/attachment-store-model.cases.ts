import { createHash } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileAttachmentStore } from '../../src/attachments/attachment-store.js'
import { CompatModelClient } from '../../src/adapters/model/compat-model-client.js'
import {
  KunCapabilitiesConfig,
  type AttachmentsCapabilityConfig,
  type ModelCapabilityMetadata
} from '../../src/contracts/capabilities.js'
import { modelCapabilitiesForModel } from '../../src/loop/model-context-profile.js'
import type { ModelClient, ModelRequest } from '../../src/ports/model-client.js'
import type { LocalTool } from '../../src/adapters/tool/local-tool-host.js'
import { dispatchRequest } from '../../src/server/http-server.js'
import {
  _internal as attachmentRouteInternal,
  MAX_ATTACHMENT_UPLOAD_BODY_BYTES
} from '../../src/server/routes/attachments.js'
import { bootstrapThread, makeHarness } from '../loop-test-harness.js'
import { buildHarness, readJson } from '../http-server-test-harness.js'
import { generateImageTool, png, visionCapabilities } from '../support/attachment-store-fixtures.js'

describe('Attachment store and multimodal input', () => {
  let dir = ''

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kun-attachments-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('resolves image attachments for vision models and text fallbacks for text-only models', async () => {
    const store = createStore()
    const workspace = join(dir, 'workspace')
    const localFilePath = join(workspace, 'assets', 'shot.png')
    const attachment = await store.create({
      name: 'shot.png',
      data: png(1, 1),
      localFilePath,
      threadId: 'thr_1',
      workspace
    })
    const seenRequests: ModelRequest[] = []
    const model: ModelClient = {
      provider: 'fake',
      model: 'fake',
      async *stream(request) {
        seenRequests.push(request)
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }
    const h = makeHarness(model, {
      attachmentStore: store,
      modelCapabilities: () => visionCapabilities(),
      tools: [generateImageTool()]
    })
    await bootstrapThread(h, {
      workspace,
      request: { prompt: 'look', attachmentIds: [attachment.id], model: 'vision-model' }
    })

    await h.loop.runTurn(h.threadId, h.turnId)

    expect(seenRequests.at(-1)?.attachments?.[0]).toMatchObject({
      id: attachment.id,
      mimeType: 'image/png',
      dataBase64: expect.any(String),
      localFilePath
    })
    expect(seenRequests.at(-1)?.contextInstructions?.join('\n')).toContain('reference_image_paths')
    expect(seenRequests.at(-1)?.contextInstructions?.join('\n')).toContain('assets/shot.png')

    const textOnly = makeHarness(model, {
      attachmentStore: store,
      modelCapabilities: () => ({ ...visionCapabilities(), inputModalities: ['text'] })
    })
    await bootstrapThread(textOnly, {
      workspace,
      request: { prompt: 'look', attachmentIds: [attachment.id], model: 'text-only' }
    })
    expect(await textOnly.loop.runTurn(textOnly.threadId, textOnly.turnId)).toBe('completed')
    expect(seenRequests.at(-1)?.attachments).toBeUndefined()
    expect(seenRequests.at(-1)?.attachmentTextFallbacks?.[0]).toMatchObject({
      id: attachment.id,
      mimeType: 'image/png',
      dataBase64: expect.any(String),
      localFilePath,
      wasCompressed: false
    })
    expect(seenRequests.at(-1)?.contextInstructions?.join('\n') ?? '').not.toContain('reference_image_paths')
  })

  it('does not expose image reference paths outside the active workspace', async () => {
    const store = createStore()
    const workspace = join(dir, 'workspace')
    const localFilePath = join(dir, 'outside', 'secret.png')
    const attachment = await store.create({
      name: 'secret.png',
      data: png(1, 1),
      localFilePath,
      threadId: 'thr_1',
      workspace
    })
    const seenRequests: ModelRequest[] = []
    const model: ModelClient = {
      provider: 'fake',
      model: 'fake',
      async *stream(request) {
        seenRequests.push(request)
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }
    const h = makeHarness(model, {
      attachmentStore: store,
      modelCapabilities: () => visionCapabilities(),
      tools: [generateImageTool()]
    })
    await bootstrapThread(h, {
      workspace,
      request: { prompt: 'look', attachmentIds: [attachment.id], model: 'vision-model' }
    })

    expect(await h.loop.runTurn(h.threadId, h.turnId)).toBe('completed')
    const instructions = seenRequests.at(-1)?.contextInstructions?.join('\n') ?? ''
    expect(instructions).toContain(`attachment ID ${attachment.id}`)
    expect(instructions).toContain('reference_attachment_ids')
    expect(instructions).not.toContain(localFilePath)
  })

  it('routes built-in DeepSeek v4 image attachments as text fallbacks', async () => {
    const store = createStore()
    const attachment = await store.create({
      name: 'shot.png',
      data: png(1, 1),
      localFilePath: '/tmp/picked/shot.png',
      threadId: 'thr_1',
      workspace: '/tmp/ws'
    })
    const seenRequests: ModelRequest[] = []
    const model: ModelClient = {
      provider: 'fake',
      model: 'fake',
      async *stream(request) {
        seenRequests.push(request)
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }
    const h = makeHarness(model, {
      attachmentStore: store,
      modelCapabilities: modelCapabilitiesForModel
    })
    await bootstrapThread(h, {
      workspace: '/tmp/ws',
      request: { prompt: 'look', attachmentIds: [attachment.id], model: 'deepseek-v4-pro' }
    })

    expect(await h.loop.runTurn(h.threadId, h.turnId)).toBe('completed')
    const userItem = (await h.sessionStore.loadItems(h.threadId))
      .find((item) => item.kind === 'user_message')
    expect(userItem).toMatchObject({ attachmentIds: [attachment.id] })
    await expect(h.turns.getTurn(h.threadId, h.turnId)).resolves.toMatchObject({
      attachmentIds: [attachment.id]
    })
    expect(seenRequests.at(-1)?.attachments).toBeUndefined()
    expect(seenRequests.at(-1)?.attachmentTextFallbacks?.[0]).toMatchObject({
      id: attachment.id,
      mimeType: 'image/png',
      dataBase64: expect.any(String),
      localFilePath: '/tmp/picked/shot.png',
      wasCompressed: false
    })
    const preSend = (await h.sessionStore.loadEventsSince(h.threadId, 0))
      .find((event): event is Extract<typeof event, { kind: 'pipeline_stage' }> =>
        event.kind === 'pipeline_stage' && event.stage === 'pre_send'
      )
    expect(preSend?.details).toMatchObject({
      attachmentIds: [attachment.id],
      modelInputModalities: ['text'],
      modelMessageParts: ['text'],
      imageAttachmentCount: 0,
      imageAttachmentBase64Bytes: 0,
      textFallbackCount: 1,
      textFallbackBase64Bytes: png(1, 1).toString('base64').length,
      textFallbackMimeTypes: ['image/png']
    })
  })

  it('fails text-only image turns when no bounded text fallback is available', async () => {
    const store = createStore({ textFallbackMaxBase64Bytes: 8 })
    const attachment = await store.create({
      name: 'shot.png',
      data: png(1, 1),
      threadId: 'thr_1',
      workspace: '/tmp/ws'
    })
    const model: ModelClient = {
      provider: 'fake',
      model: 'fake',
      async *stream() {
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }
    const h = makeHarness(model, {
      attachmentStore: store,
      modelCapabilities: () => ({ ...visionCapabilities(), inputModalities: ['text'] })
    })
    await bootstrapThread(h, {
      workspace: '/tmp/ws',
      request: { prompt: 'look', attachmentIds: [attachment.id], model: 'text-only' }
    })

    expect(await h.loop.runTurn(h.threadId, h.turnId)).toBe('failed')
    await expect(h.turns.getTurn(h.threadId, h.turnId)).resolves.toMatchObject({
      error: expect.stringMatching(/missing a compressed text fallback/)
    })
  })

  it('maps image attachments to DeepSeek-compatible message parts', async () => {
    let body: { messages?: Array<{ role: string; content: unknown }> } | undefined
    const client = new CompatModelClient({
      baseUrl: 'https://model.example.test',
      apiKey: '',
      model: 'vision-model',
      nonStreaming: true,
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body))
        return new Response(JSON.stringify({
          id: 'cmpl_1',
          model: 'vision-model',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }]
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
    })

    for await (const _chunk of client.stream({
      threadId: 'thr_1',
      turnId: 'turn_1',
      model: 'vision-model',
      prefix: [],
      history: [{
        id: 'item_user',
        threadId: 'thr_1',
        turnId: 'turn_1',
        role: 'user',
        status: 'completed',
        createdAt: 'now',
        finishedAt: 'now',
        kind: 'user_message',
        text: 'describe'
      }],
      attachments: [{
        id: 'att_1',
        name: 'shot.png',
        mimeType: 'image/png',
        dataBase64: png(1, 1).toString('base64')
      }],
      tools: [],
      abortSignal: new AbortController().signal
    })) {
      // drain stream
    }

    expect(body?.messages?.[0]?.content).toEqual([
      { type: 'text', text: 'describe' },
      { type: 'image_url', image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) } }
    ])
  })

  it('maps text attachment fallbacks to structured DeepSeek-compatible user text', async () => {
    let body: { messages?: Array<{ role: string; content: unknown }> } | undefined
    const client = new CompatModelClient({
      baseUrl: 'https://model.example.test',
      apiKey: '',
      model: 'text-model',
      nonStreaming: true,
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body))
        return new Response(JSON.stringify({
          id: 'cmpl_1',
          model: 'text-model',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }]
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
    })

    for await (const _chunk of client.stream({
      threadId: 'thr_1',
      turnId: 'turn_1',
      model: 'text-model',
      prefix: [],
      history: [{
        id: 'item_user',
        threadId: 'thr_1',
        turnId: 'turn_1',
        role: 'user',
        status: 'completed',
        createdAt: 'now',
        finishedAt: 'now',
        kind: 'user_message',
        text: 'describe'
      }],
      attachmentTextFallbacks: [{
        id: 'att_1',
        name: 'shot.png',
        mimeType: 'image/webp',
        dataBase64: 'YWJj',
        byteSize: 3,
        width: 1280,
        height: 720,
        localFilePath: '/tmp/picked/shot.png',
        wasCompressed: true
      }],
      tools: [],
      abortSignal: new AbortController().signal
    })) {
      // drain stream
    }

    expect(body?.messages?.[0]?.content).toContain('describe')
    expect(body?.messages?.[0]?.content).toContain('[Attached image as base64 text]')
    expect(body?.messages?.[0]?.content).toContain('FilePath: /tmp/picked/shot.png')
    expect(body?.messages?.[0]?.content).toContain('MIME: image/webp')
    expect(body?.messages?.[0]?.content).toContain('Dimensions: 1280x720')
    expect(body?.messages?.[0]?.content).toContain('```base64\nYWJj\n```')
  })

  it('stores PDF document attachments with extracted text', async () => {
    const store = createStore()
    const doc = await store.create({
      name: 'spec.pdf',
      data: Buffer.from('%PDF-1.7\nbinary-body'),
      mimeType: 'application/pdf',
      documentText: 'Hello from the PDF body.',
      pageCount: 3,
      threadId: 'thr_1'
    })

    expect(doc).toMatchObject({
      kind: 'document',
      mimeType: 'application/pdf',
      documentText: 'Hello from the PDF body.',
      pageCount: 3
    })
    await expect(store.resolveContent(doc.id, { threadId: 'thr_1' })).resolves.toMatchObject({
      kind: 'document',
      documentText: 'Hello from the PDF body.'
    })
  })

  it('decodes and truncates text-like document attachments', async () => {
    const store = createStore({ maxDocumentTextChars: 5 })
    const doc = await store.create({
      name: 'notes.md',
      data: Buffer.from('\uFEFF0123456789', 'utf8'),
      mimeType: 'text/markdown',
      threadId: 'thr_1'
    })

    expect(doc).toMatchObject({
      kind: 'document',
      documentText: '01234',
      truncated: true
    })
  })

  it('rejects document attachments with disallowed MIME or missing extracted text', async () => {
    await expect(createStore().create({
      name: 'archive.zip',
      data: Buffer.from('PK\u0003\u0004nope'),
      mimeType: 'application/zip'
    })).rejects.toThrow(/unsupported attachment type/)

    await expect(createStore().create({
      name: 'scan.pdf',
      data: Buffer.from('%PDF-1.4 no extractable text'),
      mimeType: 'application/pdf'
    })).rejects.toThrow(/document text is required/)
  })

  it('injects document attachments into model requests as text context', async () => {
    const store = createStore()
    const doc = await store.create({
      name: 'spec.pdf',
      data: Buffer.from('%PDF-1.7 body'),
      mimeType: 'application/pdf',
      documentText: 'The deployment runbook lives here.',
      pageCount: 2,
      threadId: 'thr_1',
      workspace: '/tmp/ws'
    })
    const seenRequests: ModelRequest[] = []
    const model: ModelClient = {
      provider: 'fake',
      model: 'fake',
      async *stream(request) {
        seenRequests.push(request)
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }
    const h = makeHarness(model, {
      attachmentStore: store,
      modelCapabilities: () => ({ ...visionCapabilities(), inputModalities: ['text'] })
    })
    await bootstrapThread(h, {
      workspace: '/tmp/ws',
      request: { prompt: 'summarize', attachmentIds: [doc.id], model: 'text-only' }
    })

    expect(await h.loop.runTurn(h.threadId, h.turnId)).toBe('completed')
    expect(seenRequests.at(-1)?.attachments).toBeUndefined()
    expect(seenRequests.at(-1)?.attachmentDocuments?.[0]).toMatchObject({
      id: doc.id,
      mimeType: 'application/pdf',
      text: 'The deployment runbook lives here.',
      pageCount: 2
    })
  })

  it('formats document attachments as untrusted text for the model', async () => {
    let body: { messages?: Array<{ role: string; content: unknown }> } | undefined
    const client = new CompatModelClient({
      baseUrl: 'https://model.example.test',
      apiKey: '',
      model: 'text-model',
      nonStreaming: true,
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body))
        return new Response(JSON.stringify({
          id: 'cmpl_1',
          model: 'text-model',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }]
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
    })

    for await (const _chunk of client.stream({
      threadId: 'thr_1',
      turnId: 'turn_1',
      model: 'text-model',
      prefix: [],
      history: [{
        id: 'item_user',
        threadId: 'thr_1',
        turnId: 'turn_1',
        role: 'user',
        status: 'completed',
        createdAt: 'now',
        finishedAt: 'now',
        kind: 'user_message',
        text: 'summarize'
      }],
      attachmentDocuments: [{
        id: 'att_doc',
        name: 'spec.pdf',
        mimeType: 'application/pdf',
        text: 'Runbook contents.',
        byteSize: 42,
        pageCount: 2,
        localFilePath: '/tmp/picked/spec.pdf'
      }],
      tools: [],
      abortSignal: new AbortController().signal
    })) {
      // drain stream
    }

    const content = String(body?.messages?.[0]?.content ?? '')
    expect(content).toContain('[Attached document]')
    expect(content).toContain('Name: spec.pdf')
    expect(content).toContain('Pages: 2')
    expect(content).toContain('<untrusted-content source="document:spec.pdf">')
    expect(content).toContain('Runbook contents.')
  })

  function createStore(overrides: Partial<AttachmentsCapabilityConfig> = {}) {
    return new FileAttachmentStore({
      rootDir: join(dir, 'attachments'),
      config: attachmentConfig(overrides),
      nowIso: () => '2026-06-03T00:00:00.000Z'
    })
  }

  function attachmentConfig(overrides: Partial<AttachmentsCapabilityConfig> = {}) {
    return KunCapabilitiesConfig.parse({
      attachments: {
        enabled: true,
        ...overrides
      }
    }).attachments
  }
})
