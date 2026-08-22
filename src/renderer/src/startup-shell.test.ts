import { describe, expect, it, vi } from 'vitest'
import { startupPhaseLabel, startupShellAllowsWorkbench } from './startup-shell'

describe('desktop startup shell policy', () => {
  it('allows the workbench only after the ready phase', () => {
    expect(startupShellAllowsWorkbench('bootstrapping')).toBe(false)
    expect(startupShellAllowsWorkbench('runtime_handoff')).toBe(false)
    expect(startupShellAllowsWorkbench('runtime_starting')).toBe(false)
    expect(startupShellAllowsWorkbench('recovery_required')).toBe(false)
    expect(startupShellAllowsWorkbench('ready')).toBe(true)
  })

  it('uses actionable but non-sensitive phase labels', () => {
    expect(startupPhaseLabel('runtime_handoff')).toContain('runtime')
    expect(startupPhaseLabel('recovery_required')).toContain('recovery')
    expect(JSON.stringify(startupPhaseLabel('runtime_handoff'))).not.toContain('/Users/')
  })
})
