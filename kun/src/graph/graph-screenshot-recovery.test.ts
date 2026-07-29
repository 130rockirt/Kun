import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import type { DelegationRuntime } from '../delegation/delegation-runtime.js'
import type { ToolHostContext } from '../ports/tool-host.js'
import { buildGraphLeadPatchTool } from '../adapters/tool/graph-lead-patch-tool.js'
import {
  testCompletedChild,
  testGraphConfig,
  testGraphPlan
} from './graph-test-fixtures.test-support.js'
import {
  schedulerHarness,
  schedulerTestRoots as roots,
  waitFor
} from '../../tests/graph-scheduler-test-harness.js'

const activeSchedulers: Array<{ stop(): Promise<void> }> = []

afterEach(async () => {
  await Promise.all(activeSchedulers.splice(0).map((scheduler) => scheduler.stop()))
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })))
})

describe('Graph screenshot recovery path', () => {
  it('clips oversized evidence, carries Lead repair guidance, then supersedes exhausted work', async () => {
    const source = {
      ...testGraphPlan().nodes[0]!,
      title: 'Screenshot audit',
      completion: {
        ...testGraphPlan().nodes[0]!.completion,
        requiredResultFields: ['summary' as const, 'evidence' as const],
        review: {
          kinds: ['lead' as const],
          requireAll: true,
          deterministicChecks: []
        }
      },
      maxAttempts: 3
    }
    const plan = testGraphPlan({
      nodes: [source],
      edges: [],
      completionNodeIds: [source.id],
      autoStart: true
    })
    const invocations: Array<{ label?: string; prompt: string }> = []
    let execution = 0
    const delegation = {
      enabled: () => true,
      runChild: async (input: {
        label?: string
        prompt: string
        onQueued?: (id: string) => Promise<void> | void
        onRunning?: (id: string) => Promise<void> | void
      }) => {
        execution += 1
        invocations.push({ label: input.label, prompt: input.prompt })
        const childId = `child_screenshot_${execution}`
        await input.onQueued?.(childId)
        await input.onRunning?.(childId)
        const replacement = input.label === 'Bounded replacement audit'
        return {
          ...testCompletedChild(
            childId,
            replacement ? 'Replacement is bounded.' : `Original attempt ${execution}.`
          ),
          summary: JSON.stringify({
            summary: replacement
              ? 'Replacement is bounded.'
              : `Original attempt ${execution} completed without a host error.`,
            changedFiles: [],
            checks: [],
            evidence: [replacement ? 'bounded evidence' : '证'.repeat(5_000)],
            risks: []
          })
        }
      }
    } as unknown as DelegationRuntime
    const harness = await schedulerHarness(
      plan,
      () => delegation,
      {},
      { autoLeadReview: false }
    )
    activeSchedulers.push(harness.scheduler)
    harness.scheduler.start()

    const first = await submittedAttempt(harness, source.id, 1)
    expect(first.nodes[source.id]!.attempts[0]).toMatchObject({
      status: expect.stringMatching(/submitted|reviewing/),
      validation: { valid: true }
    })
    expect(first.nodes[source.id]!.attempts[0]!.result!.evidence[0]).toHaveLength(4_096)
    expect(first.nodes[source.id]!.attempts[0]!.normalizedFailure).toBeUndefined()

    await revise(
      harness,
      source.id,
      first.nodes[source.id]!.attempts[0]!.id,
      1,
      'Keep the evidence bounded and name the inspected section.'
    )
    const second = await submittedAttempt(harness, source.id, 2)
    expect(invocations[1]!.prompt).toContain(
      'Repair instructions (untrusted JSON string): ' +
      '"Keep the evidence bounded and name the inspected section."'
    )

    await revise(
      harness,
      source.id,
      second.nodes[source.id]!.attempts[1]!.id,
      2,
      'Return only the decisive evidence and its source.'
    )
    const third = await submittedAttempt(harness, source.id, 3)
    expect(invocations[2]!.prompt).toContain(
      'Repair instructions (untrusted JSON string): ' +
      '"Return only the decisive evidence and its source."'
    )

    await revise(
      harness,
      source.id,
      third.nodes[source.id]!.attempts[2]!.id,
      3,
      'The final automatic attempt is still unsuitable; replace this task semantically.'
    )
    const exhausted = await waitFor(async () => {
      const run = await harness.store.get('run_harness')
      return run?.status === 'awaiting_supervision' &&
        run.nodes[source.id]?.status === 'repair_required' &&
        run.nodes[source.id]?.attempts.length === 3
        ? run
        : null
    })

    await expect(harness.control.retryNode(exhausted.id, source.id, {
      commandId: 'forbidden_fourth_retry',
      idempotencyKey: 'forbidden-fourth-retry'
    })).rejects.toThrow(/semantic supersession/)
    await harness.scheduler.resumeRun(exhausted.id)
    await harness.scheduler.resumeRun(exhausted.id)
    expect((await harness.store.get(exhausted.id))!.nodes[source.id]!.attempts)
      .toHaveLength(3)

    let patchId = 0
    const patchTool = buildGraphLeadPatchTool({
      control: harness.control,
      store: harness.store,
      registry: {
        identify: async () => harness.identity
      } as never,
      shouldAdvertise: () => true,
      nowIso: () => '2026-07-30T00:00:10.000Z',
      nextId: (prefix) => `${prefix}_${++patchId}`,
      config: () => testGraphConfig()
    })
    const patchResult = await patchTool.execute({
      runId: exhausted.id,
      reason: 'Replace the exhausted screenshot audit with bounded work.',
      operations: [{
        op: 'supersede_node',
        nodeId: source.id,
        title: 'Bounded replacement audit',
        objective: 'Return concise evidence that fits the durable result contract.'
      }]
    }, leadContext(harness.workspace))
    expect(patchResult.isError).not.toBe(true)

    const revised = await waitFor(async () => {
      const run = await harness.store.get(exhausted.id)
      const replacementId = run?.nodes[source.id]?.supersededByNodeId
      return replacementId &&
        run?.status === 'awaiting_supervision' &&
        run.nodes[replacementId]?.attempts.length === 1
        ? { run, replacementId }
        : null
    })
    expect(revised.run.nodes[source.id]?.status).toBe('superseded')
    expect(revised.run.nodes[source.id]?.attempts).toHaveLength(3)
    expect(revised.run.nodes[revised.replacementId]?.status)
      .toMatch(/submitted|reviewing/)
    expect(revised.run.nodes[revised.replacementId]?.attempts).toHaveLength(1)

    const replacementAttempt =
      revised.run.nodes[revised.replacementId]!.attempts[0]!
    await harness.control.recordReview(revised.run.id, {
      version: 1,
      reviewId: 'lead_pass_replacement',
      nodeId: revised.replacementId,
      attemptId: replacementAttempt.id,
      reviewerKind: 'lead',
      outcome: 'pass',
      summary: 'The semantic replacement is concise and sufficient.',
      evidence: ['The host-captured evidence is within the durable bound.'],
      artifactRefs: [],
      createdAt: '2026-07-30T00:00:11.000Z'
    }, {
      commandId: 'lead_pass_replacement',
      idempotencyKey: 'lead-pass-replacement'
    }, 'lead')

    const completed = await waitFor(async () => {
      const run = await harness.store.get(exhausted.id)
      return run?.status === 'completed' ? run : null
    })
    const attemptNodeIds = (await harness.store.events(completed.id)).flatMap((envelope) =>
      envelope.event.type === 'attempt_created'
        ? [envelope.event.payload.attempt.nodeId]
        : [])

    expect(completed.nodes[source.id]?.status).toBe('superseded')
    expect(completed.nodes[source.id]?.attempts).toHaveLength(3)
    expect(completed.nodes[revised.replacementId]?.status).toBe('accepted')
    expect(completed.nodes[revised.replacementId]?.attempts).toHaveLength(1)
    expect(attemptNodeIds.filter((nodeId) => nodeId === source.id)).toHaveLength(3)
    expect(attemptNodeIds.filter((nodeId) => nodeId === revised.replacementId))
      .toHaveLength(1)
    expect(invocations.filter((item) => item.label === source.title)).toHaveLength(3)
    expect(invocations.filter((item) => item.label === 'Bounded replacement audit'))
      .toHaveLength(1)
  }, 20_000)
})

