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
    const updates = workWhiteboardSessionTitleUpdates(whiteboards, threads, writeWorkspaceRoot)
    if (updates.length === 0) return
    void (async () => {
      for (const update of updates) {
        const state = useWriteWorkspaceStore.getState()
        const latest = state.whiteboards[update.boardId]
        if (latest && latest.title !== update.title) {
          await state.renameWhiteboard(update.boardId, update.title)
        }
      }
    })()
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
