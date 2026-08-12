import i18n from '../i18n'
import { isWriteImageFilePath, isWritePdfFilePath, isWriteWorkspaceFilePath } from '@shared/write-text-file'
import { writePathToFileUrl } from '@shared/write-markdown-resource'
import type { WriteWorkspaceGet, WriteWorkspaceSet, WriteWorkspaceState } from './write-workspace-store-types'
import type { WriteDocumentSession, WriteEditorGroupId, WritePreviewMode } from './write-workspace-store-types'
import { nextWriteDocumentEpoch } from './write-document-context'
import {
  emptySelection,
  filterWriteEntries,
  formatWriteImageLoadError,
  imageMimeTypeFromPath,
  initialState,
  isMissingImageIpc,
  normalizePath,
  pathsEqual,
  readRememberedActiveFile,
  rememberActiveFile,
  writeDirnameFromPath
} from './write-workspace-store-helpers'
import {
  forgetWriteFileThreads,
  moveWriteFileThreads,
  saveWriteThreadRegistry
} from './write-thread-registry'
import {
  addTabToGroup,
  createWriteDocumentSession,
  persistWriteEditorLayout,
  projectFocusedDocument,
  readWriteEditorLayout,
  writeDocumentKey
} from './write-editor-layout'
import { pathsUnderRenamedEntry } from './write-editor-group-actions'

type WriteFileActions = Pick<
  WriteWorkspaceState,
  | 'initializeWorkspace'
  | 'loadDirectory'
  | 'toggleDirectory'
  | 'refreshWorkspace'
  | 'openFile'
  | 'createFile'
  | 'createDirectory'
  | 'renameEntry'
  | 'deleteEntry'
>

type WriteFileActionContext = {
  set: WriteWorkspaceSet
  get: WriteWorkspaceGet
  cancelExternalSyncAnimation: () => void
}

function formatActionError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function extensionFromWritePath(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  const slash = normalized.lastIndexOf('/')
  const dot = normalized.lastIndexOf('.')
  return dot > slash ? normalized.slice(dot) : ''
}

function ensureMarkdownRenameExtension(path: string, newName: string): string {
  if (extensionFromWritePath(newName)) return newName
  const currentExtension = extensionFromWritePath(path)
  return /^(?:\.md|\.markdown|\.mdx)$/i.test(currentExtension)
    ? `${newName}${currentExtension.toLowerCase()}`
    : newName
}

function withoutLoadingDirs(
  loadingDirs: Record<string, boolean>,
  keys: Array<string | undefined>
): Record<string, boolean> {
  const next = { ...loadingDirs }
  for (const key of keys) {
    if (key) delete next[key]
  }
  return next
}

function openDocumentState(
  state: WriteWorkspaceState,
  document: WriteDocumentSession,
  groupId: WriteEditorGroupId,
  viewMode: WritePreviewMode
): Partial<WriteWorkspaceState> {
  const documentsByPath = {
    ...state.documentsByPath,
    [writeDocumentKey(document.path)]: document
  }
  const editorLayout = addTabToGroup(state.editorLayout, groupId, document.path, viewMode)
  persistWriteEditorLayout(state.workspaceRoot, editorLayout)
  return { documentsByPath, editorLayout, ...projectFocusedDocument(editorLayout, documentsByPath) }
}

async function prepareActiveFileForNavigation(
  get: WriteWorkspaceGet,
  workspaceRoot: string
): Promise<boolean> {
  const state = get()
  const dirtyDocuments = Object.values(state.documentsByPath).filter(
    (document) => document.kind === 'text' && document.saveStatus !== 'saved'
  )
  if (dirtyDocuments.length === 0) return true
  if (state.autoSaveEnabled) return get().saveAllDocuments(workspaceRoot)
  if (window.confirm(i18n.t('common:writeSaveAllUnsavedConfirm'))) {
    return get().saveAllDocuments(workspaceRoot)
  }
  return window.confirm(i18n.t('common:writeDiscardUnsavedChangesConfirm'))
}

