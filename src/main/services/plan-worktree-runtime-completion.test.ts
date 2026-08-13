import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { PlanWorktreeCompletionSnapshot, PlanWorktreeRunRecord } from '../../shared/plan-worktree'
import { createPlanWorktreeRuntimeCompletionVerifier } from './plan-worktree-runtime-completion'

function record(orchestration: 'direct' | 'graph' = 'direct'): PlanWorktreeRunRecord {
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
    executionThreadId: 'thread-execution',
    executionTurnId: 'turn-execution',
    orchestration,
    sourceWorkspaceRoot: '/repo',
    sourceCheckoutRoot: '/repo',
    primaryRepositoryRoot: '/repo',
    repositoryIdentity: '/repo/.git',
    targetBranch: 'feature/auth',
    baseCommit: 'a'.repeat(40),
    executionBranch: 'codex/auth-run1',
    worktreePath: '/tmp/run-1',
    status: 'executing',
    cleanup: {
      threadRebound: false,
      worktreeRemoved: false,
      branchDeleted: false,
      metadataPruned: false
    },
    createdAt: '2026-08-12T12:00:00.000Z',
    updatedAt: '2026-08-12T12:00:00.000Z'
  }
}

function claim(): PlanWorktreeCompletionSnapshot {
  return {
    executionTurnId: 'turn-execution',
    turnStatus: 'completed',
    goalStatus: 'complete',
    hasLaterRunningTurn: false,
    hasPendingApproval: false,
    hasPendingUserInput: false,
    graphStatus: 'not_applicable',
    graphHasPendingGate: false
  }
}

function thread(
  overrides: Record<string, unknown> = {},
  orchestration: 'direct' | 'graph' = 'direct'
): Record<string, unknown> {
  return {
    id: 'thread-execution',
    workspace: '/tmp/run-1',
    relation: 'side',
    parentThreadId: 'thread-source',
    planBuildRunId: 'run-1',
    forkedFromTurnCount: 1,
    goal: { objective: 'Implement and validate Auth', status: 'complete' },
    pendingUserInputIds: [],
    pendingApprovalIds: [],
    turns: [
      { id: 'turn-source', status: 'completed' },
      originTurn('completed', orchestration)
    ],
    ...overrides
  }
}

function originTurn(
  status: string,
  orchestration: 'direct' | 'graph' = 'direct'
): Record<string, unknown> {
  return {
    id: 'turn-execution',
    status,
    prompt: 'Exact authoritative plan prompt',
    clientRequestId: 'plan-build:run-1',
    orchestration,
    agentSurface: 'code'
  }
}

