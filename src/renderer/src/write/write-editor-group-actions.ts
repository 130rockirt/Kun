import i18n from '../i18n'
import type {
  WriteDocumentSession,
  WriteEditorGroupId,
  WriteEditorLayoutOrientation,
  WritePreviewMode,
  WriteWorkspaceGet,
  WriteWorkspaceSet,
  WriteWorkspaceState
} from './write-workspace-store-types'
import {
  addTabToGroup,
  captureFocusedDocument,
  focusedWriteGroup,
  persistWriteEditorLayout,
  projectFocusedDocument,
  tabViewMode,
  writeDocumentKey
} from './write-editor-layout'
import { enqueueWriteWorkspaceSave, flushWriteWorkspaceSaveQueue } from './write-save-coordinator'
import { normalizePath, pathsEqual } from './write-workspace-store-helpers'

type WriteEditorActions = Pick<
  WriteWorkspaceState,
  | 'activateTab'
  | 'closeTab'
  | 'moveTab'
  | 'focusEditorGroup'
  | 'splitEditorGroup'
  | 'closeEditorGroup'
  | 'setTabViewMode'
  | 'setSplitOrientation'
  | 'setSplitRatio'
  | 'setDocumentContent'
  | 'saveDocument'
  | 'saveAllDocuments'
>

function persist(workspaceRoot: string, layout: WriteWorkspaceState['editorLayout']): void {
  persistWriteEditorLayout(workspaceRoot, layout)
}

function withProjection(
  documentsByPath: WriteWorkspaceState['documentsByPath'],
  editorLayout: WriteWorkspaceState['editorLayout']
): Partial<WriteWorkspaceState> {
  return { documentsByPath, editorLayout, ...projectFocusedDocument(editorLayout, documentsByPath) }
}

function updateDocument(
  documents: Record<string, WriteDocumentSession>,
  path: string,
  update: (document: WriteDocumentSession) => WriteDocumentSession
): Record<string, WriteDocumentSession> {
  const key = writeDocumentKey(path)
  const document = documents[key]
  if (!document) return documents
  return { ...documents, [key]: update(document) }
}

function documentReferenceCount(state: WriteWorkspaceState, path: string): number {
  const key = writeDocumentKey(path)
  return state.editorLayout.groups.reduce(
    (count, group) => count + group.tabs.filter((tab) => writeDocumentKey(tab.path) === key).length,
    0
  )
}

function removeTabFromGroup(
  state: WriteWorkspaceState,
  groupId: WriteEditorGroupId,
  path: string
): Pick<WriteWorkspaceState, 'editorLayout' | 'documentsByPath'> {
  const key = writeDocumentKey(path)
  const groups = state.editorLayout.groups.map((group) => {
    if (group.id !== groupId) return group
    const index = group.tabs.findIndex((tab) => writeDocumentKey(tab.path) === key)
    if (index < 0) return group
    const tabs = group.tabs.filter((_, tabIndex) => tabIndex !== index)
    const nextActive = group.activePath && writeDocumentKey(group.activePath) !== key
      ? group.activePath
      : tabs[Math.min(index, Math.max(0, tabs.length - 1))]?.path ?? null
    return { ...group, tabs, activePath: nextActive }
  })
  let editorLayout = { ...state.editorLayout, groups }
  if (editorLayout.focusedGroupId === groupId && !groups.some((group) => group.id === groupId)) {
    editorLayout = { ...editorLayout, focusedGroupId: groups[0]?.id ?? 'primary' }
  }
  const stillReferenced = groups.some((group) => group.tabs.some((tab) => writeDocumentKey(tab.path) === key))
  if (stillReferenced) return { editorLayout, documentsByPath: state.documentsByPath }
  const documentsByPath = { ...state.documentsByPath }
  delete documentsByPath[key]
  return { editorLayout, documentsByPath }
}

