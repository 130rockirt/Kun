import { describe, expect, it } from 'vitest'
import {
  canvasSurfacePersistsDesignSystem,
  canvasSurfaceScopesKeyboard,
  canvasSurfaceSupportsExport,
  isDesignCanvasSurface,
  isDiagramCanvasSurface
} from './canvas-surface'

describe('canvas surface capabilities', () => {
  it('keeps Work on the lightweight diagram capability set', () => {
    expect(isDiagramCanvasSurface('work')).toBe(true)
    expect(isDesignCanvasSurface('work')).toBe(false)
    expect(canvasSurfaceScopesKeyboard('work')).toBe(true)
    expect(canvasSurfaceSupportsExport('work')).toBe(true)
  })

  it('persists per-resource diagram systems while Design uses project sync', () => {
    expect(canvasSurfacePersistsDesignSystem('design')).toBe(false)
    expect(canvasSurfacePersistsDesignSystem('code')).toBe(true)
    expect(canvasSurfacePersistsDesignSystem('work')).toBe(true)
  })
})
