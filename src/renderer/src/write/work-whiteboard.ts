import type {
  WorkWhiteboard,
  WorkWhiteboardPhase,
  WriteEditorGroupId,
  WriteWorkspaceGet,
  WriteWorkspaceSet,
  WriteWorkspaceState
} from './write-workspace-store-types'
import { deleteDesignWorkspaceEntry, writeDesignWorkspaceFile } from '../design/design-persistence-coordinator'
import { normalizePath } from './write-workspace-store-helpers'
import i18n from '../i18n'
import {
  addEditorItemToGroup,
  captureFocusedDocument,
  clearWriteOfficeSelections,
  persistWriteEditorLayout,
  projectFocusedDocument,
  writeEditorItemKey
} from './write-editor-layout'
import { cancelPendingCanvasDocument } from '../design/canvas/canvas-persistence'

export const WORK_WHITEBOARD_DIR = '.kun-write/whiteboards'
export const WORK_WHITEBOARD_INDEX = `${WORK_WHITEBOARD_DIR}/index.json`

type WorkWhiteboardRegistryV1 = {
  version: 1
  whiteboards: WorkWhiteboard[]
}

function normalizeBoard(value: unknown, workspaceRoot: string): WorkWhiteboard | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<WorkWhiteboard>
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id) || !title) return null
  const phase = raw.phase === 'directions' || raw.phase === 'review' || raw.phase === 'complete'
    ? raw.phase
    : 'blank'
  const createdAt = typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : new Date(0).toISOString()
  const updatedAt = typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : createdAt
  return {
    id,
    title,
    workspaceRoot: normalizePath(workspaceRoot),
    threadId: typeof raw.threadId === 'string' && raw.threadId.trim() ? raw.threadId.trim() : null,
    ...(typeof raw.sourcePath === 'string' && raw.sourcePath.trim() ? { sourcePath: normalizePath(raw.sourcePath) } : {}),
    ...(typeof raw.workflowId === 'string' && raw.workflowId.trim() ? { workflowId: raw.workflowId.trim() } : {}),
    ...(typeof raw.childId === 'string' && raw.childId.trim() ? { childId: raw.childId.trim() } : {}),
    ...(typeof raw.outputPath === 'string' && raw.outputPath.trim() ? { outputPath: normalizePath(raw.outputPath) } : {}),
    phase,
    revision: Number.isInteger(raw.revision) && Number(raw.revision) >= 0 ? Number(raw.revision) : 0,
    createdAt,
    updatedAt
  }
}

export function workWhiteboardArtifactId(boardId: string): string {
  return boardId.trim()
}

export function workWhiteboardBaseDir(): string {
  return WORK_WHITEBOARD_DIR
}

export function workWhiteboardTabKey(boardId: string): string {
  return `whiteboard:${boardId.trim()}`
}

export function boardIdFromWriteTabKey(key: string | null | undefined): string | null {
  return key?.startsWith('whiteboard:') ? key.slice('whiteboard:'.length).trim() || null : null
}

export function parseWorkWhiteboardRegistry(content: string, workspaceRoot: string): Record<string, WorkWhiteboard> {
  try {
    const parsed = JSON.parse(content) as Partial<WorkWhiteboardRegistryV1>
    if (parsed.version !== 1 || !Array.isArray(parsed.whiteboards)) return {}
    return Object.fromEntries(parsed.whiteboards
      .map((board) => normalizeBoard(board, workspaceRoot))
      .filter((board): board is WorkWhiteboard => Boolean(board))
      .map((board) => [board.id, board]))
  } catch {
    return {}
  }
}

export function serializeWorkWhiteboardRegistry(boards: Record<string, WorkWhiteboard>): string {
  const registry: WorkWhiteboardRegistryV1 = {
    version: 1,
    whiteboards: Object.values(boards).sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }
  return `${JSON.stringify(registry, null, 2)}\n`
}

