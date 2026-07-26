import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserUseViewState } from '@shared/browser-use'
import i18n from '../i18n'
import { AgentBrowserFloatingPreview } from './AgentBrowserFloatingPreview'

function state(overrides: Partial<BrowserUseViewState> = {}): BrowserUseViewState {
  return {
    contractVersion: 1,
    capabilityStatus: 'available',
    sessionId: 'session-1234567890',
    threadId: 'thread-1',
    lifecycle: 'ready',
    controlOwner: 'agent',
    visible: false,
    mounted: false,
    mode: 'public',
    tabs: [{
      id: 'tab-1',
      title: 'Example',
      origin: 'https://example.com',
      sanitizedUrl: 'https://example.com',
      active: true,
      loading: false,
      canGoBack: false,
      canGoForward: false
    }],
    activeTabId: 'tab-1',
    updatedAt: '2026-07-26T00:00:00.000Z',
    ...overrides
  }
}

describe('AgentBrowserFloatingPreview', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('starts collapsed, can be opened and closed, and does not clear the session', async () => {
    const clearBrowserUse = vi.fn()
    const setBrowserUseControl = vi.fn(async () => state({ controlOwner: 'manual' }))
    vi.stubGlobal('window', {
      kunGui: {
        getBrowserUseState: vi.fn(async () => state()),
        onBrowserUseState: vi.fn(() => vi.fn()),
        mountBrowserUse: vi.fn(async () => state()),
        decideBrowserUseAction: vi.fn(),
        decideBrowserUseOrigin: vi.fn(),
        navigateBrowserUse: vi.fn(),
        setBrowserUseControl,
        stopBrowserUse: vi.fn(),
        clearBrowserUse
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })

    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(createElement(AgentBrowserFloatingPreview, {
        activeThreadId: 'thread-1'
      }))
    })

    const show = renderer.root.findByProps({ 'aria-label': 'Show Agent Browser' })
    expect(show).toBeTruthy()
    await act(async () => show.props.onClick())
    const preview = renderer.root.findByProps({ 'aria-label': 'Agent Browser' })
    expect(preview.props.className).toContain('aspect-video')
    expect(renderer.root.findByProps({
      'data-browser-use-variant': 'pip'
    })).toBeTruthy()
    const takeControl = renderer.root.findByProps({ 'aria-label': 'Take control' })
    await act(async () => takeControl.props.onClick())
    expect(setBrowserUseControl).toHaveBeenCalledWith({
      threadId: 'thread-1',
      controlOwner: 'manual'
    })
    const close = renderer.root.findByProps({
      'aria-label': 'Close preview and keep safe work running in the background'
    })
    await act(async () => close.props.onClick())
    expect(renderer.root.findByProps({ 'aria-label': 'Show Agent Browser' })).toBeTruthy()
    expect(clearBrowserUse).not.toHaveBeenCalled()
  })

  it('opens automatically when Main requests a visible approval surface', async () => {
    let publish: ((next: BrowserUseViewState) => void) | undefined
    vi.stubGlobal('window', {
      kunGui: {
        getBrowserUseState: vi.fn(async () => state()),
        onBrowserUseState: vi.fn((handler: (next: BrowserUseViewState) => void) => {
          publish = handler
          return vi.fn()
        }),
        mountBrowserUse: vi.fn(async () => state()),
        decideBrowserUseAction: vi.fn(),
        decideBrowserUseOrigin: vi.fn(),
        navigateBrowserUse: vi.fn(),
        setBrowserUseControl: vi.fn(),
        stopBrowserUse: vi.fn(),
        clearBrowserUse: vi.fn()
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })

    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(createElement(AgentBrowserFloatingPreview, {
        activeThreadId: 'thread-1'
      }))
    })
    act(() => publish?.(state({ lifecycle: 'mount-required' })))

    expect(renderer.root.findByProps({ 'aria-label': 'Agent Browser' })).toBeTruthy()
    expect(renderer.root.findAllByProps({ 'aria-label': 'Show Agent Browser' })).toHaveLength(0)
    expect(renderer.root.findByProps({ 'aria-label': 'Stop' })).toBeTruthy()
    expect(renderer.root.findByProps({ 'aria-label': 'Clear session' })).toBeTruthy()
  })
})
