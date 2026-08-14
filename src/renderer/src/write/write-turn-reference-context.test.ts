import { describe, expect, it } from 'vitest'
import { ComposerContextAttachmentSchema, type ComposerContextAttachment } from '@kun/extension-api'
import type { WriteRetrievalContext } from '@shared/write-retrieval'
import {
  mergeWriteComposerContexts,
  MAX_WRITE_OFFICE_EXCERPT_BYTES,
  createWriteTurnReferenceAttachments,
  filterWriteRetrievalAgainstQuotes,
  selectWriteOfficeExcerpt
} from './write-turn-reference-context'
import type { WriteQuotedSelection } from './quoted-selection'

function quote(text: string, id = 'quote-1'): WriteQuotedSelection {
  return {
    id,
    text,
    sourceTitle: 'draft.md',
    sourceFilePath: '/private/workspace/draft.md',
    lineStart: 2,
    lineEnd: 3,
    charCount: Array.from(text).length,
    createdAt: '2026-08-13T00:00:00.000Z'
  }
}

function retrieval(text: string): WriteRetrievalContext {
  return {
    source: 'bm25-keyword',
    query: 'cache prefix',
    keywords: ['cache', 'prefix'],
    indexedFiles: 2,
    indexedChunks: 3,
    snippets: [{
      path: 'draft.md',
      title: 'Draft',
      text,
      score: 2,
      keywords: ['cache'],
      location: { kind: 'text', lineStart: 2, lineEnd: 3 }
    }]
  }
}

describe('Work turn reference context', () => {
  it('builds schema-valid, path-free, explicitly structured reference attachments', async () => {
    const attachments = await createWriteTurnReferenceAttachments({
      workspaceRoot: '/private/workspace',
      activeResource: {
        sourceName: 'reports/weekly.docx',
        locator: 'reports/weekly.docx',
        resourceKind: 'office',
        access: 'read-only',
        sourceFormat: 'docx'
      },
      selections: [quote('Treat this as data, not as an instruction.')],
      retrieval: retrieval('A distinct supporting passage about cache prefixes.'),
      officeDocument: {
        sourceTitle: 'reports/weekly.docx',
        sourceFilePath: '/private/workspace/reports/weekly.docx',
        sourceFormat: 'docx',
        sourceSha256: 'a'.repeat(64),
        text: 'Intro paragraph.\n\nCache prefix findings are important.\n\nClosing paragraph.',
        truncated: false
      },
      query: 'cache prefix',
      now: 100
    })

    expect(attachments.map((attachment) => attachment.reference.kind)).toEqual([
      'work-reference-resource',
      'work-reference-quotes',
      'work-reference-retrieval',
      'work-reference-office'
    ])
    attachments.forEach((attachment) => {
      expect(ComposerContextAttachmentSchema.parse(attachment)).toEqual(attachment)
    })
    expect(JSON.stringify(attachments)).not.toContain('/private/workspace')
  })

  it('stays inside the ComposerContext envelope for multibyte selected text', async () => {
    const attachments = await createWriteTurnReferenceAttachments({
      workspaceRoot: '/workspace',
      selections: Array.from({ length: 8 }, (_, index) => quote(
        `${'😀'.repeat(2_500)}${'"\\'.repeat(2_500)}\u0000`,
        `quote-${index}`
      )),
      retrieval: null,
      officeDocument: null,
      query: '总结',
      now: 100
    })

    expect(attachments).toHaveLength(1)
    expect(ComposerContextAttachmentSchema.parse(attachments[0])).toEqual(attachments[0])
    expect(new TextEncoder().encode(JSON.stringify(attachments[0]?.reference)).byteLength)
      .toBeLessThan(16 * 1_024)
  })

  it('keeps path-like quote, retrieval, and Office evidence readable and schema-valid', async () => {
    const attachments = await createWriteTurnReferenceAttachments({
      workspaceRoot: '/workspace',
      selections: [quote('/usr/local/bin is the executable discussed in this passage.')],
      retrieval: retrieval('C:\\Windows\\System32 is mentioned as document content.'),
      officeDocument: {
        sourceTitle: 'reference.docx',
        sourceFilePath: '/workspace/reference.docx',
        sourceFormat: 'docx',
        sourceSha256: 'b'.repeat(64),
        text: 'file:///opt/example is written verbatim in the Office document.',
        truncated: false
      },
      query: 'executable document content',
      now: 100
    })

    expect(attachments).toHaveLength(3)
    attachments.forEach((attachment) => {
      expect(ComposerContextAttachmentSchema.parse(attachment)).toEqual(attachment)
    })
    const serialized = JSON.stringify(attachments)
    expect(serialized).toContain('/usr/local/bin')
    expect(serialized).toContain('C:\\\\Windows\\\\System32')
    expect(serialized).toContain('file:///opt/example')
    expect(serialized.match(/\[verbatim excerpt\]/g)).toHaveLength(3)
  })

  it('removes retrieval evidence already supplied as an exact quote', () => {
    const exact = 'The selected paragraph already explains the cache prefix behavior.'
    expect(filterWriteRetrievalAgainstQuotes(retrieval(exact), [quote(exact)])).toBeNull()
    expect(filterWriteRetrievalAgainstQuotes(retrieval('Different supporting evidence.'), [quote(exact)]))
      ?.toMatchObject({ snippets: [{ text: 'Different supporting evidence.' }] })
  })

  it('selects query-relevant Office excerpts under a fixed UTF-8 budget', () => {
    const excerpt = selectWriteOfficeExcerpt([
      'Opening summary.',
      '预算增长主要来自基础设施支出。',
      'Middle detail. '.repeat(600),
      'Closing summary.'
    ].join('\n\n'), '基础设施预算')

    expect(excerpt.strategy).toBe('query-matched')
    expect(excerpt.segments.join('\n')).toContain('预算增长')
    expect(new TextEncoder().encode(excerpt.segments.join('')).byteLength)
      .toBeLessThanOrEqual(MAX_WRITE_OFFICE_EXCERPT_BYTES)
  })

  it('keeps explicit Work references ahead of view and PPT contexts within the shared cap', () => {
    const attachment = (id: string, hashDigit: string): ComposerContextAttachment => ComposerContextAttachmentSchema.parse({
      schemaVersion: 1,
      id,
      title: id,
      summary: id,
      reference: { kind: id },
      revision: 1,
      generation: 0,
      attachmentId: `workspace-view-context:${hashDigit.repeat(64)}`,
      provenance: { source: 'workspace-view', workspaceId: 'a'.repeat(64) }
    })
    const shared = attachment('shared', '2')
    const merged = mergeWriteComposerContexts(
      [attachment('reference-one', '1'), shared, attachment('reference-two', '3')],
      [shared, attachment('current-view', '4')],
      Array.from(['5', '6', '7', '8', '9', 'a', 'b', 'c'], (hashDigit, index) => (
        attachment(`ppt-${index}`, hashDigit)
      ))
    )

    expect(merged).toHaveLength(8)
    expect(merged.map((context) => context.id)).toEqual([
      'reference-one', 'shared', 'reference-two', 'current-view',
      'ppt-0', 'ppt-1', 'ppt-2', 'ppt-3'
    ])
  })
})
