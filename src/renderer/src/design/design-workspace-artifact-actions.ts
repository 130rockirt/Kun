import {
  artifactDesignMdPathOf,
  deleteArtifactDir,
  persistArtifactMeta
} from './design-artifact-persistence'
import { defaultPreviewNodeSizeForDesignTarget } from './design-context'
import {
  defaultDesignArtifactNode,
  isFileDesignArtifactKind,
  type DesignDocument
} from './design-types'
import type { DesignWorkspaceState } from './design-workspace-store-types'
import { applyToActiveDoc } from './design-workspace-store/helpers'
import { duplicateHtmlArtifact } from './design-workspace-store/html-turn'
import { duplicateSvgArtifact } from './design-workspace-store/svg-turn'
import { markDesignArtifactRemoved } from './design-workspace-registry'
import { afterFlushingDesignWorkspace } from './design-workspace-lifecycle'

type StoreSet = (
  update: Partial<DesignWorkspaceState> | ((state: DesignWorkspaceState) => Partial<DesignWorkspaceState>)
) => void

type StoreBridge = {
  get: () => DesignWorkspaceState
  set: StoreSet
  persistIndex: () => void
  persistIndexNow: () => void
}

type ArtifactActions = Pick<
  DesignWorkspaceState,
  | 'setActiveArtifact'
  | 'upsertArtifact'
  | 'addArtifactVersion'
  | 'markImplemented'
  | 'removeArtifact'
  | 'renameArtifact'
  | 'setVersionSummary'
  | 'setArtifactPreviewStatus'
  | 'setDirectionStatus'
  | 'updateArtifactNode'
  | 'duplicateArtifact'
  | 'selectArtifactVersion'
>