export function createWriteEditorGroupActions(
  set: WriteWorkspaceSet,
  get: WriteWorkspaceGet
): WriteEditorActions {
  const saveDocument = async (
    workspaceRoot: string,
    path: string,
    options: { resolveExternalConflict?: 'keep-local' } = {}
  ): Promise<boolean> => {
    const key = writeDocumentKey(path)
    for (;;) {
      const rawSnapshot = get()
      const capturedDocuments = captureFocusedDocument(rawSnapshot)
      if (capturedDocuments !== rawSnapshot.documentsByPath) set({ documentsByPath: capturedDocuments })
      const snapshot = { ...rawSnapshot, documentsByPath: capturedDocuments }
      const document = snapshot.documentsByPath[key]
      if (!document || document.kind !== 'text') return true
      if (document.fileTruncated) return false
      const resolveConflict = options.resolveExternalConflict === 'keep-local'
      if (document.reviewActive && !document.pendingAgentReview) return false
      if (document.pendingAgentReview && !resolveConflict) return false
      await flushWriteWorkspaceSaveQueue(workspaceRoot, document.path)
      const latest = get().documentsByPath[key]
      if (!latest) return true
      if (latest.fileContent === latest.persistedContent) {
        set((state) => {
          const documentsByPath = updateDocument(state.documentsByPath, path, (current) => ({
            ...current,
            saveStatus: 'saved',
            ...(resolveConflict ? { pendingAgentReview: null, reviewActive: false, fileError: null } : {})
          }))
          return withProjection(documentsByPath, state.editorLayout)
        })
        return true
      }
      const content = latest.fileContent
      const revision = latest.contentRevision
      set((state) => {
        const documentsByPath = updateDocument(state.documentsByPath, path, (current) =>
          current.contentRevision === revision ? { ...current, saveStatus: 'saving' } : current
        )
        return withProjection(documentsByPath, state.editorLayout)
      })
      let result: Awaited<ReturnType<typeof window.kunGui.writeWorkspaceFile>>
      try {
        result = await enqueueWriteWorkspaceSave({ path: latest.path, workspaceRoot, content })
      } catch (error) {
        set((state) => {
          const documentsByPath = updateDocument(state.documentsByPath, path, (current) => ({
            ...current,
            saveStatus: 'error',
            fileError: error instanceof Error ? error.message : String(error)
          }))
          return withProjection(documentsByPath, state.editorLayout)
        })
        return false
      }
      if (!result.ok) {
        set((state) => {
          const documentsByPath = updateDocument(state.documentsByPath, path, (current) => ({
            ...current,
            saveStatus: 'error',
            fileError: result.message
          }))
          return withProjection(documentsByPath, state.editorLayout)
        })
        return false
      }
      set((state) => {
        const documentsByPath = updateDocument(state.documentsByPath, path, (current) => ({
          ...current,
          persistedContent: content,
          saveStatus: current.fileContent === content ? 'saved' : 'dirty',
          fileError: null,
          ...(resolveConflict ? { pendingAgentReview: null, reviewActive: false } : {})
        }))
        return withProjection(documentsByPath, state.editorLayout)
      })
      const afterSave = get().documentsByPath[key]
      if (!afterSave || afterSave.fileContent === afterSave.persistedContent) return true
    }
  }

  return {
    activateTab: (groupId, path) => {
      const rawState = get()
      const state = { ...rawState, documentsByPath: captureFocusedDocument(rawState) }
      const key = writeDocumentKey(path)
      const group = state.editorLayout.groups.find((candidate) => candidate.id === groupId)
      if (!group?.tabs.some((tab) => writeDocumentKey(tab.path) === key)) return
      const editorLayout = {
        ...state.editorLayout,
        focusedGroupId: groupId,
        groups: state.editorLayout.groups.map((candidate) =>
          candidate.id === groupId ? { ...candidate, activePath: key } : candidate
        )
      }
      persist(state.workspaceRoot, editorLayout)
      set(withProjection(state.documentsByPath, editorLayout))
    },

    closeTab: async (groupId, path, force = false) => {
      const rawSnapshot = get()
      const snapshot = { ...rawSnapshot, documentsByPath: captureFocusedDocument(rawSnapshot) }
      const document = snapshot.documentsByPath[writeDocumentKey(path)]
      const lastReference = documentReferenceCount(snapshot, path) <= 1
      const needsDecision = lastReference && document && (
        document.saveStatus === 'dirty' || document.saveStatus === 'error' || document.reviewActive
      )
      if (needsDecision && !force) {
        if (snapshot.autoSaveEnabled && document.kind === 'text') {
          const saved = await saveDocument(snapshot.workspaceRoot, path, { resolveExternalConflict: 'keep-local' })
          if (!saved) return false
        } else {
          const saveBeforeClosing = document.kind === 'text' && window.confirm(
            i18n.t('common:writeSaveUnsavedTabConfirm')
          )
          if (saveBeforeClosing) {
            const saved = await saveDocument(snapshot.workspaceRoot, path, { resolveExternalConflict: 'keep-local' })
            if (!saved) return false
          } else if (!window.confirm(i18n.t('common:writeCloseUnsavedTabConfirm'))) {
            return false
          }
        }
      }
      const rawState = get()
      const state = { ...rawState, documentsByPath: captureFocusedDocument(rawState) }
      const next = removeTabFromGroup(state, groupId, path)
      persist(state.workspaceRoot, next.editorLayout)
      set(withProjection(next.documentsByPath, next.editorLayout))
      return true
    },

    moveTab: (path, fromGroupId, toGroupId, index) => {
      const rawState = get()
      const state = { ...rawState, documentsByPath: captureFocusedDocument(rawState) }
      if (fromGroupId === toGroupId) {
        const key = writeDocumentKey(path)
        const groups = state.editorLayout.groups.map((group) => {
          if (group.id !== fromGroupId) return group
          const tab = group.tabs.find((candidate) => writeDocumentKey(candidate.path) === key)
          if (!tab) return group
          const tabs = group.tabs.filter((candidate) => writeDocumentKey(candidate.path) !== key)
          tabs.splice(Math.min(Math.max(index ?? tabs.length, 0), tabs.length), 0, tab)
          return { ...group, tabs }
        })
        const editorLayout = { ...state.editorLayout, groups }
        persist(state.workspaceRoot, editorLayout)
        set({ editorLayout })
        return
      }
      const from = state.editorLayout.groups.find((group) => group.id === fromGroupId)
      const tab = from?.tabs.find((candidate) => pathsEqual(candidate.path, path))
      if (!tab) return
      let editorLayout = addTabToGroup(state.editorLayout, toGroupId, tab.path, tab.viewMode)
      editorLayout = {
        ...editorLayout,
        groups: editorLayout.groups.map((group) => group.id === fromGroupId
          ? {
              ...group,
              tabs: group.tabs.filter((candidate) => !pathsEqual(candidate.path, path)),
              activePath: pathsEqual(group.activePath ?? '', path)
                ? group.tabs.find((candidate) => !pathsEqual(candidate.path, path))?.path ?? null
                : group.activePath
            }
          : group)
      }
      persist(state.workspaceRoot, editorLayout)
      set(withProjection(state.documentsByPath, editorLayout))
    },

    focusEditorGroup: (groupId) => {
      const rawState = get()
      const state = { ...rawState, documentsByPath: captureFocusedDocument(rawState) }
      if (!state.editorLayout.groups.some((group) => group.id === groupId)) return
      const editorLayout = { ...state.editorLayout, focusedGroupId: groupId }
      persist(state.workspaceRoot, editorLayout)
      set(withProjection(state.documentsByPath, editorLayout))
    },

    splitEditorGroup: (orientation, requestedPath) => {
      const rawState = get()
      const state = { ...rawState, documentsByPath: captureFocusedDocument(rawState) }
      if (state.editorLayout.groups.length === 2) {
        const editorLayout = { ...state.editorLayout, orientation }
        persist(state.workspaceRoot, editorLayout)
        set({ editorLayout })
        return
      }
      const source = focusedWriteGroup(state.editorLayout)
      const path = requestedPath ?? source.activePath
      const secondaryTabs = path ? [{ path, viewMode: 'preview' as const }] : []
      const editorLayout = {
        ...state.editorLayout,
        orientation,
        focusedGroupId: 'secondary' as const,
        groups: [source, { id: 'secondary' as const, tabs: secondaryTabs, activePath: path ?? null }]
      }
      persist(state.workspaceRoot, editorLayout)
      set(withProjection(state.documentsByPath, editorLayout))
    },

    closeEditorGroup: (groupId) => {
      const rawState = get()
      const state = { ...rawState, documentsByPath: captureFocusedDocument(rawState) }
      if (state.editorLayout.groups.length < 2) return
      const closing = state.editorLayout.groups.find((group) => group.id === groupId)
      const survivor = state.editorLayout.groups.find((group) => group.id !== groupId)
      if (!closing || !survivor) return
      const tabs = [...survivor.tabs]
      for (const tab of closing.tabs) {
        if (!tabs.some((candidate) => pathsEqual(candidate.path, tab.path))) tabs.push(tab)
      }
      const primary = { ...survivor, id: 'primary' as const, tabs, activePath: survivor.activePath ?? tabs[0]?.path ?? null }
      const editorLayout = {
        ...state.editorLayout,
        orientation: 'single' as const,
        focusedGroupId: 'primary' as const,
        groups: [primary]
      }
      persist(state.workspaceRoot, editorLayout)
      set(withProjection(state.documentsByPath, editorLayout))
    },

    setTabViewMode: (groupId, path, mode) => {
      const rawState = get()
      const state = { ...rawState, documentsByPath: captureFocusedDocument(rawState) }
      const editorLayout = {
        ...state.editorLayout,
        groups: state.editorLayout.groups.map((group) => group.id === groupId
          ? { ...group, tabs: group.tabs.map((tab) => pathsEqual(tab.path, path) ? { ...tab, viewMode: mode } : tab) }
          : group)
      }
      persist(state.workspaceRoot, editorLayout)
      set(withProjection(state.documentsByPath, editorLayout))
    },

    setSplitOrientation: (orientation) => {
      const state = get()
      if (state.editorLayout.groups.length < 2) return
      const editorLayout = { ...state.editorLayout, orientation }
      persist(state.workspaceRoot, editorLayout)
      set({ editorLayout })
    },

    setSplitRatio: (ratio) => {
      const state = get()
      if (state.editorLayout.groups.length < 2) return
      const editorLayout = { ...state.editorLayout, ratio: Math.min(0.75, Math.max(0.25, ratio)) }
      persist(state.workspaceRoot, editorLayout)
      set({ editorLayout })
    },

    setDocumentContent: (path, content) => {
      set((state) => {
        const documentsByPath = updateDocument(state.documentsByPath, path, (document) => {
          if (document.kind !== 'text' || document.fileContent === content) return document
          return {
            ...document,
            fileContent: content,
            contentRevision: document.contentRevision + 1,
            saveStatus: content === document.persistedContent ? 'saved' : 'dirty'
          }
        })
        return withProjection(documentsByPath, state.editorLayout)
      })
    },

    saveDocument,

    saveAllDocuments: async (workspaceRoot) => {
      const paths = Object.values(get().documentsByPath)
        .filter((document) => document.kind === 'text' && document.saveStatus !== 'saved')
        .map((document) => document.path)
      const results = await Promise.all(paths.map((path) => saveDocument(workspaceRoot, path)))
      return results.every(Boolean)
    }
  }
}

export function focusedPreviewMode(state: WriteWorkspaceState): WritePreviewMode {
  const group = focusedWriteGroup(state.editorLayout)
  return group.activePath
    ? tabViewMode(state.editorLayout, group.id, group.activePath)
    : state.previewMode
}

export function pathsUnderRenamedEntry(path: string, previousPath: string, nextPath: string): string {
  const normalizedPath = normalizePath(path)
  const previous = normalizePath(previousPath)
  if (normalizedPath === previous) return normalizePath(nextPath)
  return normalizedPath.startsWith(`${previous}/`)
    ? `${normalizePath(nextPath)}/${normalizedPath.slice(previous.length + 1)}`
    : normalizedPath
}
