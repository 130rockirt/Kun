import type { ComponentPrototypeMetadata } from '../agent/types'
import {
  artifactDesignMdPath,
  artifactDirPath
} from './design-artifact-persistence'
import { defaultDesignArtifactNode, createDesignArtifactId } from './design-types'
import { writeDesignWorkspaceFile } from './design-persistence-coordinator'
import { normalizeDesignWorkspaceRoot } from './design-workspace-lifecycle'
import { useDesignWorkspaceStore } from './design-workspace-store'

export type ComponentPrototypeCanvasImportResult = {
  artifactId: string
  relativePath: string
  documentId: string
  /** True when the prototype was already imported and only re-activated. */
  reused: boolean
}

const COMPONENT_PROTOTYPE_PATH_RE = /^\.kun-design\/component-prototypes\/[^/]+\/prototype\.html$/i

const MIN_PROTOTYPE_WIDTH = 280
const MAX_PROTOTYPE_WIDTH = 1_200
const MIN_PROTOTYPE_HEIGHT = 240
const MAX_PROTOTYPE_HEIGHT = 900

function safeComponentPrototypePath(path: string): string | null {
  const normalized = path.trim().replaceAll('\\', '/')
  if (!COMPONENT_PROTOTYPE_PATH_RE.test(normalized) || normalized.split('/').includes('..')) return null
  return normalized
}

function sameWorkspaceRoot(left: string, right: string): boolean {
  return normalizeDesignWorkspaceRoot(left) === normalizeDesignWorkspaceRoot(right)
}

function clampViewportSize(prototype: ComponentPrototypeMetadata): { width: number; height: number } {
  const width = Math.min(MAX_PROTOTYPE_WIDTH, Math.max(MIN_PROTOTYPE_WIDTH, Math.round(prototype.viewport.width)))
  const height = Math.min(MAX_PROTOTYPE_HEIGHT, Math.max(MIN_PROTOTYPE_HEIGHT, Math.round(prototype.viewport.height)))
  return { width, height }
}

/** Pick the active 设计稿, or create a real (non-transient) one when none exists. */
function ensurePersistentDocument(): string {
  const state = useDesignWorkspaceStore.getState()
  if (state.activeDocumentId && state.documents.some((document) => document.id === state.activeDocumentId)) {
    return state.activeDocumentId
  }
  if (state.documents.length > 0) {
    const documentId = state.documents[0].id
    state.switchActiveDocument(documentId)
    return documentId
  }
  return state.createDocument()
}

/**
 * Import a conversation component prototype into the Design workspace as a
 * first-class HTML artifact, then activate it so the canvas frame sync picks it
 * up. Reuses the artifact when the same source prototype was imported before.
 *
 * Never throws and never leaks read/write errors to the chat surface: any
 * failure returns null and leaves the Design store untouched.
 */
export async function importComponentPrototypeToDesignCanvas(options: {
  workspaceRoot: string
  prototype: ComponentPrototypeMetadata
}): Promise<ComponentPrototypeCanvasImportResult | null> {
  const workspaceRoot = options.workspaceRoot.trim()
  const sourcePath = safeComponentPrototypePath(options.prototype.relativePath)
  if (!workspaceRoot || !sourcePath) return null
  if (options.prototype.status !== 'completed') return null

  const store = useDesignWorkspaceStore.getState()
  if (!sameWorkspaceRoot(store.workspaceRoot, workspaceRoot)) {
    store.setWorkspaceRoot(workspaceRoot)
    useDesignWorkspaceStore.setState({ settingsLoaded: false })
  }
  // Settings load can be unavailable (or point at a different configured root);
  // hydration below is the actual gate for the artifact index.
  try {
    await useDesignWorkspaceStore.getState().loadDesignSettings()
  } catch {
    // Keep the explicit prototype workspace and hydrate from disk directly.
  }
  const afterSettings = useDesignWorkspaceStore.getState()
  if (!sameWorkspaceRoot(afterSettings.workspaceRoot, workspaceRoot)) {
    afterSettings.setWorkspaceRoot(workspaceRoot)
  }
  await useDesignWorkspaceStore.getState().rehydrateArtifacts().catch(() => undefined)

  // Idempotent: re-activate the artifact that was already imported from this
  // prototype instead of creating a second copy.
  const hydrated = useDesignWorkspaceStore.getState()
  for (const document of hydrated.documents) {
    const existing = document.artifacts.find((artifact) => artifact.importedFromPath === sourcePath)
    if (!existing) continue
    if (document.id !== hydrated.activeDocumentId) hydrated.switchActiveDocument(document.id)
    useDesignWorkspaceStore.getState().setActiveArtifact(existing.id)
    return {
      artifactId: existing.id,
      relativePath: existing.relativePath,
      documentId: document.id,
      reused: true
    }
  }

  if (typeof window.kunGui?.readWorkspaceFile !== 'function') return null
  const read = await window.kunGui
    .readWorkspaceFile({ path: sourcePath, workspaceRoot })
    .catch(() => null)
  if (!read || !read.ok || !read.content) return null

  const documentId = ensurePersistentDocument()
  const artifactId = createDesignArtifactId()
  const relativePath = `${artifactDirPath(documentId, artifactId)}/v1.html`
  const designMdPath = artifactDesignMdPath(documentId, artifactId)
  const write = await writeDesignWorkspaceFile({ path: relativePath, workspaceRoot, content: read.content })
  if (!write.ok) return null

  const createdAt = new Date().toISOString()
  const size = clampViewportSize(options.prototype)
  const active = useDesignWorkspaceStore.getState()
  const index = active.artifacts.length
  const node = { ...defaultDesignArtifactNode(index), ...size, sizeMode: 'manual' as const, viewMode: 'preview' as const }
  useDesignWorkspaceStore.getState().upsertArtifact({
    id: artifactId,
    kind: 'html',
    title: options.prototype.title,
    relativePath,
    createdAt,
    updatedAt: createdAt,
    versions: [{ id: `${artifactId}-v1`, relativePath, createdAt, summary: '' }],
    designMdPath,
    previewStatus: 'pending',
    node,
    importedFromPath: sourcePath
  })
  useDesignWorkspaceStore.getState().setActiveArtifact(artifactId)
  return { artifactId, relativePath, documentId, reused: false }
}
