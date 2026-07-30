import { describe, expect, it } from 'vitest'
import {
  KUN_TOOL_PERMISSION_MODES,
  kunToolPermissionModeFromSettings,
  kunToolPermissionModeSettings
} from './policy.js'

describe('tool permission preset contract', () => {
  it('keeps the three GUI and TUI modes in their shared presentation order', () => {
    expect(KUN_TOOL_PERMISSION_MODES).toEqual([
      'ask-for-approval',
      'approve-for-me',
      'full-access'
    ])
  })

  it.each([
    ['ask-for-approval', 'on-request', 'workspace-write', 'user'],
    ['approve-for-me', 'on-request', 'workspace-write', 'agent'],
    ['full-access', 'auto', 'danger-full-access', 'user']
  ] as const)(
    'maps %s to the shared complete permission snapshot',
    (mode, approvalPolicy, sandboxMode, approvalReviewer) => {
      expect(kunToolPermissionModeSettings(mode)).toEqual({
        approvalPolicy,
        sandboxMode,
        approvalReviewer
      })
    }
  )

  it.each([
    [
      { approvalPolicy: 'on-request', sandboxMode: 'workspace-write', approvalReviewer: 'user' },
      'ask-for-approval'
    ],
    [
      { approvalPolicy: 'on-request', sandboxMode: 'workspace-write', approvalReviewer: 'agent' },
      'approve-for-me'
    ],
    [
      { approvalPolicy: 'auto', sandboxMode: 'danger-full-access', approvalReviewer: 'user' },
      'full-access'
    ]
  ] as const)('round-trips canonical settings for %s', (settings, expected) => {
    expect(kunToolPermissionModeFromSettings(settings)).toBe(expected)
  })

  it.each([
    [{ approvalPolicy: 'never', sandboxMode: 'read-only' }, 'ask-for-approval'],
    [{ approvalPolicy: 'suggest', sandboxMode: 'external-sandbox' }, 'ask-for-approval'],
    [{ approvalPolicy: 'never', sandboxMode: 'workspace-write' }, 'ask-for-approval'],
    [{ approvalPolicy: 'always', sandboxMode: 'read-only' }, 'ask-for-approval'],
    [{ approvalPolicy: 'untrusted', sandboxMode: 'external-sandbox' }, 'ask-for-approval'],
    [
      { approvalPolicy: 'auto', sandboxMode: 'danger-full-access', approvalReviewer: 'agent' },
      'ask-for-approval'
    ]
  ] as const)('projects custom raw settings without changing the input: %o', (settings, expected) => {
    const original = { ...settings }
    expect(kunToolPermissionModeFromSettings(settings)).toBe(expected)
    expect(settings).toEqual(original)
  })

  it('treats a missing legacy reviewer as user without mutating the input', () => {
    const settings = {
      approvalPolicy: 'on-request' as const,
      sandboxMode: 'workspace-write' as const
    }
    expect(kunToolPermissionModeFromSettings(settings)).toBe('ask-for-approval')
    expect(settings).not.toHaveProperty('approvalReviewer')
  })
})
