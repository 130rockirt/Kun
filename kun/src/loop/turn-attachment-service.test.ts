import { describe, expect, it, vi } from 'vitest'
import type { AttachmentContent, AttachmentStore } from '../attachments/attachment-store.js'
import type { ModelCapabilityMetadata } from '../contracts/capabilities.js'
import { makeUserItem } from '../domain/item.js'
import {
  TurnAttachmentService,
  imageGenerationReferenceInstructions
} from './turn-attachment-service.js'

function imageAttachment(overrides: Partial<AttachmentContent> = {}): AttachmentContent {
  return {
    id: 'att_0123456789abcdef01234567',
    name: 'image.png',
    kind: 'image',
    mimeType: 'image/png',
    byteSize: 5,
    hash: 'hash',
    threadIds: ['thread_1'],
    workspaces: ['/workspace'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    data: Buffer.from('image'),
    ...overrides
  }
}

function store(content: AttachmentContent): AttachmentStore {
  return {
    resolveContent: vi.fn(async () => content),
    textFallbackPolicy: () => ({
      textFallbackMaxBase64Bytes: 1_024,
      textFallbackMaxImageDimension: 1_024,
      textFallbackPreferredMimeType: 'image/jpeg'
    })
  } as unknown as AttachmentStore
}

function officeDocumentAttachment(overrides: Partial<AttachmentContent> = {}): AttachmentContent {
  return {
    id: 'att_abcdef0123456789abcdef01',
    name: 'book.xlsx',
    kind: 'document',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    byteSize: 8,
    hash: 'a'.repeat(64),
    sourceSha256: 'a'.repeat(64),
    documentFormat: 'xlsx',
    documentText: 'Sheet1\nA1 = 42\nA2 = =SUM(A1:A1)',
    visualPreview: {
      dataBase64: Buffer.from('preview').toString('base64'),
      mimeType: 'image/webp',
      byteSize: 7,
      width: 800,
      height: 600,
      wasCompressed: true
    },
    threadIds: ['thread_1'],
    workspaces: ['/workspace'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    data: Buffer.from('workbook'),
    ...overrides
  }
}

describe('TurnAttachmentService', () => {
  it('materializes image bytes only for image-capable models', async () => {
    const service = new TurnAttachmentService(store(imageAttachment()))
    const resolved = await service.resolveTurnAttachments({
      attachmentIds: ['att_0123456789abcdef01234567'],
      threadId: 'thread_1',
      workspace: '/workspace',
      modelCapabilities: {
        id: 'vision', inputModalities: ['image'], outputModalities: ['text'],
        supportsToolCalling: true, messageParts: ['image_url']
      }
    })

    expect(resolved).toEqual({
      imageAttachments: [expect.objectContaining({ dataBase64: Buffer.from('image').toString('base64') })],
      textFallbacks: [],
      documents: []
    })
  })

  it('uses a text fallback when a text-only model receives a new image attachment', async () => {
    const content = imageAttachment()
    const service = new TurnAttachmentService(store(content))

    const resolved = await service.resolveTurnAttachments({
      attachmentIds: [content.id],
      threadId: 'thread_1',
      workspace: '/workspace',
      modelCapabilities: {
        id: 'text', inputModalities: ['text'], outputModalities: ['text'],
        supportsToolCalling: true, messageParts: ['text']
      }
    })

    expect(resolved).toEqual({
      imageAttachments: [],
      textFallbacks: [expect.objectContaining({
        id: content.id,
        dataBase64: content.data.toString('base64'),
        wasCompressed: false
      })],
      documents: []
    })
  })

  it('sends Office semantics to every model and adds its preview only for visual models', async () => {
    const content = officeDocumentAttachment()
    const service = new TurnAttachmentService(store(content))
    const textModel: ModelCapabilityMetadata = {
      id: 'text',
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportsToolCalling: true,
      messageParts: ['text']
    }

    await expect(service.resolveTurnAttachments({
      attachmentIds: [content.id],
      threadId: 'thread_1',
      workspace: '/workspace',
      modelCapabilities: textModel
    })).resolves.toEqual({
      imageAttachments: [],
      textFallbacks: [],
      documents: [expect.objectContaining({
        id: content.id,
        documentFormat: 'xlsx',
        sourceSha256: content.sourceSha256,
        text: expect.stringContaining('A1 = 42')
      })]
    })

    await expect(service.resolveTurnAttachments({
      attachmentIds: [content.id],
      threadId: 'thread_1',
      workspace: '/workspace',
      modelCapabilities: {
        ...textModel,
        id: 'vision',
        inputModalities: ['text', 'image'],
        messageParts: ['text', 'image_url']
      }
    })).resolves.toEqual({
      imageAttachments: [expect.objectContaining({
        id: `${content.id}_preview`,
        mimeType: 'image/webp',
        dataBase64: content.visualPreview?.dataBase64
      })],
      textFallbacks: [],
      documents: [expect.objectContaining({
        id: content.id,
        documentFormat: 'xlsx'
      })]
    })
  })

  it('uses the authorized attachment before a recorded file fallback', async () => {
    const content = imageAttachment({ data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) })
    const attachmentStore = store(content)
    const service = new TurnAttachmentService(attachmentStore)

    await expect(service.resolveGeneratedImageForForward({
      attachments: [{ id: content.id }],
      files: [{ absolutePath: '/does/not/exist.png' }]
    }, 'thread_1', '/workspace')).resolves.toMatchObject({
      mimeType: 'image/png', dataBase64: content.data.toString('base64')
    })
    expect(attachmentStore.resolveContent).toHaveBeenCalledWith(content.id, {
      threadId: 'thread_1', workspace: '/workspace'
    })
  })

  it('reads the live attachment store after runtime replacement', async () => {
    let currentStore: AttachmentStore | undefined
    const service = new TurnAttachmentService(() => currentStore)
    const first = imageAttachment({ data: Buffer.from('first') })
    const second = imageAttachment({ data: Buffer.from('second') })

    currentStore = store(first)
    await expect(service.resolveTurnAttachments({
      attachmentIds: [first.id],
      threadId: 'thread_1',
      workspace: '/workspace',
      modelCapabilities: {
        id: 'vision', inputModalities: ['image'], outputModalities: ['text'],
        supportsToolCalling: true, messageParts: ['image_url']
      }
    })).resolves.toMatchObject({
      imageAttachments: [{ dataBase64: first.data.toString('base64') }]
    })

    currentStore = store(second)
    await expect(service.resolveTurnAttachments({
      attachmentIds: [second.id],
      threadId: 'thread_1',
      workspace: '/workspace',
      modelCapabilities: {
        id: 'vision', inputModalities: ['image'], outputModalities: ['text'],
        supportsToolCalling: true, messageParts: ['image_url']
      }
    })).resolves.toMatchObject({
      imageAttachments: [{ dataBase64: second.data.toString('base64') }]
    })
  })

  it('replays retained attachments by their owning user-message item', async () => {
    const first = imageAttachment({ id: 'att_first', data: Buffer.from('first') })
    const second = officeDocumentAttachment({ id: 'att_second' })
    const attachmentStore = {
      resolveContent: vi.fn(async (id: string) => id === first.id ? first : second),
      textFallbackPolicy: () => ({
        textFallbackMaxBase64Bytes: 1_024,
        textFallbackMaxImageDimension: 1_024,
        textFallbackPreferredMimeType: 'image/jpeg'
      })
    } as unknown as AttachmentStore
    const service = new TurnAttachmentService(attachmentStore)
    const items = [
      makeUserItem({
        id: 'user-first', threadId: 'thread_1', turnId: 'turn-first', text: 'first',
        attachmentIds: [first.id]
      }),
      makeUserItem({
        id: 'user-second', threadId: 'thread_1', turnId: 'turn-second', text: 'second',
        attachmentIds: [second.id]
      })
    ]
    const resolved = await service.resolveHistoryAttachments({
      items,
      threadId: 'thread_1',
      workspace: '/workspace',
      modelCapabilities: {
        id: 'vision', inputModalities: ['text', 'image'], outputModalities: ['text'],
        supportsToolCalling: true, messageParts: ['text', 'image_url']
      }
    })

    expect(resolved['user-first']?.images).toEqual([
      expect.objectContaining({ id: first.id, dataBase64: first.data.toString('base64') })
    ])
    expect(resolved['user-second']?.documents).toEqual([
      expect.objectContaining({ id: second.id, documentFormat: 'xlsx' })
    ])
    expect(Object.values(resolved).flatMap((entry) => entry.unavailable)).toEqual([])
  })

  it('uses a deterministic unavailable marker and keeps resolving other messages', async () => {
    const available = imageAttachment({ id: 'att_available' })
    const attachmentStore = {
      resolveContent: vi.fn(async (id: string) => {
        if (id === 'att_missing') throw new Error('missing')
        return available
      }),
      textFallbackPolicy: () => ({
        textFallbackMaxBase64Bytes: 1_024,
        textFallbackMaxImageDimension: 1_024,
        textFallbackPreferredMimeType: 'image/jpeg'
      })
    } as unknown as AttachmentStore
    const service = new TurnAttachmentService(attachmentStore)
    const resolved = await service.resolveHistoryAttachments({
      items: [makeUserItem({
        id: 'user-mixed', threadId: 'thread_1', turnId: 'turn-mixed', text: 'mixed',
        attachmentIds: ['att_missing', available.id]
      })],
      threadId: 'thread_1',
      workspace: '/workspace',
      modelCapabilities: {
        id: 'vision', inputModalities: ['image'], outputModalities: ['text'],
        supportsToolCalling: true, messageParts: ['image_url']
      }
    })

    expect(resolved['user-mixed']?.unavailable).toEqual([{
      id: 'att_missing',
      text: expect.stringContaining('AttachmentId: att_missing')
    }])
    expect(resolved['user-mixed']?.images).toHaveLength(1)
    expect(resolved['user-mixed']?.order).toEqual([
      { kind: 'unavailable', index: 0 },
      { kind: 'image', index: 0 }
    ])
  })

  it('supplies attachment IDs for temporary images and paths for workspace images', () => {
    const instructions = imageGenerationReferenceInstructions({
      imageAttachments: [
        {
          id: 'att_temp', name: 'pasted.png', mimeType: 'image/png', dataBase64: 'aW1hZ2U=',
          localFilePath: '/tmp/clipboard.png'
        },
        {
          id: 'att_workspace', name: 'ref.png', mimeType: 'image/png', dataBase64: 'aW1hZ2U=',
          localFilePath: '/workspace/assets/ref.png'
        }
      ],
      textFallbacks: [],
      workspace: '/workspace',
      tools: [{
        name: 'generate_image',
        inputSchema: {
          type: 'object',
          properties: { reference_attachment_ids: {}, reference_image_paths: {} }
        }
      }]
    })

    expect(instructions).toHaveLength(1)
    expect(instructions[0]).toContain('pasted.png: attachment ID att_temp')
    expect(instructions[0]).not.toContain('/tmp/clipboard.png')
    expect(instructions[0]).toContain('ref.png: attachment ID att_workspace; workspace path assets/ref.png')
    expect(instructions[0]).toContain('reference_attachment_ids')
    expect(instructions[0]).toContain('reference_image_paths')
  })

  it('does not advertise image-to-image when the tool schema lacks reference inputs', () => {
    expect(imageGenerationReferenceInstructions({
      imageAttachments: [{
        id: 'att', name: 'ref.png', mimeType: 'image/png', dataBase64: 'aW1hZ2U='
      }],
      textFallbacks: [],
      workspace: '/workspace',
      tools: [{ name: 'generate_image', inputSchema: { type: 'object', properties: {} } }]
    })).toEqual([])
  })
})
