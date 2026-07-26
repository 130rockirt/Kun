import { describe, expect, it } from 'vitest'
import type { BrowserUseViewState } from '@shared/browser-use'
import {
  isBrowserUseSessionActive,
  shouldAutoOpenBrowserUsePreview
} from '../AgentBrowserFloatingPreview'

const activeState: BrowserUseViewState = {
  contractVersion: 1,
  capabilityStatus: 'available',
  sessionId: 'session-1234567890',
  threadId: 'thread-1',
  lifecycle: 'ready',
  controlOwner: 'agent',
  visible: false,
  mounted: false,
  mode: 'public',
  tabs: [],
  updatedAt: '2026-07-26T00:00:00.000Z'
}

describe('Agent Browser floating preview activation', () => {
  it('keeps an ordinary active session in the background by default', () => {
    expect(isBrowserUseSessionActive(activeState, 'thread-1')).toBe(true)
    expect(shouldAutoOpenBrowserUsePreview(activeState, 'thread-1')).toBe(false)
    expect(isBrowserUseSessionActive(activeState, 'thread-2')).toBe(false)
    expect(isBrowserUseSessionActive(activeState, null)).toBe(false)
    expect(isBrowserUseSessionActive({
      ...activeState,
      sessionId: undefined,
      lifecycle: 'closed'
    }, 'thread-1')).toBe(false)
  })

  it('opens only when the owning active thread needs a visible approval surface', () => {
    expect(shouldAutoOpenBrowserUsePreview({
      ...activeState,
      lifecycle: 'mount-required'
    }, 'thread-1')).toBe(true)
    expect(shouldAutoOpenBrowserUsePreview({
      ...activeState,
      lifecycle: 'waiting-origin-consent',
      pendingOriginConsent: {
        id: 'request-12345678',
        sessionId: 'session-1234567890',
        threadId: 'thread-1',
        origin: 'http://127.0.0.1:4173',
        sanitizedUrl: 'http://127.0.0.1:4173',
        mode: 'local-development',
        createdAt: '2026-07-26T00:00:00.000Z'
      }
    }, 'thread-1')).toBe(true)
    expect(shouldAutoOpenBrowserUsePreview({
      ...activeState,
      lifecycle: 'mount-required'
    }, 'thread-2')).toBe(false)
  })
})
