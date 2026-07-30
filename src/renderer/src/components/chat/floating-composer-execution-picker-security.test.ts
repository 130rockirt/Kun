import { describe, expect, it, vi } from 'vitest'
import { applyTrustedComposerExecutionChange } from './FloatingComposerExecutionPicker'

describe('FloatingComposer execution security', () => {
  it('does not apply full-access mode from a Direct DOM synthetic click', () => {
    const onChange = vi.fn()
    const fullAccess = {
      approvalPolicy: 'auto' as const,
      sandboxMode: 'danger-full-access' as const,
      approvalReviewer: 'user' as const
    }

    expect(applyTrustedComposerExecutionChange({ isTrusted: false }, fullAccess, onChange)).toBe(false)
    expect(onChange).not.toHaveBeenCalled()

    expect(applyTrustedComposerExecutionChange({ isTrusted: true }, fullAccess, onChange)).toBe(true)
    expect(onChange).toHaveBeenCalledWith(fullAccess)
  })
})
