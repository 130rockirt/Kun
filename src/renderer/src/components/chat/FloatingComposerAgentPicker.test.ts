import { describe, expect, it } from 'vitest'
import type { KunSubagentProfileV1 } from '@shared/app-settings'
import {
  composerAgentPickerSurface,
  primaryAgentAvailableOnSurface
} from '../../lib/subagent-profile-surface'

function profile(patch: Partial<KunSubagentProfileV1>): KunSubagentProfileV1 {
  return {
    id: 'profile',
    enabled: true,
    name: 'Profile',
    mode: 'primary',
    toolPolicy: 'inherit',
    ...patch
  }
}

describe('FloatingComposerAgentPicker surface filtering', () => {
  it('uses the owning standalone surface before the optional task selector', () => {
    expect(composerAgentPickerSurface('write')).toBe('write')
    expect(composerAgentPickerSurface('design')).toBe('design')
    expect(composerAgentPickerSurface('chat', 'design')).toBe('design')
    expect(composerAgentPickerSurface('chat')).toBe('code')
  })

  it('inherits shared profiles and rejects profiles assigned to another surface', () => {
    expect(primaryAgentAvailableOnSurface(profile({ surfaces: ['shared'] }), 'write')).toBe(true)
    expect(primaryAgentAvailableOnSurface(profile({ surfaces: ['write'] }), 'write')).toBe(true)
    expect(primaryAgentAvailableOnSurface(profile({ surfaces: ['code'] }), 'write')).toBe(false)
    expect(primaryAgentAvailableOnSurface(profile({ surfaces: ['write'] }), 'code')).toBe(false)
    expect(primaryAgentAvailableOnSurface(profile({ surfaces: ['write'] }), 'design')).toBe(false)
    expect(primaryAgentAvailableOnSurface(profile({ enabled: false, surfaces: ['write'] }), 'write'))
      .toBe(false)
  })

  it('keeps missing custom surface metadata backward-compatible as shared', () => {
    expect(primaryAgentAvailableOnSurface(profile({ id: 'custom-primary' }), 'write')).toBe(true)
    expect(primaryAgentAvailableOnSurface(profile({ surfaces: [] }), 'write')).toBe(false)
  })
})
