import { describe, expect, it } from 'vitest'
import {
  BrowserUseActionConsentRequestSchema,
  BrowserUseDecisionInputSchema,
  BrowserUseViewStateSchema
} from './browser-use'
import {
  defaultKunRuntimeSettings,
  mergeKunRuntimeSettings
} from './app-settings'

describe('Browser Use shared contracts', () => {
  it('does not admit a permanent consent decision', () => {
    expect(BrowserUseDecisionInputSchema.safeParse({
      threadId: 'thread-1',
      requestId: 'request-identifier-1234',
      decision: 'always-allow'
    }).success).toBe(false)
  })

  it('rejects unknown consent authority and bridge fields', () => {
    expect(BrowserUseActionConsentRequestSchema.safeParse({
      id: 'request-identifier-1234',
      sessionId: 'session-identifier-1234',
      threadId: 'thread-1',
      tabId: 'tab-1',
      origin: 'https://example.com',
      pageTitle: 'Example',
      action: 'click',
      risk: 'interaction',
      targetRole: 'button',
      targetName: 'Continue',
      targetRect: { x: 0, y: 0, width: 10, height: 10 },
      expiresAt: new Date().toISOString(),
      bridgeToken: 'must-never-cross-preload'
    }).success).toBe(false)
  })

  it('bounds tabs in renderer state', () => {
    const tabs = Array.from({ length: 4 }, (_, index) => ({
      id: `tab-${index}`,
      title: '',
      origin: 'https://example.com',
      sanitizedUrl: 'https://example.com/',
      active: index === 0,
      loading: false,
      canGoBack: false,
      canGoForward: false
    }))
    expect(BrowserUseViewStateSchema.safeParse({
      contractVersion: 1,
      capabilityStatus: 'available',
      lifecycle: 'ready',
      controlOwner: 'agent',
      visible: true,
      mounted: true,
      mode: 'public',
      tabs,
      updatedAt: new Date().toISOString()
    }).success).toBe(false)
  })
})

describe('Browser Use settings', () => {
  it('defaults to enabled auto-safe temporary public browsing', () => {
    expect(defaultKunRuntimeSettings().browserUse).toEqual({
      enabled: true,
      mode: 'public',
      approvalMode: 'auto-safe',
      maxTabs: 2,
      maxObservationActionsPerTurn: 30,
      maxInteractionActionsPerTurn: 12,
      maxSnapshotNodes: 250,
      maxSnapshotTextChars: 20_000,
      maxImageDimension: 1280,
      idleTimeoutMs: 300_000
    })
  })

  it('normalizes invalid and oversized values without changing computer use', () => {
    const current = defaultKunRuntimeSettings()
    const next = mergeKunRuntimeSettings(current, {
      browserUse: {
        enabled: true,
        mode: 'local-development',
        approvalMode: 'always-ask',
        maxTabs: 99,
        maxObservationActionsPerTurn: 999,
        maxInteractionActionsPerTurn: 999,
        maxSnapshotNodes: 9999,
        maxSnapshotTextChars: 999_999,
        maxImageDimension: 99,
        idleTimeoutMs: 1
      }
    })

    expect(next.browserUse).toEqual({
      enabled: true,
      mode: 'local-development',
      approvalMode: 'always-ask',
      maxTabs: 3,
      maxObservationActionsPerTurn: 100,
      maxInteractionActionsPerTurn: 50,
      maxSnapshotNodes: 500,
      maxSnapshotTextChars: 50_000,
      maxImageDimension: 320,
      idleTimeoutMs: 30_000
    })
    expect(next.computerUse).toEqual(current.computerUse)
  })
})
