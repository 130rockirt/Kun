import { mkdtempSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlanWorktreeRunRecord } from '../../shared/plan-worktree'
import { PlanWorktreeCoordinator } from '../services/plan-worktree-coordinator'
import { PlanWorktreeRunStore } from '../services/plan-worktree-run-store'
import {
  cleanupAppIpcHandlerTestState,
  handlers,
  registerOptions,
  resetAppIpcHandlerTestState
} from './register-app-ipc-handlers.test-support'
import { registerAppIpcHandlers } from './register-app-ipc-handlers'

let userDataPath = ''

describe('plan worktree IPC handlers', () => {
  beforeEach(() => {
    resetAppIpcHandlerTestState()
    userDataPath = mkdtempSync(join(tmpdir(), 'kun-plan-worktree-ipc-'))
  })

  afterEach(() => {
    cleanupAppIpcHandlerTestState()
    vi.restoreAllMocks()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('registers the complete lifecycle surface and validates payloads strictly', async () => {
    registerAppIpcHandlers(registerOptions({ userDataPath }))
    for (const channel of [
      'plan-worktree:preflight',
      'plan-worktree:prepare',
      'plan-worktree:attach-thread',
      'plan-worktree:list',
      'plan-worktree:diagnostics',
      'plan-worktree:get',
      'plan-worktree:reconcile',
      'plan-worktree:resume-admission',
      'plan-worktree:finalize',
      'plan-worktree:retry-integration',
      'plan-worktree:continue-rebase',
      'plan-worktree:abort-rebase',
      'plan-worktree:safe-cancel',
      'plan-worktree:cleanup',
      'plan-worktree:discard'
    ]) {
      expect(handlers.get(channel), channel).toBeTypeOf('function')
    }

    await expect(handlers.get('plan-worktree:get')?.({}, {
      runId: '../escape',
      worktreePath: '/tmp/delete-me'
    })).rejects.toThrow(/Invalid payload for plan-worktree:get/)
    await expect(handlers.get('plan-worktree:discard')?.({}, {
      runId: 'run-1',
      confirmedDiscard: false
    })).rejects.toThrow(/Invalid payload for plan-worktree:discard/)
  })

  it('does not serve durable records until startup reconciliation finishes', async () => {
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    vi.spyOn(PlanWorktreeCoordinator.prototype, 'reconcileStartup')
      .mockImplementation(async () => {
        entered()
        await blocked
        return []
      })
    registerAppIpcHandlers(registerOptions({ userDataPath }))
    await started
    let settled = false
    const listing = handlers.get('plan-worktree:list')?.({}, {}).then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    release()
    await listing
    expect(settled).toBe(true)
  })

  it('verifies side-fork identity before persisting immutable attachment metadata', async () => {
    const store = new PlanWorktreeRunStore(userDataPath)
    const record = runRecord()
    await store.save(record)
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: JSON.stringify({
        id: 'thread-execution',
        workspace: record.worktreePath,
        relation: 'side',
        parentThreadId: record.sourceThreadId,
        planBuildRunId: record.runId,
        forkedFromTurnCount: 1,
        turns: [{ id: 'turn-source' }, { id: 'turn-execution' }]
      })
    }))
    registerAppIpcHandlers(registerOptions({ userDataPath, runtimeRequest }))

    const attached = await handlers.get('plan-worktree:attach-thread')?.({}, {
      runId: record.runId,
      executionThreadId: 'thread-execution'
    }) as PlanWorktreeRunRecord
    expect(attached.executionThreadId).toBe('thread-execution')
    expect(runtimeRequest).toHaveBeenCalledWith('/v1/threads/thread-execution', 'GET')

    runtimeRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: JSON.stringify({
        id: 'thread-execution',
        workspace: '/different-worktree',
        relation: 'side',
        parentThreadId: record.sourceThreadId,
        planBuildRunId: record.runId
      })
    })
    await expect(handlers.get('plan-worktree:attach-thread')?.({}, {
      runId: record.runId,
      executionThreadId: 'thread-execution',
      executionTurnId: 'turn-execution'
    })).rejects.toMatchObject({ reason: 'thread_attach_failed' })
    expect((await store.get(record.runId))?.executionTurnId).toBeUndefined()
  })

  it('rejects poisoning the durable origin with a later continuation turn', async () => {
    const store = new PlanWorktreeRunStore(userDataPath)
    const record = runRecord()
    await store.save(record)
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: JSON.stringify({
        ...executionThreadIdentity(record),
        forkedFromTurnCount: 1,
        turns: [
          { id: 'turn-source', status: 'completed' },
          { id: 'turn-origin', status: 'running' },
          { id: 'turn-later', status: 'completed' }
        ]
      })
    }))
    registerAppIpcHandlers(registerOptions({ userDataPath, runtimeRequest }))

    await expect(handlers.get('plan-worktree:attach-thread')?.({}, {
      runId: record.runId,
      executionThreadId: 'thread-execution',
      executionTurnId: 'turn-later'
    })).rejects.toMatchObject({ reason: 'thread_attach_failed' })
    expect((await store.get(record.runId))?.executionTurnId).toBeUndefined()
  })

  it('adopts the unique side thread and origin turn when Kun comes online later', async () => {
    const store = new PlanWorktreeRunStore(userDataPath)
    const record = runRecord()
    await store.save(record)
    let runtimeReady = false
    const runtimeRequest = vi.fn(async (path: string) => {
      if (!runtimeReady) return { ok: false, status: 503, body: '' }
      if (path.startsWith('/v1/threads?')) {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({ threads: [executionThreadIdentity(record)] })
        }
      }
      return {
        ok: true,
        status: 200,
        body: JSON.stringify({
          ...executionThreadIdentity(record),
          forkedFromTurnCount: 1,
          goal: { objective: record.goalObjective, status: 'active' },
          pendingUserInputIds: [],
          pendingApprovalIds: [],
          turns: [{ id: 'turn-source', status: 'completed' }, {
            ...executionOrigin(record), status: 'running'
          }, {
            id: 'turn-continuation', status: 'running'
          }]
        })
      }
    })
    registerAppIpcHandlers(registerOptions({ userDataPath, runtimeRequest }))
    await handlers.get('plan-worktree:list')?.({}, {})
    expect(await store.get(record.runId)).toMatchObject({
      status: 'needs_attention',
      attentionReason: 'thread_attach_failed'
    })
    expect((await store.get(record.runId))?.executionThreadId).toBeUndefined()

    runtimeReady = true
    const reconciled = await handlers.get('plan-worktree:reconcile')?.({}, {
      runId: record.runId
    }) as PlanWorktreeRunRecord
    expect(reconciled).toMatchObject({
      executionThreadId: 'thread-execution',
      executionTurnId: 'turn-execution'
    })
    expect(await store.get(record.runId)).toMatchObject({
      executionThreadId: 'thread-execution',
      executionTurnId: 'turn-execution'
    })
  })

  it('blocks destructive cancellation while a possible execution fork is undiscoverable', async () => {
    const store = new PlanWorktreeRunStore(userDataPath)
    await store.save(runRecord())
    const runtimeRequest = vi.fn(async () => ({ ok: false, status: 503, body: '' }))
    registerAppIpcHandlers(registerOptions({ userDataPath, runtimeRequest }))

    await expect(handlers.get('plan-worktree:safe-cancel')?.({}, {
      runId: 'run-ipc'
    })).rejects.toMatchObject({ reason: 'thread_attach_failed' })
    expect(await store.get('run-ipc')).toMatchObject({
      status: 'needs_attention',
      attentionReason: 'thread_attach_failed'
    })
  })
})

