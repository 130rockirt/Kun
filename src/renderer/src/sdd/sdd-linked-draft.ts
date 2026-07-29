import { sddDraftRelativePathForPlanPath } from '@shared/sdd'
import type { GuiPlanArtifact } from '../plan/plan-store'
import { buildSddDraftId, type SddDraft } from './sdd-draft-store'

export type SddThreadDraftRef = {
  workspaceRoot: string
  draftRelativePath: string
}

export function resolveLinkedSddDraft(options: {
  plan: GuiPlanArtifact | null
  threadDraftRef: SddThreadDraftRef | null
}): SddDraft | null {
  if (options.plan) {
    const relativePath = sddDraftRelativePathForPlanPath(options.plan.relativePath)
    if (relativePath) {
      return {
        id: buildSddDraftId(options.plan.workspaceRoot, relativePath),
        workspaceRoot: options.plan.workspaceRoot,
        relativePath,
        createdAt: options.plan.createdAt,
        updatedAt: options.plan.updatedAt
      }
    }
  }

  if (!options.threadDraftRef) return null
  const timestamp = new Date(0).toISOString()
  return {
    id: buildSddDraftId(
      options.threadDraftRef.workspaceRoot,
      options.threadDraftRef.draftRelativePath
    ),
    workspaceRoot: options.threadDraftRef.workspaceRoot,
    relativePath: options.threadDraftRef.draftRelativePath,
    createdAt: timestamp,
    updatedAt: timestamp
  }
}