describe('plan worktree runtime completion verification', () => {
  it('ignores forged renderer flags and projects authoritative thread blockers', async () => {
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: JSON.stringify(thread({
        goal: { objective: 'Implement and validate Auth', status: 'active' },
        pendingApprovalIds: ['approval-1'],
        turns: [
          { id: 'turn-source', status: 'completed' },
          originTurn('running')
        ]
      }))
    }))

    const verified = await createPlanWorktreeRuntimeCompletionVerifier(runtimeRequest)(
      record(),
      claim()
    )
    expect(verified).toMatchObject({
      turnStatus: 'running',
      goalStatus: 'active',
      hasPendingApproval: true
    })
  })

  it('rejects a runtime thread that is not the attached side fork identity', async () => {
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: JSON.stringify(thread({ planBuildRunId: 'another-run' }))
    }))

    await expect(createPlanWorktreeRuntimeCompletionVerifier(runtimeRequest)(
      record(),
      claim()
    )).rejects.toThrow(/no longer matches/i)
  })

  it('never trusts a claimed later turn when the host has not adopted an origin', async () => {
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: JSON.stringify(thread({
        turns: [
          { id: 'turn-source', status: 'completed' },
          { id: 'turn-origin', status: 'running' },
          { id: 'turn-later', status: 'completed' }
        ]
      }))
    }))
    const withoutOrigin = { ...record(), executionTurnId: undefined }

    await expect(createPlanWorktreeRuntimeCompletionVerifier(runtimeRequest)(
      withoutOrigin,
      { ...claim(), executionTurnId: 'turn-later' }
    )).rejects.toThrow(/origin turn has not been durably adopted/i)
  })

  it('aggregates continuation turns from the immutable execution-turn anchor', async () => {
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: JSON.stringify(thread({
        turns: [
          { id: 'turn-source', status: 'completed' },
          originTurn('completed'),
          { id: 'turn-continuation', status: 'failed' }
        ]
      }))
    }))

    const verified = await createPlanWorktreeRuntimeCompletionVerifier(runtimeRequest)(
      record(),
      claim()
    )
    expect(verified).toMatchObject({
      executionTurnId: 'turn-execution',
      turnStatus: 'failed',
      hasLaterRunningTurn: false
    })
  })

  it.each(['failed', 'aborted'] as const)(
    'allows a successful continuation to supersede an earlier %s turn',
    async (earlierStatus) => {
      const runtimeRequest = vi.fn(async () => ({
        ok: true,
        status: 200,
        body: JSON.stringify(thread({
          turns: [
            { id: 'turn-source', status: 'completed' },
            originTurn(earlierStatus),
            { id: 'turn-continuation', status: 'completed' }
          ]
        }))
      }))

      const verified = await createPlanWorktreeRuntimeCompletionVerifier(runtimeRequest)(
        record(),
        claim()
      )
      expect(verified.turnStatus).toBe('completed')
    }
  )

  it('rejects completion when the durable goal objective was replaced', async () => {
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: JSON.stringify(thread({
        goal: { objective: 'Do some unrelated task', status: 'complete' }
      }))
    }))

    await expect(createPlanWorktreeRuntimeCompletionVerifier(runtimeRequest)(
      record(),
      claim()
    )).rejects.toThrow(/goal no longer matches/i)
  })

  it('requires a completed Graph with accepted integration and no pending gate', async () => {
    const runtimeRequest = vi.fn(async (path: string) => {
      if (path.startsWith('/v1/threads/')) {
        return { ok: true, status: 200, body: JSON.stringify(thread({}, 'graph')) }
      }
      if (path.startsWith('/v1/graphs?')) {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            runs: [{
              id: 'graph-1', threadId: 'thread-execution',
              sourceTurnId: 'turn-execution', status: 'completed'
            }]
          })
        }
      }
      return {
        ok: true,
        status: 200,
        body: JSON.stringify({
          id: 'graph-1',
          threadId: 'thread-execution',
          sourceTurnId: 'turn-execution',
          status: 'completed',
          nodes: {
            integrate: {
              status: 'accepted',
              node: { kind: 'integration', required: true }
            }
          },
          cleanup: [{ state: 'completed' }],
          supervision: { pendingActions: [], peerReviewLeases: [] }
        })
      }
    })

    const verified = await createPlanWorktreeRuntimeCompletionVerifier(runtimeRequest)(
      record('graph'),
      { ...claim(), graphStatus: 'completed' }
    )
    expect(verified).toMatchObject({
      graphStatus: 'completed',
      graphHasPendingGate: false
    })
  })

  it('allows a successful Graph continuation to supersede a closed failed attempt', async () => {
    const runtimeRequest = vi.fn(async (path: string) => {
      if (path.startsWith('/v1/threads/')) {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify(thread({
            turns: [
              { id: 'turn-source', status: 'completed' },
              originTurn('failed', 'graph'),
              { id: 'turn-continuation', status: 'completed', orchestration: 'graph' }
            ]
          }))
        }
      }
      if (path.startsWith('/v1/graphs?')) {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            runs: [
              {
                id: 'graph-failed', threadId: 'thread-execution',
                sourceTurnId: 'turn-execution', status: 'failed'
              },
              {
                id: 'graph-success', threadId: 'thread-execution',
                sourceTurnId: 'turn-continuation', status: 'completed'
              }
            ]
          })
        }
      }
      const failed = path.endsWith('/graph-failed')
      return {
        ok: true,
        status: 200,
        body: JSON.stringify({
          id: failed ? 'graph-failed' : 'graph-success',
          threadId: 'thread-execution',
          sourceTurnId: failed ? 'turn-execution' : 'turn-continuation',
          status: failed ? 'failed' : 'completed',
          nodes: {
            integrate: {
              status: failed ? 'superseded' : 'accepted',
              node: { kind: 'integration', required: true }
            }
          },
          cleanup: [{ state: 'completed' }],
          supervision: { pendingActions: [], peerReviewLeases: [] }
        })
      }
    })

    const verified = await createPlanWorktreeRuntimeCompletionVerifier(runtimeRequest)(
      record('graph'),
      { ...claim(), graphStatus: 'completed' }
    )
    expect(verified).toMatchObject({
      turnStatus: 'completed',
      graphStatus: 'completed',
      graphHasPendingGate: false
    })
  })

  it('projects a failed Graph continuation on a run that originated as Direct', async () => {
    const runtimeRequest = vi.fn(async (path: string) => {
      if (path.startsWith('/v1/threads/')) {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify(thread({
            turns: [
              { id: 'turn-source', status: 'completed' },
              originTurn('completed'),
              { id: 'turn-graph', status: 'completed', orchestration: 'graph' }
            ]
          }))
        }
      }
      if (path.startsWith('/v1/graphs?')) {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            runs: [{
              id: 'graph-failed', threadId: 'thread-execution',
              sourceTurnId: 'turn-graph', status: 'failed'
            }]
          })
        }
      }
      return {
        ok: true,
        status: 200,
        body: JSON.stringify({
          id: 'graph-failed',
          threadId: 'thread-execution',
          sourceTurnId: 'turn-graph',
          status: 'failed',
          nodes: {},
          cleanup: [{ state: 'completed' }],
          supervision: { pendingActions: [], peerReviewLeases: [] }
        })
      }
    })

    const verified = await createPlanWorktreeRuntimeCompletionVerifier(runtimeRequest)(
      record('direct'),
      claim()
    )
    expect(verified).toMatchObject({ graphStatus: 'failed', graphHasPendingGate: false })
  })

  it('follows every Graph list page before identifying the execution run', async () => {
    const runtimeRequest = vi.fn(async (path: string) => {
      if (path.startsWith('/v1/threads/')) {
        return { ok: true, status: 200, body: JSON.stringify(thread({}, 'graph')) }
      }
      if (path.includes('/v1/graphs?') && !path.includes('cursor=')) {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            runs: [{
              id: 'graph-other', threadId: 'thread-execution',
              sourceTurnId: 'turn-other', status: 'completed'
            }],
            nextCursor: 'page-2'
          })
        }
      }
      if (path.includes('/v1/graphs?')) {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            runs: [{
              id: 'graph-1', threadId: 'thread-execution',
              sourceTurnId: 'turn-execution', status: 'completed'
            }]
          })
        }
      }
      return {
        ok: true,
        status: 200,
        body: JSON.stringify({
          id: 'graph-1',
          threadId: 'thread-execution',
          sourceTurnId: 'turn-execution',
          status: 'completed',
          nodes: {
            integrate: { status: 'accepted', node: { kind: 'integration', required: true } }
          },
          cleanup: [{ state: 'completed' }],
          supervision: { pendingActions: [], peerReviewLeases: [] }
        })
      }
    })

    const verified = await createPlanWorktreeRuntimeCompletionVerifier(runtimeRequest)(
      record('graph'),
      { ...claim(), graphStatus: 'completed' }
    )
    expect(verified.graphHasPendingGate).toBe(false)
    expect(runtimeRequest).toHaveBeenCalledWith(
      expect.stringContaining('cursor=page-2'),
      'GET'
    )
  })
})
