import { describe, expect, it } from 'vitest'
import type { ToolBlock } from '../../agent/types'
import {
  requestKnowledgeSourceNavigation,
  subscribeKnowledgeSourceNavigation
} from '../../lib/knowledge-source-navigation'
import { knowledgeEvidenceSourcePath, parseKnowledgeEvidence } from './KnowledgeEvidenceDetail'

describe('knowledge evidence cards', () => {
  it('parses Office citations and formats precise source locations', () => {
    const block: ToolBlock = {
      kind: 'tool',
      id: 'tool_knowledge',
      summary: 'knowledge_read',
      status: 'success',
      detail: JSON.stringify({
        evidence: [
          {
            mountId: 'kb_docs',
            relativePath: 'reports/summary.docx',
            format: 'docx',
            sourceSha256: 'a'.repeat(64),
            location: { kind: 'word', paragraphStart: 4, paragraphEnd: 8 },
            text: 'Quarterly summary',
            truncated: false
          },
          {
            mountId: 'kb_docs',
            relativePath: 'reports/revenue.xlsx',
            format: 'xlsx',
            location: { kind: 'spreadsheet', sheetName: '收入', range: 'B2:F9' },
            text: 'B2\tRevenue',
            truncated: true
          }
        ]
      })
    }

    expect(parseKnowledgeEvidence(block)).toEqual([
      expect.objectContaining({ relativePath: 'reports/summary.docx', locationLabel: 'Paragraphs 4-8' }),
      expect.objectContaining({ relativePath: 'reports/revenue.xlsx', locationLabel: '收入!B2:F9', truncated: true })
    ])
  })

  it('ignores malformed tool output rather than exposing arbitrary values as sources', () => {
    const block: ToolBlock = {
      kind: 'tool', id: 'tool_bad', summary: 'knowledge_read', status: 'success',
      detail: '{"evidence":[{"relativePath":"secret"}]}'
    }
    expect(parseKnowledgeEvidence(block)).toEqual([])
  })

  it('opens only mount-relative sources', () => {
    expect(knowledgeEvidenceSourcePath('/workspace/docs/', 'reports/deck.pptx')).toBe('/workspace/docs/reports/deck.pptx')
    expect(knowledgeEvidenceSourcePath('/workspace/docs', '../secret.docx')).toBeNull()
    expect(knowledgeEvidenceSourcePath('/workspace/docs', '/absolute.docx')).toBeNull()
  })

  it('keeps a citation target until the matching viewer is ready', () => {
    requestKnowledgeSourceNavigation({
      filePath: '/workspace/docs/deck.pptx',
      location: { kind: 'presentation', slideStart: 7, slideEnd: 7 }
    })
    const received: number[] = []
    const unsubscribeOther = subscribeKnowledgeSourceNavigation('/workspace/docs/other.pptx', () => true)
    const unsubscribeTarget = subscribeKnowledgeSourceNavigation('/workspace/docs/deck.pptx', (location) => {
      if (location.kind !== 'presentation') return false
      received.push(location.slideStart)
      return true
    })
    expect(received).toEqual([7])
    unsubscribeOther()
    unsubscribeTarget()
  })
})
