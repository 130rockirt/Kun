import { describe, expect, it } from 'vitest'
import { formatGrokBrowserAuthFailure } from './settings-section-providers-grok-login'

const labels: Record<string, string> = {
  grokAuthErrorBrowserOpen: 'Check the Windows default browser association, then retry.',
  grokAuthErrorDiscovery: 'Check the global proxy and network, then retry.',
  grokAuthErrorCancelled: 'Grok sign-in was cancelled.'
}

const t = (key: string): string => labels[key] ?? key

describe('formatGrokBrowserAuthFailure', () => {
  it('adds actionable Windows guidance to browser launch failures', () => {
    expect(formatGrokBrowserAuthFailure({
      ok: false,
      code: 'browser_open_failed',
      message: 'No application is associated with the specified file.'
    }, t)).toBe(
      'Check the Windows default browser association, then retry. '
      + 'No application is associated with the specified file.'
    )
  })

  it('identifies discovery failures as proxy or network failures', () => {
    expect(formatGrokBrowserAuthFailure({
      ok: false,
      code: 'discovery_failed',
      message: 'fetch failed'
    }, t)).toBe('Check the global proxy and network, then retry. fetch failed')
  })

  it('does not append the main-process cancellation detail', () => {
    expect(formatGrokBrowserAuthFailure({
      ok: false,
      code: 'cancelled',
      message: '已取消登录'
    }, t)).toBe('Grok sign-in was cancelled.')
  })
})
