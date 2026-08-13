import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import '../../i18n'
import { WriteWorkspaceStart } from './WriteWorkspaceStart'

const baseProps = {
  onAskAssistant: () => undefined,
  onCreateDraft: () => undefined,
  onPickWorkspace: () => undefined,
  onRefreshWorkspace: () => undefined,
  workspaceName: 'write_workspace',
  workspacePathLabel: '/home/user/.kun/write_workspace'
}

describe('WriteWorkspaceStart', () => {
  it('explains Work-space setup only during onboarding', () => {
    const html = renderToStaticMarkup(createElement(WriteWorkspaceStart, {
      ...baseProps,
      onboarding: true
    }))

    expect(html).toContain('Create your first Work space')
    expect(html).toContain('Create Work space')
    expect(html).toContain('Use Kun default space')
    expect(html).toContain('separately from code projects')
    expect(html).toContain('Office files open as read-only previews')
  })

  it('offers document and Office starters after onboarding', () => {
    const html = renderToStaticMarkup(createElement(WriteWorkspaceStart, baseProps))

    expect(html).toContain('New draft')
    expect(html).toContain('Generate a document plan')
    expect(html).toContain('Summarize a document')
    expect(html).toContain('Ask about a PDF')
    expect(html).toContain('Analyze a spreadsheet')
    expect(html).toContain('Create a presentation')
    expect(html).not.toContain('Use Kun default space')
  })

  it('keeps workspace initialization failures visible in the main panel', () => {
    const html = renderToStaticMarkup(createElement(WriteWorkspaceStart, {
      ...baseProps,
      error: 'Unable to load this Work space'
    }))

    expect(html).toContain('Unable to load this Work space')
  })

  it('loads an Office starter prompt into the assistant', async () => {
    const onAskAssistant = vi.fn<(prompt: string) => void>()
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(createElement(WriteWorkspaceStart, {
        ...baseProps,
        onAskAssistant
      }))
    })

    const spreadsheetButton = renderer.root.findAllByType('button').find((button) =>
      button.findAllByType('span').some((span) => span.children.includes('Analyze a spreadsheet'))
    )
    expect(spreadsheetButton).toBeDefined()
    await act(async () => spreadsheetButton!.props.onClick())
    expect(onAskAssistant).toHaveBeenCalledWith(expect.stringContaining('read-only content'))
  })
})
