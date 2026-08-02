import { describe, expect, it, vi } from 'vitest'
import {
  GraphReviewResultV1Schema,
  GraphRunSummaryV1Schema,
  type GraphDomainEventV1,
  type GraphNodeAttemptV1,
  type GraphRunV1
} from '../contracts/graph.js'
import type { AppendGraphEventInput } from './graph-run-store.js'
import { applyGraphEvent } from './graph-reducer.js'
import { GraphSupervisor } from './graph-supervisor.js'
import {
  testAssignmentSnapshot,
  testCompletedChild,
  testGraphConfig,
  testGraphEnvelope,
  testGraphPlan
} from './graph-test-fixtures.test-support.js'

function baseRun(): GraphRunV1 {
  return applyGraphEvent(undefined, testGraphEnvelope(1, {
    type: 'run_created',
    payload: {
      plan: testGraphPlan(),
      projectId: 'project_1',
      sourceTurnId: 'turn_1'
    }
  }))
}

function applyTestAppend(
  current: GraphRunV1,
  input: AppendGraphEventInput
): {
  state: GraphRunV1
  envelope: ReturnType<typeof testGraphEnvelope>
  duplicate: false
} {
  const graphSeq = current.lastEventSeq + 1
  const envelope = testGraphEnvelope(graphSeq, input.event as GraphDomainEventV1, {
    eventId: `graph_event_${current.id}_${graphSeq}`,
    runId: current.id,
    threadId: current.threadId,
    graphRevision: input.graphRevision,
    ...(input.commandId ? { commandId: input.commandId } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    ...(input.timestamp ? { timestamp: input.timestamp } : {})
  })
  return {
    state: applyGraphEvent(current, envelope),
    envelope,
    duplicate: false
  }
}

function failedAttempt(id: string, attemptNumber: number, failure: string): GraphNodeAttemptV1 {
  return {
    version: 1,
    id,
    runId: 'run_1',
    nodeId: 'research',
    revision: 1,
    attemptNumber,
    iteration: 0,
    commandId: `command_${id}`,
    idempotencyKey: `attempt_${id}`,
    status: 'failed',
    assignment: testAssignmentSnapshot(),
    queuedAt: '2026-07-26T00:00:00.000Z',
    finishedAt: '2026-07-26T00:00:01.000Z',
    normalizedFailure: failure,
    failureClass: 'retryable',
    tokenUsage: 10,
    elapsedMs: 1_000
  }
}

function runningRun(startedAt: string): GraphRunV1 {
  const original = baseRun()
  const attempt: GraphNodeAttemptV1 = {
    version: 1,
    id: 'attempt_running',
    runId: original.id,
    nodeId: 'research',
    revision: 1,
    attemptNumber: 1,
    iteration: 0,
    commandId: 'command_running',
    idempotencyKey: 'attempt_running',
    status: 'running',
    assignment: testAssignmentSnapshot(),
    childThreadId: 'child_running',
    queuedAt: startedAt,
    startedAt,
    tokenUsage: 0,
    elapsedMs: 0
  }
  return {
    ...original,
    status: 'running',
    nodes: {
      ...original.nodes,
      research: {
        ...original.nodes.research,
        status: 'running',
        attempts: [attempt]
      }
    }
  }
}

describe('GraphSupervisor', () => {
  it('coalesces material signals without pausing repeated non-progress failures', async () => {
    const original = baseRun()
    let current: GraphRunV1 = {
      ...original,
      status: 'running',
      nodes: {
        ...original.nodes,
        research: {
          ...original.nodes.research,
          status: 'failed',
          attempts: [
            failedAttempt('attempt_1', 1, 'HTTP 500 while validating'),
            failedAttempt('attempt_2', 2, 'HTTP 503 while validating')
          ]
        }
      }
    }
    const leadTurn = vi.fn(async () => undefined)
    const store = {
      get: vi.fn(async () => current),
      list: vi.fn(async () => [current]),
      events: vi.fn(async () => []),
      append: vi.fn(async (_runId: string, input: AppendGraphEventInput) => {
        const result = applyTestAppend(current, input)
        current = result.state
        return result
      })
    }
    const supervisor = new GraphSupervisor({
      store: store as never,
      config: () => testGraphConfig({
        supervision: {
          coalesceWindowMs: 60_000,
          repeatedFailureThreshold: 2
        }
      }),
      delegation: () => undefined,
      leadTurn
    })
    await supervisor.signal({
      runId: 'run_1',
      reason: 'failure',
      nodeIds: ['research'],
      digest: 'first failure'
    })
    await supervisor.signal({
      runId: 'run_1',
      reason: 'help',
      nodeIds: ['finish'],
      digest: 'worker requested help'
    })
    await supervisor.flush('run_1')
    await supervisor.stop()

    expect(current.status).toBe('running')
    expect(store.append).not.toHaveBeenCalledWith(
      'run_1',
      expect.objectContaining({
        event: expect.objectContaining({
          type: 'run_status_changed'
        })
      })
    )
    expect(leadTurn).toHaveBeenCalledOnce()
    expect(leadTurn).toHaveBeenCalledWith(expect.objectContaining({
      reasons: expect.arrayContaining(['failure', 'help']),
      nodeIds: expect.arrayContaining(['research', 'finish'])
    }))
  })

  it('conservatively requests a human when an independent reviewer is unavailable', async () => {
    const run = baseRun()
    const attempt = failedAttempt('attempt_review', 1, 'not relevant')
    const supervisor = new GraphSupervisor({
      store: {} as never,
      config: () => testGraphConfig(),
      delegation: () => undefined
    })
    await expect(supervisor.review({
      run,
      node: run.nodes.research,
      attempt,
      kind: 'peer'
    })).resolves.toMatchObject({
      reviewerKind: 'peer',
      outcome: 'needs_human',
      summary: 'Independent reviewer runtime is unavailable.'
    })
  })

  it('aborts a deferred peer reviewer when Graph execution is quiesced', async () => {
    const run = baseRun()
    const attempt: GraphNodeAttemptV1 = {
      ...failedAttempt('attempt_deferred_review', 1, 'not relevant'),
      status: 'submitted',
      result: {
        version: 1,
        summary: 'Review this result.',
        changedFiles: [],
        checks: [],
        evidence: [],
        artifactRefs: [],
        risks: [],
        suggestedMessages: []
      }
    }
    let reviewStarted!: () => void
    const started = new Promise<void>((resolve) => {
      reviewStarted = resolve
    })
    const runChild = vi.fn(async (input: { signal: AbortSignal }) => {
      reviewStarted()
      if (!input.signal.aborted) {
        await new Promise<void>((resolve) => {
          input.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }
      return {
        ...testCompletedChild('peer_review_shutdown', 'interrupted'),
        status: 'aborted' as const,
        error: 'Graph runtime is shutting down'
      }
    })
    const supervisor = new GraphSupervisor({
      store: {} as never,
      config: () => testGraphConfig(),
      delegation: () => ({
        enabled: () => true,
        runChild
      } as never)
    })

    const review = supervisor.review({
      run,
      node: run.nodes.research,
      attempt,
      kind: 'peer'
    })
    await started
    supervisor.quiesceReviews()

    await expect(Promise.race([
      review,
      new Promise<'timed_out'>((resolve) =>
        setTimeout(() => resolve('timed_out'), 500))
    ])).resolves.toMatchObject({
      reviewerKind: 'peer',
      outcome: 'needs_human'
    })
    await supervisor.stop()
  })

  it('normalizes oversized peer review prose and artifacts without rerunning the reviewer', async () => {
    const run = baseRun()
    const canonicalArtifact = {
      version: 1 as const,
      artifactId: 'host_artifact',
      contentHash: 'a'.repeat(64),
      mimeType: 'text/plain',
      byteLength: 1,
      summary: 'Host-captured artifact.',
      visibility: 'lead' as const,
      retention: 'run' as const,
      createdAt: '2026-07-26T00:00:00.000Z'
    }
    const attempt: GraphNodeAttemptV1 = {
      ...failedAttempt('attempt_peer_review', 1, 'not relevant'),
      result: {
        version: 1,
        summary: 'Worker result.',
        artifactRefs: [canonicalArtifact],
        changedFiles: [],
        reportedChecks: [],
        verifiedChecks: [],
        evidence: [],
        risks: [],
        suggestedMessages: []
      }
    }
    const artifactRefs = [
      {
        ...canonicalArtifact,
        summary: 'Peer-authored metadata must not replace canonical metadata.'
      },
      ...Array.from({ length: 70 }, (_, index) => ({
        ...canonicalArtifact,
        artifactId: `fabricated_peer_artifact_${index}`,
        contentHash: index.toString(16).padStart(64, '0'),
        summary: '物'.repeat(4_311)
      }))
    ]
    const runChild = vi.fn(async () => ({
      ...testCompletedChild('peer_reviewer_1', 'unused'),
      id: 'peer_reviewer_1',
      summary: JSON.stringify({
        outcome: 'revise',
        summary: '审'.repeat(4_311),
        evidence: [
          '证'.repeat(4_311),
          null,
          ...Array.from({ length: 140 }, (_, index) => `evidence-${index}`)
        ],
        artifactRefs: [
          null,
          { artifactId: 'host_artifact', contentHash: 'not-a-hash' },
          ...artifactRefs
        ],
        repairInstructions: '修'.repeat(33_000)
      })
    }))
    const supervisor = new GraphSupervisor({
      store: {} as never,
      config: () => testGraphConfig(),
      delegation: () => ({
        enabled: () => true,
        runChild
      } as never),
      nowIso: () => '2026-07-26T12:00:00.000Z',
      nextId: (prefix) => `${prefix}_peer`
    })

    const review = await supervisor.review({
      run,
      node: run.nodes.research,
      attempt,
      kind: 'peer'
    })

    expect(runChild).toHaveBeenCalledOnce()
    expect(GraphReviewResultV1Schema.safeParse(review).success).toBe(true)
    expect(review.summary).toHaveLength(4_096)
    expect(review.evidence.length).toBeLessThanOrEqual(128)
    expect(review.evidence.length).toBeGreaterThan(1)
    expect(review.evidence[0]).toHaveLength(4_096)
    expect(review.repairInstructions).toHaveLength(32_768)
    expect(review.artifactRefs).toHaveLength(1)
    expect(review.artifactRefs[0]).toMatchObject({
      artifactId: 'host_artifact',
      summary: 'Host-captured artifact.'
    })
    expect(review.artifactRefs.some((artifact) =>
      artifact.artifactId.startsWith('fabricated_peer_artifact_')
    )).toBe(false)
    await supervisor.stop()
  })

  it('allows a Lead turn to emit a new supervision signal without deadlocking', async () => {
    let current: GraphRunV1 = { ...baseRun(), status: 'running' }
    const store = {
      get: vi.fn(async () => current),
      list: vi.fn(async () => [current]),
      events: vi.fn(async () => []),
      append: vi.fn(async (_runId: string, input: AppendGraphEventInput) => {
        const result = applyTestAppend(current, input)
        current = result.state
        return result
      })
    }
    let supervisor: GraphSupervisor
    supervisor = new GraphSupervisor({
      store: store as never,
      config: () => testGraphConfig({ supervision: { coalesceWindowMs: 60_000 } }),
      delegation: () => undefined,
      leadTurn: async () => {
        await supervisor.signal({
          runId: 'run_1',
          reason: 'user_steering',
          nodeIds: [],
          digest: 'Lead persisted follow-up steering.'
        })
      }
    })
    await supervisor.signal({
      runId: 'run_1',
      reason: 'help',
      nodeIds: ['research'],
      digest: 'Initial signal.'
    })
    await expect(Promise.race([
      supervisor.flush('run_1'),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('supervisor flush deadlocked')), 1_000))
    ])).resolves.toBeUndefined()
    await supervisor.stop()
    expect(store.append).toHaveBeenCalled()
  })

  it('does not start another Lead turn for the same durable supervision episode', async () => {
    let current: GraphRunV1 = { ...baseRun(), status: 'running' }
    const idempotencyKeys = new Set<string>()
    const eventTypes: string[] = []
    const leadTurn = vi.fn(async () => undefined)
    const store = {
      get: vi.fn(async () => current),
      list: vi.fn(async () => [current]),
      events: vi.fn(async () => []),
      append: vi.fn(async (_runId: string, input: AppendGraphEventInput) => {
        const key = input.idempotencyKey ?? input.commandId ?? `event:${current.lastEventSeq + 1}`
        const duplicate = idempotencyKeys.has(key)
        if (!duplicate) {
          idempotencyKeys.add(key)
          eventTypes.push(input.event.type)
          const result = applyTestAppend(current, input)
          current = result.state
          return result
        }
        return {
          state: current,
          envelope: testGraphEnvelope(current.lastEventSeq, input.event),
          duplicate
        }
      })
    }
    const supervisor = new GraphSupervisor({
      store: store as never,
      config: () => testGraphConfig({ supervision: { coalesceWindowMs: 60_000 } }),
      delegation: () => undefined,
      leadTurn
    })
    const signal = {
      runId: current.id,
      reason: 'help' as const,
      nodeIds: ['research'],
      digest: 'A worker requested source Lead guidance.'
    }

    await supervisor.signal(signal)
    await supervisor.flush(current.id)
    await supervisor.signal(signal)
    await supervisor.flush(current.id)
    await supervisor.stop()

    expect(eventTypes.filter((type) => type === 'supervision_requested')).toHaveLength(1)
    expect(leadTurn).toHaveBeenCalledOnce()
  })

  it('uses latest safe child activity instead of attempt start time for quiet supervision', async () => {
    const current = runningRun('2026-07-26T10:00:00.000Z')
    const store = {
      get: vi.fn(async () => current),
      list: vi.fn(async () => [current]),
      events: vi.fn(async () => []),
      append: vi.fn()
    }
    const diagnostics = vi.fn(async () => ({
      childRuns: [{
        id: 'child_running',
        status: 'running',
        updatedAt: '2026-07-26T11:59:00.000Z',
        activity: {
          kind: 'tool',
          label: 'Scanning repository',
          updatedAt: '2026-07-26T11:59:00.000Z'
        }
      }]
    }))
    const supervisor = new GraphSupervisor({
      store: store as never,
      config: () => testGraphConfig({
        supervision: { stallTimeoutMs: 15 * 60_000, coalesceWindowMs: 60_000 }
      }),
      delegation: () => ({ diagnostics } as never),
      leadTurn: vi.fn(async () => undefined),
      nowMs: () => Date.parse('2026-07-26T12:00:00.000Z')
    })

    await expect(supervisor.sweepStalls()).resolves.toBe(0)
    await supervisor.stop()

    expect(diagnostics).toHaveBeenCalledWith('thread_1')
    expect(store.append).not.toHaveBeenCalled()
  })

  it('signals a quiet running child without aborting or changing its durable state', async () => {
    let current = runningRun('2026-07-26T10:00:00.000Z')
    const store = {
      get: vi.fn(async () => current),
      list: vi.fn(async () => [current]),
      events: vi.fn(async () => []),
      append: vi.fn(async (_runId: string, input: AppendGraphEventInput) => {
        const result = applyTestAppend(current, input)
        current = result.state
        return result
      })
    }
    const supervisor = new GraphSupervisor({
      store: store as never,
      config: () => testGraphConfig({
        supervision: { stallTimeoutMs: 15 * 60_000, coalesceWindowMs: 60_000 }
      }),
      delegation: () => ({
        diagnostics: async () => ({
          childRuns: [{
            id: 'child_running',
            status: 'running',
            updatedAt: '2026-07-26T11:40:00.000Z',
            activity: {
              kind: 'model',
              label: 'Waiting for model response',
              updatedAt: '2026-07-26T11:40:00.000Z'
            }
          }]
        })
      } as never),
      leadTurn: vi.fn(async () => undefined),
      nowMs: () => Date.parse('2026-07-26T12:00:00.000Z')
    })

    await expect(supervisor.sweepStalls()).resolves.toBe(1)
    await supervisor.stop()

    expect(store.append).toHaveBeenCalled()
    expect(current.nodes.research.status).toBe('running')
    expect(current.nodes.research.attempts.at(-1)?.status).toBe('running')
  })

  it('keeps source-Lead lifecycle delivery active when optional auto-start is disabled', async () => {
    let config = testGraphConfig({
      supervision: { autoStart: false, coalesceWindowMs: 60_000 }
    })
    let current: GraphRunV1 = { ...baseRun(), status: 'running' }
    const leadTurn = vi.fn(async () => undefined)
    const store = {
      get: vi.fn(async () => current),
      list: vi.fn(async () => [current]),
      events: vi.fn(async () => []),
      append: vi.fn(async (_runId: string, input: AppendGraphEventInput) => {
        const result = applyTestAppend(current, input)
        current = result.state
        return result
      })
    }
    const supervisor = new GraphSupervisor({
      store: store as never,
      config: () => config,
      delegation: () => undefined,
      leadTurn
    })

    await supervisor.signal({
      runId: current.id,
      reason: 'help',
      nodeIds: ['research'],
      digest: 'Manual supervision signal.'
    })
    await supervisor.flush(current.id)
    expect(store.append).toHaveBeenCalled()
    expect(leadTurn).toHaveBeenCalledOnce()

    config = testGraphConfig({
      supervision: { autoStart: true, coalesceWindowMs: 60_000 }
    })
    supervisor.reconfigure()
    await supervisor.signal({
      runId: current.id,
      reason: 'help',
      nodeIds: ['research'],
      digest: 'Automatic supervision signal.'
    })
    await supervisor.flush(current.id)
    expect(leadTurn).toHaveBeenCalledTimes(2)

    config = testGraphConfig({ enabled: false })
    supervisor.reconfigure()
    await supervisor.signal({
      runId: current.id,
      reason: 'help',
      nodeIds: [],
      digest: 'Disabled signal.'
    })
    expect(store.append).toHaveBeenCalled()
    await supervisor.stop()
  })

  it('delivers a terminal failure signal to the source Lead', async () => {
    let current: GraphRunV1 = { ...baseRun(), status: 'failed' }
    const leadTurn = vi.fn(async () => undefined)
    const store = {
      get: vi.fn(async () => current),
      list: vi.fn(async () => [current]),
      events: vi.fn(async () => []),
      append: vi.fn(async (_runId: string, input: AppendGraphEventInput) => {
        const result = applyTestAppend(current, input)
        current = result.state
        return result
      })
    }
    const supervisor = new GraphSupervisor({
      store: store as never,
      config: () => testGraphConfig({
        supervision: { coalesceWindowMs: 60_000 }
      }),
      delegation: () => undefined,
      leadTurn
    })

    await supervisor.signal({
      runId: current.id,
      reason: 'failure',
      nodeIds: [],
      digest: 'The GraphRun exhausted its recovery path.'
    })
    await supervisor.flush(current.id)

    expect(leadTurn).toHaveBeenCalledWith(expect.objectContaining({
      run: expect.objectContaining({ status: 'failed' }),
      reasons: ['failure']
    }))
    await supervisor.stop()
  })

  it('builds a bounded deterministic synthesis with evidence and risks', async () => {
    const original = baseRun()
    const attempt: GraphNodeAttemptV1 = {
      ...failedAttempt('attempt_ok', 1, 'none'),
      status: 'accepted',
      normalizedFailure: undefined,
      failureClass: undefined,
      result: {
        version: 1,
        summary: 'Completed the requested implementation.',
        changedFiles: ['src/example.ts', 'src/example.ts'],
        checks: [{
          name: 'test',
          status: 'passed',
          summary: 'Passed.',
          artifactRefs: []
        }],
        verifiedChecks: [{
          name: 'test',
          status: 'passed',
          summary: 'Host verification passed.',
          artifactRefs: [],
          command: ['npm', 'test'],
          exitCode: 0,
          workspaceRevision: 'abc123:clean',
          outputSummary: 'All tests passed.'
        }],
        evidence: ['test passed'],
        artifactRefs: [],
        risks: ['One documented residual risk.'],
        suggestedMessages: []
      }
    }
    const run: GraphRunV1 = {
      ...original,
      nodes: {
        ...original.nodes,
        finish: {
          ...original.nodes.finish,
          status: 'accepted',
          acceptedAttemptId: attempt.id,
          attempts: [attempt]
        }
      }
    }
    const supervisor = new GraphSupervisor({
      store: {} as never,
      config: () => testGraphConfig(),
      delegation: () => undefined,
      nowIso: () => '2026-07-26T12:00:00.000Z'
    })
    const summary = await supervisor.synthesize(run)
    expect(summary).toMatchObject({
      finalAnswer: 'Completed the requested implementation.',
      changedFiles: ['src/example.ts'],
      unresolvedRisks: ['One documented residual risk.'],
      completedAt: '2026-07-26T12:00:00.000Z'
    })
    expect(() => GraphRunSummaryV1Schema.parse(summary)).not.toThrow()
    expect(summary.validationResults).toEqual([{
      name: 'test',
      status: 'passed',
      summary: 'Host verification passed.',
      artifactRefs: []
    }])
  })
})
