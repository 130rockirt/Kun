import { describe, expect, it } from 'vitest'
import {
  BrowserUseActionInput,
  BrowserUseBridgeRequest,
  redactBrowserUseActionForPersistence,
  redactBrowserUseUrl,
  signBrowserUseKunApprovalGrant,
  verifyBrowserUseKunApprovalGrant
} from './browser-use.js'
import { ToolOperationJournal } from '../reliability/operation-journal.js'

const expectedTarget = {
  sessionId: 'session-1234567890',
  tabId: 'tab-1',
  documentGeneration: 3,
  origin: 'https://example.com',
  sanitizedUrl: 'https://example.com/form',
  role: 'textbox',
  name: 'Public note'
}

describe('BrowserUseActionInput', () => {
  it('accepts only the stable bounded action catalog', () => {
    expect(BrowserUseActionInput.parse({ action: 'snapshot' })).toEqual({ action: 'snapshot' })
    expect(BrowserUseActionInput.parse({
      action: 'type',
      ref: 'opaque-reference-1234',
      expectedTarget,
      text: 'bounded text'
    })).toEqual({
      action: 'type',
      ref: 'opaque-reference-1234',
      expectedTarget,
      text: 'bounded text'
    })
  })

  it.each([
    { action: 'click', ref: 'opaque-reference-1234', expectedTarget, selector: '#buy' },
    { action: 'snapshot', script: 'document.cookie' },
    { action: 'open', url: 'file:///etc/passwd' },
    { action: 'open', url: 'https://user:secret@example.com/private' },
    {
      action: 'type',
      ref: 'opaque-reference-1234',
      expectedTarget,
      text: 'x',
      filePath: '/tmp/x'
    },
    {
      action: 'type',
      ref: 'opaque-reference-1234',
      expectedTarget,
      text: 'x',
      submit: true
    },
    { action: 'cdp', method: 'Runtime.evaluate' }
  ])('rejects ambient or executable input %#', (input) => {
    expect(BrowserUseActionInput.safeParse(input).success).toBe(false)
  })

  it.each([
    { action: 'click', ref: 'opaque-reference-1234' },
    { action: 'type', ref: 'opaque-reference-1234', text: 'hello' },
    { action: 'select', ref: 'opaque-reference-1234', value: 'one' },
    { action: 'press', ref: 'opaque-reference-1234', key: 'Enter' }
  ])('rejects interaction actions without the exact snapshot target binding %#', (input) => {
    expect(BrowserUseActionInput.safeParse(input).success).toBe(false)
  })

  it('requires thread scope and a UUID request id at the bridge boundary', () => {
    expect(BrowserUseBridgeRequest.safeParse({
      contractVersion: 2,
      requestId: 'not-a-uuid',
      threadId: '',
      turnId: '',
      action: { action: 'snapshot' }
    }).success).toBe(false)
    expect(BrowserUseBridgeRequest.safeParse({
      contractVersion: 2,
      requestId: '00000000-0000-4000-8000-000000000000',
      threadId: 'thread-1',
      turnId: 'turn-1',
      action: { action: 'snapshot' },
      kunApprovalMode: 'full-access'
    }).success).toBe(false)
  })

  it('requires a short action-bound Kun grant for approval-worthy bridge actions', () => {
    const action = { action: 'open' as const, url: 'https://example.test/path' }
    const signingKey = 's'.repeat(43)
    const base = {
      contractVersion: 2 as const,
      requestId: '00000000-0000-4000-8000-000000000000',
      threadId: 'thread-1',
      turnId: 'turn-1',
      action
    }
    expect(BrowserUseBridgeRequest.safeParse(base).success).toBe(false)
    const grant = signBrowserUseKunApprovalGrant({
      id: `appr_${'a'.repeat(32)}`,
      source: 'agent',
      toolName: 'browser_use',
      threadId: 'thread-1',
      turnId: 'turn-1',
      callId: 'call-open',
      argumentsHash: ToolOperationJournal.argsHash(action),
      issuedAt: '2026-07-30T00:00:00.000Z',
      expiresAt: '2026-07-30T00:02:00.000Z'
    }, signingKey)
    expect(BrowserUseBridgeRequest.safeParse({
      ...base,
      kunApprovalMode: 'agent',
      kunApprovalGrant: grant
    }).success).toBe(true)
    expect(verifyBrowserUseKunApprovalGrant(grant, signingKey)).toBe(true)
    expect(verifyBrowserUseKunApprovalGrant({
      ...grant,
      turnId: 'turn-substituted'
    }, signingKey)).toBe(false)
    expect(verifyBrowserUseKunApprovalGrant({
      ...grant,
      source: 'user'
    }, signingKey)).toBe(false)
    expect(BrowserUseBridgeRequest.safeParse({
      ...base,
      kunApprovalMode: 'agent',
      kunApprovalGrant: {
        ...grant,
        expiresAt: '2026-07-30T00:20:00.000Z'
      }
    }).success).toBe(false)
  })
})

describe('redactBrowserUseUrl', () => {
  it('omits query strings and fragments', () => {
    expect(redactBrowserUseUrl('https://example.com/path?q=secret#token'))
      .toBe('https://example.com/path')
  })

  it('redacts persisted query strings and entered values while preserving executable shape', () => {
    expect(redactBrowserUseActionForPersistence({
      action: 'open',
      url: 'https://example.com/path?q=secret#token'
    })).toEqual({ action: 'open', url: 'https://example.com/path' })
    expect(redactBrowserUseActionForPersistence({
      action: 'type',
      ref: 'opaque-reference-1234',
      expectedTarget,
      text: 'private value'
    })).toEqual({
      action: 'type',
      ref: 'opaque-reference-1234',
      expectedTarget: {
        ...expectedTarget,
        name: '[redacted]'
      },
      text: '[redacted]'
    })
  })
})
