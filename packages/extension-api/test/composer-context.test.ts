import { describe, expect, it, vi } from 'vitest'
import {
  ComposerContextAttachmentRequestSchema,
  ComposerContextAttachmentSchema,
  ExtensionHostClient,
  isExtensionViewSafeMethod,
  type HostTransport
} from '../src/index.js'

const request = {
  schemaVersion: 1,
  id: 'video-selection',
  title: 'Interview selection',
  summary: 'Revision 4 with two selected clips',
  reference: {
    projectId: 'project-1',
    sequenceId: 'sequence-main',
    selectedItemIds: ['clip-1', 'clip-2']
  },
  revision: 4,
  generation: 7
} as const

const attachment = {
  ...request,
  attachmentId: `extension-context:${'a'.repeat(64)}`,
  provenance: {
    extensionId: 'acme.video-editor',
    extensionVersion: '1.1.0',
    viewContributionId: 'extension:acme.video-editor/editor',
    workspaceId: 'b'.repeat(64)
  }
} as const

describe('bounded composer context API', () => {
  it('accepts bounded path-free references and publishes the View method', () => {
    expect(ComposerContextAttachmentRequestSchema.parse(request)).toEqual(request)
    expect(ComposerContextAttachmentSchema.parse(attachment)).toEqual(attachment)
    expect(isExtensionViewSafeMethod('ui.attachComposerContext')).toBe(true)
  })

  it('accepts first-party Preview provenance without changing extension attachments', () => {
    const previewAttachment = {
      ...request,
      attachmentId: `dev-preview-context:${'c'.repeat(64)}`,
      provenance: { source: 'dev-preview', workspaceId: 'd'.repeat(64) }
    } as const
    expect(ComposerContextAttachmentSchema.parse(previewAttachment)).toEqual(previewAttachment)
    expect(ComposerContextAttachmentSchema.parse(attachment)).toEqual(attachment)
    expect(ComposerContextAttachmentSchema.safeParse({
      ...previewAttachment,
      attachmentId: `browser-context:${'c'.repeat(64)}`
    }).success).toBe(false)
  })

  it('accepts first-party workspace document selections', () => {
    const selectionAttachment = {
      ...request,
      attachmentId: `workspace-selection-context:${'e'.repeat(64)}`,
      provenance: { source: 'workspace-selection', workspaceId: 'f'.repeat(64) }
    } as const
    expect(ComposerContextAttachmentSchema.parse(selectionAttachment)).toEqual(selectionAttachment)
    expect(ComposerContextAttachmentSchema.safeParse({
      ...selectionAttachment,
      attachmentId: `document-context:${'e'.repeat(64)}`
    }).success).toBe(false)
  })

  it('accepts path-free first-party workspace view positions', () => {
    const viewAttachment = {
      ...request,
      id: 'office-view-position',
      title: 'deck.pptx',
      summary: 'Current view · Slide 3 of 9',
      reference: {
        kind: 'office-view-position',
        schemaVersion: 1,
        sourceName: 'deck.pptx',
        sourceFormat: 'pptx',
        sourceSha256: 'a'.repeat(64),
        location: { kind: 'presentation', slide: 3, slideCount: 9 }
      },
      attachmentId: `workspace-view-context:${'e'.repeat(64)}`,
      provenance: { source: 'workspace-view', workspaceId: 'f'.repeat(64) }
    } as const
    expect(ComposerContextAttachmentSchema.parse(viewAttachment)).toEqual(viewAttachment)
    expect(ComposerContextAttachmentSchema.safeParse({
      ...viewAttachment,
      reference: { ...viewAttachment.reference, filePath: '/private/deck.pptx' }
    }).success).toBe(false)
  })

  it('rejects absolute paths, path fields, excessive depth, and oversized references', () => {
    expect(ComposerContextAttachmentRequestSchema.safeParse({
      ...request,
      reference: { filePath: '/private/interview.mp4' }
    }).success).toBe(false)
    expect(ComposerContextAttachmentRequestSchema.safeParse({
      ...request,
      reference: { source: '/private/interview.mp4' }
    }).success).toBe(false)
    expect(ComposerContextAttachmentRequestSchema.safeParse({
      ...request,
      reference: { workspaceRelativePath: 'media/interview.mp4' }
    }).success).toBe(false)
    expect(ComposerContextAttachmentRequestSchema.safeParse({
      ...request,
      provenance: attachment.provenance
    }).success).toBe(false)
    let nested: Record<string, unknown> = { value: 'clip-1' }
    for (let index = 0; index < 10; index += 1) nested = { nested }
    expect(ComposerContextAttachmentRequestSchema.safeParse({
      ...request,
      reference: nested
    }).success).toBe(false)
    expect(ComposerContextAttachmentRequestSchema.safeParse({
      ...request,
      reference: { summary: 'x'.repeat(17 * 1024) }
    }).success).toBe(false)
  })

  it('validates request and Host provenance through ExtensionHostClient', async () => {
    const hostRequest = vi.fn(async () => attachment)
    const transport: HostTransport = {
      request: hostRequest,
      notify: vi.fn(),
      onNotification: () => ({ dispose: () => undefined }),
      registerHandler: () => ({ dispose: () => undefined }),
      dispose: () => undefined
    }
    const client = new ExtensionHostClient(transport)

    await expect(client.ui.attachComposerContext(request)).resolves.toEqual(attachment)
    expect(hostRequest).toHaveBeenCalledWith('ui.attachComposerContext', request, undefined)
    client.dispose()
  })
})
