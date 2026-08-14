import { normalizeWorkspaceRoot } from '../lib/workspace-path'
import {
  createWorkspaceCheckpointRequestId,
  threadActionSharedState
} from './chat-store-thread-actions-support'

/**
 * Kick off the pre-send Git checkpoint snapshot (issue #651/#1156 wiring).
 * Returns the pending checkpoint request id so the turn can attach it and the
 * agent-loop gate can wait for it before the first mutating tool.
 *
 * Failure handling is deliberately quiet: a failed snapshot preserves the
 * historical best-effort behavior (tools continue without a rollback id).
 * `git_unavailable` flags the workspace so later sends skip Git entirely;
 * `quota_exceeded` (issue #1156) is expected behavior — skipped with an info
 * log rather than reported as a workspace error.
 */
export function startWorkspaceCheckpointSnapshot(params: {
  settings: { checkpointCleanup?: { createEnabled?: boolean } }
  threads: Array<{ id: string, workspace?: string }>
  activeThreadId: string
  fallbackWorkspaceRoot: string
}): string | undefined {
  const { settings, threads, activeThreadId, fallbackWorkspaceRoot } = params
  const checkpointThread = threads.find((thread) => thread.id === activeThreadId)
  const checkpointWorkspaceRoot = normalizeWorkspaceRoot(checkpointThread?.workspace) || normalizeWorkspaceRoot(fallbackWorkspaceRoot)
  const checkpointWorkspaceKey = checkpointWorkspaceRoot.replaceAll('\\', '/').toLowerCase()
  if (
    settings.checkpointCleanup?.createEnabled &&
    checkpointWorkspaceRoot &&
    threadActionSharedState.checkpointGitAvailability.canAttempt(checkpointWorkspaceKey) &&
    typeof window.kunGui.createGitCheckpoint === 'function'
  ) {
    const checkpointId = createWorkspaceCheckpointRequestId()
    const checkpoint = window.kunGui.createGitCheckpoint({
      workspaceRoot: checkpointWorkspaceRoot,
      threadId: activeThreadId,
      checkpointId
    }).catch((error) => ({
      ok: false as const,
      reason: 'error' as const,
      message: error instanceof Error ? error.message : String(error)
    }))
    void checkpoint.then((result) => {
      if (
        result.ok ||
        result.reason === 'not_git_repo' ||
        result.reason === 'no_workspace' ||
        result.reason === 'disabled'
      ) return
      if (result.reason === 'git_unavailable') {
        threadActionSharedState.checkpointGitAvailability.markUnavailable(checkpointWorkspaceKey)
      }
      if (result.reason === 'quota_exceeded') {
        console.info('[git-checkpoint] skipped: storage quota exceeded', {
          reason: result.reason,
          workspaceRoot: checkpointWorkspaceRoot
        })
        return
      }
      void window.kunGui.logError(
        'git-checkpoint',
        result.reason === 'git_unavailable'
          ? 'Git checkpoint disabled for this workspace because Git was not found'
          : 'Failed to create Git checkpoint',
        {
          message: result.message,
          reason: result.reason,
          workspaceRoot: checkpointWorkspaceRoot
        }
      ).catch(() => undefined)
    })
    return checkpointId
  }
  return undefined
}
