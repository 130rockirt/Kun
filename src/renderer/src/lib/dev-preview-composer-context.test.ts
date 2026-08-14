import { describe, expect, it } from 'vitest'
import { ComposerContextAttachmentSchema } from '@kun/extension-api'
import { createDevPreviewComposerContextAttachment } from './dev-preview-composer-context'

describe('development Preview Composer context', () => {
  it('creates stable source-neutral IDs and valid Preview provenance', async () => {
    const input = {
      workspaceRoot: '/workspace/a',
      threadId: 'thread-1',
      kind: 'element' as const,
      title: 'button: Save',
      summary: '#app > button · Save',
      reference: {
        kind: 'element',
        url: 'http://localhost:3000/',
        selector: '#app > button'
      },
      now: 100
    }
    const first = await createDevPreviewComposerContextAttachment(input)
    const second = await createDevPreviewComposerContextAttachment({ ...input, now: 200 })
    expect(ComposerContextAttachmentSchema.parse(first)).toEqual(first)
    expect(first.attachmentId).toBe(second.attachmentId)
    expect(first.revision).toBe(100)
    expect(second.revision).toBe(200)
    expect(first.provenance).toMatchObject({ source: 'dev-preview' })
  })

  it('changes identity across threads', async () => {
    const base = {
      workspaceRoot: '/workspace/a',
      kind: 'issue' as const,
      title: 'Console error',
      summary: 'Boom',
      reference: { kind: 'issue', message: 'Boom' }
    }
    const a = await createDevPreviewComposerContextAttachment({ ...base, threadId: 'a' })
    const b = await createDevPreviewComposerContextAttachment({ ...base, threadId: 'b' })
    expect(a.attachmentId).not.toBe(b.attachmentId)
  })
})

