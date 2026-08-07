import { describe, expect, test } from 'vitest'
import { isModelConnectionProfileUsable } from './model-connections.js'

describe('model connection usability', () => {
  test('keeps legacy configured snapshots without credential status usable', () => {
    expect(isModelConnectionProfileUsable({ configured: true })).toBe(true)
    expect(isModelConnectionProfileUsable({ configured: true, credentialStatus: 'ready' })).toBe(true)
  })

  test.each(['missing', 'unreadable'] as const)(
    'rejects configured profiles whose credential is %s',
    (credentialStatus) => {
      expect(isModelConnectionProfileUsable({ configured: true, credentialStatus })).toBe(false)
    }
  )

  test('does not make an unconfigured profile usable from credential health alone', () => {
    expect(isModelConnectionProfileUsable({ configured: false, credentialStatus: 'ready' })).toBe(false)
  })
})
