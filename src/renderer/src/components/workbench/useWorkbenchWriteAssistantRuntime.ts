import { useEffect, useMemo, useRef } from 'react'
import type { ModelProviderModelGroup } from '@shared/kun-gui-api'
import {
  buildComposerAssistantPickList,
  resolveComposerAssistantProviderId
} from '../chat/composer-model-selection'
import { useWriteWorkspaceStore } from '../../write/write-workspace-store'
import { useChatStore } from '../../store/chat-store'
import {
  activeWriteThreadForWorkspace,
  readWriteThreadRegistry
} from '../../write/write-thread-registry'
import { workWhiteboardSessionTitleUpdates } from '../../write/work-whiteboard-session-title'

type WorkbenchWriteAssistantRuntimeOptions = {
  composerPickList: string[]
  composerModelGroups: ModelProviderModelGroup[]
}

export function useWorkbenchWriteAssistantRuntime({
  composerPickList,
  composerModelGroups
}: WorkbenchWriteAssistantRuntimeOptions) {
  const writeAssistantOpen = useWriteWorkspaceStore((s) => s.assistantOpen)
  const setWriteAssistantOpen = useWriteWorkspaceStore((s) => s.setAssistantOpen)
  const writeAssistantModel = useWriteWorkspaceStore((s) => s.assistantModel)
  const writeAssistantProviderId = useWriteWorkspaceStore((s) => s.assistantProviderId)
  const writeWorkspaceRoot = useWriteWorkspaceStore((s) => s.workspaceRoot)
  const activeWriteFilePath = useWriteWorkspaceStore((s) => s.activeFilePath)
  const activeWhiteboardId = useWriteWorkspaceStore((s) => s.activeWhiteboardId)
  const activeWhiteboard = useWriteWorkspaceStore((s) =>
    s.activeWhiteboardId ? s.whiteboards[s.activeWhiteboardId] ?? null : null
  )
  const whiteboards = useWriteWorkspaceStore((s) => s.whiteboards)
  const setWriteAssistantModel = useWriteWorkspaceStore((s) => s.setAssistantModel)
  const route = useChatStore((s) => s.route)
  const runtimeConnection = useChatStore((s) => s.runtimeConnection)
  const activeThreadId = useChatStore((s) => s.activeThreadId)
  const threads = useChatStore((s) => s.threads)
  const pendingThreadIdRef = useRef<string | null>(null)
  const pendingBoardIdRef = useRef<string | null>(null)
  // Thread projections replace `threads` for each SSE event. Keep pending
  // whiteboard title writes keyed to their workspace and bound thread so a
  // stream cannot enqueue the same registry update more than once.
  const desiredWhiteboardTitlesRef = useRef(new Map<string, string>())
  const syncingWhiteboardTitlesRef = useRef(new Set<string>())
  const writeAssistantPickList = useMemo(() => {
    return buildComposerAssistantPickList({
      composerPickList
    })
  }, [composerPickList])
  const resolvedWriteAssistantProviderId = useMemo(() => {
    return resolveComposerAssistantProviderId({
      composerModelGroups,
      model: writeAssistantModel,
      storedProviderId: writeAssistantProviderId
    })
  }, [composerModelGroups, writeAssistantModel, writeAssistantProviderId])

  useEffect(() => {
    if (route !== 'write' || !writeWorkspaceRoot) return
    const chatState = useChatStore.getState()
    if (activeWhiteboardId && activeWhiteboard) {
      if (runtimeConnection !== 'ready') {
        if (activeThreadId) chatState.clearActiveThreadSelection()
        return
      }
      const boundThread = activeWhiteboard.threadId
        ? threads.find((thread) => thread.id === activeWhiteboard.threadId) ?? null
        : null
      if (boundThread?.id === activeThreadId) return
      if (boundThread) {
        if (pendingThreadIdRef.current === boundThread.id) return
        pendingThreadIdRef.current = boundThread.id
        void chatState.selectWriteThread(boundThread.id, writeWorkspaceRoot).finally(() => {
          if (pendingThreadIdRef.current === boundThread.id) pendingThreadIdRef.current = null
        })
        return
      }
      if (pendingBoardIdRef.current === activeWhiteboardId) return
      pendingBoardIdRef.current = activeWhiteboardId
      void chatState.createWriteThread(writeWorkspaceRoot, undefined, activeWhiteboard.title).then(async (threadId) => {
        if (threadId) {
          await useWriteWorkspaceStore.getState().bindWhiteboardThread(activeWhiteboardId, threadId)
        }
      }).finally(() => {
        if (pendingBoardIdRef.current === activeWhiteboardId) pendingBoardIdRef.current = null
      })
      return
    }
    if (!activeWriteFilePath) {
      if (activeThreadId) chatState.clearActiveThreadSelection()
      return
    }
    if (runtimeConnection !== 'ready') {
      if (activeThreadId) chatState.clearActiveThreadSelection()
      return
    }

    const target = activeWriteThreadForWorkspace(
      writeWorkspaceRoot,
      threads,
      readWriteThreadRegistry(),
      activeWriteFilePath
    )
    if (target?.id === activeThreadId) return
    if (target) {
      if (pendingThreadIdRef.current === target.id) return
      pendingThreadIdRef.current = target.id
      void chatState.selectWriteThread(target.id, writeWorkspaceRoot).finally(() => {
        if (pendingThreadIdRef.current === target.id) pendingThreadIdRef.current = null
      })
    } else if (activeThreadId) {
      chatState.clearActiveThreadSelection()
    }
  }, [
    activeThreadId,
    activeWhiteboard,
    activeWhiteboardId,
    activeWriteFilePath,
    route,
    runtimeConnection,
    threads,
    writeWorkspaceRoot
  ])

  useEffect(() => {
    const boardSyncKey = (boardId: string, threadId: string): string =>
      `${writeWorkspaceRoot}\u0000${boardId}\u0000${threadId}`
    const activeKeys = new Set(
      Object.values(whiteboards).flatMap((board) =>
        board.workspaceRoot === writeWorkspaceRoot && board.threadId
          ? [boardSyncKey(board.id, board.threadId)]
          : []
      )
    )
    for (const key of desiredWhiteboardTitlesRef.current.keys()) {
      if (!activeKeys.has(key)) desiredWhiteboardTitlesRef.current.delete(key)
    }

    const updates = workWhiteboardSessionTitleUpdates(whiteboards, threads, writeWorkspaceRoot)
    for (const update of updates) {
      const board = whiteboards[update.boardId]
      const threadId = board?.threadId
      if (!board || !threadId || board.workspaceRoot !== writeWorkspaceRoot) continue
      const key = boardSyncKey(update.boardId, threadId)
      if (desiredWhiteboardTitlesRef.current.get(key) === update.title) continue
      desiredWhiteboardTitlesRef.current.set(key, update.title)
      if (syncingWhiteboardTitlesRef.current.has(key)) continue

      syncingWhiteboardTitlesRef.current.add(key)
      void (async () => {
        try {
          while (true) {
            const title = desiredWhiteboardTitlesRef.current.get(key)
            if (!title) return
            const state = useWriteWorkspaceStore.getState()
            const latest = state.whiteboards[update.boardId]
            if (
              !latest ||
              latest.workspaceRoot !== writeWorkspaceRoot ||
              latest.threadId !== threadId
            ) {
              desiredWhiteboardTitlesRef.current.delete(key)
              return
            }
            if (latest.title !== title) {
              const renamed = await state.renameWhiteboard(update.boardId, title)
              if (!renamed) {
                desiredWhiteboardTitlesRef.current.delete(key)
                return
              }
            }
            if (desiredWhiteboardTitlesRef.current.get(key) === title) return
          }
        } finally {
          syncingWhiteboardTitlesRef.current.delete(key)
        }
      })()
    }
  }, [threads, whiteboards, writeWorkspaceRoot])

  return {
    resolvedWriteAssistantProviderId,
    setWriteAssistantModel,
    setWriteAssistantOpen,
    writeAssistantModel,
    writeAssistantOpen,
    writeAssistantPickList
  }
}
