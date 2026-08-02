import { afterEach, describe, expect, it } from 'vitest'
import type { DelegationRuntime } from '../delegation/delegation-runtime.js'
import { GraphSupervisor } from './graph-supervisor.js'
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

afterEach(cleanupSchedulerHarnesses)

describe('Graph review regressions', () => {
  it('completes with host verification details projected into the run summary', async () => {
    const source = testGraphPlan().nodes[0]!
    const plan = testGraphPlan({
      nodes: [{
        ...source,
        completion: {
          ...source.completion,
          review: {
            kinds: ['deterministic'],
            requireAll: true,
            deterministicChecks: ['verification']
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
        await input.onQueued?.('child_verified_summary')
        await input.onRunning?.('child_verified_summary')
        return testCompletedChild('child_verified_summary', 'Host checks completed.')
      }
    } as unknown as DelegationRuntime
    const harness = await schedulerHarness(
      plan,
      () => delegation,
      {},
      {
        verifyChecks: async () => [{
          name: 'verification',
          status: 'passed',
          summary: 'Host verification passed.',
          artifactRefs: [],
          command: ['npm', 'test'],
          exitCode: 0,
          workspaceRevision: 'abc123:clean',
          outputSummary: 'All tests passed.'
        }]
      }
    )

    harness.scheduler.start()
    const completed = await waitFor(async () => {
      const run = await harness.store.get('run_harness')
      return run?.status === 'completed' ? run : null
    })

    expect(completed.summary?.validationResults).toEqual([{
      name: 'verification',
      status: 'passed',
      summary: 'Host verification passed.',
      artifactRefs: []
    }])
    await harness.scheduler.stop()
  }, 15_000)

  it('invokes peer review through a real GraphSupervisor instance', async () => {
    const source = testGraphPlan().nodes[0]!
    const plan = testGraphPlan({
      nodes: [{
        ...source,
        completion: {
          ...source.completion,
          review: {
            kinds: ['peer'],
            requireAll: true,
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
        label?: string
        onQueued?: (id: string) => Promise<void> | void
        onRunning?: (id: string) => Promise<void> | void
      }) => {
        if (input.label?.startsWith('Review:')) {
          return {
            ...testCompletedChild('peer_review_child', 'unused'),
            summary: JSON.stringify({
              outcome: 'pass',
              summary: 'Peer reviewer accepted the evidence.',
              evidence: ['Independent review completed.']
            })
          }
        }
        await input.onQueued?.('worker_for_peer_review')
        await input.onRunning?.('worker_for_peer_review')
        return testCompletedChild('worker_for_peer_review', 'Ready for peer review.')
      }
    } as unknown as DelegationRuntime
    const configPatch = {
      supervision: { coalesceWindowMs: 60_000 }
    }
    const config = testGraphConfig(configPatch)
    let supervisor: GraphSupervisor | undefined
    const harness = await schedulerHarness(
      plan,
      () => delegation,
      configPatch,
      {
        autoLeadReview: false,
        supervision: () => supervisor
      }
    )
    supervisor = new GraphSupervisor({
      store: harness.store,
      config: () => config,
      delegation: () => delegation
    })

    try {
      harness.scheduler.start()
      const reviewed = await waitFor(async () => {
        const run = await harness.store.get('run_harness')
        return run?.reviews.some((review) => review.reviewerKind === 'peer') ? run : null
      })
      expect(reviewed.reviews).toEqual(expect.arrayContaining([
        expect.objectContaining({
          reviewerKind: 'peer',
          outcome: 'pass',
          summary: 'Peer reviewer accepted the evidence.'
        })
      ]))
    } finally {
      await supervisor.stop()
      await harness.scheduler.stop()
    }
  }, 15_000)
})
