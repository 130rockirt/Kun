import { useEffect, useRef } from 'react'
import type { ChatBlock, NormalizedThread } from '../../agent/types'
import { requestCodeCanvasPanelOpen } from '../../lib/code-canvas-panel-event'
import type { AppRoute } from '../../store/chat-store-types'
import { useWriteWorkspaceStore } from '../../write/write-workspace-store'
import {
  pptCanvasOpenRequestForBlock,
  routePptCanvasOpenRequest
} from './workbench-ppt-whiteboard-routing'

export function useWorkbenchPptWhiteboardRouter(input: {
  activeThreadId: string | null
  blocks: ChatBlock[]
  route: AppRoute
  threads: NormalizedThread[]
  workspaceRoot: string
}): void {
  const handledBlockIdsRef = useRef(new Set<string>())
  useEffect(() => {
    if (input.route !== 'chat' && input.route !== 'write') return
    const writeState = useWriteWorkspaceStore.getState()
    const activeThread = input.activeThreadId
      ? input.threads.find((thread) => thread.id === input.activeThreadId) ?? null
      : null
    const pptRoute = input.route === 'write' || activeThread?.agentSurface === 'write'
      ? 'write' as const
      : 'chat' as const
    const requests = input.blocks.flatMap((block) => {
      if (handledBlockIdsRef.current.has(block.id)) return []
      const request = pptCanvasOpenRequestForBlock(block, {
        route: pptRoute,
        workspaceRoot: activeThread?.workspace || writeState.workspaceRoot || input.workspaceRoot,
        threadId: input.activeThreadId,
        sourcePath: writeState.activeFilePath
      })
      return request ? [request] : []
    })
    if (requests.length === 0) return
    for (const request of requests) handledBlockIdsRef.current.add(request.blockId)
    void (async () => {
      for (const request of requests) {
        const opened = await routePptCanvasOpenRequest(request, {
          openCode: (detail) => {
            const { target: _target, ...codeDetail } = detail
            requestCodeCanvasPanelOpen(codeDetail)
          },
          openWork: async (detail) => {
            const store = useWriteWorkspaceStore.getState()
            const board = await store.findOrCreatePptWhiteboard({
              workspaceRoot: detail.workspaceRoot,
              threadId: detail.threadId,
              workflowId: detail.workflowId,
              childId: detail.childId,
              sourcePath: detail.sourcePath
            })
            if (!board) return false
            if (detail.pptState && !await useWriteWorkspaceStore.getState().updateWhiteboardPptState(
              board.id,
              { ...detail.pptState, childId: detail.childId }
            )) return false
            return true
          }
        })
        if (!opened) handledBlockIdsRef.current.delete(request.blockId)
      }
    })()
  }, [input.activeThreadId, input.blocks, input.route, input.threads, input.workspaceRoot])
}
