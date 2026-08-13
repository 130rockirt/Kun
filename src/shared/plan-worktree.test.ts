import { describe, expect, it } from 'vitest'
import {
  PlanWorktreePreflightRequestSchema,
  PlanWorktreePrepareRequestSchema,
  PlanWorktreeRunRecordSchema
} from './plan-worktree'

const now = '2026-08-12T12:00:00.000Z'
const oid = 'a'.repeat(40)

function record() {
  return {
    version: 1,
    runId: 'run-1',
    operationId: 'operation-1',
    planId: 'plan-1',
    planRelativePath: '.kunsdd/plan/auth.md',
    planTitle: 'Auth',
    goalObjective: 'Implement and validate Auth',
    sourceThreadId: 'thread-source',
    orchestration: 'direct',
    sourceWorkspaceRoot: '/repo',
    sourceCheckoutRoot: '/repo',
    primaryRepositoryRoot: '/repo',
    repositoryIdentity: '/repo/.git',
    targetBranch: 'feature/auth',
    baseCommit: oid,
    executionBranch: 'codex/auth-run-1',
    worktreePath: '/home/user/.kun/worktrees/run-1/repo',
    status: 'preparing',
    cleanup: {
      threadRebound: false,
      worktreeRemoved: false,
      branchDeleted: false,
      metadataPruned: false
    },
    createdAt: now,
    updatedAt: now
  }
}

describe('plan worktree contracts', () => {
  it('round-trips a versioned strict run record', () => {
    expect(PlanWorktreeRunRecordSchema.parse(record())).toEqual(record())
    expect(() => PlanWorktreeRunRecordSchema.parse({ ...record(), unknown: true })).toThrow()
  })

  it('rejects unbounded and malformed ids, refs, paths, and commits', () => {
    expect(() => PlanWorktreeRunRecordSchema.parse({ ...record(), runId: 'x'.repeat(161) })).toThrow()
    expect(() => PlanWorktreeRunRecordSchema.parse({ ...record(), baseCommit: 'main' })).toThrow()
    expect(() => PlanWorktreeRunRecordSchema.parse({ ...record(), worktreePath: 'x'.repeat(4097) })).toThrow()
  })

  it('rejects unknown action fields and accepts linked source inputs', () => {
    expect(PlanWorktreePreflightRequestSchema.parse({ workspaceRoot: '/linked/repo' }))
      .toEqual({ workspaceRoot: '/linked/repo' })
    expect(() => PlanWorktreePreflightRequestSchema.parse({
      workspaceRoot: '/repo',
      deletePath: '/tmp'
    })).toThrow()
    expect(PlanWorktreePrepareRequestSchema.parse({
      operationId: 'op-1',
      planId: 'plan-1',
      planRelativePath: '.kunsdd/plan/auth.md',
      planTitle: 'Auth',
      goalObjective: 'Implement and validate Auth',
      executionPrompt: 'Exact plan prompt',
      executionDisplayText: 'Build Auth',
      sourceThreadId: 'thread-1',
      sourceWorkspaceRoot: '/repo',
      orchestration: 'graph'
    }).orchestration).toBe('graph')
    expect(() => PlanWorktreePrepareRequestSchema.parse({
      operationId: 'op-1',
      planId: 'plan-1',
      planRelativePath: '.kunsdd/plan/auth.md',
      planTitle: 'Auth',
      goalObjective: 'x'.repeat(4001),
      executionPrompt: 'Exact plan prompt',
      executionDisplayText: 'Build Auth',
      sourceThreadId: 'thread-1',
      sourceWorkspaceRoot: '/repo',
      orchestration: 'direct'
    })).toThrow()
  })
})
