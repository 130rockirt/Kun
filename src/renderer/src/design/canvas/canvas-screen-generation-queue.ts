import { isHtmlFrame, type CanvasDocument } from './canvas-types'

export type PendingScreenGeneration = {
  shapeId: string
  userPrompt: string
  brief?: string
}

export function takeNextReadyScreenGeneration({
  pendingScreens,
  document,
  currentTurnId,
  busy = false,
  pendingRuntimeWork = false,
  htmlArtifactIds
}: {
  pendingScreens: PendingScreenGeneration[]
  document: CanvasDocument
  currentTurnId: string | null
  busy?: boolean
  pendingRuntimeWork?: boolean
  htmlArtifactIds?: ReadonlySet<string>
}): PendingScreenGeneration | null {
  if (currentTurnId || busy || pendingRuntimeWork) return null
  while (pendingScreens.length > 0) {
    const next = pendingScreens.shift()
    if (!next) continue
    const shape = document.objects[next.shapeId]
    if (!shape || !isHtmlFrame(shape) || !shape.htmlArtifactId) continue
    if (htmlArtifactIds && !htmlArtifactIds.has(shape.htmlArtifactId)) continue
    return next
  }
  return null
}
