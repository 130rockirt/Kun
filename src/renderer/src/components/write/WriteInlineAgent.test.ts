import { createElement } from 'react'
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
  const action = {
    left: 200,
    width: 520,
    anchorLeft: 300,
    anchorRight: 500,
    coordinateScale: 1,
    anchorTop: 220,
    anchorBottom: 260
  }

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

  it('does not render a second AI composer beside the assistant sidebar', async () => {
    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = create(createElement(WriteInlineAgent, {
        action
      }))
    })

    expect(renderer!.root.findAllByType('textarea')).toHaveLength(0)
    expect(renderer!.root.findAllByProps({ className: 'write-inline-agent-edit' })).toHaveLength(0)
  })

  it('keeps quote and configured selection actions available', async () => {
    const onQuoteSelection = vi.fn()
    const onQuickAction = vi.fn()
    const quickAction = {
      id: 'polish',
      label: 'Polish',
      prompt: 'Polish the selection',
      mode: 'edit' as const
    }
    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = create(createElement(WriteInlineAgent, {
        action,
        onQuoteSelection,
        quickActions: [quickAction],
        onQuickAction
      }))
    })

    renderer!.root.findByProps({ 'aria-label': 'writeSelectionQuote' }).props.onClick()
    renderer!.root.findByProps({ 'aria-label': quickAction.label }).props.onClick()

    expect(onQuoteSelection).toHaveBeenCalledOnce()
    expect(onQuickAction).toHaveBeenCalledWith(quickAction)
  })
})
