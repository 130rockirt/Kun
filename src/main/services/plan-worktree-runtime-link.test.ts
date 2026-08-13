import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { PlanWorktreeRunRecord } from '../../shared/plan-worktree'
import { createPlanWorktreeRuntimeLinkResolver } from './plan-worktree-runtime-link'

function record(patch: Partial<PlanWorktreeRunRecord> = {}): PlanWorktreeRunRecord {
  const executionPrompt = 'Exact authoritative plan prompt'
  return {
    version: 1,
    runId: 'run-1',
    operationId: 'operation-1',
    planId: 'plan-1',
    planRelativePath: '.kunsdd/plan/auth.md',
    planTitle: 'Auth',
    goalObjective: 'Implement and validate Auth',
    executionPrompt,
    executionDisplayText: 'Build Auth',
    executionPromptSha256: createHash('sha256').update(executionPrompt).digest('hex'),
    admissionClientRequestId: 'plan-build:run-1',
    sourceThreadId: 'thread-source',
    orchestration: 'direct',
    sourceWorkspaceRoot: '/repo',
    sourceCheckoutRoot: '/repo',
    primaryRepositoryRoot: '/repo',
    repositoryIdentity: '/repo/.git',
    targetBranch: 'feature/auth',
    baseCommit: 'a'.repeat(40),
    executionBranch: 'codex/auth-run',
    worktreePath: '/managed/run-1/repo',
    status: 'executing',
    cleanup: {
      threadRebound: false,
      worktreeRemoved: false,
      branchDeleted: false,
      metadataPruned: false
    },
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
    ...patch
  }
}

function origin(id = 'turn-execution') {
  return {
    id,
    prompt: 'Exact authoritative plan prompt',
    clientRequestId: 'plan-build:run-1',
    orchestration: 'direct',
    agentSurface: 'code'
  }
}

function identity(id = 'thread-execution') {
  return {
    id,
    workspace: '/managed/run-1/repo',
    relation: 'side',
    parentThreadId: 'thread-source',
    planBuildRunId: 'run-1'
  }
}

describe('plan worktree runtime link recovery', () => {
  it('discovers the unique side fork and adopts its sole post-fork turn', async () => {
    const runtimeRequest = vi.fn(async (path: string) => ({
      ok: true,
      status: 200,
      body: JSON.stringify(path.startsWith('/v1/threads?')
        ? { threads: [identity()] }
        : {
            ...identity(),
            forkedFromTurnCount: 1,
            goal: { objective: 'Implement and validate Auth', status: 'active' },
            turns: [{ id: 'turn-source' }, origin()]
          })
    }))

    await expect(createPlanWorktreeRuntimeLinkResolver(runtimeRequest)(record()))
      .resolves.toEqual({
        runId: 'run-1',
        executionThreadId: 'thread-execution',
        executionTurnId: 'turn-execution'
      })
  })

  it('fails closed when more than one side thread claims the run', async () => {
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: JSON.stringify({ threads: [identity('thread-a'), identity('thread-b')] })
    }))

    await expect(createPlanWorktreeRuntimeLinkResolver(runtimeRequest)(record()))
      .rejects.toMatchObject({ reason: 'thread_attach_failed' })
  })

  it('adopts the first post-fork origin when later continuation turns also exist', async () => {
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: JSON.stringify({
        ...identity(),
        forkedFromTurnCount: 0,
        goal: { objective: 'Implement and validate Auth', status: 'active' },
        turns: [origin('turn-a'), { id: 'turn-b' }]
      })
    }))

    await expect(createPlanWorktreeRuntimeLinkResolver(runtimeRequest)(record({
      executionThreadId: 'thread-execution'
    }))).resolves.toEqual({
      runId: 'run-1',
      executionThreadId: 'thread-execution',
      executionTurnId: 'turn-a'
    })
  })

  it('refuses to adopt a turn whose runtime goal differs from the durable objective', async () => {
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: JSON.stringify({
        ...identity(),
        forkedFromTurnCount: 0,
        goal: { objective: 'Unrelated work', status: 'complete' },
        turns: [origin()]
      })
    }))

    await expect(createPlanWorktreeRuntimeLinkResolver(runtimeRequest)(record({
      executionThreadId: 'thread-execution'
    }))).rejects.toMatchObject({ reason: 'external_state_changed' })
  })
})
