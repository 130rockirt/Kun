import { describe, expect, it } from 'vitest'
import { resolveTurnPersona } from './chat-store-thread-send'

describe('composer persona experiment gate', () => {
  it('uses a queued or turn persona while the experiment is enabled', () => {
    expect(resolveTurnPersona(true, '  queued  ', 'override')).toBe('queued')
    expect(resolveTurnPersona(true, undefined, '  override  ')).toBe('override')
  })

  it('drops both new and already queued personas when the experiment is disabled', () => {
    expect(resolveTurnPersona(false, undefined, 'override')).toBe('')
    expect(resolveTurnPersona(false, 'queued', 'override')).toBe('')
  })

  it('keeps a bounded Work persona when the Code experiment is disabled', () => {
    expect(resolveTurnPersona(false, undefined, '  Work editor  ', true)).toBe('Work editor')
    expect(resolveTurnPersona(false, undefined, 'p'.repeat(2_100), true)).toHaveLength(2_000)
  })
})
