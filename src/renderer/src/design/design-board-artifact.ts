import { createEmptyDocument, type CanvasShape } from './canvas/canvas-types'
import { serializeCanvasDocument } from './canvas/canvas-persistence'
import { createLinkedHtmlScreen } from './canvas/screen-lifecycle'
import { writeDesignWorkspaceFile } from './design-persistence-coordinator'
import { createDesignArtifactId, type DesignArtifact } from './design-types'
import { useDesignWorkspaceStore } from './design-workspace-store'

export type CreateScreenFrameArtifactResult = {
  artifactId: string
  relativePath: string
  designMdPath: string
  shape: CanvasShape
}

export function findDesignBoardArtifact(
  artifacts: readonly DesignArtifact[]
): (DesignArtifact & { kind: 'canvas' }) | null {
  const boards = artifacts.filter((artifact): artifact is DesignArtifact & { kind: 'canvas' } =>
    artifact.kind === 'canvas'
  )
  if (boards.length === 0) return null
  return [...boards].sort(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt)
  )[0] ?? null
}

export async function ensureDesignBoardArtifact(
  workspaceRoot: string
): Promise<(DesignArtifact & { kind: 'canvas' }) | null> {
  const trimmedRoot = workspaceRoot.trim()
  if (!trimmedRoot) return null

  const store = useDesignWorkspaceStore.getState()
  const existing = findDesignBoardArtifact(store.artifacts)
  if (existing) {
    if (store.activeArtifactId !== existing.id) store.setActiveArtifact(existing.id)
    return existing
  }

  const docId = store.ensureActiveDocument()
  const createdAt = new Date().toISOString()
  const artifactId = createDesignArtifactId()
  const relativePath = `.kun-design/${docId}/${artifactId}/canvas.json`
  const artifact: DesignArtifact & { kind: 'canvas' } = {
    id: artifactId,
    kind: 'canvas',
    title: 'Design board',
    relativePath,
    createdAt,
    updatedAt: createdAt,
    versions: [{ id: `${artifactId}-v1`, relativePath, createdAt, summary: '' }]
  }

  const write = await writeDesignWorkspaceFile({
    path: relativePath,
    workspaceRoot: trimmedRoot,
    content: serializeCanvasDocument(createEmptyDocument())
  })
  if (!write.ok) return null

  useDesignWorkspaceStore.getState().upsertArtifact(artifact)
  return artifact
}

export function createScreenFrameArtifact(options: {
  boardArtifactId: string
  brief?: string
  title?: string
  width?: number
  height?: number
  x?: number
  y?: number
}): CreateScreenFrameArtifactResult {
  const created = createLinkedHtmlScreen({
    boardArtifactId: options.boardArtifactId,
    name: options.title,
    brief: options.brief,
    x: options.x,
    y: options.y,
    width: options.width,
    height: options.height
  })
  if (!created) throw new Error('Cannot create screen artifact')
  return created
}
