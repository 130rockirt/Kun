import { describe, expect, it } from 'vitest'
import { ComposerContextAttachmentSchema } from '@kun/extension-api'
import {
  MAX_WORKSPACE_DOCUMENT_QUOTE_CHARS,
  createWorkspaceDocumentQuoteAttachment,
  normalizeWorkspaceDocumentQuoteText
} from './workspace-document-quote'

describe('workspace document quote context', () => {
  it('creates stable, path-free attachments with first-party provenance', async () => {
    const draft = {
      sourceName: 'weekly-report.docx',
      documentFormat: 'docx' as const,
      sourceSha256: 'a'.repeat(64),
      pageStart: 2,
      pageEnd: 2,
      text: '  Selected\u00a0text  '
    }
    const first = await createWorkspaceDocumentQuoteAttachment({
      workspaceRoot: '/workspace/private',
      draft,
      now: 100
    })
    const second = await createWorkspaceDocumentQuoteAttachment({
      workspaceRoot: '/workspace/private',
      draft,
      now: 200
    })

    expect(ComposerContextAttachmentSchema.parse(first)).toEqual(first)
    expect(first.attachmentId).toBe(second.attachmentId)
    expect(first.reference).toMatchObject({
      kind: 'document-quote',
      sourceName: 'weekly-report.docx',
      pageStart: 2,
      pageEnd: 2,
      charCount: 13,
      text: 'Selected text'
    })
    expect(JSON.stringify(first)).not.toContain('/workspace/private')
    expect(first.provenance).toMatchObject({ source: 'workspace-selection' })
  })

  it('caps selected text at the schema string limit', () => {
    expect(normalizeWorkspaceDocumentQuoteText(`  ${'x'.repeat(2_100)}  `)).toHaveLength(
      MAX_WORKSPACE_DOCUMENT_QUOTE_CHARS
    )
  })
})
