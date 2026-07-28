import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileArtifactStore } from '../artifacts/artifact-store.js'
import { GRAPH_CONTRACT_VERSION, GraphPlanV1Schema } from '../contracts/graph.js'
import type {
  ChildRunRecord,
  ChildSecuritySnapshot,
  DelegationRuntime
} from '../delegation/delegation-runtime.js'
import { GraphAssignmentResolver } from './graph-assignment.js'
import { GraphControlService } from './graph-control-service.js'
import { FileGraphRunStore } from './graph-run-store.js'
import { GraphMailbox } from './graph-mailbox.js'
import { GraphScheduler } from './graph-scheduler.js'
import { GraphWorkerSessionRegistry } from './graph-worker-sessions.js'
import { FileGraphWriteCoordinator } from './graph-write-coordinator.js'
import { FileProjectAgentRegistry } from './project-agent-registry.js'
import {
  testCompletedChild,
  testGraphConfig,
  testGraphPlan
} from './graph-test-fixtures.test-support.js'
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
describe('GraphScheduler', () => {
  it('completes regardless of a legacy Graph token ceiling', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-graph-scheduler-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(workspace, 'src'), { recursive: true })
    const config = testGraphConfig({
      supervision: { requireFinalReview: false },
      writeIsolation: { mode: 'lease' }
    })
    let id = 0
    const nextId = (prefix: string) => `${prefix}_${++id}`
    const artifacts = new FileArtifactStore(join(root, 'artifacts'))
    const store = new FileGraphRunStore({
      rootDir: join(root, 'graphs'),
      config: () => config,
      artifactStore: artifacts,
      nextId
    })
    const control = new GraphControlService({ store, config: () => config, nextId })
    const registry = new FileProjectAgentRegistry({
      rootDir: join(root, 'agents'),
      config: () => config,
      nextId
    })
    const mailbox = new GraphMailbox({ store, config: () => config })
    const writes = new FileGraphWriteCoordinator({
      rootDir: join(root, 'resources'),
      config: () => config,
      artifactStore: artifacts,
      nextId
    })
    const sessions = new GraphWorkerSessionRegistry()
    const childSecurity: ChildSecuritySnapshot[] = []
    const fakeDelegation = {
      enabled: () => true,
      runChild: async (input: {
        onQueued?: (id: string) => Promise<void> | void
        onRunning?: (id: string) => Promise<void> | void
        security?: ChildSecuritySnapshot
      }) => {
        if (input.security) childSecurity.push(input.security)
        const childId = nextId('child')
        await input.onQueued?.(childId)
        await input.onRunning?.(childId)
        return {
          id: childId,
          status: 'completed',
          summary: JSON.stringify({
            summary: 'Verified node output.',
            changedFiles: [],
            checks: [{ name: 'verification', status: 'passed', summary: 'Passed.' }],
            evidence: ['Inspected relevant source.'],
            risks: []
          }),
          evidence: ['Inspected relevant source.'],
          usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
          durationMs: 5
        } as ChildRunRecord
      }
    } as unknown as DelegationRuntime
    const identity = await registry.identify(workspace)
    await control.create({
      runId: 'run_1',
      threadId: 'thread_1',
      projectId: identity.projectId,
      sourceTurnId: 'turn_1',
      plan: GraphPlanV1Schema.parse({
        ...testGraphPlan({ workspaceRoot: workspace, autoStart: true }),
        budget: {
          ...testGraphPlan().budget,
          maxTotalTokens: 1
        }
      }),
      commandId: 'command_create',
      idempotencyKey: 'create_1',
      start: true
    })
    await control.steer('run_1', {
      version: GRAPH_CONTRACT_VERSION,
      steeringId: 'steering_research',
      runId: 'run_1',
      target: { kind: 'node', nodeId: 'research' },
      text: 'Verify the relevant source before returning.',
      status: 'persisted',
      createdAt: new Date().toISOString()
    }, {
      commandId: 'command_steer',
      idempotencyKey: 'steer_research'
    })
    const scheduler = new GraphScheduler({
      store,
      config: () => config,
      delegation: () => fakeDelegation,
      registry,
      assignments: new GraphAssignmentResolver({ registry }),
      mailbox,
      writes,
      workerSessions: sessions,
      authorityForRun: () => ({
        workspaceRoot: workspace,
        model: 'test-model',
        providerId: 'test-provider',
        reasoningEffort: 'off',
        approvalPolicy: 'on-request',
        sandboxMode: 'workspace-write',
        allowedTools: ['read', 'grep', 'graph_worker_progress', 'graph_worker_submit_result'],
        blockedTools: [],
        allowedSkills: ['safe-skill'],
        blockedSkills: [],
        allowedMcpServers: [],
        blockedMcpServers: [],
        readScopes: ['.'],
        writeScopes: ['.'],
        networkAllowed: false
      }),
      artifactStore: artifacts,
      nextId,
      tickIntervalMs: 5
    })
    scheduler.start()
    const completed = await waitFor(async () => {
      const run = await store.get('run_1')
      return run?.status === 'completed' ? run : null
    })
    await scheduler.stop()
    expect(completed.status).toBe('completed')
    expect(completed.nodes.research.status).toBe('accepted')
    expect(completed.nodes.finish.status).toBe('accepted')
    expect(completed.summary?.finalAnswer).toContain('Verified node output')
    expect(completed.budget.totalTokens).toBe(40)
    expect(childSecurity).not.toHaveLength(0)
    expect(childSecurity.every((security) =>
      security.allowedProviderIds?.length === 0 &&
      security.allowedModelProviderIds?.join(',') === 'test-provider' &&
      security.allowedModelIds?.join(',') === 'test-model' &&
      security.allowedSkillIds?.join(',') === 'safe-skill' &&
      security.blockedProviderIds?.includes('imageGen') === true &&
      security.blockedProviderIds?.includes('videoGen') === true
    )).toBe(true)
    expect(completed.steering).toEqual(expect.arrayContaining([
      expect.objectContaining({
        steeringId: 'steering_research',
        status: 'handled'
      })
    ]))
    expect(completed.cleanup).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resourceKind: 'journal',
        resourceId: 'run_1',
        state: 'completed'
      })
    ]))
  }, 15_000)

  it('allows the final admitted attempt to finish at the global attempt limit', async () => {
    const source = {
      ...testGraphPlan().nodes[0]!,
      maxAttempts: 1
    }
    const plan = testGraphPlan({
      nodes: [source],
      edges: [],
      budget: {
        ...testGraphPlan().budget,
        maxAttemptsPerNode: 1
      },
      completionNodeIds: [source.id],
      autoStart: true
    })
    const delegation = {
      enabled: () => true,
      runChild: async (input: {
        onQueued?: (id: string) => Promise<void> | void
        onRunning?: (id: string) => Promise<void> | void
        signal?: AbortSignal
      }) => {
        await input.onQueued?.('child_final_attempt')
        await input.onRunning?.('child_final_attempt')
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 50)
          input.signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(input.signal?.reason ?? new Error('aborted'))
          }, { once: true })
        })
        return testCompletedChild('child_final_attempt', 'PASS')
      }
    } as unknown as DelegationRuntime
    const harness = await schedulerHarness(plan, () => delegation)
    harness.scheduler.start()
    const completed = await waitFor(async () => {
      const run = await harness.store.get('run_harness')
      return run?.status === 'completed' ? run : null
    })

    expect(completed.budget.attempts).toBe(1)
    expect(completed.nodes.research.status).toBe('accepted')
    expect(completed.nodes.research.attempts[0]?.status).toBe('accepted')
    await harness.scheduler.stop()
  }, 15_000)

  it('resumes an awaiting-human run after a durable user review', async () => {
    const source = testGraphPlan().nodes[0]!
    const plan = testGraphPlan({
      nodes: [{
        ...source,
        completion: {
          ...source.completion,
          review: {
            kinds: ['human'],
            requireAll: true,
            deterministicChecks: [],
            humanReason: 'User acceptance is required.'
          }
        }
      }],
      edges: [],
      completionNodeIds: [source.id],
      autoStart: true
    })
    const fakeDelegation = {
      enabled: () => true,
      runChild: async (input: {
        onQueued?: (id: string) => Promise<void> | void
        onRunning?: (id: string) => Promise<void> | void
      }) => {
        await input.onQueued?.('child_human')
        await input.onRunning?.('child_human')
        return testCompletedChild('child_human', 'Result awaiting user acceptance.')
      }
    } as unknown as DelegationRuntime
    const harness = await schedulerHarness(plan, () => fakeDelegation, {
      writeIsolation: { leaseTtlMs: 1_000 }
    })
    harness.scheduler.start()
    const waiting = await waitFor(async () => {
      const run = await harness.store.get('run_harness')
      return run?.status === 'awaiting_human' ? run : null
    })
    const attempt = waiting.nodes.research.attempts.at(-1)!
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    const lease = (await harness.writes.list()).leases.find((entry) =>
      entry.attemptId === attempt.id)
    expect(lease?.state).toBe('active')
    expect(Date.parse(lease!.expiresAt)).toBeGreaterThan(Date.now())
    await harness.control.recordReview('run_harness', {
      version: 1,
      reviewId: 'human_review_1',
      nodeId: 'research',
      attemptId: attempt.id,
      reviewerKind: 'human',
      outcome: 'pass',
      summary: 'Approved by user.',
      evidence: [],
      artifactRefs: [],
      createdAt: new Date().toISOString()
    }, {
      commandId: 'human_review_command',
      idempotencyKey: 'human_review_command',
      expectedSeq: waiting.lastEventSeq,
      expectedRevision: waiting.currentRevision
    })
    const completed = await waitFor(async () => {
      const run = await harness.store.get('run_harness')
      return run?.status === 'completed' ? run : null
    })
    await harness.scheduler.stop()
    expect(completed.nodes.research.status).toBe('accepted')
  }, 15_000)

  it('accepts any required reviewer pass when requireAll is false', async () => {
    const source = testGraphPlan().nodes[0]!
    const plan = testGraphPlan({
      nodes: [{
        ...source,
        completion: {
          ...source.completion,
          review: {
            kinds: ['deterministic', 'lead'],
            requireAll: false,
            deterministicChecks: []
          }
        }
      }],
      edges: [],
      completionNodeIds: [source.id],
      autoStart: true
    })
    const delegation = {
      enabled: () => true,
      runChild: async (input: {
        onQueued?: (id: string) => Promise<void> | void
        onRunning?: (id: string) => Promise<void> | void
      }) => {
        await input.onQueued?.('child_any_review')
        await input.onRunning?.('child_any_review')
        return testCompletedChild('child_any_review', 'Deterministic evidence is sufficient.')
      }
    } as unknown as DelegationRuntime
    const harness = await schedulerHarness(plan, () => delegation)
    harness.scheduler.start()
    const completed = await waitFor(async () => {
      const run = await harness.store.get('run_harness')
      return run?.status === 'completed' ? run : null
    })
    expect(completed.nodes.research.status).toBe('accepted')
    expect(completed.reviews.map((review) => review.reviewerKind)).toEqual(['deterministic'])
    await harness.scheduler.stop()
  }, 15_000)

  it('pauses once when delegation is unavailable instead of producing an event storm', async () => {
    const harness = await schedulerHarness(
      testGraphPlan({ autoStart: true }),
      () => undefined
    )
    await harness.scheduler.tick()
    const paused = await harness.store.get('run_harness')
    expect(paused?.status).toBe('paused')
    const seq = paused!.lastEventSeq
    await harness.scheduler.tick()
    expect((await harness.store.get('run_harness'))?.lastEventSeq).toBe(seq)
  }, 15_000)

  it('executes a bounded LoopGate repeatedly, preserves attempt history, and exits on exhaustion', async () => {
    const base = testGraphPlan()
    const start = { ...base.nodes[0]!, id: 'start', title: 'Start' }
    const body = { ...base.nodes[0]!, id: 'body', title: 'Loop body' }
    const gate = {
      ...base.nodes[0]!,
      id: 'gate',
      kind: 'loop_gate' as const,
      title: 'Bounded gate',
      objective: 'Continue while the body is accepted, then exhaust.',
      required: false,
      assignment: undefined,
      loopGate: {
        maxIterations: 2,
        condition: {
          sourceNodeId: 'body',
          outcomeIn: ['accepted' as const]
        },
        continueTargetNodeId: 'body',
        exitTargetNodeId: 'finish',
        exhaustionTargetNodeId: 'finish'
      }
    }
    const finish = { ...base.nodes[1]!, id: 'finish', title: 'Finish' }
    const plan = testGraphPlan({
      nodes: [start, body, gate, finish],
      edges: [
        {
          id: 'start_body',
          kind: 'control',
          from: 'start',
          to: 'body',
          requiredOutcomes: ['accepted']
        },
        {
          id: 'body_gate',
          kind: 'control',
          from: 'body',
          to: 'gate',
          requiredOutcomes: ['accepted']
        },
        {
          id: 'gate_body',
          kind: 'control',
          from: 'gate',
          to: 'body',
          requiredOutcomes: ['skipped']
        },
        {
          id: 'gate_finish',
          kind: 'control',
          from: 'gate',
          to: 'finish',
          requiredOutcomes: ['skipped']
        }
      ],
      completionNodeIds: ['finish'],
      autoStart: true
    })
    let child = 0
    const delegation = {
      enabled: () => true,
      runChild: async (input: {
        onQueued?: (id: string) => Promise<void> | void
        onRunning?: (id: string) => Promise<void> | void
      }) => {
        const id = `loop_child_${++child}`
        await input.onQueued?.(id)
        await input.onRunning?.(id)
        return testCompletedChild(id, `Completed ${id}.`)
      }
    } as unknown as DelegationRuntime
    const harness = await schedulerHarness(plan, () => delegation)
    const completed = await waitFor(async () => {
      await harness.scheduler.tick()
      const run = await harness.store.get('run_harness')
      return run?.status === 'completed' ? run : null
    }, 12_000)
    await harness.scheduler.stop()

    expect(completed.status).toBe('completed')
    expect(completed.budget.loopIterations).toBe(2)
    expect(completed.nodes.gate.status).toBe('skipped')
    expect(completed.nodes.gate.loopIteration).toBe(2)
    expect(completed.nodes.body.attempts).toHaveLength(3)
    expect(completed.nodes.body.attempts.map((attempt) => attempt.iteration)).toEqual([0, 1, 2])
    expect(completed.nodes.finish.status).toBe('accepted')
  }, 15_000)

  it('aborts active workers, discards late results, and records cleanup on cancellation', async () => {
    let workerAborted = false
    const delegation = {
      enabled: () => true,
      runChild: async (input: {
        onQueued?: (id: string) => Promise<void> | void
        onRunning?: (id: string) => Promise<void> | void
        signal?: AbortSignal
      }) => {
        await input.onQueued?.('child_cancel')
        await input.onRunning?.('child_cancel')
        return rejectWhenAborted(input.signal, () => {
          workerAborted = true
        })
      }
    } as unknown as DelegationRuntime
    const harness = await schedulerHarness(
      testGraphPlan({
        nodes: [testGraphPlan().nodes[0]!],
        edges: [],
        completionNodeIds: ['research'],
        autoStart: true
      }),
      () => delegation
    )
    await harness.scheduler.tick()
    await waitFor(async () => {
      const run = await harness.store.get('run_harness')
      return run?.nodes.research.status === 'running' ? run : null
    })
    const cancelled = await harness.control.cancel('run_harness', {
      commandId: 'cancel_active',
      idempotencyKey: 'cancel_active',
      reason: 'user cancelled'
    })

    expect(workerAborted).toBe(true)
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.nodes.research.status).toBe('cancelled')
    expect(cancelled.nodes.research.attempts[0]?.status).toBe('cancelled')
    expect(cancelled.cleanup).toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceKind: 'lease', state: 'completed' }),
      expect.objectContaining({ resourceKind: 'journal', state: 'completed' })
    ]))
    await harness.scheduler.stop()
  })

  it('host-aborts a worker that exceeds its node wall-time budget and retries safely', async () => {
    let calls = 0
    const node = {
      ...testGraphPlan().nodes[0]!,
      timeoutMs: 20,
      maxAttempts: 1
    }
    const delegation = {
      enabled: () => true,
      runChild: async (input: {
        onQueued?: (id: string) => Promise<void> | void
        onRunning?: (id: string) => Promise<void> | void
        signal?: AbortSignal
      }) => {
        calls += 1
        await input.onQueued?.('child_timeout')
        await input.onRunning?.('child_timeout')
        return rejectWhenAborted(input.signal)
      }
    } as unknown as DelegationRuntime
    const harness = await schedulerHarness(
      testGraphPlan({
        nodes: [node],
        edges: [],
        completionNodeIds: [node.id],
        autoStart: true
      }),
      () => delegation
    )
    harness.scheduler.start()
    const failed = await waitFor(async () => {
      await harness.scheduler.tick()
      const run = await harness.store.get('run_harness')
      return run?.status === 'failed' ? run : null
    })

    expect(calls).toBe(1)
    expect(failed.nodes.research.attempts[0]).toEqual(expect.objectContaining({
      status: 'failed',
      failureClass: 'retryable',
      normalizedFailure: 'Graph node wall-time budget exhausted'
    }))
    expect(failed.cleanup).toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceKind: 'journal', state: 'completed' })
    ]))
    const events = await harness.store.events('run_harness')
    expect(events.at(-1)?.event).toMatchObject({
      type: 'run_status_changed',
      payload: { to: 'failed' }
    })
    expect(events.findIndex((event) => event.event.type === 'cleanup_updated'))
      .toBeLessThan(events.length - 1)
    await harness.scheduler.stop()
  }, 15_000)

  it('enforces concurrent-run admission and gives the next run a turn after capacity frees', async () => {
    let calls = 0
    const delegation = {
      enabled: () => true,
      runChild: async (input: {
        onQueued?: (id: string) => Promise<void> | void
        onRunning?: (id: string) => Promise<void> | void
        signal?: AbortSignal
      }) => {
        calls += 1
        const childId = `child_fair_${calls}`
        await input.onQueued?.(childId)
        await input.onRunning?.(childId)
        return rejectWhenAborted(input.signal)
      }
    } as unknown as DelegationRuntime
    const singleNodePlan = testGraphPlan({
      nodes: [testGraphPlan().nodes[0]!],
      edges: [],
      budget: {
        ...testGraphPlan().budget,
        maxConcurrentNodes: 1
      },
      completionNodeIds: ['research'],
      autoStart: true
    })
    const harness = await schedulerHarness(singleNodePlan, () => delegation, {
      scheduler: {
        maxConcurrentRuns: 1,
        maxConcurrentNodes: 2,
        maxConcurrentNodesPerRun: 1
      }
    })
    await harness.control.create({
      runId: 'run_second',
      threadId: 'thread_second',
      projectId: harness.identity.projectId,
      sourceTurnId: 'turn_second',
      plan: testGraphPlan({
        ...singleNodePlan,
        workspaceRoot: harness.workspace
      }),
      commandId: 'create_second',
      idempotencyKey: 'create_second',
      start: true
    })

    await harness.scheduler.tick()
    const firstActive = await waitFor(async () => {
      const active = harness.scheduler.diagnostics().active
      return active.length === 1 ? active[0]! : null
    })
    expect(calls).toBe(1)
    await harness.scheduler.tick()
    expect(calls).toBe(1)

    await harness.control.cancel(firstActive.runId, {
      commandId: 'cancel_first_fair',
      idempotencyKey: 'cancel_first_fair'
    })
    await harness.scheduler.tick()
    await waitFor(async () => calls === 2 ? true : null)
    const remaining = (await harness.store.list({ statuses: ['running'] }))[0]
    if (remaining) {
      await harness.control.cancel(remaining.id, {
        commandId: 'cancel_second_fair',
        idempotencyKey: 'cancel_second_fair'
      })
    }
    await harness.scheduler.stop()
  }, 15_000)
})

