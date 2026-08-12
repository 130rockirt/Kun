/** Product surfaces that can host the shared canvas renderer. */
export type CanvasSurface = 'design' | 'code' | 'work'

export function isDesignCanvasSurface(surface: CanvasSurface): boolean {
  return surface === 'design'
}

/** Code and Work use the lightweight diagram/whiteboard capability set. */
export function isDiagramCanvasSurface(surface: CanvasSurface): boolean {
  return surface === 'code' || surface === 'work'
}

export function canvasSurfaceScopesKeyboard(surface: CanvasSurface): boolean {
  return isDiagramCanvasSurface(surface)
}

export function canvasSurfaceSupportsExport(surface: CanvasSurface): boolean {
  return isDiagramCanvasSurface(surface)
}

export function canvasSurfacePersistsDesignSystem(surface: CanvasSurface): boolean {
  return isDiagramCanvasSurface(surface)
}
