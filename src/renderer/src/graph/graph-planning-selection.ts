import type { GraphPlanningDraftView } from './graph-types'

export function selectGraphPlanningCorrectionDraft(
  drafts: readonly GraphPlanningDraftView[],
  threadId: string | null
): GraphPlanningDraftView | null {
  if (!threadId) return null
  return drafts.find((view) =>
    view.draft.threadId === threadId &&
    view.draft.status === 'needs_correction') ?? null
}
