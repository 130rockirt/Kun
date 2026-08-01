import { create } from 'zustand'
import { rendererRuntimeClient } from '../agent/runtime-client'
import { readBrowserStorageItem, writeBrowserStorageItem } from '../lib/browser-storage'
import {
  artifactDesignMdPathOf,
  deleteArtifactDir,
  persistArtifactMeta
} from './design-artifact-persistence'
import {
  ensureDocumentDir,
  flushDocumentsIndex,
  removePersistedDesignDocument
} from './design-document-persistence'
import { defaultPreviewNodeSizeForDesignTarget, hashDesignSystem, normalizeDesignTarget } from './design-context'
import { parseProjectDesignMdWithOfficialLint } from './design-md/design-md-adapter'
import { PROJECT_DESIGN_MD_PATH } from './design-md/design-md-paths'
import {
  createDesignDocumentId,
  defaultDesignArtifactNode,
  isFileDesignArtifactKind
} from './design-types'
import type { DesignDocument } from './design-types'
import type { DesignWorkspaceState } from './design-workspace-store-types'
import {
  AI_RAIL_COLLAPSED_KEY,
  ASSISTANT_MODEL_KEY,
  ASSISTANT_PROVIDER_KEY,
  CANVAS_ASSISTANT_OPEN_KEY,
  CANVAS_INSPECTOR_PINNED_KEY,
  CANVAS_VIEW_KEY,
  DESIGN_TARGET_KEY,
  MULTI_PAGE_MODE_KEY,
  VIEWPORT_KEY,
  applyToActiveDoc,
  builtinDesignWorkspaceRoot,
  projectActiveDoc,
  readPersistedAiRailCollapsed,
  readPersistedAssistantModel,
  readPersistedAssistantProvider,
  readPersistedCanvasAssistantOpen,
  readPersistedCanvasInspectorPinned,
  readPersistedCanvasView,
  readPersistedDesignTarget,
  readPersistedMultiPageMode,
  readPersistedViewport,
  rehydrateDesignWorkspaceArtifacts
} from './design-workspace-store/helpers'
import { duplicateHtmlArtifact, prepareDesignHtmlTurn } from './design-workspace-store/html-turn'
import { duplicateSvgArtifact, prepareDesignSvgTurn } from './design-workspace-store/svg-turn'
import {
  markDesignArtifactRemoved,
  markDesignDocumentRemoved,
  markDesignDocumentUserCreated
} from './design-workspace-registry'
import {
  afterFlushingDesignWorkspace,
  flushAndReleaseDesignWorkspace,
  normalizeDesignWorkspaceRoot,
  registerDesignPersistenceFailureHandler,
  resetDesignWorkspaceTransientStores
} from './design-workspace-lifecycle'
import { persistDesignWorkspaceIndex } from './design-workspace-index-persistence'

