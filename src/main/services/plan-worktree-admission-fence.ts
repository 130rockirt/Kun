import { relative, resolve } from 'node:path'
import { realpath } from 'node:fs/promises'
import type { PlanWorktreeRunRecord } from '../../shared/plan-worktree'
import type { PlanWorktreeRunStore } from './plan-worktree-run-store'

export type PlanWorktreeAdmissionFenceRequest = {
  threadId: string
  planBuildRunId: string
  expectedWorkspace: string
  frozen: boolean
  workspace?: string
}

export type SetPlanWorktreeAdmissionFence = (
  request: PlanWorktreeAdmissionFenceRequest
) => Promise<void>

export function isolatedExecutionWorkspace(record: PlanWorktreeRunRecord): string {
  const relativeWorkspace = relative(record.sourceCheckoutRoot, record.sourceWorkspaceRoot)
  const workspace = resolve(record.worktreePath, relativeWorkspace)
  const contained = relative(record.worktreePath, workspace)
  if (contained === '..' || contained.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error('The execution workspace escapes the managed worktree.')
  }
  return workspace
}

export function currentExecutionWorkspace(record: PlanWorktreeRunRecord): string {
  if (record.cleanup.threadRebound) return record.sourceWorkspaceRoot
  return record.executionWorkspace ?? isolatedExecutionWorkspace(record)
}

export class PlanWorktreeAdmissionFence {
  constructor(
    private readonly store: PlanWorktreeRunStore,
    private readonly timestamp: () => string,
    private readonly setFence?: SetPlanWorktreeAdmissionFence,
    private readonly legacyRebind?: (threadId: string, workspace: string) => Promise<void>,
    private readonly afterRuntimeTransition?: () => Promise<void>
  ) {}

  get enabled(): boolean {
    return Boolean(this.setFence)
  }

  async freeze(record: PlanWorktreeRunRecord): Promise<PlanWorktreeRunRecord> {
    if (!record.executionThreadId || !this.setFence) return record
    const current = record.admissionTransition
      ? await this.completeTransition(record)
      : record
    await this.setFence({
      threadId: current.executionThreadId!,
      planBuildRunId: current.runId,
      expectedWorkspace: currentExecutionWorkspace(current),
      frozen: true
    })
    return this.store.save({
      ...current,
      admissionFrozen: true,
      updatedAt: this.timestamp()
    })
  }

  async move(
    record: PlanWorktreeRunRecord,
    workspace: string,
    threadRebound: boolean
  ): Promise<PlanWorktreeRunRecord> {
    const canonicalWorkspace = await realpath(workspace).catch(() => resolve(workspace))
    let current = record
    if (record.executionThreadId && this.setFence) {
      const expectedWorkspace = currentExecutionWorkspace(record)
      const transition = {
        operationId: `fence-move:${record.runId}:${threadRebound ? 'source' : 'isolated'}`,
        expectedWorkspace,
        targetWorkspace: canonicalWorkspace,
        targetThreadRebound: threadRebound,
        targetFrozen: true
      }
      current = await this.store.save({
        ...record,
        admissionTransition: transition,
        updatedAt: this.timestamp()
      })
      return this.completeTransition(current)
    }
    if (record.executionThreadId) {
      if (this.legacyRebind) {
        await this.legacyRebind(record.executionThreadId, canonicalWorkspace)
      } else {
        throw new Error('Execution thread rebinding is unavailable.')
      }
    }
    return this.store.save({
      ...record,
      executionWorkspace: canonicalWorkspace,
      cleanup: { ...record.cleanup, threadRebound },
      status: 'cleanup_pending',
      updatedAt: this.timestamp()
    })
  }

  async release(
    record: PlanWorktreeRunRecord,
    workspace: string
  ): Promise<PlanWorktreeRunRecord> {
    const canonicalWorkspace = await realpath(workspace).catch(() => resolve(workspace))
    if (record.executionThreadId && this.setFence) {
      const current = record.admissionTransition
        ? await this.completeTransition(record)
        : record
      const transition = {
        operationId: `fence-release:${record.runId}:${canonicalWorkspace === record.sourceWorkspaceRoot ? 'source' : 'isolated'}`,
        expectedWorkspace: currentExecutionWorkspace(current),
        targetWorkspace: canonicalWorkspace,
        targetThreadRebound: canonicalWorkspace === record.sourceWorkspaceRoot,
        targetFrozen: false
      }
      const pending = await this.store.save({
        ...current,
        admissionTransition: transition,
        updatedAt: this.timestamp()
      })
      return this.completeTransition(pending)
    }
    return this.store.save({
      ...record,
      executionWorkspace: canonicalWorkspace,
      admissionFrozen: false,
      updatedAt: this.timestamp()
    })
  }

  private async completeTransition(
    record: PlanWorktreeRunRecord
  ): Promise<PlanWorktreeRunRecord> {
    const transition = record.admissionTransition
    if (!transition || !record.executionThreadId || !this.setFence) return record
    await this.setFence({
      threadId: record.executionThreadId,
      planBuildRunId: record.runId,
      expectedWorkspace: transition.expectedWorkspace,
      workspace: transition.targetWorkspace,
      frozen: transition.targetFrozen
    })
    await this.afterRuntimeTransition?.()
    return this.store.save({
      ...record,
      executionWorkspace: transition.targetWorkspace,
      cleanup: {
        ...record.cleanup,
        threadRebound: transition.targetThreadRebound
      },
      admissionFrozen: transition.targetFrozen,
      admissionTransition: undefined,
      updatedAt: this.timestamp()
    })
  }
}
