import { describe, expect, it } from 'vitest'
import { isTrustedTrayQuotaSender, parseTrayQuotaDashboardUrl } from './tray-quota-ipc'

describe('tray quota IPC', () => {
  it('allows HTTPS provider dashboard URLs', () => {
    expect(parseTrayQuotaDashboardUrl('https://example.com/usage?tab=quota')).toBe(
      'https://example.com/usage?tab=quota'
    )
  })

  it('rejects insecure or malformed dashboard URLs', () => {
    expect(() => parseTrayQuotaDashboardUrl('http://example.com/usage')).toThrow(/HTTPS/)
    expect(() => parseTrayQuotaDashboardUrl('not a URL')).toThrow(/Invalid/)
  })

  it('only trusts the current tray window main frame', () => {
    const mainFrame = {}
    const webContents = {
      isDestroyed: () => false,
      mainFrame
    }
    const window = {
      isDestroyed: () => false,
      webContents
    }
    expect(isTrustedTrayQuotaSender(
      { sender: webContents, senderFrame: mainFrame } as never,
      window as never
    )).toBe(true)
    expect(isTrustedTrayQuotaSender(
      { sender: webContents, senderFrame: {} } as never,
      window as never
    )).toBe(false)
    expect(isTrustedTrayQuotaSender(
      { sender: { isDestroyed: () => false }, senderFrame: mainFrame } as never,
      window as never
    )).toBe(false)
  })
})
