import { describe, expect, it } from 'vitest'
import type { WorkspacePresentationViewReference } from '@shared/office-document'
import {
  createWorkspaceOfficeViewPositionAttachment,
  isWorkspaceOfficeViewPositionAttachment,
  readWorkspaceOfficeViewPosition
} from './workspace-office-view-context'

function view(
  overrides: Partial<WorkspacePresentationViewReference> = {}
): WorkspacePresentationViewReference {
  return {
    kind: 'presentation',
    path: '/workspace/deck.pptx',
    sourceName: 'deck.pptx',
    sourceFormat: 'pptx',
    sourceSha256: 'a'.repeat(64),
    slide: 3,
    slideCount: 9,
    ...overrides
  }
}

describe('workspace Office view composer context', () => {
  it('creates a stable, path-free first-party attachment', async () => {
    const first = await createWorkspaceOfficeViewPositionAttachment({
      workspaceRoot: '/workspace', view: view(), now: 7
    })
    const second = await createWorkspaceOfficeViewPositionAttachment({
      workspaceRoot: '/workspace', view: view(), now: 8
    })

    expect(first.attachmentId).toBe(second.attachmentId)
    expect(first.provenance).toEqual({
      source: 'workspace-view', workspaceId: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
    expect(first.reference).toEqual({
      kind: 'office-view-position',
      schemaVersion: 1,
      sourceName: 'deck.pptx',
      sourceFormat: 'pptx',
      sourceSha256: 'a'.repeat(64),
      location: { kind: 'presentation', slide: 3, slideCount: 9 }
    })
    expect(JSON.stringify(first.reference)).not.toContain('/workspace')
    expect(isWorkspaceOfficeViewPositionAttachment(first)).toBe(true)
    expect(readWorkspaceOfficeViewPosition(first)).toEqual({
      kind: 'presentation', sourceName: 'deck.pptx', sourceFormat: 'pptx',
      sourceSha256: 'a'.repeat(64), slide: 3, slideCount: 9
    })
  })

  it('changes identity when the source or captured slide changes', async () => {
    const first = await createWorkspaceOfficeViewPositionAttachment({
      workspaceRoot: '/workspace', view: view()
    })
    const nextSlide = await createWorkspaceOfficeViewPositionAttachment({
      workspaceRoot: '/workspace', view: view({ slide: 4 })
    })
    const nextSource = await createWorkspaceOfficeViewPositionAttachment({
      workspaceRoot: '/workspace', view: view({ sourceSha256: 'b'.repeat(64) })
    })
    expect(nextSlide.attachmentId).not.toBe(first.attachmentId)
    expect(nextSource.attachmentId).not.toBe(first.attachmentId)
  })

  it('rejects invalid coordinates and source identities', async () => {
    await expect(createWorkspaceOfficeViewPositionAttachment({
      workspaceRoot: '/workspace', view: view({ slide: 0 })
    })).rejects.toThrow('Invalid workspace presentation view reference')
    await expect(createWorkspaceOfficeViewPositionAttachment({
      workspaceRoot: '/workspace', view: view({ slide: 10 })
    })).rejects.toThrow('Invalid workspace presentation view reference')
    await expect(createWorkspaceOfficeViewPositionAttachment({
      workspaceRoot: '/workspace', view: view({ sourceSha256: 'bad' })
    })).rejects.toThrow('Invalid workspace presentation view reference')
  })

  it('rejects forged provenance, prefixes, and path-bearing references', async () => {
    const attachment = await createWorkspaceOfficeViewPositionAttachment({
      workspaceRoot: '/workspace', view: view()
    })
    expect(isWorkspaceOfficeViewPositionAttachment({
      ...attachment,
      provenance: { source: 'dev-preview', workspaceId: 'b'.repeat(64) }
    })).toBe(false)
    expect(isWorkspaceOfficeViewPositionAttachment({
      ...attachment,
      attachmentId: `workspace-selection-context:${'b'.repeat(64)}`
    })).toBe(false)
    expect(isWorkspaceOfficeViewPositionAttachment({
      ...attachment,
      reference: { ...attachment.reference, filePath: '/workspace/deck.pptx' }
    })).toBe(false)
  })
})