export function createDesignWorkspaceArtifactActions({
  get,
  set,
  persistIndex,
  persistIndexNow
}: StoreBridge): ArtifactActions {
  return {
    setActiveArtifact: (artifactId) => {
      set((state) => {
        const index = state.documents.findIndex((document) => document.id === state.activeDocumentId)
        if (index === -1) return { activeArtifactId: artifactId, fileError: null }
        const document = state.documents[index]
        if (document.activeArtifactId === artifactId) return { fileError: null }
        const documents = state.documents.map((item, itemIndex) => (
          itemIndex === index ? { ...item, activeArtifactId: artifactId } : item
        ))
        return { documents, activeArtifactId: artifactId, fileError: null }
      })
      persistIndex()
    },

    upsertArtifact: (artifact) => {
      get().ensureActiveDocument()
      set((state) =>
        applyToActiveDoc(
          state,
          (artifacts) => {
            const existingIndex = artifacts.findIndex((item) => item.id === artifact.id)
            const existing = existingIndex >= 0 ? artifacts[existingIndex] : undefined
            const withDefaults = isFileDesignArtifactKind(artifact.kind)
              ? { ...artifact, designMdPath: artifact.designMdPath ?? artifactDesignMdPathOf(artifact.relativePath) }
              : artifact
            const defaultNode = withDefaults.kind === 'html'
              ? {
                  ...defaultDesignArtifactNode(existingIndex >= 0 ? existingIndex : artifacts.length),
                  ...defaultPreviewNodeSizeForDesignTarget(state.designContext.designTarget)
                }
              : defaultDesignArtifactNode(existingIndex >= 0 ? existingIndex : artifacts.length)
            const nextArtifact = withDefaults.node
              ? withDefaults
              : existing?.node
                ? { ...withDefaults, node: existing.node }
                : { ...withDefaults, node: defaultNode }
            return existing
              ? artifacts.map((item) => (item.id === artifact.id ? nextArtifact : item))
              : [nextArtifact, ...artifacts]
          },
          artifact.id
        )
      )
      const updated = get().artifacts.find((item) => item.id === artifact.id)
      if (updated) persistArtifactMeta(get().workspaceRoot, updated)
      persistIndex()
    },

    addArtifactVersion: (artifactId, version) => {
      set((state) =>
        applyToActiveDoc(state, (artifacts) =>
          artifacts.map((item) =>
            item.id === artifactId
              ? {
                  ...item,
                  relativePath: version.relativePath,
                  updatedAt: version.createdAt,
                  versions: [version, ...item.versions],
                  ...(isFileDesignArtifactKind(item.kind)
                    ? {
                        designMdPath: item.designMdPath ?? artifactDesignMdPathOf(version.relativePath),
                        previewStatus: 'pending' as const
                      }
                    : {})
                }
              : item
          )
        )
      )
      const updated = get().artifacts.find((item) => item.id === artifactId)
      if (updated) persistArtifactMeta(get().workspaceRoot, updated)
      persistIndex()
    },

    markImplemented: (artifactId, threadId, designSystemHash) => {
      set((state) => ({
        ...(designSystemHash ? { designSystemHash } : {}),
        ...applyToActiveDoc(state, (artifacts) =>
          artifacts.map((item) =>
            item.id === artifactId
              ? {
                  ...item,
                  implementedAt: new Date().toISOString(),
                  implementedThreadId: threadId,
                  ...(designSystemHash ? { implementedDesignSystemHash: designSystemHash } : {})
                }
              : item
          )
        )
      }))
      const updated = get().artifacts.find((item) => item.id === artifactId)
      if (updated) persistArtifactMeta(get().workspaceRoot, updated)
      persistIndex()
    },

    removeArtifact: (artifactId) => {
      const workspaceRoot = get().workspaceRoot
      markDesignArtifactRemoved(workspaceRoot, artifactId)
      const target = get().artifacts.find((item) => item.id === artifactId)
      set((state) => {
        const index = state.documents.findIndex((document) => document.id === state.activeDocumentId)
        if (index === -1) return {}
        const document = state.documents[index]
        const artifacts = document.artifacts.filter((item) => item.id !== artifactId)
        const activeArtifactId = document.activeArtifactId === artifactId
          ? artifacts[0]?.id ?? null
          : document.activeArtifactId
        const nextDocument: DesignDocument = {
          ...document,
          artifacts,
          activeArtifactId,
          updatedAt: new Date().toISOString()
        }
        const documents = state.documents.map((item, itemIndex) => itemIndex === index ? nextDocument : item)
        return { documents, artifacts, activeArtifactId }
      })
      persistIndexNow()
      if (target) {
        afterFlushingDesignWorkspace(workspaceRoot, () => deleteArtifactDir(workspaceRoot, target.relativePath))
      }
    },

    renameArtifact: (artifactId, title) => {
      const trimmed = title.trim()
      set((state) =>
        applyToActiveDoc(state, (artifacts) =>
          artifacts.map((item) => item.id === artifactId ? { ...item, title: trimmed || item.title } : item)
        )
      )
      const updated = get().artifacts.find((item) => item.id === artifactId)
      if (updated) persistArtifactMeta(get().workspaceRoot, updated)
      persistIndex()
    },

    setVersionSummary: (artifactId, versionId, summary) => {
      const trimmed = summary.trim()
      if (!trimmed) return
      let changedAny = false
      set((state) =>
        applyToActiveDoc(state, (artifacts) =>
          artifacts.map((item) => {
            if (item.id !== artifactId) return item
            let changed = false
            const versions = item.versions.map((version) => {
              if (version.id !== versionId || version.summary === trimmed) return version
              changed = true
              return { ...version, summary: trimmed }
            })
            if (changed) changedAny = true
            return changed ? { ...item, versions } : item
          })
        )
      )
      if (!changedAny) return
      const updated = get().artifacts.find((item) => item.id === artifactId)
      if (updated) persistArtifactMeta(get().workspaceRoot, updated)
      persistIndex()
    },

    setArtifactPreviewStatus: (artifactId, status) => {
      const currentArtifact = get().artifacts.find((item) => item.id === artifactId)
      if (!currentArtifact || !isFileDesignArtifactKind(currentArtifact.kind) || currentArtifact.previewStatus === status) return
      let changedAny = false
      set((state) =>
        applyToActiveDoc(state, (artifacts) =>
          artifacts.map((item) => {
            if (item.id !== artifactId || !isFileDesignArtifactKind(item.kind) || item.previewStatus === status) {
              return item
            }
            changedAny = true
            return { ...item, previewStatus: status }
          })
        )
      )
      if (!changedAny) return
      const updated = get().artifacts.find((item) => item.id === artifactId)
      if (updated) persistArtifactMeta(get().workspaceRoot, updated)
      persistIndex()
    },

    setDirectionStatus: (directionId, status) => {
      const id = directionId.trim()
      if (!id) return
      const changedIds = new Set<string>()
      set((state) =>
        applyToActiveDoc(state, (artifacts) =>
          artifacts.map((item, index) => {
            if (item.direction?.id !== id) return item
            const directionChanged = (item.direction.status ?? 'active') !== status
            const shouldFavorite = status === 'accepted' && item.node?.favorite !== true
            if (!directionChanged && !shouldFavorite) return item
            changedIds.add(item.id)
            const node = shouldFavorite
              ? { ...(item.node ?? defaultDesignArtifactNode(index)), favorite: true }
              : item.node
            return { ...item, direction: { ...item.direction, status }, ...(node ? { node } : {}) }
          })
        )
      )
      if (changedIds.size === 0) return
      const state = get()
      for (const item of state.artifacts) {
        if (changedIds.has(item.id)) persistArtifactMeta(state.workspaceRoot, item)
      }
      persistIndex()
    },

    updateArtifactNode: (artifactId, patch) => {
      set((state) =>
        applyToActiveDoc(state, (artifacts) =>
          artifacts.map((item, index) => {
            if (item.id !== artifactId) return item
            const current = item.node ?? defaultDesignArtifactNode(index)
            const minWidth = item.kind === 'svg' ? 64 : 240
            const minHeight = item.kind === 'svg' ? 64 : 180
            return {
              ...item,
              node: {
                ...current,
                ...patch,
                width: Math.max(minWidth, patch.width ?? current.width),
                height: Math.max(minHeight, patch.height ?? current.height)
              }
            }
          })
        )
      )
      const updated = get().artifacts.find((item) => item.id === artifactId)
      if (updated) persistArtifactMeta(get().workspaceRoot, updated)
      persistIndex()
    },

    duplicateArtifact: (artifactId) => {
      const artifact = get().artifacts.find((item) => item.id === artifactId)
      return artifact?.kind === 'svg'
        ? duplicateSvgArtifact(artifactId, get)
        : duplicateHtmlArtifact(artifactId, get)
    },

    selectArtifactVersion: (artifactId, versionId) => {
      set((state) =>
        applyToActiveDoc(state, (artifacts) =>
          artifacts.map((item) => {
            if (item.id !== artifactId) return item
            const version = item.versions.find((candidate) => candidate.id === versionId)
            if (!version) return item
            return {
              ...item,
              relativePath: version.relativePath,
              updatedAt: version.createdAt,
              ...(isFileDesignArtifactKind(item.kind) ? { previewStatus: 'pending' as const } : {})
            }
          })
        )
      )
      const updated = get().artifacts.find((item) => item.id === artifactId)
      if (updated) persistArtifactMeta(get().workspaceRoot, updated)
      persistIndex()
    }
  }
}
