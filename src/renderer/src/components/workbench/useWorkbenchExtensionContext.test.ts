import { describe, expect, it } from 'vitest'
import { composerContextChip } from './useWorkbenchExtensionContext'

describe('Workbench Composer context chips', () => {
  it('maps document selection metadata without showing quote text as chip detail', () => {
    const chip = composerContextChip({
      workspaceRoot: '/workspace',
      threadId: 'thread-1',
      attachment: {
        schemaVersion: 1,
        id: 'document-quote-a',
        title: 'weekly-report.docx',
        summary: 'Page 3 · 27 characters',
        reference: {
          kind: 'document-quote',
          sourceName: 'weekly-report.docx',
          documentFormat: 'docx',
          sourceSha256: 'a'.repeat(64),
          pageStart: 3,
          pageEnd: 3,
          charCount: 27,
          text: 'The selected report passage'
        },
        revision: 1,
        generation: 0,
        attachmentId: `workspace-selection-context:${'b'.repeat(64)}`,
        provenance: {
          source: 'workspace-selection',
          workspaceId: 'c'.repeat(64)
        }
      }
    })

    expect(chip).toEqual({
      id: `workspace-selection-context:${'b'.repeat(64)}`,
      kind: 'document-quote',
      label: 'weekly-report.docx',
      removable: true,
      quote: {
        text: 'The selected report passage',
        pageStart: 3,
        pageEnd: 3,
        charCount: 27
      }
    })
    expect(chip.detail).toBeUndefined()
  })
})
