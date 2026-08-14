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
