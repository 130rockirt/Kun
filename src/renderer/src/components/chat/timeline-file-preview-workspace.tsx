import { createContext, useContext, type ReactNode } from 'react'

export function timelineFilePreviewWorkspaceRoot(
  activeThread: { workspace?: string | null } | null | undefined,
  workspaceRoot: string
): string {
  return activeThread?.workspace?.trim() || workspaceRoot
}

const TimelineFilePreviewWorkspaceContext = createContext('')
const TimelineFilePreviewThreadContext = createContext('')

export function TimelineFilePreviewWorkspaceProvider({
  workspaceRoot,
  threadId,
  children
}: {
  workspaceRoot: string
  threadId?: string | null
  children: ReactNode
}) {
  return (
    <TimelineFilePreviewThreadContext.Provider value={threadId?.trim() ?? ''}>
      <TimelineFilePreviewWorkspaceContext.Provider value={workspaceRoot}>
        {children}
      </TimelineFilePreviewWorkspaceContext.Provider>
    </TimelineFilePreviewThreadContext.Provider>
  )
}

export function useTimelineFilePreviewWorkspaceRoot(): string {
  return useContext(TimelineFilePreviewWorkspaceContext)
}

export function useTimelineFilePreviewThreadId(): string {
  return useContext(TimelineFilePreviewThreadContext)
}
