import { isWriteWorkspaceFilePath } from '@shared/write-text-file'
import {
  readBrowserStorageItem,
  writeBrowserStorageItem
} from '../lib/browser-storage'
import type {
  WriteDocumentSession,
  WriteEditorGroup,
  WriteEditorGroupId,
  WriteEditorLayoutOrientation,
  WriteEditorLayoutV1,
  WriteEditorTab,
  WritePreviewMode,
  WriteWorkspaceState
} from './write-workspace-store-types'
import { emptySelection, normalizePath } from './write-workspace-store-helpers'

const LAYOUT_KEY_PREFIX = 'kun.write.editor-layout:v1:'

export function emptyWriteEditorGroup(id: WriteEditorGroupId): WriteEditorGroup {
  return { id, tabs: [], activePath: null }
}

export function emptyWriteEditorLayout(): WriteEditorLayoutV1 {
  return {
    version: 1,
    orientation: 'single',
    ratio: 0.5,
    focusedGroupId: 'primary',
    groups: [emptyWriteEditorGroup('primary')]
  }
}

export function isWriteEditorLayoutSplit(layout: WriteEditorLayoutV1): boolean {
  return layout.groups.length === 2 && (
    layout.orientation === 'horizontal' || layout.orientation === 'vertical'
  )
}

export function writeEditorGroupFlex(
  layout: WriteEditorLayoutV1,
  groupIndex: number
): string {
  if (!isWriteEditorLayoutSplit(layout)) return '1 1 100%'
  const share = groupIndex === 0 ? layout.ratio : 1 - layout.ratio
  return `${share} 1 0%`
}

export function writeDocumentKey(path: string): string {
  return normalizePath(path)
}

export function clearWriteOfficeSelections(
  documents: Record<string, WriteDocumentSession>
): Record<string, WriteDocumentSession> {
  let changed = false
  const next = Object.fromEntries(Object.entries(documents).map(([key, document]) => {
    if (document.kind !== 'office' || document.selection.charCount === 0) return [key, document]
    changed = true
    return [key, { ...document, selection: emptySelection() }]
  }))
  return changed ? next : documents
}

export function createWriteDocumentSession(input: Partial<WriteDocumentSession> & Pick<WriteDocumentSession, 'path' | 'kind'>): WriteDocumentSession {
  return {
    path: normalizePath(input.path),
    kind: input.kind,
    fileContent: input.fileContent ?? '',
    imageDataUrl: input.imageDataUrl ?? '',
    imageMimeType: input.imageMimeType ?? '',
    pdfDataBase64: input.pdfDataBase64 ?? '',
    pdfMimeType: input.pdfMimeType ?? '',
    pdfMtimeMs: input.pdfMtimeMs ?? 0,
    officePreview: input.officePreview ?? null,
    officeLoading: input.officeLoading ?? false,
    officeRefreshError: input.officeRefreshError ?? null,
    officeAgentEditing: input.officeAgentEditing ?? false,
    officeSemanticText: input.officeSemanticText ?? '',
    officeSemanticSha256: input.officeSemanticSha256 ?? '',
    officeSemanticTruncated: input.officeSemanticTruncated ?? false,
    fileSize: input.fileSize ?? 0,
    fileTruncated: input.fileTruncated ?? false,
    fileError: input.fileError ?? null,
    fileLoading: input.fileLoading ?? false,
    saveStatus: input.saveStatus ?? 'saved',
    documentEpoch: input.documentEpoch ?? 0,
    contentRevision: input.contentRevision ?? 0,
    persistedContent: input.persistedContent ?? input.fileContent ?? '',
    pendingAgentReview: input.pendingAgentReview ?? null,
    reviewActive: input.reviewActive ?? false,
    selection: input.selection ?? emptySelection(),
    quotedSelections: input.quotedSelections ?? [],
    recentEdits: input.recentEdits ?? []
  }
}

export function focusedWriteGroup(layout: WriteEditorLayoutV1): WriteEditorGroup {
  return layout.groups.find((group) => group.id === layout.focusedGroupId) ?? layout.groups[0]
}

export function activePathForGroup(layout: WriteEditorLayoutV1, groupId: WriteEditorGroupId): string | null {
  return layout.groups.find((group) => group.id === groupId)?.activePath ?? null
}

