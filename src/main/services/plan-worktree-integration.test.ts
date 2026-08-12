import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  PlanWorktreeCompletionSnapshot,
  PlanWorktreePrepareRequest
} from '../../shared/plan-worktree'
import { runGit } from './git-service'
import { PlanWorktreeCoordinator } from './plan-worktree-coordinator'
import {
  evaluatePlanWorktreeCompletion,
  PlanWorktreeIntegration
} from './plan-worktree-integration'
import { PlanWorktreeRunStore } from './plan-worktree-run-store'

const roots: string[] = []

async function temp(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `kun-plan-integration-${name}-`))
  roots.push(root)
  return root
}

async function repository(name: string): Promise<string> {
  const root = await temp(name)
  await runGit(root, ['init', '-b', 'feature/source'])
  await writeFile(join(root, 'shared.txt'), 'base\n', 'utf8')
  await runGit(root, ['add', 'shared.txt'])
  await commit(root, 'initial')
  return root
}

async function commit(cwd: string, message: string): Promise<void> {
  await runGit(cwd, [
    '-c', 'user.name=Kun Test',
    '-c', 'user.email=kun@example.invalid',
    'commit', '-m', message
  ])
}

function prepareRequest(workspace: string, id = '1'): PlanWorktreePrepareRequest {
  return {
    operationId: `operation-${id}`,
    planId: `plan-${id}`,
    planRelativePath: `.kunsdd/plan/plan-${id}.md`,
    planTitle: `Plan ${id}`,
    goalObjective: `Implement and validate Plan ${id}`,
    executionPrompt: `Exact Plan ${id} prompt`,
    executionDisplayText: `Build Plan ${id}`,
    sourceThreadId: `thread-source-${id}`,
    sourceWorkspaceRoot: workspace,
    orchestration: 'direct',
    branchPrefix: 'codex/'
  }
}

function completion(turnId = 'turn-execution'): PlanWorktreeCompletionSnapshot {
  return {
    executionTurnId: turnId,
    turnStatus: 'completed',
    goalStatus: 'complete',
    hasLaterRunningTurn: false,
    hasPendingApproval: false,
    hasPendingUserInput: false,
    graphStatus: 'not_applicable',
    graphHasPendingGate: false
  }
}

async function harness(name: string) {
  const source = await repository(name)
  const userData = await temp(`${name}-data`)
  const managedRoot = await temp(`${name}-managed`)
  const store = new PlanWorktreeRunStore(userData)
  let id = 0
  const coordinator = new PlanWorktreeCoordinator({
    store,
    managedRoot,
    createRunId: () => `run-${name}-${++id}`,
    verifyExecutionThread: async () => undefined,
    recoverExecutionLink: async () => null
  })
  return { source, userData, managedRoot, store, coordinator }
}

function verifiedIntegration(
  options: Omit<ConstructorParameters<typeof PlanWorktreeIntegration>[0], 'verifyCompletion'>
): PlanWorktreeIntegration {
  return new PlanWorktreeIntegration({
    rebindThreadWorkspace: async () => undefined,
    ...options,
    // Model the runtime as authoritative across finalize and every later
    // retry/merge fence instead of echoing the deliberately-incomplete probe.
    verifyCompletion: async (_record, claimed) => completion(claimed.executionTurnId)
  })
}

async function attachExecution(
  coordinator: PlanWorktreeCoordinator,
  runId: string,
  executionTurnId = 'turn-execution'
): Promise<void> {
  await coordinator.attachThread({
    runId,
    executionThreadId: `thread-${runId}`,
    executionTurnId
  })
}