export const useDesignWorkspaceStore = create<DesignWorkspaceState>((set, get) => {
  let workspaceGeneration = 0
  let settingsLoadGeneration = 0
  registerDesignPersistenceFailureHandler({
    getWorkspaceRoot: () => get().workspaceRoot,
    setFileError: (fileError) => set({ fileError })
  })
  const indexState = (): Pick<DesignWorkspaceState, 'workspaceRoot' | 'documents' | 'activeDocumentId'> => {
    const state = get()
    if (!state.drawingCreationOpen && !state.drawingCreationDocumentId) return state
    const documents = state.drawingCreationDocumentId
      ? state.documents.filter((document) => document.id !== state.drawingCreationDocumentId)
      : state.documents
    const activeDocumentId =
      state.activeDocumentId !== state.drawingCreationDocumentId &&
      documents.some((document) => document.id === state.activeDocumentId)
        ? state.activeDocumentId
        : state.drawingCreationReturnDocumentId &&
            documents.some((document) => document.id === state.drawingCreationReturnDocumentId)
          ? state.drawingCreationReturnDocumentId
          : documents[0]?.id ?? null
    return { workspaceRoot: state.workspaceRoot, documents, activeDocumentId }
  }
  const persistIndex = (): void => persistDesignWorkspaceIndex(indexState())
  const persistIndexNow = (): void => persistDesignWorkspaceIndex(indexState(), true)

  return {
    workspaceRoot: '',
    documents: [],
    activeDocumentId: null,
    drawingCreationOpen: false,
    drawingCreationReturnDocumentId: null,
    drawingCreationDocumentId: null,
    drawingCreationSubmitting: false,
    drawingHistoryMutation: null,
    artifacts: [],
    activeArtifactId: null,
    canvasView: readPersistedCanvasView(),
    viewport: readPersistedViewport(),
    devPreviewUrl: '',
    assistantModel: readPersistedAssistantModel(),
    assistantProviderId: readPersistedAssistantProvider(),
    designContext: { designTarget: readPersistedDesignTarget() },
    canvasBackground: 'light',
    liveRefresh: true,
    deviceFrame: true,
    generationPrompt: '',
    reasoningEffort: '',
    implementStackHint: '',
    injectIntoCode: true,
    publishDesignSystem: true,
    settingsLoaded: false,
    fileError: null,
    designSystemHash: '',
    implementOpen: false,
    implementTitle: '',
    aiRailCollapsed: readPersistedAiRailCollapsed(),
    canvasAssistantOpen: readPersistedCanvasAssistantOpen(),
    canvasInspectorPinned: readPersistedCanvasInspectorPinned(),
    designIntentMode: 'generate',
    multiPageMode: readPersistedMultiPageMode(),
    pagesRun: null,
    parallelPageStates: {},

    setWorkspaceRoot: (workspaceRoot) => {
      const normalized = normalizeDesignWorkspaceRoot(workspaceRoot)
      const previous = get().workspaceRoot
      if (normalizeDesignWorkspaceRoot(previous) === normalized) return
      workspaceGeneration += 1
      flushAndReleaseDesignWorkspace(previous)
      resetDesignWorkspaceTransientStores()
      set({
        workspaceRoot: normalized,
        documents: [],
        activeDocumentId: null,
        drawingCreationOpen: false,
        drawingCreationReturnDocumentId: null,
        drawingCreationDocumentId: null,
        drawingCreationSubmitting: false,
        artifacts: [],
        activeArtifactId: null,
        fileError: null,
        designSystemHash: '',
        implementOpen: false,
        implementTitle: '',
        pagesRun: null,
        parallelPageStates: {}
      })
    },

    setCanvasView: (view) => {
      writeBrowserStorageItem(CANVAS_VIEW_KEY, view)
      set({ canvasView: view })
    },

    setViewport: (viewport) => {
      writeBrowserStorageItem(VIEWPORT_KEY, viewport)
      set({ viewport })
    },

    setDevPreviewUrl: (url) => set({ devPreviewUrl: url }),

    setCanvasBackground: (background) => set({ canvasBackground: background }),

    setActiveArtifact: (artifactId) => {
      set((state) => {
        const idx = state.documents.findIndex((d) => d.id === state.activeDocumentId)
        if (idx === -1) return { activeArtifactId: artifactId, fileError: null }
        const doc = state.documents[idx]
        if (doc.activeArtifactId === artifactId) return { fileError: null }
        const documents = state.documents.map((d, i) => (i === idx ? { ...d, activeArtifactId: artifactId } : d))
        return { documents, activeArtifactId: artifactId, fileError: null }
      })
      persistIndex()
    },

    createDocument: (title, options) => {
      const id = createDesignDocumentId()
      const createdAt = new Date().toISOString()
      if (!options?.transient) markDesignDocumentUserCreated(get().workspaceRoot, id)
      set((state) => {
        const order = state.documents.reduce((max, d) => Math.max(max, d.order), -1) + 1
        const doc: DesignDocument = {
          id,
          title: (title ?? '').trim() || id,
          ...(options?.titleOrigin ? { titleOrigin: options.titleOrigin } : {}),
          createdAt,
          updatedAt: createdAt,
          order,
          artifacts: [],
          activeArtifactId: null
        }
        const documents = [...state.documents, doc]
        return {
          documents,
          activeDocumentId: id,
          ...(options?.transient ? { drawingCreationDocumentId: id } : {}),
          ...projectActiveDoc(documents, id),
          fileError: null
        }
      })
      void ensureDocumentDir(get().workspaceRoot, id)
      if (options?.transient) persistIndex()
      else persistIndexNow()
      return id
    },

    beginDrawingCreation: () => {
      if (get().drawingCreationSubmitting) return
      resetDesignWorkspaceTransientStores()
      set((state) => {
        const provisionalId =
          state.drawingCreationDocumentId &&
          state.documents.some((document) => document.id === state.drawingCreationDocumentId)
            ? state.drawingCreationDocumentId
            : null
        return {
          drawingCreationOpen: true,
          drawingCreationReturnDocumentId:
            state.drawingCreationOpen
              ? state.drawingCreationReturnDocumentId
              : state.activeDocumentId,
          activeDocumentId: provisionalId,
          ...projectActiveDoc(state.documents, provisionalId),
          fileError: null
        }
      })
    },

    beginDrawingSubmission: () => {
      if (get().drawingCreationSubmitting) return false
      set({ drawingCreationSubmitting: true })
      return true
    },

    endDrawingSubmission: () => set({ drawingCreationSubmitting: false }),

    finishDrawingCreation: (documentId) => {
      const targetId = (documentId ?? get().activeDocumentId ?? '').trim()
      if (!targetId || !get().documents.some((doc) => doc.id === targetId)) {
        set({ drawingCreationSubmitting: false })
        return
      }
      markDesignDocumentUserCreated(get().workspaceRoot, targetId)
      set((state) => ({
        drawingCreationOpen: false,
        drawingCreationReturnDocumentId: null,
        drawingCreationDocumentId: null,
        drawingCreationSubmitting: false,
        activeDocumentId: targetId,
        ...projectActiveDoc(state.documents, targetId),
        fileError: null
      }))
      persistIndexNow()
    },

    cancelDrawingCreation: () => {
      set((state) => {
        if (!state.drawingCreationOpen) return { drawingCreationSubmitting: false }
        const committedDocuments = state.documents.filter(
          (document) => document.id !== state.drawingCreationDocumentId
        )
        const targetId =
          state.drawingCreationReturnDocumentId &&
          committedDocuments.some((doc) => doc.id === state.drawingCreationReturnDocumentId)
            ? state.drawingCreationReturnDocumentId
            : committedDocuments[0]?.id ?? null
        return {
          drawingCreationOpen: false,
          drawingCreationReturnDocumentId: null,
          drawingCreationSubmitting: false,
          activeDocumentId: targetId,
          ...projectActiveDoc(state.documents, targetId),
          fileError: null
        }
      })
    },

    renameDocument: (documentId, title, options) => {
      const trimmed = title.trim()
      if (!trimmed) return
      set((state) => ({
        documents: state.documents.map((d) =>
          d.id === documentId
            ? {
                ...d,
                title: trimmed,
                titleOrigin: options?.titleOrigin ?? 'user',
                updatedAt: new Date().toISOString()
              }
            : d
        )
      }))
      persistIndexNow()
    },

    beginDrawingHistoryMutation: (workspaceRoot, documentId, kind) => {
      const normalizedWorkspaceRoot = normalizeDesignWorkspaceRoot(workspaceRoot)
      const normalizedDocumentId = documentId.trim()
      if (!normalizedWorkspaceRoot || !normalizedDocumentId || get().drawingHistoryMutation) {
        return false
      }
      set({
        drawingHistoryMutation: {
          workspaceRoot: normalizedWorkspaceRoot,
          documentId: normalizedDocumentId,
          kind
        }
      })
      return true
    },

    endDrawingHistoryMutation: (workspaceRoot, documentId) => {
      const current = get().drawingHistoryMutation
      if (
        !current ||
        current.workspaceRoot !== normalizeDesignWorkspaceRoot(workspaceRoot) ||
        current.documentId !== documentId.trim()
      ) return
      set({ drawingHistoryMutation: null })
    },

    removeDocument: async (documentId) => {
      const snapshot = get()
      const workspaceRoot = snapshot.workspaceRoot
      const doc = snapshot.documents.find((d) => d.id === documentId)
      if (!workspaceRoot || !doc) return false
      const removingProvisionalDrawing = snapshot.drawingCreationDocumentId === documentId
      const fallbackDocuments = removingProvisionalDrawing
        ? snapshot.documents.filter((document) => document.id !== documentId)
        : snapshot.documents
      const fallbackActiveDocumentId = removingProvisionalDrawing
        ? snapshot.drawingCreationReturnDocumentId &&
            fallbackDocuments.some(
              (document) => document.id === snapshot.drawingCreationReturnDocumentId
            )
          ? snapshot.drawingCreationReturnDocumentId
          : fallbackDocuments[0]?.id ?? null
        : snapshot.activeDocumentId
      const removed = await removePersistedDesignDocument({
        workspaceRoot,
        documentId,
        fallbackDocuments,
        fallbackActiveDocumentId
      })
      if (!removed) return false

      markDesignDocumentRemoved(workspaceRoot, documentId)
      for (const artifact of doc.artifacts) {
        markDesignArtifactRemoved(workspaceRoot, artifact.id)
      }
      if (
        normalizeDesignWorkspaceRoot(get().workspaceRoot) !==
          normalizeDesignWorkspaceRoot(workspaceRoot)
      ) return true
      set((state) => {
        const documents = state.documents.filter((d) => d.id !== documentId)
        const activeDocumentId =
          state.activeDocumentId === documentId ? documents[0]?.id ?? null : state.activeDocumentId
        const drawingCreationReturnDocumentId =
          state.drawingCreationReturnDocumentId === documentId
            ? documents[0]?.id ?? null
            : state.drawingCreationReturnDocumentId
        return {
          documents,
          activeDocumentId,
          drawingCreationReturnDocumentId,
          drawingCreationDocumentId:
            state.drawingCreationDocumentId === documentId
              ? null
              : state.drawingCreationDocumentId,
          ...projectActiveDoc(documents, activeDocumentId),
          fileError: null
        }
      })
      // A debounced index write can be scheduled while the directory deletion
      // is in flight. Replace it with the final in-memory projection so that a
      // stale documents.json cannot resurrect the deleted drawing.
      const finalIndexState = indexState()
      await flushDocumentsIndex(
        finalIndexState.workspaceRoot,
        finalIndexState.documents,
        finalIndexState.activeDocumentId
      )
      return true
    },

    switchActiveDocument: (documentId) => {
      set((state) => {
        if (!state.documents.some((d) => d.id === documentId)) return {}
        return { activeDocumentId: documentId, ...projectActiveDoc(state.documents, documentId), fileError: null }
      })
      persistIndex()
    },

    ensureActiveDocument: () => {
      const state = get()
      if (state.activeDocumentId && state.documents.some((d) => d.id === state.activeDocumentId)) {
        return state.activeDocumentId
      }
      if (state.documents.length > 0) {
        const id = state.documents[0].id
        set({ activeDocumentId: id, ...projectActiveDoc(state.documents, id) })
        persistIndex()
        return id
      }
      return get().createDocument(undefined, { transient: true })
    },

    upsertArtifact: (artifact) => {
      get().ensureActiveDocument()
      set((state) =>
        applyToActiveDoc(
          state,
          (artifacts) => {
            const existingIndex = artifacts.findIndex((item) => item.id === artifact.id)
            const existing = existingIndex >= 0 ? artifacts[existingIndex] : undefined
            const withDefaults =
              isFileDesignArtifactKind(artifact.kind)
                ? { ...artifact, designMdPath: artifact.designMdPath ?? artifactDesignMdPathOf(artifact.relativePath) }
                : artifact
            const defaultNode =
              withDefaults.kind === 'html'
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
        const idx = state.documents.findIndex((d) => d.id === state.activeDocumentId)
        if (idx === -1) return {}
        const doc = state.documents[idx]
        const artifacts = doc.artifacts.filter((item) => item.id !== artifactId)
        const activeArtifactId =
          doc.activeArtifactId === artifactId ? artifacts[0]?.id ?? null : doc.activeArtifactId
        const nextDoc: DesignDocument = { ...doc, artifacts, activeArtifactId, updatedAt: new Date().toISOString() }
        const documents = state.documents.map((d, i) => (i === idx ? nextDoc : d))
        return { documents, artifacts, activeArtifactId }
      })
      persistIndexNow()
      if (target) afterFlushingDesignWorkspace(workspaceRoot, () => deleteArtifactDir(workspaceRoot, target.relativePath))
    },

    renameArtifact: (artifactId, title) => {
      const trimmed = title.trim()
      set((state) =>
        applyToActiveDoc(state, (artifacts) =>
          artifacts.map((item) => (item.id === artifactId ? { ...item, title: trimmed || item.title } : item))
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
      if (
        !currentArtifact ||
        !isFileDesignArtifactKind(currentArtifact.kind) ||
        currentArtifact.previewStatus === status
      ) return
      let changedAny = false
      set((state) =>
        applyToActiveDoc(state, (artifacts) =>
          artifacts.map((item) => {
            if (
              item.id !== artifactId ||
              !isFileDesignArtifactKind(item.kind) ||
              item.previewStatus === status
            ) {
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
            return {
              ...item,
              direction: { ...item.direction, status },
              ...(node ? { node } : {})
            }
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
    },

    setDesignIntentMode: (mode) => set({ designIntentMode: mode }),

    setDesignTarget: (target) => {
      const normalized = normalizeDesignTarget(target)
      writeBrowserStorageItem(DESIGN_TARGET_KEY, normalized)
      set((state) => ({ designContext: { ...state.designContext, designTarget: normalized } }))
    },

    setMultiPageMode: (on) => {
      writeBrowserStorageItem(MULTI_PAGE_MODE_KEY, on ? '1' : '0')
      set({ multiPageMode: on })
    },

    setPagesRun: (state) => set({ pagesRun: state }),

    setParallelPageStates: (states) =>
      set({
        parallelPageStates: Object.fromEntries(
          states.map((state) => [state.artifactId, state])
        )
      }),

    updateParallelPageState: (artifactId, patch) => {
      const id = artifactId.trim()
      if (!id) return
      set((state) => ({
        parallelPageStates: {
          ...state.parallelPageStates,
          [id]: {
            ...state.parallelPageStates[id],
            ...patch,
            artifactId: id,
            status: patch.status ?? state.parallelPageStates[id]?.status ?? 'queued',
            updatedAt: patch.updatedAt ?? new Date().toISOString()
          }
        }
      }))
    },

    clearParallelPageStates: () => set({ parallelPageStates: {} }),

    setFileError: (error) => set({ fileError: error }),

    openImplementPanel: (title) => set({ implementOpen: true, implementTitle: title }),

    closeImplementPanel: () => set({ implementOpen: false }),

    prepareHtmlTurn: (brief, options = {}) =>
      prepareDesignHtmlTurn({ brief, options, get, set, persistIndex }),

    prepareSvgTurn: (brief, options = {}) =>
      prepareDesignSvgTurn({ brief, options, get, set, persistIndex }),

    setAiRailCollapsed: (collapsed) => {
      writeBrowserStorageItem(AI_RAIL_COLLAPSED_KEY, collapsed ? '1' : '0')
      writeBrowserStorageItem(CANVAS_ASSISTANT_OPEN_KEY, collapsed ? '0' : '1')
      set({ aiRailCollapsed: collapsed, canvasAssistantOpen: !collapsed })
    },

    setCanvasAssistantOpen: (open) => {
      writeBrowserStorageItem(CANVAS_ASSISTANT_OPEN_KEY, open ? '1' : '0')
      writeBrowserStorageItem(AI_RAIL_COLLAPSED_KEY, open ? '0' : '1')
      set({ canvasAssistantOpen: open, aiRailCollapsed: !open })
    },

    toggleCanvasAssistantOpen: () => {
      get().setCanvasAssistantOpen(!get().canvasAssistantOpen)
    },

    setCanvasInspectorPinned: (pinned) => {
      writeBrowserStorageItem(CANVAS_INSPECTOR_PINNED_KEY, pinned ? '1' : '0')
      set({ canvasInspectorPinned: pinned })
    },

    setAssistantModel: (model, providerId) => {
      const normalized = model.trim()
      const normalizedProvider = (providerId ?? '').trim()
      writeBrowserStorageItem(ASSISTANT_MODEL_KEY, normalized)
      writeBrowserStorageItem(ASSISTANT_PROVIDER_KEY, normalizedProvider)
      set({ assistantModel: normalized, assistantProviderId: normalizedProvider })
    },

    updateDesignContext: (patch) => {
      const nextPatch = { ...patch }
      if (nextPatch.designTarget) {
        nextPatch.designTarget = normalizeDesignTarget(nextPatch.designTarget)
        writeBrowserStorageItem(DESIGN_TARGET_KEY, nextPatch.designTarget)
      }
      set((state) => ({ designContext: { ...state.designContext, ...nextPatch } }))
    },

    loadDesignSettings: async () => {
      settingsLoadGeneration += 1
      const loadGeneration = settingsLoadGeneration
      set({ settingsLoaded: false })
      try {
        try {
          const settings = await rendererRuntimeClient.getSettings()
          if (loadGeneration !== settingsLoadGeneration) return
          const design = settings.design
          const hasStoredViewport = readBrowserStorageItem(VIEWPORT_KEY) !== null
          const hasStoredView = readBrowserStorageItem(CANVAS_VIEW_KEY) !== null
          const resolvedWorkspaceRoot = get().workspaceRoot || design.defaultWorkspaceRoot || builtinDesignWorkspaceRoot() || ''
          if (normalizeDesignWorkspaceRoot(get().workspaceRoot) !== normalizeDesignWorkspaceRoot(resolvedWorkspaceRoot)) {
            get().setWorkspaceRoot(resolvedWorkspaceRoot)
          }
          set((state) => ({
            assistantModel: state.assistantModel || design.model,
            assistantProviderId: state.assistantProviderId || design.providerId,
            canvasBackground: design.canvasBackground,
            liveRefresh: design.liveRefresh,
            deviceFrame: design.deviceFrame,
            generationPrompt: design.generationPrompt,
            reasoningEffort: design.reasoningEffort,
            implementStackHint: design.implementStackHint,
            injectIntoCode: design.injectIntoCode,
            publishDesignSystem: design.publishDesignSystem,
            viewport: hasStoredViewport ? state.viewport : design.defaultViewport,
            canvasView: hasStoredView ? state.canvasView : design.defaultCanvasView,
            designContext: {
              ...state.designContext,
              designTarget: state.designContext.designTarget ?? readPersistedDesignTarget(),
              designType: state.designContext.designType ?? (design.designType || undefined),
              designGuidelines: state.designContext.designGuidelines || design.designGuidelines || undefined,
              radius: state.designContext.radius ?? (design.radius || undefined),
              density: state.designContext.density ?? (design.density || undefined),
              fontStyle: state.designContext.fontStyle ?? (design.fontStyle || undefined),
              brandColor: state.designContext.brandColor || design.brandColor || undefined,
              tone:
                state.designContext.tone && state.designContext.tone.length > 0
                  ? state.designContext.tone
                  : design.tone.length > 0
                    ? design.tone
                    : undefined,
              designSystemPreset:
                state.designContext.designSystemPreset ??
                (design.designSystemPreset === 'none' ? undefined : design.designSystemPreset)
            }
          }))
        } catch {
          // Keep local/default state and still let rehydration/fallback below settle the workspace.
        }
        if (loadGeneration !== settingsLoadGeneration) return
        const workspaceRoot = get().workspaceRoot
        await get().rehydrateArtifacts()
        if (
          loadGeneration !== settingsLoadGeneration ||
          normalizeDesignWorkspaceRoot(get().workspaceRoot) !== normalizeDesignWorkspaceRoot(workspaceRoot)
        ) return
        await get().refreshDesignSystemHash()
        if (
          loadGeneration !== settingsLoadGeneration ||
          normalizeDesignWorkspaceRoot(get().workspaceRoot) !== normalizeDesignWorkspaceRoot(workspaceRoot)
        ) return
      } finally {
        if (loadGeneration === settingsLoadGeneration) set({ settingsLoaded: true })
      }
    },

    rehydrateArtifacts: () => {
      const generation = workspaceGeneration
      const workspaceRoot = get().workspaceRoot
      return rehydrateDesignWorkspaceArtifacts({
        get,
        set,
        persistIndex,
        isCurrent: (candidateRoot) =>
          generation === workspaceGeneration &&
          normalizeDesignWorkspaceRoot(candidateRoot) === normalizeDesignWorkspaceRoot(workspaceRoot) &&
          normalizeDesignWorkspaceRoot(get().workspaceRoot) === normalizeDesignWorkspaceRoot(workspaceRoot)
      })
    },

    refreshDesignSystemHash: async () => {
      const { workspaceRoot } = get()
      if (!workspaceRoot || typeof window.kunGui?.readWorkspaceFile !== 'function') {
        set({ designSystemHash: '' })
        return
      }
      const res = await window.kunGui
        .readWorkspaceFile({ path: PROJECT_DESIGN_MD_PATH, workspaceRoot })
        .catch(() => null)
      const parsed = res?.ok
        ? await parseProjectDesignMdWithOfficialLint(res.content, { truncated: res.truncated })
        : null
      if (normalizeDesignWorkspaceRoot(get().workspaceRoot) !== normalizeDesignWorkspaceRoot(workspaceRoot)) return
      set({ designSystemHash: parsed?.ok && res?.ok ? hashDesignSystem(res.content) : '' })
    },

    resetWorkspace: () => {
      workspaceGeneration += 1
      const workspaceRoot = get().workspaceRoot
      flushAndReleaseDesignWorkspace(workspaceRoot)
      resetDesignWorkspaceTransientStores()
      set({
        documents: [],
        activeDocumentId: null,
        drawingCreationOpen: false,
        drawingCreationReturnDocumentId: null,
        drawingCreationDocumentId: null,
        drawingCreationSubmitting: false,
        artifacts: [],
        activeArtifactId: null,
        fileError: null,
        designSystemHash: '',
        implementOpen: false,
        pagesRun: null,
        parallelPageStates: {}
      })
    }
  }
})