export function tabViewMode(layout: WriteEditorLayoutV1, groupId: WriteEditorGroupId, path: string): WritePreviewMode {
  const key = writeDocumentKey(path)
  return layout.groups.find((group) => group.id === groupId)?.tabs.find((tab) => writeDocumentKey(tab.path) === key)?.viewMode ?? 'rich'
}

export function projectFocusedDocument(
  layout: WriteEditorLayoutV1,
  documentsByPath: Record<string, WriteDocumentSession>
): Partial<WriteWorkspaceState> {
  const path = focusedWriteGroup(layout).activePath
  const document = path ? documentsByPath[writeDocumentKey(path)] : undefined
  if (!document) {
    return {
      activeFilePath: null,
      activeFileKind: null,
      fileContent: '',
      imageDataUrl: '',
      imageMimeType: '',
      pdfDataBase64: '',
      pdfMimeType: '',
      pdfMtimeMs: 0,
      fileSize: 0,
      fileTruncated: false,
      fileError: null,
      fileLoading: false,
      saveStatus: 'saved',
      persistedContent: '',
      pendingAgentReview: null,
      reviewActive: false,
      contentRevision: 0,
      selection: emptySelection(),
      quotedSelections: [],
      recentEdits: [],
      previewMode: path ? tabViewMode(layout, layout.focusedGroupId, path) : 'rich'
    }
  }
  return {
    activeFilePath: document.path,
    activeFileKind: document.kind,
    fileContent: document.fileContent,
    imageDataUrl: document.imageDataUrl,
    imageMimeType: document.imageMimeType,
    pdfDataBase64: document.pdfDataBase64,
    pdfMimeType: document.pdfMimeType,
    pdfMtimeMs: document.pdfMtimeMs,
    fileSize: document.fileSize,
    fileTruncated: document.fileTruncated,
    fileError: document.fileError,
    fileLoading: document.fileLoading,
    saveStatus: document.saveStatus,
    documentEpoch: document.documentEpoch,
    contentRevision: document.contentRevision,
    persistedContent: document.persistedContent,
    pendingAgentReview: document.pendingAgentReview,
    reviewActive: document.reviewActive,
    selection: document.selection,
    quotedSelections: document.quotedSelections,
    recentEdits: document.recentEdits,
    previewMode: tabViewMode(layout, layout.focusedGroupId, document.path)
  }
}

export function captureFocusedDocument(state: WriteWorkspaceState): Record<string, WriteDocumentSession> {
  if (!state.activeFilePath || !state.activeFileKind) return state.documentsByPath
  const key = writeDocumentKey(state.activeFilePath)
  const previous = state.documentsByPath[key]
  const document = createWriteDocumentSession({
    ...previous,
    path: state.activeFilePath,
    kind: state.activeFileKind,
    fileContent: state.fileContent,
    imageDataUrl: state.imageDataUrl,
    imageMimeType: state.imageMimeType,
    pdfDataBase64: state.pdfDataBase64,
    pdfMimeType: state.pdfMimeType,
    pdfMtimeMs: state.pdfMtimeMs,
    fileSize: state.fileSize,
    fileTruncated: state.fileTruncated,
    fileError: state.fileError,
    fileLoading: state.fileLoading,
    saveStatus: state.saveStatus,
    documentEpoch: state.documentEpoch,
    contentRevision: state.contentRevision,
    persistedContent: state.persistedContent,
    pendingAgentReview: state.pendingAgentReview,
    reviewActive: state.reviewActive,
    selection: state.selection,
    quotedSelections: state.quotedSelections,
    recentEdits: state.recentEdits
  })
  if (previous === document) return state.documentsByPath
  return { ...state.documentsByPath, [key]: document }
}

export function addTabToGroup(
  layout: WriteEditorLayoutV1,
  groupId: WriteEditorGroupId,
  path: string,
  viewMode: WritePreviewMode = 'rich'
): WriteEditorLayoutV1 {
  const normalized = writeDocumentKey(path)
  const groups = layout.groups.map((group) => {
    if (group.id !== groupId) return group
    const existing = group.tabs.find((tab) => writeDocumentKey(tab.path) === normalized)
    const tabs = existing ? group.tabs : [...group.tabs, { path: normalized, viewMode }]
    return { ...group, tabs, activePath: normalized }
  })
  return { ...layout, focusedGroupId: groupId, groups }
}

