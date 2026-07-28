export const DEFAULT_GRAPH_INSPECTOR_WIDTH = 340
export const MIN_GRAPH_INSPECTOR_WIDTH = 220
export const MAX_GRAPH_INSPECTOR_WIDTH = 560

const MIN_CANVAS_WIDTH = 240
const PREFERRED_INSPECTOR_MIN = 260

export function clampGraphInspectorWidth(
  requested: number,
  containerWidth: number
): number {
  const maximum = Math.max(
    MIN_GRAPH_INSPECTOR_WIDTH,
    Math.min(
      MAX_GRAPH_INSPECTOR_WIDTH,
      Math.floor(containerWidth * 0.58),
      containerWidth - MIN_CANVAS_WIDTH
    )
  )
  const minimum = Math.min(PREFERRED_INSPECTOR_MIN, maximum)
  return Math.min(maximum, Math.max(minimum, Math.round(requested)))
}
