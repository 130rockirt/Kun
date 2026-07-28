export type TrayQuotaRectangle = {
  x: number
  y: number
  width: number
  height: number
}

export type TrayQuotaSize = {
  width: number
  height: number
}

export type TrayQuotaPositionInput = {
  trayBounds: TrayQuotaRectangle
  windowSize: TrayQuotaSize
  workArea: TrayQuotaRectangle
  gap?: number
  margin?: number
}

export function resolveTrayQuotaPopoverPosition({
  trayBounds,
  windowSize,
  workArea,
  gap = 8,
  margin = 8
}: TrayQuotaPositionInput): { x: number; y: number } {
  const minX = workArea.x + margin
  const maxX = workArea.x + workArea.width - windowSize.width - margin
  const centeredX = trayBounds.x + (trayBounds.width - windowSize.width) / 2
  const x = clamp(Math.round(centeredX), minX, Math.max(minX, maxX))

  const minY = workArea.y + margin
  const maxY = workArea.y + workArea.height - windowSize.height - margin
  const below = trayBounds.y + trayBounds.height + gap
  const above = trayBounds.y - windowSize.height - gap
  const hasRoomBelow = below <= maxY
  const preferredY = hasRoomBelow ? below : above

  return {
    x,
    y: clamp(Math.round(preferredY), minY, Math.max(minY, maxY))
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