async function submittedAttempt(
  harness: Awaited<ReturnType<typeof schedulerHarness>>,
  nodeId: string,
  count: number
) {
  return waitFor(async () => {
    const run = await harness.store.get('run_harness')
    const node = run?.nodes[nodeId]
    return run?.status === 'awaiting_supervision' &&
      node?.attempts.length === count &&
      (node.status === 'submitted' || node.status === 'reviewing')
      ? run
      : null
  })
}

async function revise(
  harness: Awaited<ReturnType<typeof schedulerHarness>>,
  nodeId: string,
  attemptId: string,
  sequence: number,
  repairInstructions: string
): Promise<void> {
  await harness.control.recordReview('run_harness', {
    version: 1,
    reviewId: `lead_revise_${sequence}`,
    nodeId,
    attemptId,
    reviewerKind: 'lead',
    outcome: 'revise',
    summary: `Lead requested revision ${sequence}.`,
    evidence: [],
    artifactRefs: [],
    repairInstructions,
    createdAt: `2026-07-30T00:00:0${sequence}.000Z`
  }, {
    commandId: `lead_revise_${sequence}`,
    idempotencyKey: `lead-revise:${sequence}`
  }, 'lead')
}

function leadContext(workspace: string): ToolHostContext {
  return {
    threadId: 'thread_harness',
    turnId: 'turn_harness',
    workspace,
    orchestration: 'graph',
    approvalPolicy: 'never',
    abortSignal: new AbortController().signal,
    awaitApproval: async () => 'deny'
  }
}