async function schedulerHarness(
  plan: ReturnType<typeof testGraphPlan>,
  delegation: () => DelegationRuntime | undefined,
  configPatch: Parameters<typeof testGraphConfig>[0] = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'kun-graph-scheduler-harness-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(workspace, 'src'), { recursive: true })
  const config = testGraphConfig({
    ...configPatch,
    supervision: {
      requireFinalReview: false,
      ...configPatch.supervision
    },
    writeIsolation: {
      mode: 'lease',
      ...configPatch.writeIsolation
    }
  })
  let id = 0
  const nextId = (prefix: string) => `${prefix}_${++id}`
  const artifacts = new FileArtifactStore(join(root, 'artifacts'))
  const store = new FileGraphRunStore({
    rootDir: join(root, 'graphs'),
    config: () => config,
    artifactStore: artifacts,
    nextId
  })
  const registry = new FileProjectAgentRegistry({
    rootDir: join(root, 'agents'),
    config: () => config,
    nextId
  })
  const identity = await registry.identify(workspace)
  const normalizedPlan = testGraphPlan({ ...plan, workspaceRoot: workspace })
  const mailbox = new GraphMailbox({ store, config: () => config })
  const writes = new FileGraphWriteCoordinator({
    rootDir: join(root, 'resources'),
    config: () => config,
    artifactStore: artifacts,
    nextId
  })
  let scheduler: GraphScheduler | undefined
  const control = new GraphControlService({
    store,
    config: () => config,
    cancelActive: async (run) => {
      await scheduler?.cancelRun(run.id, 'cancel')
    },
    cleanupResources: (run) => writes.cleanupRun(run.id),
    nextId
  })
  await control.create({
    runId: 'run_harness',
    threadId: 'thread_harness',
    projectId: identity.projectId,
    sourceTurnId: 'turn_harness',
    plan: normalizedPlan,
    commandId: 'command_create_harness',
    idempotencyKey: 'create_harness',
    start: true
  })
  scheduler = new GraphScheduler({
    store,
    config: () => config,
    delegation,
    registry,
    assignments: new GraphAssignmentResolver({ registry }),
    mailbox,
    writes,
    workerSessions: new GraphWorkerSessionRegistry(),
    authorityForRun: () => ({
      workspaceRoot: workspace,
      model: 'test-model',
      providerId: 'default',
      reasoningEffort: 'off',
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      allowedTools: ['read', 'graph_worker_submit_result'],
      blockedTools: [],
      allowedSkills: [],
      blockedSkills: [],
      allowedMcpServers: [],
      blockedMcpServers: [],
      readScopes: ['.'],
      writeScopes: ['.'],
      networkAllowed: false
    }),
    artifactStore: artifacts,
    nextId,
    tickIntervalMs: 5
  })
  return { store, control, scheduler, identity, workspace, writes }
}

async function waitFor<T>(
  read: () => Promise<T | null>,
  timeoutMs = 10_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for Graph scheduler')
}
function rejectWhenAborted(
  signal: AbortSignal | undefined,
  onAbort?: () => void
): Promise<ChildRunRecord> {
  return new Promise((_resolve, reject) => {
    const abort = () => {
      onAbort?.()
      reject(signal?.reason ?? new Error('aborted'))
    }
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}
