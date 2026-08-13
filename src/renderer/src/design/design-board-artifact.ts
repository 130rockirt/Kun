import { createEmptyDocument, type CanvasShape } from './canvas/canvas-types'
import { serializeCanvasDocument } from './canvas/canvas-persistence'
import { createLinkedHtmlScreen } from './canvas/screen-lifecycle'
import { writeDesignWorkspaceFile } from './design-persistence-coordinator'
import { createDesignArtifactId, type DesignArtifact } from './design-types'
import { normalizeDesignWorkspaceRoot } from './design-workspace-lifecycle'
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

/**
 * Resolve the exact canvas artifact pinned by a locked task target. Unlike
 * {@link findDesignBoardArtifact} this never falls back to another board, so a
 * multi-board document keeps showing and editing the board the task locked.
 */
export function findDesignBoardArtifactById(
  artifacts: readonly DesignArtifact[],
  boardArtifactId: string
): (DesignArtifact & { kind: 'canvas' }) | null {
  if (!boardArtifactId) return null
  return artifacts.find((artifact): artifact is DesignArtifact & { kind: 'canvas' } =>
    artifact.kind === 'canvas' && artifact.id === boardArtifactId
  ) ?? null
}

type DesignBoardArtifact = DesignArtifact & { kind: 'canvas' }
const pendingDesignBoardArtifacts = new Map<string, Promise<DesignBoardArtifact | null>>()

export async function ensureDesignBoardArtifact(
  workspaceRoot: string,
  expectedDocumentId?: string
): Promise<DesignBoardArtifact | null> {
  const normalizedRoot = normalizeDesignWorkspaceRoot(workspaceRoot)
  if (!normalizedRoot) return null
  const initial = useDesignWorkspaceStore.getState()
  const documentId = expectedDocumentId?.trim() || initial.ensureActiveDocument()
  if (!documentId || useDesignWorkspaceStore.getState().activeDocumentId !== documentId) return null
  const key = `${normalizedRoot}\0${documentId}`
  const pending = pendingDesignBoardArtifacts.get(key)
  if (pending) return pending
  const creation = createDesignBoardArtifact(normalizedRoot, documentId)
  pendingDesignBoardArtifacts.set(key, creation)
  try {
    return await creation
  } finally {
    if (pendingDesignBoardArtifacts.get(key) === creation) pendingDesignBoardArtifacts.delete(key)
  }
}

async function createDesignBoardArtifact(
  workspaceRoot: string,
  documentId: string
): Promise<DesignBoardArtifact | null> {
  const store = useDesignWorkspaceStore.getState()
  if (normalizeDesignWorkspaceRoot(store.workspaceRoot) !== workspaceRoot ||
    store.activeDocumentId !== documentId) return null
  const existing = findDesignBoardArtifact(store.artifacts)
  if (existing) {
    if (store.activeArtifactId !== existing.id) store.setActiveArtifact(existing.id)
    return existing
  }

  const createdAt = new Date().toISOString()
  const artifactId = createDesignArtifactId()
  const relativePath = `.kun-design/${documentId}/${artifactId}/canvas.json`
  const artifact: DesignBoardArtifact = {
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
    workspaceRoot,
    content: serializeCanvasDocument(createEmptyDocument())
  })
  if (!write.ok) return null
  const latest = useDesignWorkspaceStore.getState()
  if (normalizeDesignWorkspaceRoot(latest.workspaceRoot) !== workspaceRoot ||
    latest.activeDocumentId !== documentId) return null
  latest.upsertArtifact(artifact)
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
