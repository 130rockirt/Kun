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

  it('reconciles stale obligations when a live run emits its terminal signal', async () => {
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
      config: () => testGraphConfig({ supervision: { coalesceWindowMs: 60_000 } }),
      delegation: () => undefined,
      leadTurn,
      isLeadTurnActive: () => true
    })

    await supervisor.signal({
      runId: current.id,
      reason: 'help',
      nodeIds: [],
      digest: 'A nonterminal obligation awaiting source Lead action.'
    })
    await supervisor.flush(current.id)
    expect(current.supervisionObligations[0]?.state).toBe('awaiting_action')

    current = { ...current, status: 'failed' }
    await supervisor.signal({
      runId: current.id,
      reason: 'failure',
      nodeIds: [],
      digest: 'The GraphRun reached a terminal failure.'
    })
    await supervisor.flush(current.id)

    expect(leadTurn).toHaveBeenCalledTimes(2)
    expect(current.supervisionObligations).toHaveLength(2)
    expect(current.supervisionObligations.every((entry) => entry.state === 'resolved'))
      .toBe(true)
    const stableSeq = current.lastEventSeq
    await Promise.all(Array.from({ length: 1_000 }, () => supervisor.sweepObligations()))
    expect(current.lastEventSeq).toBe(stableSeq)
    await supervisor.stop()
  })

  it.each([
    ['completed', 'completion'],
    ['failed', 'failure'],
    ['cancelled', 'completion']
  ] as const)(
    'recovers an abandoned %s delivery and bounds a stable startup episode',
    async (status, reason) => {
      let current: GraphRunV1 = { ...baseRun(), status }
      let releaseAbandoned!: () => void
      let markAbandonedStarted!: () => void
      const abandonedStarted = new Promise<void>((resolve) => { markAbandonedStarted = resolve })
      const abandonedBlocked = new Promise<void>((resolve) => { releaseAbandoned = resolve })
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
      const abandoned = new GraphSupervisor({
        store: store as never,
        config: () => testGraphConfig({ supervision: { coalesceWindowMs: 60_000 } }),
        delegation: () => undefined,
        leadTurn: async () => {
          markAbandonedStarted()
          await abandonedBlocked
        }
      })
      const signal = {
        runId: current.id,
        reason,
        nodeIds: [] as string[],
        digest: `Terminal lifecycle for ${status}.`
      }
      await abandoned.signal(signal)
      const abandonedFlush = abandoned.flush(current.id)
      await abandonedStarted
      expect(current.supervisionObligations[0]).toMatchObject({
        state: 'delivering',
        deliveryAttempts: 1
      })

      let releaseSecondAbandoned!: () => void
      let markSecondAbandonedStarted!: () => void
      const secondAbandonedStarted = new Promise<void>((resolve) => {
        markSecondAbandonedStarted = resolve
      })
      const secondAbandonedBlocked = new Promise<void>((resolve) => {
        releaseSecondAbandoned = resolve
      })
      const secondAbandoned = new GraphSupervisor({
        store: store as never,
        config: () => testGraphConfig({ supervision: { coalesceWindowMs: 60_000 } }),
        delegation: () => undefined,
        leadTurn: async () => {
          markSecondAbandonedStarted()
          await secondAbandonedBlocked
        }
      })
      const secondAbandonedDelivery = secondAbandoned.redeliverNow(signal)
      await secondAbandonedStarted
      expect(current.supervisionObligations[0]).toMatchObject({
        state: 'delivering',
        deliveryAttempts: 2
      })

      const recoveredLead = vi.fn(async () => undefined)
      const recovered = new GraphSupervisor({
        store: store as never,
        config: () => testGraphConfig({ supervision: { coalesceWindowMs: 60_000 } }),
        delegation: () => undefined,
        leadTurn: recoveredLead
      })
      const recoverySignal = {
        ...signal,
        recoveryKey: `terminal:${status}:${current.sourceTurnId}:0`
      }
      await recovered.redeliverNow(recoverySignal)
      releaseAbandoned()
      releaseSecondAbandoned()
      await Promise.all([abandonedFlush, secondAbandonedDelivery])

      expect(recoveredLead).toHaveBeenCalledOnce()
      expect(current.supervisionObligations).toHaveLength(2)
      expect(current.supervisionObligations[0]).toMatchObject({
        state: 'resolved',
        deliveryAttempts: 2
      })
      expect(current.supervisionObligations[1]).toMatchObject({
        state: 'resolved',
        deliveryAttempts: 1
      })
      // The active notification exhausted its delivery cap. The same startup pass
      // creates the stable recovery episode, and that key cannot create another.
      const stableRecoverySeq = current.lastEventSeq
      await recovered.redeliverNow(recoverySignal)
      await recovered.redeliverNow(recoverySignal)
      await recovered.redeliverNow({
        ...recoverySignal,
        digest: `Changed recovery prose for the same ${status} episode.`
      })
      expect(recoveredLead).toHaveBeenCalledOnce()
      expect(current.supervisionObligations).toHaveLength(2)
      expect(current.lastEventSeq).toBe(stableRecoverySeq)
      const resolvedEvents = store.append.mock.calls.filter(([, input]) =>
        input.event.type === 'supervision_obligation_resolved')
      expect(resolvedEvents).toHaveLength(2)
      const appendCount = store.append.mock.calls.length
      await Promise.all(Array.from({ length: 1_000 }, () => recovered.sweepObligations()))
      expect(store.append).toHaveBeenCalledTimes(appendCount)
      await Promise.all([abandoned.stop(), secondAbandoned.stop(), recovered.stop()])
    }
  )

  it('serializes an exact terminal recovery with a concurrent legacy signal', async () => {
    let current: GraphRunV1 = { ...baseRun(), status: 'failed' }
    let markRecoveryRead!: () => void
    let releaseRecoveryRead!: () => void
    const recoveryRead = new Promise<void>((resolve) => { markRecoveryRead = resolve })
    const recoveryReadBlocked = new Promise<void>((resolve) => { releaseRecoveryRead = resolve })
    let blockFirstRead = true
    const leadTurn = vi.fn(async () => undefined)
    const store = {
      get: vi.fn(async () => {
        if (blockFirstRead) {
          blockFirstRead = false
          markRecoveryRead()
          await recoveryReadBlocked
        }
        return current
      }),
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
      config: () => testGraphConfig({ supervision: { coalesceWindowMs: 60_000 } }),
      delegation: () => undefined,
      leadTurn
    })
    const recoverySignal = {
      runId: current.id,
      reason: 'failure' as const,
      nodeIds: [] as string[],
      digest: 'Recovered terminal failure.',
      recoveryKey: `terminal:failed:${current.sourceTurnId}:0`
    }

    const recovery = supervisor.redeliverNow(recoverySignal)
    await recoveryRead
    const legacySignal = supervisor.signal({
      runId: current.id,
      reason: 'failure',
      nodeIds: [],
      digest: 'Concurrent legacy terminal failure.'
    })
    releaseRecoveryRead()
    await Promise.all([recovery, legacySignal])
    await supervisor.flush(current.id)

    expect(leadTurn).toHaveBeenCalledOnce()
    expect(current.supervisionObligations).toHaveLength(1)
    expect(current.supervisionObligations[0]).toMatchObject({
      state: 'resolved',
      deliveryAttempts: 1
    })
    const stableSeq = current.lastEventSeq
    await supervisor.redeliverNow(recoverySignal)
    expect(leadTurn).toHaveBeenCalledOnce()
    expect(current.lastEventSeq).toBe(stableSeq)
    await supervisor.stop()
  })

  it('redelivers terminal pending work once when Graph is disabled and re-enabled', async () => {
    let current: GraphRunV1 = { ...baseRun(), status: 'failed' }
    let config = testGraphConfig({ supervision: { coalesceWindowMs: 60_000 } })
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
    supervisor.start()
    await supervisor.signal({
      runId: current.id,
      reason: 'failure',
      nodeIds: [],
      digest: 'Terminal work was queued before Graph was disabled.'
    })
    expect(current.supervisionObligations[0]?.state).toBe('pending')

    config = testGraphConfig({ enabled: false })
    supervisor.reconfigure()
    config = testGraphConfig({ supervision: { coalesceWindowMs: 0 } })
    supervisor.reconfigure()

    await vi.waitFor(() => {
      expect(current.supervisionObligations[0]?.state).toBe('resolved')
    })
    expect(leadTurn).toHaveBeenCalledOnce()
    const resolvedEvents = store.append.mock.calls.filter(([, input]) =>
      input.event.type === 'supervision_obligation_resolved')
    expect(resolvedEvents).toHaveLength(1)
    await supervisor.stop()
  })

  it('defers startup terminal recovery while Graph is disabled and replays it on enable', async () => {
    let current: GraphRunV1 = { ...baseRun(), status: 'failed' }
    let config = testGraphConfig({ supervision: { coalesceWindowMs: 60_000 } })
    let failNextGet = false
    const store = {
      get: vi.fn(async () => {
        if (failNextGet) {
          failNextGet = false
          throw new Error('transient store read failure')
        }
        return current
      }),
      list: vi.fn(async () => [current]),
      events: vi.fn(async () => []),
      append: vi.fn(async (_runId: string, input: AppendGraphEventInput) => {
        const result = applyTestAppend(current, input)
        current = result.state
        return result
      })
    }
    const original = new GraphSupervisor({
      store: store as never,
      config: () => config,
      delegation: () => undefined
    })
    await original.signal({
      runId: current.id,
      reason: 'failure',
      nodeIds: [],
      digest: 'Persisted before the disabled startup.'
    })
    await original.stop()

    config = testGraphConfig({ enabled: false })
    const leadTurn = vi.fn(async () => undefined)
    const recovered = new GraphSupervisor({
      store: store as never,
      config: () => config,
      delegation: () => undefined,
      leadTurn
    })
    const recoverySignal = {
      runId: current.id,
      reason: 'failure' as const,
      nodeIds: [] as string[],
      digest: 'Recovered terminal failure after disabled startup.',
      recoveryKey: `terminal:failed:${current.sourceTurnId}:0`
    }
    await recovered.redeliverNow(recoverySignal)
    expect(leadTurn).not.toHaveBeenCalled()

    config = testGraphConfig({ supervision: { coalesceWindowMs: 0 } })
    failNextGet = true
    recovered.reconfigure()
    await vi.waitFor(() => {
      expect(leadTurn).toHaveBeenCalledOnce()
      expect(current.supervisionObligations).toHaveLength(2)
      expect(current.supervisionObligations.every((entry) => entry.state === 'resolved'))
        .toBe(true)
    })
    const stableRecoverySeq = current.lastEventSeq
    await recovered.redeliverNow(recoverySignal)
    expect(leadTurn).toHaveBeenCalledOnce()
    expect(current.lastEventSeq).toBe(stableRecoverySeq)
    await recovered.stop()
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
