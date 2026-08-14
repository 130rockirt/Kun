import { describe, expect, it, vi } from 'vitest'
import { focusActiveDesignComposer } from './useDesignComposerContextState'

describe('focusActiveDesignComposer', () => {
  it('prefers the production floating composer over the legacy design rail', () => {
    const floating = { focus: vi.fn(), closest: vi.fn(() => null) }
    const legacy = { focus: vi.fn(), closest: vi.fn(() => null) }
    const browserDocument = {
      querySelectorAll: vi.fn((selector: string) => (
        selector.startsWith('[data-primary-floating-composer]')
          ? [floating]
          : selector.startsWith('[data-design-rail-composer]') ? [legacy] : []
      ))
    } as unknown as Document

    expect(focusActiveDesignComposer(browserDocument)).toBe(true)
    expect(floating.focus).toHaveBeenCalledOnce()
    expect(legacy.focus).not.toHaveBeenCalled()
  })

  it('falls back to the legacy rail when the production composer is absent', () => {
    const legacy = { focus: vi.fn(), closest: vi.fn(() => null) }
    const browserDocument = {
      querySelectorAll: vi.fn((selector: string) => (
        selector.startsWith('[data-design-rail-composer]') ? [legacy] : []
      ))
    } as unknown as Document

    expect(focusActiveDesignComposer(browserDocument)).toBe(true)
    expect(legacy.focus).toHaveBeenCalledOnce()
  })

  it('focuses the visible primary composer when side composers appear earlier in the DOM', () => {
    const side = { focus: vi.fn(), closest: vi.fn(() => null) }
    const hiddenPrimary = {
      focus: vi.fn(),
      closest: vi.fn(() => null),
      checkVisibility: vi.fn(() => false)
    }
    const visiblePrimary = {
      focus: vi.fn(),
      closest: vi.fn(() => null),
      checkVisibility: vi.fn(() => true)
    }
    const browserDocument = {
      querySelectorAll: vi.fn((selector: string) => (
        selector.startsWith('[data-primary-floating-composer]')
          ? [hiddenPrimary, visiblePrimary]
          : selector.startsWith('[data-floating-composer]') ? [side] : []
      ))
    } as unknown as Document

    expect(focusActiveDesignComposer(browserDocument)).toBe(true)
    expect(visiblePrimary.focus).toHaveBeenCalledOnce()
    expect(hiddenPrimary.focus).not.toHaveBeenCalled()
    expect(side.focus).not.toHaveBeenCalled()
  })
})
