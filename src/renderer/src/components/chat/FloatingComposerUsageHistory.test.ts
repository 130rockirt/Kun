import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  calculateUsageHistoryPopoverPlacement,
  FloatingComposerUsageHistory
} from './FloatingComposerUsageHistory'

vi.mock('react-dom', () => ({
  createPortal: (children: unknown) => children
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

vi.mock('./InitialSessionUsageHeatmap', () => ({
  InitialSessionUsageHeatmap: () => createElement('div', { 'data-usage-content': true })
}))

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('window', {
    innerWidth: 1280,
    innerHeight: 800,
    requestAnimationFrame: vi.fn(() => 1),
    cancelAnimationFrame: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  })
  vi.stubGlobal('document', { body: {} })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('FloatingComposerUsageHistory', () => {
  it('clamps a large popover to the viewport and prefers space above the composer', () => {
    expect(calculateUsageHistoryPopoverPlacement({
      anchorRect: { left: 1000, right: 1120, top: 740, bottom: 768 },
      popoverHeight: 640,
      viewportHeight: 800,
      viewportWidth: 1280
    })).toEqual({
      left: 348,
      top: 92,
      width: 920,
      maxHeight: 720
    })

    const narrow = calculateUsageHistoryPopoverPlacement({
      anchorRect: { left: 120, right: 220, top: 500, bottom: 528 },
      popoverHeight: 700,
      viewportHeight: 600,
      viewportWidth: 360
    })
    expect(narrow.width).toBe(336)
    expect(narrow.left).toBe(12)
    expect(narrow.maxHeight).toBe(576)
  })

  it('exposes an accessible trigger and mounts history only while open', async () => {
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(createElement(FloatingComposerUsageHistory, {
        title: 'Current usage',
        children: createElement('span', null, '12k tokens')
      }))
    })
    const trigger = renderer.root.findByProps({ 'aria-haspopup': 'dialog' })
    expect(trigger.props['aria-expanded']).toBe(false)
    expect(renderer.root.findAllByProps({ role: 'dialog' })).toHaveLength(0)

    await act(async () => trigger.props.onClick())
    expect(renderer.root.findByProps({ role: 'dialog' }).props['aria-modal']).toBe('false')
    expect(renderer.root.findAllByProps({ 'data-usage-content': true })).toHaveLength(1)

    await act(async () => renderer.root.findByProps({ 'aria-label': 'close' }).props.onClick())
    expect(renderer.root.findAllByProps({ role: 'dialog' })).toHaveLength(0)
    await act(async () => renderer.unmount())
  })
})
