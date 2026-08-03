import { createHash } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileAttachmentStore } from '../src/attachments/attachment-store.js'
import { CompatModelClient } from '../src/adapters/model/compat-model-client.js'
import {
  KunCapabilitiesConfig,
  type AttachmentsCapabilityConfig,
  type ModelCapabilityMetadata
} from '../src/contracts/capabilities.js'
import { modelCapabilitiesForModel } from '../src/loop/model-context-profile.js'
import type { ModelClient, ModelRequest } from '../src/ports/model-client.js'
import type { LocalTool } from '../src/adapters/tool/local-tool-host.js'
import { dispatchRequest } from '../src/server/http-server.js'
import {
  _internal as attachmentRouteInternal,
  MAX_ATTACHMENT_UPLOAD_BODY_BYTES
} from '../src/server/routes/attachments.js'
import { bootstrapThread, makeHarness } from './loop-test-harness.js'
import { buildHarness, readJson } from './http-server-test-harness.js'

describe('Attachment store and multimodal input', () => {
  let dir = ''

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kun-attachments-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('stores images outside session logs, deduplicates by hash, and enforces scope', async () => {
    const store = createStore()
    const data = png(2, 3)
    const first = await store.create({
      name: 'shot.png',
      data,
      mimeType: 'image/png',
      localFilePath: '/tmp/picked/shot.png',
      threadId: 'thr_1',
      workspace: '/tmp/ws'
    })
    const second = await store.create({
      name: 'shot-again.png',
      data,
      threadId: 'thr_1'
    })

    expect(second.id).toBe(first.id)
    expect(first).toMatchObject({
      mimeType: 'image/png',
      width: 2,
      height: 3,
      byteSize: data.byteLength,
      localFilePath: '/tmp/picked/shot.png'
    })
    await expect(store.resolveContent(first.id, { threadId: 'thr_2' })).rejects.toThrow(/not authorized/)
    await expect(store.resolveContent(first.id, { workspace: '/tmp/ws' })).resolves.toMatchObject({ id: first.id })
  })

  it('binds an authorized attachment to its final thread idempotently', async () => {
    const store = createStore()
    const attachment = await store.create({
      name: 'draft.png',
      data: png(2, 3),
      workspace: '/tmp/ws'
    })

    await store.bindScope(attachment.id, { threadId: 'thr_final', workspace: '/tmp/ws' })
    await store.bindScope(attachment.id, { threadId: 'thr_final', workspace: '/tmp/ws' })

    expect(await store.get(attachment.id)).toMatchObject({
      threadIds: ['thr_final'],
      workspaces: ['/tmp/ws']
    })
    await expect(store.resolveContent(attachment.id, { threadId: 'thr_final' }))
      .resolves.toMatchObject({ id: attachment.id })
  })

  it('does not bind an attachment from an unrelated scope', async () => {
    const store = createStore()
    const attachment = await store.create({
      name: 'private.png',
      data: png(2, 3),
      threadId: 'thr_owner',
      workspace: '/tmp/owner'
    })

    await expect(store.bindScope(attachment.id, {
      threadId: 'thr_attacker',
      workspace: '/tmp/other'
    })).rejects.toThrow(/not authorized/)
    expect(await store.get(attachment.id)).toMatchObject({
      threadIds: ['thr_owner'],
      workspaces: ['/tmp/owner']
    })
  })

  it('rejects invalid or missing attachment ids when binding scope', async () => {
    const store = createStore()
    await expect(store.bindScope('../outside', { threadId: 'thr_1' })).rejects.toThrow(/invalid attachment id/)
    await expect(store.bindScope('att_000000000000000000000000', { threadId: 'thr_1' }))
      .rejects.toThrow(/attachment not found/)
  })

  it('keeps attachment data and metadata private on disk', async () => {
    const store = createStore()
    const attachment = await store.create({ name: 'shot.png', data: png(2, 3), threadId: 'thr_1' })
    const root = join(dir, 'attachments')

    if (process.platform !== 'win32') {
      expect((await stat(root)).mode & 0o777).toBe(0o700)
      expect((await stat(join(root, `${attachment.id}.bin`))).mode & 0o777).toBe(0o600)
      expect((await stat(join(root, `${attachment.id}.json`))).mode & 0o777).toBe(0o600)
    }
  })

  it('keeps composer leases private, reference-counts duplicate uploads, and rejects foreign release ids', async () => {
    const store = createStore()
    const data = png(2, 4)
    const first = await store.create({
      name: 'first.png',
      data,
      leaseId: 'lease-client-a'
    })
    const second = await store.create({
      name: 'second.png',
      data,
      leaseId: 'lease-client-b'
    })

    expect(second.id).toBe(first.id)
    expect(JSON.stringify(first)).not.toContain('lease-client')
    expect(JSON.stringify(await store.get(first.id))).not.toContain('lease-client')
    expect(await store.releaseLease(first.id, 'lease-unknown-client', false)).toBe(false)
    expect(await store.get(first.id)).not.toBeNull()
    expect(await store.releaseLease(first.id, 'lease-client-a', false)).toBe(true)
    expect(await store.get(first.id)).not.toBeNull()
    expect(await store.releaseLease(first.id, 'lease-client-b', true)).toBe(true)
    expect(await store.get(first.id)).not.toBeNull()
  })

  it('deletes released or expired lease-managed uploads only when history does not reference them', async () => {
    const store = createStore()
    const released = await store.create({
      name: 'released.png',
      data: png(3, 4),
      leaseId: 'lease-released'
    })
    expect(await store.releaseLease(released.id, 'lease-released', false)).toBe(true)
    expect(await store.get(released.id)).toBeNull()

    const expired = await store.create({
      name: 'expired.png',
      data: png(4, 4),
      leaseId: 'lease-expired'
    })
    const referenced = await store.create({
      name: 'referenced.png',
      data: png(5, 4),
      leaseId: 'lease-referenced'
    })
    const pruned = await store.pruneExpiredLeases(
      new Set([referenced.id]),
      '2026-06-04T00:00:00.000Z'
    )

    expect(pruned).toEqual({ deleted: 1, released: 2 })
    expect(await store.get(expired.id)).toBeNull()
    expect(await store.get(referenced.id)).not.toBeNull()
  })

  it('repairs missing content when a duplicate attachment is uploaded again', async () => {
    const store = createStore()
    const data = png(2, 3)
    const first = await store.create({
      name: 'shot.png',
      data,
      threadId: 'thr_1'
    })
    await rm(join(dir, 'attachments', `${first.id}.bin`), { force: true })

    const second = await store.create({
      name: 'shot-again.png',
      data,
      threadId: 'thr_1'
    })

    expect(second.id).toBe(first.id)
    await expect(store.resolveContent(first.id, { threadId: 'thr_1' })).resolves.toMatchObject({
      id: first.id,
      data
    })
  })

  it('rejects attachment ids that could escape the store directory', async () => {
    const store = createStore()
    await expect(store.get('../outside')).resolves.toBeNull()
    await expect(store.resolveContent('..\\outside', {})).rejects.toThrow(/invalid attachment id/)
  })

  it('rejects unsupported MIME, size, and dimensions', async () => {
    await expect(createStore().create({
      name: 'bad.bin',
      data: Buffer.from('nope'),
      mimeType: 'application/octet-stream'
    })).rejects.toThrow(/unsupported/)

    await expect(createStore().create({
      name: 'spoofed.xlsx',
      data: Buffer.from('not a zip package'),
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      documentText: 'fake'
    })).rejects.toThrow(/unsupported/)

    await expect(createStore({ maxImageBytes: 10 }).create({
      name: 'large.png',
      data: png(1, 1)
    })).rejects.toThrow(/byte limit/)

    await expect(createStore({ maxImageDimension: 4 }).create({
      name: 'huge.png',
      data: png(5, 1)
    })).rejects.toThrow(/dimension/)

    await expect(createStore({ textFallbackMaxBase64Bytes: 4 }).create({
      name: 'fallback-large.png',
      data: png(1, 1),
      textFallback: {
        dataBase64: 'abcdefgh',
        mimeType: 'image/png',
        byteSize: 6,
        width: 1,
        height: 1
      }
    })).rejects.toThrow(/fallback image exceeds/)
  })

  it('stores Office semantics and visual previews while verifying the declared source hash', async () => {
    const store = createStore()
    const data = Buffer.from('PK\u0003\u0004 workbook fixture')
    const sourceSha256 = createHash('sha256').update(data).digest('hex')
    const preview = {
      dataBase64: Buffer.from('preview').toString('base64'),
      mimeType: 'image/webp',
      byteSize: 7,
      width: 800,
      height: 600,
      wasCompressed: true
    } as const

    const attachment = await store.create({
      name: 'book.xlsx',
      data,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      documentText: 'Sheet1\nA1 = 42',
      documentFormat: 'xlsx',
      sourceSha256,
      visualPreview: preview,
      threadId: 'thr_office'
    })

    expect(attachment).toMatchObject({
      kind: 'document',
      documentFormat: 'xlsx',
      sourceSha256,
      documentText: 'Sheet1\nA1 = 42',
      visualPreview: preview
    })
    await expect(store.create({
      name: 'book.xlsx',
      data,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      documentText: 'Sheet1',
      documentFormat: 'xlsx',
      sourceSha256: '0'.repeat(64)
    })).rejects.toThrow(/source SHA-256/)
  })

  it('decodes UTF-16 BOM text documents without treating their NUL bytes as binary', async () => {
    const store = createStore()
    const text = '编号\t金额\n1\t42'
    const data = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(text, 'utf16le')
    ])

    const attachment = await store.create({
      name: 'data.tsv',
      data,
      mimeType: 'text/tab-separated-values',
      documentFormat: 'text',
      threadId: 'thr_text'
    })

    expect(attachment).toMatchObject({
      kind: 'document',
      documentText: text
    })
  })

  it('serves authenticated upload, metadata, content, and diagnostics routes', async () => {
    const h = buildHarness()
    h.runtime.attachmentStore = createStore()
    const upload = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/attachments', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'shot.png',
          mimeType: 'image/png',
          dataBase64: png(1, 1).toString('base64'),
          localFilePath: '/tmp/picked/shot.png',
          threadId: 'thr_1',
          textFallback: {
            dataBase64: 'abcd',
            mimeType: 'image/png',
            byteSize: 3,
            width: 1,
            height: 1,
            wasCompressed: false
          }
        })
      })
    )

    expect(upload.status).toBe(201)
    const uploaded = await readJson(upload) as { attachment: { id: string } }
    const metadata = await dispatchRequest(
      h.router,
      new Request(`http://localhost/v1/attachments/${uploaded.attachment.id}`, {
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    expect(metadata.status).toBe(200)
    expect(await readJson(metadata)).toMatchObject({
      attachment: {
        localFilePath: '/tmp/picked/shot.png',
        textFallback: {
          dataBase64: 'abcd',
          mimeType: 'image/png'
        }
      }
    })
    const content = await dispatchRequest(
      h.router,
      new Request(`http://localhost/v1/attachments/${uploaded.attachment.id}/content?thread_id=thr_1`, {
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    expect(content.status).toBe(200)
    expect((await readJson(content)) as { dataBase64?: string }).toMatchObject({
      dataBase64: expect.any(String)
    })
    const diagnostics = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/attachments/diagnostics', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    expect(await readJson(diagnostics)).toMatchObject({ enabled: true, count: 1 })
  })

  it('releases an unreferenced upload lease without exposing the lease in HTTP metadata', async () => {
    const h = buildHarness()
    h.runtime.attachmentStore = createStore()
    const upload = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/attachments', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'pending.png',
          dataBase64: png(6, 4).toString('base64'),
          leaseId: 'lease-http-client'
        })
      })
    )
    const uploadedText = await upload.text()
    expect(uploadedText).not.toContain('lease-http-client')
    const uploaded = JSON.parse(uploadedText) as { attachment: { id: string } }

    const released = await dispatchRequest(
      h.router,
      new Request(`http://localhost/v1/attachments/${uploaded.attachment.id}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({ leaseId: 'lease-http-client' })
      })
    )
    expect(released.status).toBe(200)
    expect(await readJson(released)).toEqual({ released: true })

    const missing = await dispatchRequest(
      h.router,
      new Request(`http://localhost/v1/attachments/${uploaded.attachment.id}`, {
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    expect(missing.status).toBe(404)
  })

  it('rejects malformed base64 attachment uploads', async () => {
    const h = buildHarness()
    h.runtime.attachmentStore = createStore()
    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/attachments', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'shot.png', dataBase64: 'not-base64!' })
      })
    )
    expect(response.status).toBe(400)
    expect(await readJson(response)).toMatchObject({ message: 'attachment data is not valid base64' })
  })

  it('rejects declared oversized uploads before reading their body', async () => {
    const h = buildHarness()
    const store = createStore()
    h.runtime.attachmentStore = store
    const create = vi.spyOn(store, 'create')
    let cancelled = false
    let pulled = false
    const body = new ReadableStream<Uint8Array>({
      pull() {
        pulled = true
      },
      cancel() {
        cancelled = true
      }
    })

    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/attachments', {
        method: 'POST',
        headers: {
          authorization: 'Bearer tok-1',
          'content-type': 'application/json',
          'content-length': String(MAX_ATTACHMENT_UPLOAD_BODY_BYTES + 1)
        },
        body,
        duplex: 'half'
      } as RequestInit & { duplex: 'half' })
    )

    expect(response.status).toBe(413)
    expect(pulled).toBe(false)
    expect(cancelled).toBe(true)
    expect(create).not.toHaveBeenCalled()
  })

  it('admits only one bounded upload per attachment store at a time', async () => {
    const h = buildHarness()
    const store = createStore()
    h.runtime.attachmentStore = store
    let allowCreate!: () => void
    const createMayContinue = new Promise<void>((resolve) => {
      allowCreate = resolve
    })
    let signalCreateStarted!: () => void
    const createStarted = new Promise<void>((resolve) => {
      signalCreateStarted = resolve
    })
    const originalCreate = store.create.bind(store)
    const create = vi.spyOn(store, 'create').mockImplementation(async (input) => {
      signalCreateStarted()
      await createMayContinue
      return originalCreate(input)
    })

    const first = dispatchRequest(
      h.router,
      new Request('http://localhost/v1/attachments', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'shot.png', dataBase64: png(1, 1).toString('base64') })
      })
    )
    await createStarted

    let cancelled = false
    const secondBody = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      }
    })
    const second = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/attachments', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: secondBody,
        duplex: 'half'
      } as RequestInit & { duplex: 'half' })
    )

    expect(second.status).toBe(429)
    expect(await readJson(second)).toMatchObject({ code: 'rate_limited' })
    await Promise.resolve()
    expect(cancelled).toBe(true)
    expect(create).toHaveBeenCalledTimes(1)

    allowCreate()
    expect((await first).status).toBe(201)
  })

  it('checks base64 size and canonical padding before decoding', () => {
    expect(attachmentRouteInternal.decodeBase64('T Q ==')).toEqual(Buffer.from('M'))
    expect(() => attachmentRouteInternal.decodeBase64('AB==')).toThrow(/not valid base64/)
    expect(() => attachmentRouteInternal.decodeBase64('AAAA', 2)).toThrow(/exceeds 2 byte limit/)
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

function visionCapabilities(): ModelCapabilityMetadata {
  return {
    id: 'vision-model',
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    supportsToolCalling: true,
    contextWindowTokens: 128_000,
    messageParts: ['text', 'image_url']
  }
}

function generateImageTool(): LocalTool {
  return {
    name: 'generate_image',
    description: 'Generate or edit an image.',
    inputSchema: {
      type: 'object',
      properties: { reference_attachment_ids: {}, reference_image_paths: {} }
    },
    toolKind: 'tool_call',
    policy: 'auto',
    async execute() {
      return { output: { ok: true } }
    }
  }
}
