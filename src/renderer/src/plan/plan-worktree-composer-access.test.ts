import { describe, expect, it } from 'vitest'
import type { PlanWorktreeRunRecord } from '@shared/plan-worktree'
import type { NormalizedThread } from '../agent/types'
import {
  hydratePlanWorktreeComposerRun,
  planWorktreeComposerAccess
} from './plan-worktree-composer-access'
import type { PlanWorktreePlanState } from './plan-worktree-store'

const thread: NormalizedThread = {
  id: 'execution-thread', title: 'Execution', updatedAt: '', model: 'auto', mode: 'agent',
  workspace: '/managed/run/repo', planBuildRunId: 'run-a'
}

function run(
  status: PlanWorktreeRunRecord['status'],
  patch: Partial<PlanWorktreeRunRecord> = {}
): PlanWorktreeRunRecord {
  return {
    version: 1, runId: 'run-a', operationId: 'operation-a', planId: 'plan-a',
    planRelativePath: '.kunsdd/plan/demo.md', planTitle: 'Demo', goalObjective: 'Build Demo',
    sourceThreadId: 'source-thread', executionThreadId: thread.id, executionTurnId: 'turn-a',
    orchestration: 'direct', sourceWorkspaceRoot: '/repo', sourceCheckoutRoot: '/repo',
    primaryRepositoryRoot: '/repo', repositoryIdentity: '/repo/.git',
    targetBranch: 'feature/source', baseCommit: 'a'.repeat(40), executionBranch: 'codex/demo',
    worktreePath: '/managed/run/repo', executionWorkspace: '/managed/run/repo', status,
    cleanup: { threadRebound: false, worktreeRemoved: false, branchDeleted: false, metadataPruned: false },
    createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z',
    ...patch
  }
}

function plans(value: PlanWorktreeRunRecord): Record<string, PlanWorktreePlanState> {
  return {
    'plan-a': {
      initialized: true, recoveryChecked: true, featureEnabled: true,
      useWorktree: true, building: false,
      preflight: { status: 'idle', contextKey: '' }, run: value
    }
  }
}

describe('isolated plan execution composer access', () => {
  it.each([
    ['executing', true],
    ['ready_to_integrate', false],
    ['integrating', false],
    ['cleanup_pending', false]
  ] as const)('maps %s to writable=%s', (status, writable) => {
    expect(planWorktreeComposerAccess(thread, plans(run(status))).writable).toBe(writable)
  })

  it('only allows attention reasons that explicitly continue implementation', () => {
    expect(planWorktreeComposerAccess(
      thread,
      plans(run('needs_attention', { attentionReason: 'execution_interrupted' }))
    ).writable).toBe(true)
    expect(planWorktreeComposerAccess(
      thread,
      plans(run('needs_attention', { attentionReason: 'rebase_conflict' }))
    ).writable).toBe(false)
  })

  it('rejects input after admission is frozen, the worktree is removed, or before turn admission', () => {
    expect(planWorktreeComposerAccess(
      thread,
      plans(run('executing', { admissionFrozen: true }))
    ).writable).toBe(false)
    expect(planWorktreeComposerAccess(thread, plans(run('executing', {
      cleanup: { threadRebound: false, worktreeRemoved: true, branchDeleted: false, metadataPruned: false }
    }))).writable).toBe(false)
    expect(planWorktreeComposerAccess(
      thread,
      plans(run('executing', { executionTurnId: undefined }))
    ).writable).toBe(false)
  })

  it('uses the active side-thread id when its summary is absent', () => {
    const pending = run('executing', { executionTurnId: undefined })
    expect(planWorktreeComposerAccess(undefined, plans(pending), thread.id)).toMatchObject({
      writable: false,
      run: { runId: pending.runId }
    })
    expect(planWorktreeComposerAccess(
      undefined,
      plans(run('executing')),
      thread.id
    ).writable).toBe(true)
  })

  it('restores ordinary input only after a terminal execution thread is rebound', () => {
    expect(planWorktreeComposerAccess(thread, plans(run('completed'))).writable).toBe(false)
    expect(planWorktreeComposerAccess(thread, plans(run('completed', {
      cleanup: { threadRebound: true, worktreeRemoved: true, branchDeleted: true, metadataPruned: true }
    }))).writable).toBe(true)
  })

  it.each(['completed', 'cancelled'] as const)(
    'hydrates an exact %s run after restart before restoring ordinary input',
    async (status) => {
      const durable = run(status, {
        cleanup: { threadRebound: true, worktreeRemoved: true, branchDeleted: true, metadataPruned: true }
      })
      const getRun = async (runId: string) => runId === durable.runId ? durable : null
      let hydrated: PlanWorktreeRunRecord | undefined

      expect(planWorktreeComposerAccess(thread, {}).writable).toBe(false)
      expect(await hydratePlanWorktreeComposerRun(thread, {}, getRun, (value) => {
        hydrated = value
      })).toBe(true)
      expect(planWorktreeComposerAccess(thread, plans(hydrated!)).writable).toBe(true)
    }
  )
})
