import { describe, expect, it } from 'vitest'
import { resolveManagerDataRequestTimeoutMs } from './remote-data-stores.js'

describe('resolveManagerDataRequestTimeoutMs', () => {
  it('allows cold timeline scans to outlive ordinary manager data requests', () => {
    expect(resolveManagerDataRequestTimeoutMs('session', 'highestSeq')).toBe(120_000)
    expect(resolveManagerDataRequestTimeoutMs('session', 'loadItemPage')).toBe(120_000)
    expect(resolveManagerDataRequestTimeoutMs('session', 'loadItems')).toBe(30_000)
    expect(resolveManagerDataRequestTimeoutMs('thread', 'get')).toBe(30_000)
  })
})
