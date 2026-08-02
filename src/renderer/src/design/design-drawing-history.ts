export type DrawingHistoryMutation = {
  workspaceRoot: string
  documentId: string
  kind: 'clear' | 'delete'
}

function normalizeWorkspaceRoot(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/\/+$/, '')
}

export function drawingHistoryMutationMatches(
  mutation: DrawingHistoryMutation | null,
  workspaceRoot: string,
  documentId: string | null
): boolean {
  return Boolean(
    mutation &&
    mutation.workspaceRoot === normalizeWorkspaceRoot(workspaceRoot) &&
    mutation.documentId === documentId
  )
}
