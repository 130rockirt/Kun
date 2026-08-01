import { create } from 'zustand'
import { rendererRuntimeClient } from '../agent/runtime-client'
import { readBrowserStorageItem, writeBrowserStorageItem } from '../lib/browser-storage'
import {
  ensureDocumentDir,
  flushDocumentsIndex,
  removePersistedDesignDocument
} from './design-document-persistence'
import { hashDesignSystem, normalizeDesignTarget } from './design-context'
import { parseProjectDesignMdWithOfficialLint } from './design-md/design-md-adapter'
import { PROJECT_DESIGN_MD_PATH } from './design-md/design-md-paths'
import {
  createDesignDocumentId,
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
import { prepareDesignHtmlTurn } from './design-workspace-store/html-turn'
import { prepareDesignSvgTurn } from './design-workspace-store/svg-turn'
import { createDesignWorkspaceArtifactActions } from './design-workspace-artifact-actions'
import {
  markDesignArtifactRemoved,
  markDesignDocumentRemoved,
  markDesignDocumentUserCreated
} from './design-workspace-registry'
import {
  flushAndReleaseDesignWorkspace,
  normalizeDesignWorkspaceRoot,
  registerDesignPersistenceFailureHandler,
  resetDesignWorkspaceTransientStores
} from './design-workspace-lifecycle'
import { persistDesignWorkspaceIndex } from './design-workspace-index-persistence'
import {
  createDesignWorkspaceFolder,
  createDesignWorkspaceFolderId,
  deleteDesignWorkspaceFolder,
  designFolderNameExists,
  renameDesignWorkspaceFolder
} from './design-workspace-folders'

export const useDesignWorkspaceStore = create<DesignWorkspaceState>((set, get) => {
  let workspaceGeneration = 0
  let settingsLoadGeneration = 0
  registerDesignPersistenceFailureHandler({
    getWorkspaceRoot: () => get().workspaceRoot,
    setFileError: (fileError) => set({ fileError })
  })
  const indexState = (): Pick<
    DesignWorkspaceState,
    'workspaceRoot' | 'documents' | 'activeDocumentId' | 'workspaceFolders'
  > => {
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
    return {
      workspaceRoot: state.workspaceRoot,
      documents,
      activeDocumentId,
      workspaceFolders: state.workspaceFolders
    }
  }
  const persistIndex = (): void => persistDesignWorkspaceIndex(indexState())
  const persistIndexNow = (): void => persistDesignWorkspaceIndex(indexState(), true)

  return {
    workspaceRoot: '',
    documents: [],
    workspaceFolders: [],
    activeDocumentId: null,
    drawingCreationOpen: false,
    drawingCreationReturnDocumentId: null,
    drawingCreationDocumentId: null,
    drawingCreationSubmitting: false,
    drawingCreationFolderId: null,
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
        workspaceFolders: [],
        activeDocumentId: null,
        drawingCreationOpen: false,
        drawingCreationReturnDocumentId: null,
        drawingCreationDocumentId: null,
        drawingCreationSubmitting: false,
        drawingCreationFolderId: null,
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

    ...createDesignWorkspaceArtifactActions({ get, set, persistIndex, persistIndexNow }),

    createDocument: (title, options) => {
      const id = createDesignDocumentId()
      const createdAt = new Date().toISOString()
      if (!options?.transient) markDesignDocumentUserCreated(get().workspaceRoot, id)
      set((state) => {
        const order = state.documents.reduce((max, d) => Math.max(max, d.order), -1) + 1
        const requestedFolderId = options?.folderId ?? state.drawingCreationFolderId
        const folderId = requestedFolderId && state.workspaceFolders.some((folder) => folder.id === requestedFolderId)
          ? requestedFolderId
          : null
        const doc: DesignDocument = {
          id,
          title: (title ?? '').trim() || id,
          ...(options?.titleOrigin ? { titleOrigin: options.titleOrigin } : {}),
          createdAt,
          updatedAt: createdAt,
          order,
          folderId,
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

    beginDrawingCreation: (options) => {
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
          drawingCreationFolderId:
            options?.folderId && state.workspaceFolders.some((folder) => folder.id === options.folderId)
              ? options.folderId
              : null,
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
        drawingCreationFolderId: null,
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
          drawingCreationFolderId: null,
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

    moveDocument: (documentId, folderId) => {
      const targetFolderId = folderId?.trim() || null
      set((state) => {
        const document = state.documents.find((item) => item.id === documentId)
        if (!document) return {}
        if (targetFolderId && !state.workspaceFolders.some((folder) => folder.id === targetFolderId)) return {}
        if ((document.folderId ?? null) === targetFolderId) return {}
        return {
          documents: state.documents.map((item) =>
            item.id === documentId
              ? { ...item, folderId: targetFolderId, updatedAt: new Date().toISOString() }
              : item
          )
        }
      })
      persistIndexNow()
    },

    createWorkspaceFolder: (name, parentId = null) => {
      const state = get()
      const targetParentId = parentId?.trim() || null
      if (designFolderNameExists(state.workspaceFolders, name, targetParentId)) return null
      const id = createDesignWorkspaceFolderId()
      const workspaceFolders = createDesignWorkspaceFolder(state.workspaceFolders, { id, name, parentId: targetParentId })
      if (!workspaceFolders.some((folder) => folder.id === id)) return null
      set({ workspaceFolders })
      persistIndexNow()
      return id
    },

    renameWorkspaceFolder: (folderId, name) => {
      const workspaceFolders = renameDesignWorkspaceFolder(get().workspaceFolders, folderId, name)
      if (workspaceFolders === get().workspaceFolders) return
      set({ workspaceFolders })
      persistIndexNow()
    },

    removeWorkspaceFolder: (folderId) => {
      const state = get()
      const deleted = deleteDesignWorkspaceFolder(state.workspaceFolders, folderId)
      if (!state.workspaceFolders.some((folder) => folder.id === folderId)) return
      set({
        workspaceFolders: deleted.folders,
        documents: state.documents.map((document) =>
          document.folderId === folderId
            ? { ...document, folderId: deleted.parentId, updatedAt: new Date().toISOString() }
            : document
        )
      })
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
        fallbackActiveDocumentId,
        fallbackFolders: snapshot.workspaceFolders
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
        finalIndexState.activeDocumentId,
        finalIndexState.workspaceFolders
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
          const resolvedWorkspaceRoot =
            get().workspaceRoot ||
            design.activeWorkspaceRoot ||
            design.defaultWorkspaceRoot ||
            design.workspaces[0] ||
            builtinDesignWorkspaceRoot() ||
            ''
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
