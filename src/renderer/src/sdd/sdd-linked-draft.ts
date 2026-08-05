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
  // 当前需求 AI 会话的草稿关联优先于(可能过期的)实现计划:即使活动 Plan
  // 指向草稿 A,只要当前线程明确属于草稿 B,会话内“需求草稿”按钮必须打开 B。
  if (options.threadDraftRef) {
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

  return null
}
