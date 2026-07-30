export const DEFAULT_GRAPH_INSPECTOR_WIDTH = 344
export const MIN_GRAPH_INSPECTOR_WIDTH = 280
export const MAX_GRAPH_INSPECTOR_WIDTH = 480
export const GRAPH_INSPECTOR_OVERLAY_BREAKPOINT = 760

const MIN_CANVAS_WIDTH = 420

export function clampGraphInspectorWidth(
  requested: number,
  containerWidth: number
): number {
  const maximum = Math.max(
    MIN_GRAPH_INSPECTOR_WIDTH,
    Math.min(
      MAX_GRAPH_INSPECTOR_WIDTH,
      Math.floor(containerWidth * 0.42),
      containerWidth - MIN_CANVAS_WIDTH
    )
  )
  const minimum = Math.min(MIN_GRAPH_INSPECTOR_WIDTH, maximum)
  return Math.min(maximum, Math.max(minimum, Math.round(requested)))
}