export function createWriteFileActions({
  set,
  get,
  cancelExternalSyncAnimation
}: WriteFileActionContext): WriteFileActions {
  let navigationGeneration = 0
  const directoryRequestGenerations = new Map<string, number>()
  const fileRequestGenerations = new Map<WriteEditorGroupId, number>()
  const nextNavigationGeneration = (): number => {
    navigationGeneration += 1
    return navigationGeneration
  }
  const navigationIsCurrent = (generation: number, workspaceRoot?: string): boolean => {
    if (generation !== navigationGeneration) return false
    if (!workspaceRoot) return true
    const activeRoot = normalizePath(get().workspaceRoot)
    return !activeRoot || activeRoot === normalizePath(workspaceRoot)
  }
  const workspaceIsCurrent = (workspaceRoot: string): boolean => {
    const activeRoot = normalizePath(get().workspaceRoot)
    return !activeRoot || activeRoot === normalizePath(workspaceRoot)
  }
  const nextFileRequestGeneration = (groupId: WriteEditorGroupId): number => {
    const generation = (fileRequestGenerations.get(groupId) ?? 0) + 1
    fileRequestGenerations.set(groupId, generation)
    return generation
  }
  const fileRequestIsCurrent = (
    groupId: WriteEditorGroupId,
    generation: number,
    workspaceRoot: string
  ): boolean => fileRequestGenerations.get(groupId) === generation && workspaceIsCurrent(workspaceRoot)

  return {
    initializeWorkspace: async (workspaceRoot) => {
      const generation = nextNavigationGeneration()
      const normalized = normalizePath(workspaceRoot.trim())
      if (!normalized) {
        cancelExternalSyncAnimation()
        set((state) => ({
          ...initialState(),
          documentEpoch: nextWriteDocumentEpoch(state.documentEpoch)
        }))
        return
      }
      const current = get()
      if (current.workspaceRoot === normalized && current.rootDirectory) {
        await get().refreshWorkspace(normalized)
        return
      }
      if (current.workspaceRoot && current.workspaceRoot !== normalized) {
        const canLeaveCurrentFile = await prepareActiveFileForNavigation(get, current.workspaceRoot)
        if (!canLeaveCurrentFile || generation !== navigationGeneration) return
      }

      cancelExternalSyncAnimation()
      set((state) => ({
        ...initialState(),
        workspaceRoot: normalized,
        documentEpoch: nextWriteDocumentEpoch(state.documentEpoch)
      }))
      const root = await get().loadDirectory(normalized)
      if (!root || !navigationIsCurrent(generation, normalized)) return
      set((state) => ({ rootDirectory: root, expandedDirs: new Set([...state.expandedDirs, root]) }))
      const restoredLayout = readWriteEditorLayout(normalized)
      if (restoredLayout) {
        set({ editorLayout: restoredLayout })
        for (const group of restoredLayout.groups) {
          if (!group.activePath) continue
          const mode = group.tabs.find((tab) => tab.path === group.activePath)?.viewMode ?? 'rich'
          await get().openFile(normalized, group.activePath, { groupId: group.id, viewMode: mode })
        }
        const documentsByPath = get().documentsByPath
        set({ editorLayout: restoredLayout, ...projectFocusedDocument(restoredLayout, documentsByPath) })
        return
      }
      const remembered = readRememberedActiveFile(normalized)
      if (remembered.trim() && isWriteWorkspaceFilePath(remembered)) {
        await get().openFile(normalized, remembered, { groupId: 'primary' })
      } else if (remembered.trim()) {
        rememberActiveFile(normalized, null)
      }
    },

    loadDirectory: async (workspaceRoot, path) => {
      const requestedWorkspace = normalizePath(workspaceRoot)
      const requestedRoot = normalizePath(path || workspaceRoot)
      const targetKey = path ? requestedRoot : '__root__'
      const requestKey = `${requestedWorkspace}\0${requestedRoot}`
      const requestGeneration = (directoryRequestGenerations.get(requestKey) ?? 0) + 1
      directoryRequestGenerations.set(requestKey, requestGeneration)
      const requestIsCurrent = (): boolean =>
        directoryRequestGenerations.get(requestKey) === requestGeneration && workspaceIsCurrent(workspaceRoot)
      set((state) => ({ loadingDirs: { ...state.loadingDirs, [targetKey]: true } }))
      let result: Awaited<ReturnType<typeof window.kunGui.listWorkspaceDirectory>>
      try {
        result = await window.kunGui.listWorkspaceDirectory({ workspaceRoot, path })
      } catch (error) {
        if (!requestIsCurrent()) return null
        set((state) => ({
          loadingDirs: withoutLoadingDirs(state.loadingDirs, [targetKey, requestedRoot]),
          treeError: formatActionError(error)
        }))
        return null
      }
      if (!requestIsCurrent()) return null
      set((state) => {
        const loadingDirs = withoutLoadingDirs(state.loadingDirs, [
          targetKey,
          requestedRoot,
          result.ok ? result.root : undefined
        ])
        return { loadingDirs }
      })
      if (!result.ok) {
        set({ treeError: result.message })
        return null
      }
      const visibleEntries = filterWriteEntries(result.entries)
      set((state) => {
        const entriesByDir = { ...state.entriesByDir, [result.root]: visibleEntries }
        if (requestedRoot && requestedRoot !== result.root) {
          entriesByDir[requestedRoot] = visibleEntries
        }
        const expandedDirs = new Set(state.expandedDirs)
        if (!path) expandedDirs.add(result.root)
        return {
          treeError: null,
          rootDirectory: !path && !state.rootDirectory ? result.root : state.rootDirectory,
          expandedDirs,
          entriesByDir
        }
      })
      return result.root
    },

    toggleDirectory: async (workspaceRoot, path) => {
      const expanded = get().expandedDirs.has(path)
      if (!expanded && !get().entriesByDir[path]) {
        await get().loadDirectory(workspaceRoot, path)
      }
      set((state) => {
        const expandedDirs = new Set(state.expandedDirs)
        if (expandedDirs.has(path)) {
          expandedDirs.delete(path)
        } else {
          expandedDirs.add(path)
        }
        return { expandedDirs }
      })
    },

    refreshWorkspace: async (workspaceRoot) => {
      const state = get()
      const root = state.rootDirectory || await get().loadDirectory(workspaceRoot)
      if (!root) return
      if (!state.rootDirectory) {
        set((latest) => ({ rootDirectory: root, expandedDirs: new Set([...latest.expandedDirs, root]) }))
      }
      const latest = get()
      const targets = new Set([root, ...latest.expandedDirs])
      await Promise.all([...targets].map((dirPath) => get().loadDirectory(workspaceRoot, dirPath)))
    },

    openFile: async (workspaceRoot, path, options = {}) => {
      const groupId = options.groupId ?? get().editorLayout.focusedGroupId
      const generation = nextFileRequestGeneration(groupId)
      cancelExternalSyncAnimation()
      if (!isWriteWorkspaceFilePath(path)) {
        set({
          fileLoading: false,
          fileError: i18n.t('common:writeUnsupportedFileType')
        })
        return
      }
      if (!fileRequestIsCurrent(groupId, generation, workspaceRoot)) return
      const viewMode = options.viewMode ?? 'rich'
      const current = get()
      if (
        current.autoSaveEnabled &&
        current.activeFilePath &&
        current.activeFileKind === 'text' &&
        !pathsEqual(current.activeFilePath, path) &&
        current.saveStatus !== 'saved'
      ) {
        void current.saveDocument(workspaceRoot, current.activeFilePath)
      }
      const existing = get().documentsByPath[writeDocumentKey(path)]
      if (existing) {
        rememberActiveFile(workspaceRoot, existing.path)
        set((state) => openDocumentState(state, existing, groupId, viewMode))
        return
      }
      set({ fileLoading: true, fileError: null })
      try {
        if (isWriteImageFilePath(path)) {
          const result = await window.kunGui.readWorkspaceImage({ path, workspaceRoot })
          if (!fileRequestIsCurrent(groupId, generation, workspaceRoot)) return
          if (!result.ok) {
            set({ fileLoading: false, fileError: result.message })
            return
          }
          rememberActiveFile(workspaceRoot, result.path)
          set((state) => openDocumentState(state, createWriteDocumentSession({
            path: result.path,
            kind: 'image',
            imageDataUrl: result.dataUrl,
            imageMimeType: result.mimeType,
            fileSize: result.size,
            documentEpoch: nextWriteDocumentEpoch(state.documentEpoch)
          }), groupId, viewMode))
          return
        }

        if (isWritePdfFilePath(path)) {
          const result = await window.kunGui.readWorkspacePdf({ path, workspaceRoot })
          if (!fileRequestIsCurrent(groupId, generation, workspaceRoot)) return
          if (!result.ok) {
            set({ fileLoading: false, fileError: result.message })
            return
          }
          rememberActiveFile(workspaceRoot, result.path)
          set((state) => openDocumentState(state, createWriteDocumentSession({
            path: result.path,
            kind: 'pdf',
            pdfDataBase64: result.dataBase64,
            pdfMimeType: result.mimeType,
            pdfMtimeMs: result.mtimeMs,
            fileSize: result.size,
            documentEpoch: nextWriteDocumentEpoch(state.documentEpoch)
          }), groupId, viewMode))
          return
        }

        const result = await window.kunGui.readWorkspaceFile({ path, workspaceRoot })
        if (!fileRequestIsCurrent(groupId, generation, workspaceRoot)) return
        if (!result.ok) {
          set({ fileLoading: false, fileError: result.message })
          return
        }
        rememberActiveFile(workspaceRoot, result.path)
        set((state) => openDocumentState(state, createWriteDocumentSession({
          path: result.path,
          kind: 'text',
          fileContent: result.content,
          persistedContent: result.content,
          fileSize: result.size,
          fileTruncated: result.truncated,
          documentEpoch: nextWriteDocumentEpoch(state.documentEpoch)
        }), groupId, viewMode))
      } catch (error) {
        if (!fileRequestIsCurrent(groupId, generation, workspaceRoot)) return
        if (isWriteImageFilePath(path) && isMissingImageIpc(error)) {
          rememberActiveFile(workspaceRoot, path)
          set((state) => openDocumentState(state, createWriteDocumentSession({
            path,
            kind: 'image',
            imageDataUrl: writePathToFileUrl(path),
            imageMimeType: imageMimeTypeFromPath(path),
            documentEpoch: nextWriteDocumentEpoch(state.documentEpoch)
          }), groupId, viewMode))
          return
        }
        set({
          fileLoading: false,
          fileError: isWriteImageFilePath(path)
            ? formatWriteImageLoadError(error)
            : error instanceof Error ? error.message : String(error)
        })
      }
    },

    createFile: async (workspaceRoot, path, content = '') => {
      let result: Awaited<ReturnType<typeof window.kunGui.createWorkspaceFile>>
      try {
        result = await window.kunGui.createWorkspaceFile({ workspaceRoot, path, content })
      } catch (error) {
        if (workspaceIsCurrent(workspaceRoot)) set({ fileError: formatActionError(error) })
        return null
      }
      if (!workspaceIsCurrent(workspaceRoot)) return null
      if (!result.ok) {
        set({ fileError: result.message })
        return null
      }
      await get().refreshWorkspace(workspaceRoot)
      await get().openFile(workspaceRoot, result.path)
      return result.path
    },

    createDirectory: async (workspaceRoot, path) => {
      let result: Awaited<ReturnType<typeof window.kunGui.createWorkspaceDirectory>>
      try {
        result = await window.kunGui.createWorkspaceDirectory({ workspaceRoot, path })
      } catch (error) {
        if (workspaceIsCurrent(workspaceRoot)) set({ fileError: formatActionError(error) })
        return null
      }
      if (!workspaceIsCurrent(workspaceRoot)) return null
      if (!result.ok) {
        set({ fileError: result.message })
        return null
      }
      set((state) => {
        const expandedDirs = new Set(state.expandedDirs)
        expandedDirs.add(writeDirnameFromPath(result.path))
        return { expandedDirs }
      })
      await get().refreshWorkspace(workspaceRoot)
      return result.path
    },

    renameEntry: async (workspaceRoot, path, newName) => {
      cancelExternalSyncAnimation()
      const nextName = ensureMarkdownRenameExtension(path, newName.trim())
      let result: Awaited<ReturnType<typeof window.kunGui.renameWorkspaceEntry>>
      try {
        result = await window.kunGui.renameWorkspaceEntry({ workspaceRoot, path, newName: nextName })
      } catch (error) {
        if (workspaceIsCurrent(workspaceRoot)) set({ fileError: formatActionError(error) })
        return null
      }
      if (!workspaceIsCurrent(workspaceRoot)) return null
      if (!result.ok) {
        set({ fileError: result.message })
        return null
      }
      saveWriteThreadRegistry(moveWriteFileThreads(
        workspaceRoot,
        result.previousPath,
        result.path
      ))
      const previousPrefix = `${normalizePath(result.previousPath)}/`
      set((state) => {
        const expandedDirs = new Set<string>()
        for (const dirPath of state.expandedDirs) {
          if (dirPath === result.previousPath) {
            expandedDirs.add(result.path)
          } else if (dirPath.startsWith(previousPrefix)) {
            expandedDirs.add(`${result.path}/${dirPath.slice(previousPrefix.length)}`)
          } else {
            expandedDirs.add(dirPath)
          }
        }
        const editorLayout = {
          ...state.editorLayout,
          groups: state.editorLayout.groups.map((group) => ({
            ...group,
            activePath: group.activePath
              ? pathsUnderRenamedEntry(group.activePath, result.previousPath, result.path)
              : null,
            tabs: group.tabs.map((tab) => ({
              ...tab,
              path: pathsUnderRenamedEntry(tab.path, result.previousPath, result.path)
            }))
          }))
        }
        const documentsByPath: WriteWorkspaceState['documentsByPath'] = {}
        for (const document of Object.values(state.documentsByPath)) {
          const nextPath = pathsUnderRenamedEntry(document.path, result.previousPath, result.path)
          const epoch = nextPath === document.path
            ? document.documentEpoch
            : nextWriteDocumentEpoch(document.documentEpoch)
          documentsByPath[writeDocumentKey(nextPath)] = {
            ...document,
            path: nextPath,
            documentEpoch: epoch,
            pendingAgentReview: document.pendingAgentReview
              ? { ...document.pendingAgentReview, filePath: nextPath, documentEpoch: epoch }
              : null
          }
        }
        persistWriteEditorLayout(workspaceRoot, editorLayout)
        return {
          documentsByPath,
          editorLayout,
          ...projectFocusedDocument(editorLayout, documentsByPath),
          expandedDirs,
          entriesByDir: {},
          fileError: null
        }
      })
      if (get().activeFilePath) {
        rememberActiveFile(workspaceRoot, get().activeFilePath)
      } else {
        rememberActiveFile(workspaceRoot, null)
      }
      await get().refreshWorkspace(workspaceRoot)
      return result.path
    },

    deleteEntry: async (workspaceRoot, path) => {
      cancelExternalSyncAnimation()
      let result: Awaited<ReturnType<typeof window.kunGui.deleteWorkspaceEntry>>
      try {
        result = await window.kunGui.deleteWorkspaceEntry({ workspaceRoot, path })
      } catch (error) {
        if (workspaceIsCurrent(workspaceRoot)) set({ fileError: formatActionError(error) })
        return false
      }
      if (!workspaceIsCurrent(workspaceRoot)) return false
      if (!result.ok) {
        set({ fileError: result.message })
        return false
      }
      saveWriteThreadRegistry(forgetWriteFileThreads(workspaceRoot, result.path))
      const deletedPath = normalizePath(result.path)
      set((state) => {
        const expandedDirs = new Set<string>()
        for (const dirPath of state.expandedDirs) {
          const normalizedDir = normalizePath(dirPath)
          if (normalizedDir !== deletedPath && !normalizedDir.startsWith(`${deletedPath}/`)) {
            expandedDirs.add(dirPath)
          }
        }
        const removed = (candidate: string): boolean => {
          const normalized = normalizePath(candidate)
          return normalized === deletedPath || normalized.startsWith(`${deletedPath}/`)
        }
        const groups = state.editorLayout.groups.map((group) => {
          const tabs = group.tabs.filter((tab) => !removed(tab.path))
          return {
            ...group,
            tabs,
            activePath: group.activePath && !removed(group.activePath)
              ? group.activePath
              : tabs[0]?.path ?? null
          }
        })
        const editorLayout = { ...state.editorLayout, groups }
        const documentsByPath = { ...state.documentsByPath }
        for (const document of Object.values(documentsByPath)) {
          if (removed(document.path)) delete documentsByPath[writeDocumentKey(document.path)]
        }
        persistWriteEditorLayout(workspaceRoot, editorLayout)
        return {
          expandedDirs,
          documentsByPath,
          editorLayout,
          ...projectFocusedDocument(editorLayout, documentsByPath)
        }
      })
      rememberActiveFile(workspaceRoot, get().activeFilePath)
      await get().refreshWorkspace(workspaceRoot)
      return true
    }
  }
}
