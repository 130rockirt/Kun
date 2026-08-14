import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SddAssistantToggleButton } from './SddDraftEditorView'
import { prepareSddAssistantSelection } from './SddDraftEditorView'

describe('SddDraftEditorView', () => {
  it('renders a control to reopen the Requirement AI panel', () => {
    const html = renderToStaticMarkup(
      createElement(SddAssistantToggleButton, {
        assistantOpen: false,
        onToggleAssistant: () => undefined,
        label: 'Requirement AI'
      })
    )

    expect(html).toContain('aria-label="Requirement AI"')
  })

  it('keeps selected requirement text out of the visible assistant input', () => {
    const prepared = prepareSddAssistantSelection({
      prompt: 'Explain this requirement',
      selection: {
        text: 'Sensitive acceptance criteria',
        ranges: [{
          from: 0, to: 29, text: 'Sensitive acceptance criteria', charCount: 29,
          startLine: 3, startColumn: 1, endLine: 3, endColumn: 30
        }],
        charCount: 29
      },
      filePath: '/private/workspace/.kunsdd/requirements/one/requirement.md',
      workspaceRoot: '/private/workspace'
    })

    expect(prepared.prompt).toBe('Explain this requirement')
    expect(prepared.prompt).not.toContain('Sensitive acceptance criteria')
    expect(prepared.prompt).not.toContain('/private/workspace')
    expect(prepared.selection).toMatchObject({
      text: 'Sensitive acceptance criteria',
      sourceTitle: '.kunsdd/requirements/one/requirement.md'
    })
  })
})
