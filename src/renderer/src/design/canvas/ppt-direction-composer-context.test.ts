import { ComposerContextAttachmentSchema } from '@kun/extension-api'
import { describe, expect, it } from 'vitest'
import { createPptDirectionComposerContextAttachments } from './ppt-direction-composer-context'

describe('PPT direction composer context', () => {
  it('sends only the selected identity and revision, without preview or plan content', async () => {
    const [attachment] = await createPptDirectionComposerContextAttachments({
      workspaceRoot: '/workspace',
      threadId: 'thread-a',
      workflows: [{
        workflowId: 'workflow-a',
        childId: 'child-a',
        revision: 4,
        directions: [{ directionId: 'signal', revision: 4 }]
      }]
    })

    expect(ComposerContextAttachmentSchema.parse(attachment)).toEqual(attachment)
    expect(attachment).toMatchObject({
      id: expect.stringMatching(/^preview-ppt-direction-[a-f0-9]{24}$/),
      attachmentId: expect.stringMatching(/^dev-preview-context:[a-f0-9]{64}$/),
      provenance: { source: 'dev-preview' },
      reference: {
        kind: 'ppt-direction',
        schemaVersion: 1,
        workflowId: 'workflow-a',
        childId: 'child-a',
        directions: [{ directionId: 'signal', revision: 4 }]
      }
    })
    expect(JSON.stringify(attachment.reference)).not.toContain('imagePath')
    expect(JSON.stringify(attachment.reference)).not.toContain('plan')
  })

  it('represents an empty selection explicitly so the runtime can use its recommendation', async () => {
    const [attachment] = await createPptDirectionComposerContextAttachments({
      workspaceRoot: '/workspace',
      threadId: 'thread-a',
      workflows: [{ workflowId: 'workflow-a', childId: 'child-a', revision: 2, directions: [] }]
    })
    expect(attachment.reference).toMatchObject({ kind: 'ppt-direction', directions: [] })
    expect(attachment.summary).toContain('persisted recommended direction')
  })

  it('rejects a forged multi-direction context before attachment creation', async () => {
    await expect(createPptDirectionComposerContextAttachments({
      workspaceRoot: '/workspace',
      threadId: 'thread-a',
      workflows: [{
        workflowId: 'workflow-a', childId: 'child-a', revision: 2,
        directions: [{ directionId: 'a', revision: 1 }, { directionId: 'b', revision: 1 }]
      }]
    })).rejects.toThrow('at most one')
  })
})
