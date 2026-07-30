export const GIT_BRANCH_STATUS_CHANGED_EVENT = 'kun:git-branch-status-changed'

export function notifyGitBranchStatusChanged(workspaceRoot: string): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
  window.dispatchEvent(
    new CustomEvent<string>(GIT_BRANCH_STATUS_CHANGED_EVENT, {
      detail: workspaceRoot
    })
  )
}
