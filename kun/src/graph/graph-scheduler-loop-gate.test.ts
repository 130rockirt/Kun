import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { GraphPlanV1Schema } from '../contracts/graph.js'
import type { DelegationRuntime } from '../delegation/delegation-runtime.js'
import {
  GraphPlanIntentV2Schema,
  compileGraphPlanIntentV2
} from './graph-intent-compiler.js'
import {
  testCompletedChild,
  testGraphConfig,
  testGraphPlan
} from './graph-test-fixtures.test-support.js'
import {
  cleanupSchedulerHarnesses,
  schedulerHarness,
  waitFor
} from '../../tests/graph-scheduler-test-harness.js'

const execFileAsync = promisify(execFile)
const schedulerWaitTimeoutMs = process.platform === 'win32' ? 30_000 : 15_000
const schedulerTestTimeoutMs = process.platform === 'win32' ? 60_000 : 30_000

function task(
  key: string,
  kind: 'work' | 'review' | 'integration' | 'loop_gate',
  patch: Record<string, unknown> = {}
) {
  return {
    key,
    kind,
    title: key,
    objective: `Complete ${key}.`,
    dependsOn: [],
    dataFrom: [],
    acceptanceCriteria: [`${key} is complete.`],
    readScopes: ['src'],
    writeScopes: [],
    ...patch
  }
}

function compileLoopPlan(
  tasks: unknown[],
  options: { useDefaultCompletion?: boolean } = {}
) {
  const config = testGraphConfig()
  return compileGraphPlanIntentV2({
    intent: GraphPlanIntentV2Schema.parse({
      tasks,
      ...(options.useDefaultCompletion ? {} : { completionTaskKeys: ['exit'] })
    }),
    goal: 'Run a bounded repair loop and finish.',
    workspaceRoot: '/workspace',
    nowIso: '2026-07-30T00:00:00.000Z',
    budgetDefaults: testGraphPlan().budget,
    config
  })
}

afterEach(cleanupSchedulerHarnesses)