async function persistRegistry(workspaceRoot: string, boards: Record<string, WorkWhiteboard>): Promise<boolean> {
  const result = await writeDesignWorkspaceFile({
    workspaceRoot,
    path: WORK_WHITEBOARD_INDEX,
    content: serializeWorkWhiteboardRegistry(boards)
  })
  return result.ok
}

function workspaceIsCurrent(get: WriteWorkspaceGet, workspaceRoot: string): boolean {
  return normalizePath(get().workspaceRoot) === normalizePath(workspaceRoot)
}

function boardBelongsToWorkspace(board: WorkWhiteboard, workspaceRoot: string): boolean {
  return normalizePath(board.workspaceRoot) === normalizePath(workspaceRoot)
}

const whiteboardPhaseRank: Record<WorkWhiteboardPhase, number> = {
  blank: 0,
  directions: 1,
  review: 2,
  complete: 3
}

function nextWhiteboardPptPhase(
  current: WorkWhiteboardPhase,
  incoming: WorkWhiteboardPhase | undefined
): WorkWhiteboardPhase {
  return incoming && whiteboardPhaseRank[incoming] > whiteboardPhaseRank[current]
    ? incoming
    : current
}

function uniqueBoardId(): string {
  return `board-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

type WhiteboardActions = Pick<WriteWorkspaceState,
  | 'loadWhiteboards'
  | 'createWhiteboard'
  | 'openWhiteboard'
  | 'findOrCreatePptWhiteboard'
  | 'renameWhiteboard'
  | 'deleteWhiteboard'
  | 'bindWhiteboardThread'
  | 'updateWhiteboardPptState'
>

export function createWorkWhiteboardActions(set: WriteWorkspaceSet, get: WriteWorkspaceGet): WhiteboardActions {
  const updateBoard = async (boardId: string, update: (board: WorkWhiteboard) => WorkWhiteboard): Promise<boolean> => {
    const state = get()
    const board = state.whiteboards[boardId]
    const workspaceRoot = normalizePath(state.workspaceRoot)
    if (!workspaceRoot || !board || !boardBelongsToWorkspace(board, workspaceRoot)) return false
    const whiteboards = { ...state.whiteboards, [boardId]: update(board) }
    const ok = await persistRegistry(workspaceRoot, whiteboards)
    if (!workspaceIsCurrent(get, workspaceRoot)) return false
    if (!ok) {
      set({ fileError: i18n.t('common:writeWhiteboardSaveFailed') })
      return false
    }
    set({ whiteboards })
    return ok
  }

  return {
    loadWhiteboards: async (workspaceRoot) => {
      const normalizedWorkspaceRoot = normalizePath(workspaceRoot)
      if (!normalizedWorkspaceRoot || !workspaceIsCurrent(get, normalizedWorkspaceRoot)) return
      set({ whiteboardsLoading: true })
      let whiteboards: Record<string, WorkWhiteboard> = {}
      try {
        const result = await window.kunGui.readWorkspaceFile({
          workspaceRoot: normalizedWorkspaceRoot,
          path: WORK_WHITEBOARD_INDEX
        })
        if (result.ok) whiteboards = parseWorkWhiteboardRegistry(result.content, normalizedWorkspaceRoot)
      } catch {
        // A missing registry is the expected first-run state.
      }
      if (workspaceIsCurrent(get, normalizedWorkspaceRoot)) {
        set({ whiteboards, whiteboardsLoading: false })
      }
    },

    createWhiteboard: async (workspaceRoot, options = {}) => {
      const normalizedWorkspaceRoot = normalizePath(workspaceRoot.trim())
      if (!normalizedWorkspaceRoot || !workspaceIsCurrent(get, normalizedWorkspaceRoot)) return null
      const now = new Date().toISOString()
      const board: WorkWhiteboard = {
        id: uniqueBoardId(),
        title: options.title?.trim() || i18n.t('common:writeUntitledWhiteboard'),
        workspaceRoot: normalizedWorkspaceRoot,
        threadId: options.threadId?.trim() || null,
        ...(options.sourcePath?.trim() ? { sourcePath: normalizePath(options.sourcePath) } : {}),
        ...(options.workflowId?.trim() ? { workflowId: options.workflowId.trim() } : {}),
        ...(options.childId?.trim() ? { childId: options.childId.trim() } : {}),
        phase: options.workflowId ? 'directions' : 'blank',
        revision: 0,
        createdAt: now,
        updatedAt: now
      }
      const whiteboards = { ...get().whiteboards, [board.id]: board }
      const persisted = await persistRegistry(normalizedWorkspaceRoot, whiteboards)
      if (!workspaceIsCurrent(get, normalizedWorkspaceRoot)) return null
      if (!persisted) {
        set({ fileError: i18n.t('common:writeWhiteboardCreateFailed') })
        return null
      }
      set({ whiteboards })
      get().openWhiteboard(board.id, options.groupId)
      return board
    },

    openWhiteboard: (boardId, groupId) => {
      const rawState = get()
      const board = rawState.whiteboards[boardId]
      if (!board || !workspaceIsCurrent(get, rawState.workspaceRoot) || !boardBelongsToWorkspace(board, rawState.workspaceRoot)) {
        return
      }
      const documentsByPath = captureFocusedDocument(rawState)
      const targetGroup = groupId ?? rawState.editorLayout.focusedGroupId
      if (!rawState.editorLayout.groups.some((group) => group.id === targetGroup)) return
      const editorLayout = addEditorItemToGroup(rawState.editorLayout, targetGroup, {
        kind: 'whiteboard',
        boardId,
        viewMode: 'rich'
      })
      persistWriteEditorLayout(rawState.workspaceRoot, editorLayout)
      const clearedDocuments = clearWriteOfficeSelections(documentsByPath)
      set({
        documentsByPath: clearedDocuments,
        editorLayout,
        ...projectFocusedDocument(editorLayout, clearedDocuments)
      })
    },

    findOrCreatePptWhiteboard: async (input) => {
      const workspaceRoot = normalizePath(input.workspaceRoot)
      if (!workspaceRoot || !workspaceIsCurrent(get, workspaceRoot)) return null
      const canonicalBoards = Object.values(get().whiteboards).filter((board) =>
        boardBelongsToWorkspace(board, workspaceRoot) &&
        board.threadId === input.threadId && board.workflowId === input.workflowId
      )
      const incomingChildId = input.childId?.trim()
      const existing = canonicalBoards.find((board) =>
        !board.childId || !incomingChildId || board.childId === incomingChildId
      )
      if (existing) {
        get().openWhiteboard(existing.id)
        return existing
      }
      // A workflow's child identity is immutable. Refusing an unexpected
      // identity is safer than creating a second canonical board or retargeting
      // the board that contains the original workflow's selections.
      if (canonicalBoards.length > 0) return null
      return get().createWhiteboard(workspaceRoot, {
        title: input.sourcePath
          ? `${input.sourcePath.split('/').pop()?.replace(/\.[^.]+$/, '')} · ${i18n.t('common:writePresentationReview')}`
          : i18n.t('common:writePresentationReview'),
        sourcePath: input.sourcePath,
        threadId: input.threadId,
        workflowId: input.workflowId,
        childId: input.childId
      })
    },

    renameWhiteboard: (boardId, title) => updateBoard(boardId, (board) => ({
      ...board,
      title: title.trim() || board.title,
      updatedAt: new Date().toISOString()
    })),

    bindWhiteboardThread: (boardId, threadId) => updateBoard(boardId, (board) => ({
      ...board,
      // PPT board refs are tied to their originating parent thread. Normal
      // boards may move to a new conversation; canonical workflow boards may
      // not be rebound after their identity has been established.
      threadId: board.workflowId && board.threadId ? board.threadId : threadId.trim() || board.threadId,
      updatedAt: new Date().toISOString()
    })),

    updateWhiteboardPptState: (boardId, patch) => updateBoard(boardId, (board) => {
      const incomingChildId = patch.childId?.trim()
      const childMatches = !board.childId || !incomingChildId || board.childId === incomingChildId
      const phase = childMatches ? nextWhiteboardPptPhase(board.phase, patch.phase) : board.phase
      const acceptsPhasePayload = childMatches && (!patch.phase ||
        whiteboardPhaseRank[patch.phase] >= whiteboardPhaseRank[board.phase])
      const incomingRevision = Number.isInteger(patch.revision) && Number(patch.revision) >= 0
        ? Number(patch.revision)
        : null
      const advancesPhase = Boolean(patch.phase) &&
        whiteboardPhaseRank[patch.phase!] > whiteboardPhaseRank[board.phase]
      // Direction and review revisions are separate counters. A transition to
      // review adopts its own revision; a delayed direction result must not
      // inflate the review's high-water mark in registry metadata.
      const revision = !childMatches || incomingRevision === null || !acceptsPhasePayload
        ? board.revision
        : advancesPhase && patch.phase !== 'complete'
          ? incomingRevision
          : Math.max(board.revision, incomingRevision)
      return {
        ...board,
        phase,
        ...(acceptsPhasePayload && patch.phase === 'complete' && patch.outputPath?.trim()
          ? { outputPath: normalizePath(patch.outputPath) }
          : {}),
        ...(childMatches && !board.childId && incomingChildId ? { childId: incomingChildId } : {}),
        revision,
        updatedAt: new Date().toISOString()
      }
    }),

    deleteWhiteboard: async (boardId) => {
      const state = get()
      const board = state.whiteboards[boardId]
      const workspaceRoot = normalizePath(state.workspaceRoot)
      if (!workspaceRoot || !board || !boardBelongsToWorkspace(board, workspaceRoot)) return false
      const whiteboards = { ...state.whiteboards }
      delete whiteboards[boardId]
      if (!await persistRegistry(workspaceRoot, whiteboards)) return false
      await cancelPendingCanvasDocument(workspaceRoot, boardId, WORK_WHITEBOARD_DIR)
      await deleteDesignWorkspaceEntry({
        workspaceRoot,
        path: `${WORK_WHITEBOARD_DIR}/${boardId}`
      })
      if (!workspaceIsCurrent(get, workspaceRoot)) return true
      const boardKey = workWhiteboardTabKey(boardId)
      const groups = state.editorLayout.groups.map((group) => {
        const tabs = group.tabs.filter((item) => writeEditorItemKey(item) !== boardKey)
        const activePath = group.activePath === boardKey
          ? tabs[0] ? writeEditorItemKey(tabs[0]) : null
          : group.activePath
        return { ...group, tabs, activePath }
      })
      const editorLayout = { ...state.editorLayout, groups }
      persistWriteEditorLayout(workspaceRoot, editorLayout)
      const documentsByPath = captureFocusedDocument(state)
      set({
        whiteboards,
        documentsByPath,
        editorLayout,
        ...projectFocusedDocument(editorLayout, documentsByPath)
      })
      return true
    }
  }
}

export function whiteboardForFocusedGroup(state: Pick<WriteWorkspaceState, 'editorLayout' | 'whiteboards'>): WorkWhiteboard | null {
  const group = state.editorLayout.groups.find((candidate) => candidate.id === state.editorLayout.focusedGroupId)
  const boardId = boardIdFromWriteTabKey(group?.activePath)
  return boardId ? state.whiteboards[boardId] ?? null : null
}

export function workWhiteboardGroupId(state: Pick<WriteWorkspaceState, 'editorLayout'>, boardId: string): WriteEditorGroupId | null {
  const group = state.editorLayout.groups.find((candidate) => candidate.tabs.some(
    (tab) => tab.kind === 'whiteboard' && tab.boardId === boardId
  ))
  return group?.id ?? null
}