function executionThreadIdentity(record: PlanWorktreeRunRecord) {
  return {
    id: 'thread-execution',
    workspace: record.worktreePath,
    relation: 'side',
    parentThreadId: record.sourceThreadId,
    planBuildRunId: record.runId
  }
}

function executionOrigin(record: PlanWorktreeRunRecord) {
  return {
    id: 'turn-execution',
    prompt: record.executionPrompt,
    clientRequestId: record.admissionClientRequestId,
    orchestration: record.orchestration,
    agentSurface: 'code'
  }
}

function runRecord(): PlanWorktreeRunRecord {
  const executionPrompt = 'Exact IPC plan prompt'
  return {
    version: 1,
    runId: 'run-ipc',
    operationId: 'operation-ipc',
    planId: 'plan-ipc',
    planRelativePath: '.kunsdd/plan/ipc.md',
    planTitle: 'IPC',
    goalObjective: 'Implement and validate IPC',
    executionPrompt,
    executionDisplayText: 'Build IPC',
    executionPromptSha256: createHash('sha256').update(executionPrompt).digest('hex'),
    admissionClientRequestId: 'plan-build:run-ipc',
    sourceThreadId: 'thread-source',
    orchestration: 'direct',
    sourceWorkspaceRoot: '/repo',
    sourceCheckoutRoot: '/repo',
    primaryRepositoryRoot: '/repo',
    repositoryIdentity: '/repo/.git',
    targetBranch: 'feature/ipc',
    baseCommit: 'a'.repeat(40),
    executionBranch: 'codex/ipc-run',
    worktreePath: '/managed/run-ipc/repo',
    status: 'executing',
    cleanup: {
      threadRebound: false,
      worktreeRemoved: false,
      branchDeleted: false,
      metadataPruned: false
    },
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z'
  }
}