async function missing(path: string): Promise<boolean> {
  try {
    await access(path)
    return false
  } catch {
    return true
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('plan worktree integration', () => {
  it('gates completion using turn, goal, blocker, and Graph truth', () => {
    expect(evaluatePlanWorktreeCompletion(completion(), 'direct').eligible).toBe(true)
    expect(evaluatePlanWorktreeCompletion({
      ...completion(),
      goalStatus: 'active'
    }, 'direct')).toMatchObject({ eligible: false, reason: 'execution_incomplete' })
    expect(evaluatePlanWorktreeCompletion({
      ...completion(),
      hasPendingApproval: true
    }, 'direct')).toMatchObject({ eligible: false, reason: 'pending_approval' })
    expect(evaluatePlanWorktreeCompletion({
      ...completion(),
      graphStatus: 'running',
      graphHasPendingGate: true
    }, 'graph')).toMatchObject({ eligible: false, reason: 'graph_incomplete' })
    expect(evaluatePlanWorktreeCompletion({
      ...completion(),
      graphStatus: 'failed'
    }, 'direct')).toMatchObject({ eligible: false, reason: 'execution_failed' })
  })

  it('refuses completion before a linked execution thread is attached', async () => {
    const h = await harness('unattached')
    const run = await h.coordinator.prepare(prepareRequest(h.source))
    await writeFile(join(run.worktreePath, 'must-stay.txt'), 'retained\n', 'utf8')
    const verifyCompletion = vi.fn(async (_record, claimed) => claimed)

    const result = await new PlanWorktreeIntegration({
      store: h.store,
      managedRoot: h.managedRoot,
      verifyCompletion
    }).finalize({ runId: run.runId, completion: completion() })

    expect(result).toMatchObject({
      status: 'needs_attention',
      attentionReason: 'thread_attach_failed'
    })
    expect(verifyCompletion).not.toHaveBeenCalled()
    expect(await missing(run.worktreePath)).toBe(false)
  })

  it('keeps ordinary active-goal and Graph-running snapshots in executing state', async () => {
    const h = await harness('still-running')
    const run = await h.coordinator.prepare(prepareRequest(h.source))
    await attachExecution(h.coordinator, run.runId)
    const integration = new PlanWorktreeIntegration({
      store: h.store,
      managedRoot: h.managedRoot,
      verifyCompletion: async (_record, claimed) => ({ ...claimed, goalStatus: 'active' })
    })

    const result = await integration.finalize({ runId: run.runId, completion: completion() })
    expect(result.status).toBe('executing')
    expect(result.attentionReason).toBeUndefined()
  })

  it('commits remaining changes, fast-forwards the captured branch, rebinds, and cleans', async () => {
    const h = await harness('success')
    const run = await h.coordinator.prepare(prepareRequest(h.source))
    await writeFile(join(run.worktreePath, 'implemented.txt'), 'done\n', 'utf8')
    await h.coordinator.attachThread({
      runId: run.runId,
      executionThreadId: 'thread-execution',
      executionTurnId: 'turn-execution'
    })
    const rebind = vi.fn(async () => undefined)
    const integration = verifiedIntegration({
      store: h.store,
      managedRoot: h.managedRoot,
      rebindThreadWorkspace: rebind
    })

    const completed = await integration.finalize({ runId: run.runId, completion: completion() })
    expect(completed.status).toBe('completed')
    expect(completed.cleanup).toEqual({
      threadRebound: true,
      worktreeRemoved: true,
      branchDeleted: true,
      metadataPruned: true
    })
    expect(await readFile(join(h.source, 'implemented.txt'), 'utf8')).toBe('done\n')
    expect(await missing(run.worktreePath)).toBe(true)
    expect(rebind).toHaveBeenCalledWith('thread-execution', completed.sourceCheckoutRoot)
    await expect(runGit(h.source, [
      'show-ref', '--verify', `refs/heads/${run.executionBranch}`
    ])).rejects.toThrow()
  })

  it('moves a frozen execution transcript before removing its worktree', async () => {
    const h = await harness('fenced-rebind-order')
    const run = await h.coordinator.prepare(prepareRequest(h.source))
    await writeFile(join(run.worktreePath, 'implemented.txt'), 'done\n', 'utf8')
    await h.coordinator.attachThread({
      runId: run.runId,
      executionThreadId: 'thread-fenced',
      executionTurnId: 'turn-execution'
    })
    const transitions: Array<{ workspace?: string; frozen: boolean }> = []
    const integration = verifiedIntegration({
      store: h.store,
      managedRoot: h.managedRoot,
      setAdmissionFence: async (request) => {
        transitions.push({ workspace: request.workspace, frozen: request.frozen })
      },
      beforeExecutionBranchDelete: async () => {
        expect(transitions.at(-1)).toMatchObject({ frozen: true })
        expect(transitions.at(-1)?.workspace).toBeTruthy()
      }
    })

    const completed = await integration.finalize({ runId: run.runId, completion: completion() })

    expect(completed.status).toBe('completed')
    expect(transitions).toEqual([
      { workspace: undefined, frozen: true },
      { workspace: completed.executionWorkspace, frozen: true },
      { workspace: completed.executionWorkspace, frozen: false }
    ])
    expect(await missing(run.worktreePath)).toBe(true)
  })

  it('rebases inside the isolated worktree when the target advances', async () => {
    const h = await harness('rebase')
    const run = await h.coordinator.prepare(prepareRequest(h.source))
    await attachExecution(h.coordinator, run.runId)
    await writeFile(join(run.worktreePath, 'executor.txt'), 'executor\n', 'utf8')
    await writeFile(join(h.source, 'target.txt'), 'target\n', 'utf8')
    await runGit(h.source, ['add', 'target.txt'])
    await commit(h.source, 'target advanced')
    const integration = verifiedIntegration({
      store: h.store,
      managedRoot: h.managedRoot
    })

    const completed = await integration.finalize({ runId: run.runId, completion: completion() })
    expect(completed.status).toBe('completed')
    expect(await readFile(join(h.source, 'target.txt'), 'utf8')).toBe('target\n')
    expect(await readFile(join(h.source, 'executor.txt'), 'utf8')).toBe('executor\n')
    expect(completed.reconciledTargetHead).not.toBe(run.baseCommit)
  })

  it('contains rebase conflicts and retains the worktree', async () => {
    const h = await harness('conflict')
    const run = await h.coordinator.prepare(prepareRequest(h.source))
    await attachExecution(h.coordinator, run.runId)
    await writeFile(join(run.worktreePath, 'shared.txt'), 'executor\n', 'utf8')
    await writeFile(join(h.source, 'shared.txt'), 'target\n', 'utf8')
    await runGit(h.source, ['add', 'shared.txt'])
    await commit(h.source, 'target conflict')
    const integration = verifiedIntegration({
      store: h.store,
      managedRoot: h.managedRoot
    })

    const retained = await integration.finalize({ runId: run.runId, completion: completion() })
    expect(retained).toMatchObject({
      status: 'needs_attention',
      attentionReason: 'rebase_conflict'
    })
    expect(await missing(run.worktreePath)).toBe(false)
    expect(await readFile(join(h.source, 'shared.txt'), 'utf8')).toBe('target\n')
  })

  it('retains work when the captured checkout switches branch or becomes dirty', async () => {
    const switched = await harness('switch')
    const switchedRun = await switched.coordinator.prepare(prepareRequest(switched.source))
    await attachExecution(switched.coordinator, switchedRun.runId)
    await writeFile(join(switchedRun.worktreePath, 'done.txt'), 'done', 'utf8')
    await runGit(switched.source, ['switch', '-c', 'other'])
    const switchedResult = await verifiedIntegration({
      store: switched.store,
      managedRoot: switched.managedRoot
    }).finalize({ runId: switchedRun.runId, completion: completion() })
    expect(switchedResult.attentionReason).toBe('source_branch_changed')
    expect(await missing(switchedRun.worktreePath)).toBe(false)

    const dirty = await harness('target-dirty')
    const dirtyRun = await dirty.coordinator.prepare(prepareRequest(dirty.source))
    await attachExecution(dirty.coordinator, dirtyRun.runId)
    await writeFile(join(dirtyRun.worktreePath, 'done.txt'), 'done', 'utf8')
    await writeFile(join(dirty.source, 'dirty.txt'), 'dirty', 'utf8')
    const dirtyResult = await verifiedIntegration({
      store: dirty.store,
      managedRoot: dirty.managedRoot
    }).finalize({ runId: dirtyRun.runId, completion: completion() })
    expect(dirtyResult.attentionReason).toBe('source_checkout_dirty')
    expect(await missing(dirtyRun.worktreePath)).toBe(false)
  })

  it('does not merge execution commits added after completion verification', async () => {
    const h = await harness('execution-head-race')
    const run = await h.coordinator.prepare(prepareRequest(h.source))
    await writeFile(join(run.worktreePath, 'verified.txt'), 'verified\n', 'utf8')
    await attachExecution(h.coordinator, run.runId)
    const result = await verifiedIntegration({
      store: h.store,
      managedRoot: h.managedRoot,
      beforeSourceMerge: async () => {
        await writeFile(join(run.worktreePath, 'late.txt'), 'late\n', 'utf8')
        await runGit(run.worktreePath, ['add', 'late.txt'])
        await commit(run.worktreePath, 'late unverified commit')
      }
    }).finalize({ runId: run.runId, completion: completion() })

    expect(result).toMatchObject({
      status: 'needs_attention',
      attentionReason: 'external_state_changed'
    })
    expect(await missing(join(h.source, 'late.txt'))).toBe(true)
    expect(await missing(run.worktreePath)).toBe(false)
  })

  it('safe-cancels only unchanged runs and retains unique work', async () => {
    const h = await harness('cancel')
    const unchanged = await h.coordinator.prepare(prepareRequest(h.source, 'unchanged'))
    const integration = verifiedIntegration({
      store: h.store,
      managedRoot: h.managedRoot
    })
    expect((await integration.safeCancel({ runId: unchanged.runId })).status).toBe('cancelled')

    const changed = await h.coordinator.prepare(prepareRequest(h.source, 'changed'))
    await writeFile(join(changed.worktreePath, 'unique.txt'), 'unique', 'utf8')
    const retained = await integration.safeCancel({ runId: changed.runId })
    expect(retained).toMatchObject({
      status: 'needs_attention',
      attentionReason: 'unique_work_retained'
    })
    expect(await missing(changed.worktreePath)).toBe(false)
  })

  it('rebinds an attached transcript before cancelling an externally removed unchanged worktree', async () => {
    const h = await harness('cancel-missing')
    const run = await h.coordinator.prepare(prepareRequest(h.source))
    await h.coordinator.attachThread({
      runId: run.runId,
      executionThreadId: 'thread-cancelled'
    })
    await runGit(h.source, ['worktree', 'remove', run.worktreePath])
    const rebind = vi.fn(async () => undefined)
    const cancelled = await verifiedIntegration({
      store: h.store,
      managedRoot: h.managedRoot,
      rebindThreadWorkspace: rebind
    }).safeCancel({ runId: run.runId })

    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.cleanup.threadRebound).toBe(true)
    expect(rebind).toHaveBeenCalledWith('thread-cancelled', run.sourceCheckoutRoot)
  })

  it('serializes two completed runs onto the same captured target branch', async () => {
    const h = await harness('serialized')
    const first = await h.coordinator.prepare(prepareRequest(h.source, 'first'))
    const second = await h.coordinator.prepare(prepareRequest(h.source, 'second'))
    await attachExecution(h.coordinator, first.runId, 'turn-first')
    await attachExecution(h.coordinator, second.runId, 'turn-second')
    await writeFile(join(first.worktreePath, 'first.txt'), 'first\n', 'utf8')
    await writeFile(join(second.worktreePath, 'second.txt'), 'second\n', 'utf8')
    const integration = verifiedIntegration({
      store: h.store,
      managedRoot: h.managedRoot
    })

    const [a, b] = await Promise.all([
      integration.finalize({ runId: first.runId, completion: completion('turn-first') }),
      integration.finalize({ runId: second.runId, completion: completion('turn-second') })
    ])
    expect([a.status, b.status]).toEqual(['completed', 'completed'])
    expect(await readFile(join(h.source, 'first.txt'), 'utf8')).toBe('first\n')
    expect(await readFile(join(h.source, 'second.txt'), 'utf8')).toBe('second\n')
  })

  it('resumes cleanup after a post-integration thread rebind failure', async () => {
    const h = await harness('cleanup-retry')
    const run = await h.coordinator.prepare(prepareRequest(h.source))
    await writeFile(join(run.worktreePath, 'implemented.txt'), 'done\n', 'utf8')
    await h.coordinator.attachThread({
      runId: run.runId,
      executionThreadId: 'thread-execution',
      executionTurnId: 'turn-execution'
    })
    const failed = await verifiedIntegration({
      store: h.store,
      managedRoot: h.managedRoot,
      rebindThreadWorkspace: async () => { throw new Error('runtime offline') }
    }).finalize({ runId: run.runId, completion: completion() })
    expect(failed).toMatchObject({
      status: 'cleanup_pending',
      attentionReason: 'thread_rebind_failed'
    })
    expect(failed.integratedHead).toBeTruthy()
    expect(await readFile(join(h.source, 'implemented.txt'), 'utf8')).toBe('done\n')

    const rebind = vi.fn(async () => undefined)
    const completed = await verifiedIntegration({
      store: h.store,
      managedRoot: h.managedRoot,
      rebindThreadWorkspace: rebind
    }).retryIntegration(run.runId)
    expect(completed.status).toBe('completed')
    expect(rebind).toHaveBeenCalledTimes(1)
    expect(await missing(run.worktreePath)).toBe(true)
  })

  it('creates a recovery patch before an explicitly confirmed discard', async () => {
    const h = await harness('discard')
    const recoveryRoot = await temp('discard-recovery')
    const run = await h.coordinator.prepare(prepareRequest(h.source))
    await writeFile(join(run.worktreePath, 'unique.txt'), 'unique\n', 'utf8')
    await h.coordinator.attachThread({
      runId: run.runId,
      executionThreadId: 'thread-discarded'
    })
    const rebind = vi.fn(async () => undefined)
    const integration = verifiedIntegration({
      store: h.store,
      managedRoot: h.managedRoot,
      recoveryRoot,
      rebindThreadWorkspace: rebind
    })

    const discarded = await integration.discard({
      runId: run.runId,
      confirmedDiscard: true
    })
    expect(discarded.status).toBe('cancelled')
    expect(discarded.recoveryPatchPath).toBeTruthy()
    expect(await readFile(discarded.recoveryPatchPath!, 'utf8')).toContain('unique.txt')
    expect(await missing(run.worktreePath)).toBe(true)
    expect(rebind).toHaveBeenCalledWith('thread-discarded', run.sourceCheckoutRoot)
  })

  it('retains an explicitly discarded worktree when transcript rebinding fails', async () => {
    const h = await harness('discard-rebind')
    const recoveryRoot = await temp('discard-rebind-recovery')
    const run = await h.coordinator.prepare(prepareRequest(h.source))
    await writeFile(join(run.worktreePath, 'unique.txt'), 'unique\n', 'utf8')
    await h.coordinator.attachThread({
      runId: run.runId,
      executionThreadId: 'thread-retained'
    })

    const retained = await verifiedIntegration({
      store: h.store,
      managedRoot: h.managedRoot,
      recoveryRoot,
      rebindThreadWorkspace: async () => { throw new Error('runtime unavailable') }
    }).discard({ runId: run.runId, confirmedDiscard: true })

    expect(retained).toMatchObject({
      status: 'cleanup_pending',
      attentionReason: 'thread_rebind_failed'
    })
    expect(retained.recoveryPatchPath).toBeTruthy()
    expect(await missing(run.worktreePath)).toBe(false)
  })

  it('refuses a forced discard when the worktree changes after recovery capture', async () => {
    const h = await harness('discard-race')
    const recoveryRoot = await temp('discard-race-recovery')
    const run = await h.coordinator.prepare(prepareRequest(h.source))
    await writeFile(join(run.worktreePath, 'first.txt'), 'first\n', 'utf8')
    const raced = await verifiedIntegration({
      store: h.store,
      managedRoot: h.managedRoot,
      recoveryRoot,
      beforeDiscardRemove: async () => {
        await writeFile(join(run.worktreePath, 'late.txt'), 'late\n', 'utf8')
      }
    }).discard({ runId: run.runId, confirmedDiscard: true })

    expect(raced).toMatchObject({
      status: 'needs_attention',
      attentionReason: 'unique_work_retained'
    })
    expect(await missing(run.worktreePath)).toBe(false)
    expect(await readFile(raced.recoveryPatchPath!, 'utf8')).not.toContain('late.txt')

    const discarded = await verifiedIntegration({
      store: h.store,
      managedRoot: h.managedRoot,
      recoveryRoot
    }).discard({ runId: run.runId, confirmedDiscard: true })
    expect(discarded.status).toBe('cancelled')
    expect(await readFile(discarded.recoveryPatchPath!, 'utf8')).toContain('late.txt')
  })

  it('retains the worktree when its captured recovery patch is tampered with', async () => {
    const h = await harness('discard-patch-race')
    const recoveryRoot = await temp('discard-patch-race-recovery')
    const run = await h.coordinator.prepare(prepareRequest(h.source))
    await writeFile(join(run.worktreePath, 'unique.txt'), 'unique\n', 'utf8')
    const result = await verifiedIntegration({
      store: h.store,
      managedRoot: h.managedRoot,
      recoveryRoot,
      beforeDiscardRemove: async (current) => {
        await writeFile(current.recoveryPatchPath!, 'tampered\n', 'utf8')
      }
    }).discard({ runId: run.runId, confirmedDiscard: true })

    expect(result).toMatchObject({
      status: 'needs_attention',
      attentionReason: 'unique_work_retained'
    })
    expect(await missing(run.worktreePath)).toBe(false)
  })

  it('does not delete an execution branch recreated at a different commit', async () => {
    const h = await harness('branch-recreated')
    const run = await h.coordinator.prepare(prepareRequest(h.source))
    await writeFile(join(run.worktreePath, 'implemented.txt'), 'done\n', 'utf8')
    await attachExecution(h.coordinator, run.runId)
    const result = await verifiedIntegration({
      store: h.store,
      managedRoot: h.managedRoot,
      beforeExecutionBranchDelete: async (current) => {
        // This hook runs after ownership/OID validation but before the atomic
        // compare-and-delete, reproducing an external ref-swap race.
        await runGit(current.sourceCheckoutRoot, ['branch', '-D', current.executionBranch])
        await runGit(current.sourceCheckoutRoot, [
          'branch', current.executionBranch, current.baseCommit
        ])
      }
    }).finalize({ runId: run.runId, completion: completion() })

    expect(result).toMatchObject({
      status: 'needs_attention',
      attentionReason: 'external_state_changed'
    })
    expect((await runGit(h.source, [
      'rev-parse', `refs/heads/${run.executionBranch}`
    ])).stdout.trim()).toBe(run.baseCommit)
  })
})
