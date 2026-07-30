import { createRef, createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WriteInlineAgent } from './WriteInlineAgent'

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn()
  },
  useTranslation: () => ({
    t: (key: string): string => key
  })
}))

describe('WriteInlineAgent', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      innerWidth: 1200,
      innerHeight: 900,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders a spacious multiline composer for requirement and writing selections', async () => {
    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = create(createElement(WriteInlineAgent, {
        action: {
          left: 200,
          width: 520,
          anchorLeft: 300,
          anchorRight: 500,
          coordinateScale: 1,
          anchorTop: 220,
          anchorBottom: 260
        },
        value: 'Improve the selected paragraph',
        inFlight: false,
        textareaRef: createRef<HTMLTextAreaElement>(),
        onValueChange: vi.fn(),
        onSubmitPrompt: vi.fn(),
        onApplyEdit: vi.fn()
      }))
    })

    const textarea = renderer!.root.findByType('textarea')
    expect(textarea.props.rows).toBe(4)
    expect(textarea.props.placeholder).toBe('writeInlineAgentPlaceholder')
    expect(renderer!.root.findByProps({ className: 'write-inline-agent-edit-title' }).children)
      .toContain('writeInlineAgentAskAi')
    expect(renderer!.root.findByProps({ className: 'write-inline-agent-selection-chip' }).children)
      .toHaveLength(2)
  })

  it('keeps Enter for new lines and uses Command/Ctrl + Enter for the primary action', async () => {
    const onApplyEdit = vi.fn()
    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = create(createElement(WriteInlineAgent, {
        action: {
          left: 200,
          width: 520,
          anchorLeft: 300,
          anchorRight: 500,
          coordinateScale: 1,
          anchorTop: 220,
          anchorBottom: 260
        },
        value: 'Rewrite this',
        inFlight: false,
        textareaRef: createRef<HTMLTextAreaElement>(),
        onValueChange: vi.fn(),
        onSubmitPrompt: vi.fn(),
        onApplyEdit
      }))
    })

    const textarea = renderer!.root.findByType('textarea')
    const plainPreventDefault = vi.fn()
    textarea.props.onKeyDown({
      key: 'Enter',
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      nativeEvent: { isComposing: false },
      preventDefault: plainPreventDefault
    })
    expect(plainPreventDefault).not.toHaveBeenCalled()
    expect(onApplyEdit).not.toHaveBeenCalled()

    const shortcutPreventDefault = vi.fn()
    textarea.props.onKeyDown({
      key: 'Enter',
      shiftKey: false,
      metaKey: true,
      ctrlKey: false,
      nativeEvent: { isComposing: false },
      preventDefault: shortcutPreventDefault
    })
    expect(shortcutPreventDefault).toHaveBeenCalledOnce()
    expect(onApplyEdit).toHaveBeenCalledWith('Rewrite this')
  })
})
