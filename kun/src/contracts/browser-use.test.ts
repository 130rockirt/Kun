import { describe, expect, it } from 'vitest'
import {
  BrowserUseActionInput,
  BrowserUseBridgeRequest,
  redactBrowserUseActionForPersistence,
  redactBrowserUseUrl
} from './browser-use.js'

describe('BrowserUseActionInput', () => {
  it('accepts only the stable bounded action catalog', () => {
    expect(BrowserUseActionInput.parse({ action: 'snapshot' })).toEqual({ action: 'snapshot' })
    expect(BrowserUseActionInput.parse({
      action: 'type',
      ref: 'opaque-reference-1234',
      text: 'bounded text'
    })).toEqual({
      action: 'type',
      ref: 'opaque-reference-1234',
      text: 'bounded text'
    })
  })

  it.each([
    { action: 'click', ref: 'opaque-reference-1234', selector: '#buy' },
    { action: 'snapshot', script: 'document.cookie' },
    { action: 'open', url: 'file:///etc/passwd' },
    { action: 'open', url: 'https://user:secret@example.com/private' },
    { action: 'type', ref: 'opaque-reference-1234', text: 'x', filePath: '/tmp/x' },
    { action: 'type', ref: 'opaque-reference-1234', text: 'x', submit: true },
    { action: 'cdp', method: 'Runtime.evaluate' }
  ])('rejects ambient or executable input %#', (input) => {
    expect(BrowserUseActionInput.safeParse(input).success).toBe(false)
  })

  it('requires thread scope and a UUID request id at the bridge boundary', () => {
    expect(BrowserUseBridgeRequest.safeParse({
      contractVersion: 1,
      requestId: 'not-a-uuid',
      threadId: '',
      turnId: '',
      action: { action: 'snapshot' }
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
      text: 'private value'
    })).toEqual({
      action: 'type',
      ref: 'opaque-reference-1234',
      text: '[redacted]'
    })
  })
})
