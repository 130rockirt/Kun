import { describe, expect, it } from 'vitest'
import {
  KUN_TOOL_PERMISSION_MODES,
  kunToolPermissionModeFromSettings,
  kunToolPermissionModeSettings
} from './policy.js'

describe('tool permission preset contract', () => {
  it('keeps the six GUI and TUI modes in their shared presentation order', () => {
    expect(KUN_TOOL_PERMISSION_MODES).toEqual([
      'always-ask',
      'read-only',
      'sensitive-ask',
      'workspace-write',
      'trusted-workspace',
      'bypass'
    ])
  })

  it.each([
    ['always-ask', 'always', 'danger-full-access'],
    ['read-only', 'on-request', 'danger-full-access'],
    ['sensitive-ask', 'untrusted', 'danger-full-access'],
    ['workspace-write', 'on-request', 'workspace-write'],
    ['trusted-workspace', 'auto', 'workspace-write'],
    ['bypass', 'auto', 'danger-full-access']
  ] as const)('maps %s to the shared raw permission pair', (mode, approvalPolicy, sandboxMode) => {
    expect(kunToolPermissionModeSettings(mode)).toEqual({ approvalPolicy, sandboxMode })
  })

  it.each([
    [{ approvalPolicy: 'never', sandboxMode: 'read-only' }, 'read-only'],
    [{ approvalPolicy: 'suggest', sandboxMode: 'external-sandbox' }, 'read-only'],
    [{ approvalPolicy: 'never', sandboxMode: 'workspace-write' }, 'workspace-write'],
    [{ approvalPolicy: 'always', sandboxMode: 'read-only' }, 'always-ask'],
    [{ approvalPolicy: 'untrusted', sandboxMode: 'external-sandbox' }, 'sensitive-ask']
  ] as const)('projects custom raw settings without changing the input: %o', (settings, expected) => {
    const original = { ...settings }
    expect(kunToolPermissionModeFromSettings(settings)).toBe(expected)
    expect(settings).toEqual(original)
  })
})