export function layoutStorageKey(workspaceRoot: string): string {
  return `${LAYOUT_KEY_PREFIX}${normalizePath(workspaceRoot)}`
}

function validMode(value: unknown): value is WritePreviewMode {
  return value === 'rich' || value === 'source' || value === 'live' || value === 'preview'
}

function normalizeStoredTab(value: unknown, workspaceRoot: string): WriteEditorTab | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<WriteEditorTab>
  const path = normalizePath(typeof candidate.path === 'string' ? candidate.path : '')
  const root = normalizePath(workspaceRoot)
  if (!path || !isWriteWorkspaceFilePath(path) || (path !== root && !path.startsWith(`${root}/`))) return null
  return {
    path,
    viewMode: validMode(candidate.viewMode) ? candidate.viewMode : 'rich',
    ...(Number.isFinite(candidate.cursorOffset) ? { cursorOffset: Math.max(0, Number(candidate.cursorOffset)) } : {}),
    ...(Number.isFinite(candidate.scrollTop) ? { scrollTop: Math.max(0, Number(candidate.scrollTop)) } : {})
  }
}

function isStoredEditorGroup(value: unknown): value is Partial<WriteEditorGroup> {
  return Boolean(value) && typeof value === 'object' && Array.isArray(
    (value as Partial<WriteEditorGroup>).tabs
  )
}

function normalizeStoredGroup(
  value: Partial<WriteEditorGroup>,
  id: WriteEditorGroupId,
  workspaceRoot: string
): WriteEditorGroup {
  const tabs = (value.tabs ?? [])
    .map((tab) => normalizeStoredTab(tab, workspaceRoot))
    .filter((tab): tab is WriteEditorTab => Boolean(tab))
    .filter((tab, index, items) => items.findIndex((candidate) => candidate.path === tab.path) === index)
  const requestedActive = normalizePath(typeof value.activePath === 'string' ? value.activePath : '')
  return {
    id,
    tabs,
    activePath: tabs.some((tab) => tab.path === requestedActive)
      ? requestedActive
      : tabs[0]?.path ?? null
  }
}

export function readWriteEditorLayout(workspaceRoot: string): WriteEditorLayoutV1 | null {
  const raw = readBrowserStorageItem(layoutStorageKey(workspaceRoot))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<WriteEditorLayoutV1>
    if (parsed.version !== 1 || !Array.isArray(parsed.groups)) return null
    const storedGroups = parsed.groups as unknown[]
    const splitOrientation = parsed.orientation === 'horizontal' || parsed.orientation === 'vertical'
    const primary = isStoredEditorGroup(storedGroups[0])
      ? normalizeStoredGroup(storedGroups[0], 'primary', workspaceRoot)
      : emptyWriteEditorGroup('primary')
    const secondary = isStoredEditorGroup(storedGroups[1])
      ? normalizeStoredGroup(storedGroups[1], 'secondary', workspaceRoot)
      : null
    const restoreSplit = splitOrientation && isStoredEditorGroup(storedGroups[0]) && secondary !== null
    const groups = restoreSplit
      ? [primary, secondary]
      : [primary]
    const orientation: WriteEditorLayoutOrientation = restoreSplit
      ? parsed.orientation as Exclude<WriteEditorLayoutOrientation, 'single'>
      : 'single'
    const focusedGroupId = parsed.focusedGroupId === 'secondary' && groups.length > 1 ? 'secondary' : 'primary'
    const ratio = Number.isFinite(parsed.ratio) ? Math.min(0.75, Math.max(0.25, Number(parsed.ratio))) : 0.5
    return { version: 1, orientation, ratio, focusedGroupId, groups }
  } catch {
    return null
  }
}

export function persistWriteEditorLayout(workspaceRoot: string, layout: WriteEditorLayoutV1): void {
  if (!workspaceRoot.trim()) return
  writeBrowserStorageItem(layoutStorageKey(workspaceRoot), JSON.stringify(layout))
}
