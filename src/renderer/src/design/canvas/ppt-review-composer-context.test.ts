import { describe, expect, it } from 'vitest'
import { ComposerContextAttachmentSchema } from '@kun/extension-api'
import { createPptReviewComposerContextAttachments } from './ppt-review-composer-context'

describe('PPT review composer context', () => {
  it('uses the bounded structured context contract without exposing preview paths', async () => {
    const [attachment] = await createPptReviewComposerContextAttachments({
      workspaceRoot: '/workspace',
      threadId: 'thread-a',
      workflows: [{
        workflowId: 'workflow-a',
        childId: 'child-a',
        slides: [{
          slideId: 'slide-2',
          revision: 3,
          imagePath: '/workspace/.kun/ppt/preview.png',
          annotations: ['  Make the headline larger  ']
        }]
      }]
    })

    expect(ComposerContextAttachmentSchema.parse(attachment)).toEqual(attachment)
    expect(attachment).toMatchObject({
      id: expect.stringMatching(/^preview-ppt-review-[a-f0-9]{24}$/),
      attachmentId: expect.stringMatching(/^dev-preview-context:[a-f0-9]{64}$/),
      provenance: { source: 'dev-preview' },
      reference: {
        kind: 'ppt-review',
        schemaVersion: 1,
        workflowId: 'workflow-a',
        childId: 'child-a',
        slides: [{
          slideId: 'slide-2',
          revision: 3,
          annotations: ['Make the headline larger']
        }]
      }
    })
    expect(JSON.stringify(attachment.reference)).not.toContain('preview.png')
    expect(JSON.stringify(attachment.reference)).not.toContain('imagePath')
  })
})