describe('GraphScheduler LoopGate repair routing', () => {
  it('routes a revised read-only review through its bounded repair LoopGate', async () => {
    const plan = compileLoopPlan([
      task('write', 'work', { writeScopes: ['src'] }),
      task('review', 'review', { dependsOn: ['write'] }),
      task('exit', 'integration', { dependsOn: ['review'] }),
      task('gate', 'loop_gate', {
        dependsOn: ['review'],
        loop: {
          conditionTaskKey: 'review',
          continueTaskKey: 'write',
          exitTaskKey: 'exit',
          continueOn: ['repair_required', 'failed'],
          maxIterations: 1
        }
      })
    ])
    let childCount = 0
    const delegation = {
      enabled: () => true,
      runChild: async (input: {
        onQueued?: (id: string) => Promise<void> | void
        onRunning?: (id: string) => Promise<void> | void
      }) => {
        const id = `loop_repair_child_${++childCount}`
        await input.onQueued?.(id)
        await input.onRunning?.(id)
        return testCompletedChild(id, `Completed ${id}.`)
      }
    } as unknown as DelegationRuntime
    const harness = await schedulerHarness(plan, () => delegation, {}, {
      autoLeadReview: false,
      verifyChecks: async () => []
    })
    await execFileAsync('git', ['init'], { cwd: harness.workspace })
    let reviewNumber = 0
    const reviewLatest = async (
      nodeId: string,
      attemptCount: number,
      outcome: 'pass' | 'revise'
    ) => {
      const waiting = await waitFor(async () => {
        const run = await harness.store.get('run_harness')
        const node = run?.nodes[nodeId]
        return run?.status === 'awaiting_supervision' &&
          node?.status === 'reviewing' &&
          node.attempts.length === attemptCount
          ? run
          : null
      })
      const attempt = waiting.nodes[nodeId]!.attempts.at(-1)!
      const reviewId = `loop_repair_review_${++reviewNumber}`
      await harness.control.recordReview('run_harness', {
        version: 1,
        reviewId,
        nodeId,
        attemptId: attempt.id,
        reviewerKind: 'lead',
        outcome,
        summary: outcome === 'pass' ? 'Lead accepted.' : 'Lead requested repair.',
        evidence: [],
        artifactRefs: [],
        ...(outcome === 'revise'
          ? { repairInstructions: 'Return through the explicit write repair path.' }
          : {}),
        createdAt: new Date().toISOString()
      }, {
        commandId: `${reviewId}_command`,
        idempotencyKey: reviewId
      }, 'lead')
      return attempt
    }

    harness.scheduler.start()
    await reviewLatest('write', 1, 'pass')
    const firstReviewAttempt = await reviewLatest('review', 1, 'revise')
    await reviewLatest('write', 2, 'pass')
    await reviewLatest('review', 2, 'pass')
    await reviewLatest('exit', 1, 'pass')
    const completed = await waitFor(async () => {
      const run = await harness.store.get('run_harness')
      return run?.status === 'completed' ? run : null
    }, schedulerWaitTimeoutMs)
    await harness.scheduler.stop()

    expect(completed.nodes.gate.loopIteration).toBe(1)
    expect(completed.budget.loopIterations).toBe(1)
    expect(completed.nodes.write.attempts).toHaveLength(2)
    expect(completed.nodes.review.attempts).toHaveLength(2)
    expect(completed.nodes.review.attempts.map((attempt) => attempt.iteration)).toEqual([0, 1])
    expect(completed.nodes.review.attempts[0]?.status).toBe('repair_required')
    expect(completed.nodes.review.attempts[1]?.status).toBe('accepted')
    expect(completed.reviews.filter((review) => review.nodeId === 'review')).toEqual([
      expect.objectContaining({
        attemptId: firstReviewAttempt.id,
        outcome: 'revise'
      }),
      expect.objectContaining({ outcome: 'pass' })
    ])
    expect(childCount).toBe(5)
    const events = await harness.store.events('run_harness')
    expect(events.some((event) =>
      event.event.type === 'node_status_changed' &&
      event.event.payload.nodeId === 'review' &&
      event.event.payload.reason?.includes('retry'))).toBe(false)
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: expect.objectContaining({
          type: 'loop_iteration_advanced',
          payload: expect.objectContaining({
            gateNodeId: 'gate',
            continueTargetNodeId: 'write',
            iteration: 1
          })
        })
      })
    ]))
  }, schedulerTestTimeoutMs)

  it('lets a failed condition continue once without permanently skipping exit', async () => {
    const plan = compileLoopPlan([
      task('write', 'work', { writeScopes: ['src'] }),
      task('exit', 'integration', { dependsOn: ['write'] }),
      task('gate', 'loop_gate', {
        dependsOn: ['write'],
        loop: {
          conditionTaskKey: 'write',
          continueTaskKey: 'write',
          exitTaskKey: 'exit',
          continueOn: ['failed'],
          maxIterations: 1
        }
      })
    ])
    let childCount = 0
    const delegation = {
      enabled: () => true,
      runChild: async (input: {
        onQueued?: (id: string) => Promise<void> | void
        onRunning?: (id: string) => Promise<void> | void
      }) => {
        const id = `failed_loop_child_${++childCount}`
        await input.onQueued?.(id)
        await input.onRunning?.(id)
        if (childCount === 1) throw new Error('first condition attempt failed')
        return testCompletedChild(id, `Completed ${id}.`)
      }
    } as unknown as DelegationRuntime
    const harness = await schedulerHarness(plan, () => delegation, {}, {
      verifyChecks: async () => []
    })
    await execFileAsync('git', ['init'], { cwd: harness.workspace })
    harness.scheduler.start()
    const completed = await waitFor(async () => {
      const run = await harness.store.get('run_harness')
      return run?.status === 'completed' ? run : null
    }, schedulerWaitTimeoutMs)
    await harness.scheduler.stop()

    expect(completed.budget.loopIterations).toBe(1)
    expect(completed.nodes.write.attempts.map((attempt) => attempt.iteration)).toEqual([0, 1])
    expect(completed.nodes.write.attempts.map((attempt) => attempt.status)).toEqual([
      'failed',
      'accepted'
    ])
    expect(completed.nodes.exit.status).toBe('accepted')
    expect(childCount).toBe(3)
    const events = await harness.store.events('run_harness')
    expect(events.some((event) =>
      event.event.type === 'node_status_changed' &&
      event.event.payload.nodeId === 'exit' &&
      event.event.payload.to === 'skipped')).toBe(false)
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: expect.objectContaining({
          type: 'loop_iteration_advanced',
          payload: expect.objectContaining({
            resetNodeIds: expect.arrayContaining(['write', 'exit', 'gate'])
          })
        })
      })
    ]))
  }, schedulerTestTimeoutMs)

  it('lets a skipped condition continue once and recover its exit branch', async () => {
    const compiled = compileLoopPlan([
      task('write', 'work', { writeScopes: ['src'] }),
      task('review', 'review', { dependsOn: ['write'] }),
      task('exit', 'integration', { dependsOn: ['review'] }),
      task('gate', 'loop_gate', {
        dependsOn: ['review'],
        loop: {
          conditionTaskKey: 'review',
          continueTaskKey: 'write',
          exitTaskKey: 'exit',
          continueOn: ['skipped'],
          maxIterations: 1
        }
      })
    ])
    const plan = GraphPlanV1Schema.parse({
      ...compiled,
      nodes: compiled.nodes.map((node) => node.id === 'write'
        ? { ...node, required: false, maxAttempts: 1 }
        : node)
    })
    let childCount = 0
    const delegation = {
      enabled: () => true,
      runChild: async (input: {
        onQueued?: (id: string) => Promise<void> | void
        onRunning?: (id: string) => Promise<void> | void
      }) => {
        const id = `skipped_loop_child_${++childCount}`
        await input.onQueued?.(id)
        await input.onRunning?.(id)
        if (childCount === 1) throw new Error('optional predecessor failed')
        return testCompletedChild(id, `Completed ${id}.`)
      }
    } as unknown as DelegationRuntime
    const harness = await schedulerHarness(plan, () => delegation, {}, {
      verifyChecks: async () => []
    })
    await execFileAsync('git', ['init'], { cwd: harness.workspace })
    harness.scheduler.start()
    const completed = await waitFor(async () => {
      const run = await harness.store.get('run_harness')
      return run?.status === 'completed' ? run : null
    }, schedulerWaitTimeoutMs)
    await harness.scheduler.stop()

    expect(completed.budget.loopIterations).toBe(1)
    expect(completed.nodes.write.attempts.map((attempt) => attempt.iteration)).toEqual([0, 1])
    expect(completed.nodes.review.attempts).toHaveLength(1)
    expect(completed.nodes.review.attempts[0]?.iteration).toBe(1)
    expect(completed.nodes.exit.status).toBe('accepted')
    expect(childCount).toBe(4)
    const events = await harness.store.events('run_harness')
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: expect.objectContaining({
          type: 'node_status_changed',
          payload: expect.objectContaining({
            nodeId: 'review',
            to: 'skipped'
          })
        })
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          type: 'loop_iteration_advanced',
          payload: expect.objectContaining({
            resetNodeIds: expect.arrayContaining(['write', 'review', 'exit', 'gate'])
          })
        })
      })
    ]))
  }, schedulerTestTimeoutMs)

  it('completes through the normal exit and conditionally skips a distinct exhaustion target', async () => {
    const plan = compileLoopPlan([
      task('condition', 'work'),
      task('exit', 'integration'),
      task('exhaustion', 'integration'),
      task('gate', 'loop_gate', {
        dependsOn: ['condition'],
        loop: {
          conditionTaskKey: 'condition',
          continueTaskKey: 'condition',
          exitTaskKey: 'exit',
          exhaustionTaskKey: 'exhaustion',
          continueOn: ['failed'],
          maxIterations: 1
        }
      })
    ], { useDefaultCompletion: true })
    expect(plan.completionNodeIds).toEqual(['exit', 'exhaustion'])

    let childCount = 0
    let conditionAttempts = 0
    const labels: string[] = []
    const delegation = {
      enabled: () => true,
      runChild: async (input: {
        label?: string
        onQueued?: (id: string) => Promise<void> | void
        onRunning?: (id: string) => Promise<void> | void
      }) => {
        const id = `normal_exit_child_${++childCount}`
        labels.push(input.label ?? '')
        await input.onQueued?.(id)
        await input.onRunning?.(id)
        if (input.label === 'condition' && ++conditionAttempts === 1) {
          throw new Error('first condition attempt requests loop continuation')
        }
        return testCompletedChild(id, `Completed ${input.label}.`)
      }
    } as unknown as DelegationRuntime
    const harness = await schedulerHarness(plan, () => delegation, {}, {
      verifyChecks: async () => []
    })

    harness.scheduler.start()
    const completed = await waitFor(async () => {
      const run = await harness.store.get('run_harness')
      return run?.status === 'completed' ? run : null
    }, schedulerWaitTimeoutMs)
    await harness.scheduler.stop()

    expect(completed.budget.loopIterations).toBe(1)
    expect(completed.nodes.condition.attempts.map((attempt) => attempt.status)).toEqual([
      'failed',
      'accepted'
    ])
    expect(completed.nodes.exit.status).toBe('accepted')
    expect(completed.nodes.exhaustion.status).toBe('skipped')
    expect(completed.nodes.exhaustion.lastTransitionReason)
      .toBe('LoopGate gate branch not selected')
    expect(labels).toEqual(['condition', 'condition', 'exit'])
  }, schedulerTestTimeoutMs)

  it('completes through a distinct exhaustion target when the loop limit is reached', async () => {
    const plan = compileLoopPlan([
      task('condition', 'work'),
      task('exit', 'integration'),
      task('exhaustion', 'integration'),
      task('gate', 'loop_gate', {
        dependsOn: ['condition'],
        loop: {
          conditionTaskKey: 'condition',
          continueTaskKey: 'condition',
          exitTaskKey: 'exit',
          exhaustionTaskKey: 'exhaustion',
          continueOn: ['failed'],
          maxIterations: 1
        }
      })
    ], { useDefaultCompletion: true })
    expect(plan.completionNodeIds).toEqual(['exit', 'exhaustion'])

    let childCount = 0
    const labels: string[] = []
    const delegation = {
      enabled: () => true,
      runChild: async (input: {
        label?: string
        onQueued?: (id: string) => Promise<void> | void
        onRunning?: (id: string) => Promise<void> | void
      }) => {
        const id = `exhaustion_child_${++childCount}`
        labels.push(input.label ?? '')
        await input.onQueued?.(id)
        await input.onRunning?.(id)
        if (input.label === 'condition') {
          throw new Error('condition remains failed until loop exhaustion')
        }
        return testCompletedChild(id, `Completed ${input.label}.`)
      }
    } as unknown as DelegationRuntime
    const harness = await schedulerHarness(plan, () => delegation, {}, {
      verifyChecks: async () => []
    })

    harness.scheduler.start()
    const completed = await waitFor(async () => {
      const run = await harness.store.get('run_harness')
      return run?.status === 'completed' ? run : null
    }, schedulerWaitTimeoutMs)
    await harness.scheduler.stop()

    expect(completed.budget.loopIterations).toBe(1)
    expect(completed.nodes.condition.attempts.map((attempt) => attempt.status)).toEqual([
      'failed',
      'failed'
    ])
    expect(completed.nodes.exit.status).toBe('skipped')
    expect(completed.nodes.exhaustion.status).toBe('accepted')
    expect(completed.nodes.gate.lastTransitionReason)
      .toBe('loop gate iteration limit exhausted')
    expect(labels).toEqual(['condition', 'condition', 'exhaustion'])
  }, schedulerTestTimeoutMs)

  it('does not ready a selected exit until its independent dependency finishes', async () => {
    const plan = compileLoopPlan([
      task('condition', 'work'),
      task('blocker', 'work'),
      task('exit', 'integration', { dependsOn: ['blocker'] }),
      task('gate', 'loop_gate', {
        dependsOn: ['condition'],
        loop: {
          conditionTaskKey: 'condition',
          continueTaskKey: 'condition',
          exitTaskKey: 'exit',
          continueOn: ['failed'],
          maxIterations: 1
        }
      })
    ])

    let childCount = 0
    let releaseBlocker: (() => void) | undefined
    const blocker = new Promise<void>((resolve) => {
      releaseBlocker = resolve
    })
    const labels: string[] = []
    const delegation = {
      enabled: () => true,
      runChild: async (input: {
        label?: string
        onQueued?: (id: string) => Promise<void> | void
        onRunning?: (id: string) => Promise<void> | void
      }) => {
        const id = `dependent_exit_child_${++childCount}`
        labels.push(input.label ?? '')
        await input.onQueued?.(id)
        await input.onRunning?.(id)
        if (input.label === 'blocker') await blocker
        return testCompletedChild(id, `Completed ${input.label}.`)
      }
    } as unknown as DelegationRuntime
    const harness = await schedulerHarness(plan, () => delegation, {}, {
      verifyChecks: async () => []
    })

    harness.scheduler.start()
    try {
      const waiting = await waitFor(async () => {
        const run = await harness.store.get('run_harness')
        return run?.nodes.gate.status === 'skipped' &&
          run.nodes.blocker.status === 'running' &&
          (
            run.nodes.exit.status === 'blocked' ||
            run.nodes.exit.attempts.length > 0
          )
          ? run
          : null
      }, schedulerWaitTimeoutMs)
      expect(waiting.nodes.exit.status).toBe('blocked')
      expect(waiting.nodes.exit.attempts).toHaveLength(0)
      expect(labels).not.toContain('exit')

      releaseBlocker?.()
      const completed = await waitFor(async () => {
        const run = await harness.store.get('run_harness')
        return run?.status === 'completed' ? run : null
      }, schedulerWaitTimeoutMs)
      expect(completed.nodes.blocker.status).toBe('accepted')
      expect(completed.nodes.exit.status).toBe('accepted')
      expect(labels).toEqual(expect.arrayContaining(['condition', 'blocker', 'exit']))
    } finally {
      releaseBlocker?.()
      await harness.scheduler.stop()
    }
  }, schedulerTestTimeoutMs)
})
