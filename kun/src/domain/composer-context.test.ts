import { describe, expect, it } from 'vitest'
import { userMessageTextWithComposerContexts } from './composer-context.js'

describe('Composer context model projection', () => {
  it('projects source-neutral context as untrusted data without extension-only wording', () => {
    const text = userMessageTextWithComposerContexts({
      text: 'Fix this element',
      composerContexts: [{
        schemaVersion: 1,
        id: 'preview-element',
        title: 'button: Save',
        summary: '#app > button',
        reference: { kind: 'element', url: 'http://localhost:3000/' },
        revision: 1,
        generation: 0,
        attachmentId: `dev-preview-context:${'a'.repeat(64)}`,
        provenance: { source: 'dev-preview', workspaceId: 'b'.repeat(64) }
      }]
    })
    expect(text).toContain('untrusted reference data')
    expect(text).toContain('Attached user context (JSON)')
    expect(text).not.toContain('extension-provided')
  })
})

