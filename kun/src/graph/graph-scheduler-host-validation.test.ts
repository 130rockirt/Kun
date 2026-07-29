import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GRAPH_CONTRACT_VERSION,
  GraphNodeAttemptV1Schema
} from '../contracts/graph.js'
import type { DelegationRuntime } from '../delegation/delegation-runtime.js'
import {
  testAssignmentSnapshot,
  testCompletedChild,
  testGraphPlan
} from './graph-test-fixtures.test-support.js'
import {
  schedulerHarness,
  schedulerTestRoots as roots,
  waitFor
} from '../../tests/graph-scheduler-test-harness.js'

const execFileAsync = promisify(execFile)

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })))
})

describe('GraphScheduler host result validation', () => {
  it('submits a worktree scope violation for supervision without retrying the worker', async () => {
    const source = writableSource(3)
    const plan = testGraphPlan({
      nodes: [source],
      edges: [],
      completionNodeIds: [source.id],
      autoStart: true
    })
    let executions = 0
    const delegation = {
      enabled: () => true,
      runChild: async (input: {
        workspace?: string
        onQueued?: (id: string) => Promise<void> | void
        onRunning?: (id: string) => Promise<void> | void
      }) => {
        executions += 1
        await input.onQueued?.('child_scope_violation')
        await input.onRunning?.('child_scope_violation')
        if (!input.workspace) throw new Error('expected worktree workspace')
        await mkdir(`${input.workspace}/other`, { recursive: true })
        await writeFile(`${input.workspace}/other/escape.txt`, 'blocked\n')
        return testCompletedChild('child_scope_violation', 'Worker completed once.')
      }
    } as unknown as DelegationRuntime
    const harness = await schedulerHarness(plan, () => delegation, {
      writeIsolation: { mode: 'worktree', allowWorktrees: true }
    }, { autoLeadReview: false })
    await git(harness.workspace, ['init'])
    await git(harness.workspace, ['config', 'user.email', 'graph-test@example.test'])
    await git(harness.workspace, ['config', 'user.name', 'Graph Test'])
    await git(harness.workspace, ['commit', '--allow-empty', '-m', 'test: base'])
    harness.scheduler.start()

    const submitted = await waitFor(async () => {
      const run = await harness.store.get('run_harness')
      const attempt = run?.nodes.research.attempts[0]
      return run?.status === 'awaiting_supervision' && attempt?.validation ? run : null
    })
    await harness.scheduler.stop()

    expect(executions).toBe(1)
    expect(submitted.nodes.research.attempts).toHaveLength(1)
    expect(submitted.nodes.research.attempts[0]).toMatchObject({
      status: expect.stringMatching(/submitted|reviewing/),
      validation: {
        valid: false,
        issues: expect.arrayContaining([
          expect.objectContaining({ code: 'changed_file_outside_scope' })
        ])
      },
      result: { changedFiles: ['other/escape.txt'] }
    })
  }, 15_000)

  it('blocks acceptance when the direct-workspace baseline is unavailable', async () => {
    const source = writableSource(3)
    const plan = testGraphPlan({
      nodes: [source],
      edges: [],
      completionNodeIds: [source.id],
      autoStart: true
    })
    let executions = 0
    const delegation = {
      enabled: () => true,
      runChild: async (input: {
        onQueued?: (id: string) => Promise<void> | void
        onRunning?: (id: string) => Promise<void> | void
      }) => {
        executions += 1
        await input.onQueued?.('child_missing_baseline')
        await input.onRunning?.('child_missing_baseline')
        return testCompletedChild('child_missing_baseline', 'Worker completed once.')
      }
    } as unknown as DelegationRuntime
    const harness = await schedulerHarness(
      plan,
      () => delegation,
      { writeIsolation: { mode: 'lease', allowWorktrees: false } },
      { autoLeadReview: false }
    )
    harness.scheduler.start()

    const submitted = await waitFor(async () => {
      const run = await harness.store.get('run_harness')
      const attempt = run?.nodes.research.attempts[0]
      return run?.status === 'awaiting_supervision' && attempt?.validation ? run : null
    })
    await harness.scheduler.stop()

    expect(executions).toBe(1)
    expect(submitted.nodes.research.attempts).toHaveLength(1)
    expect(submitted.nodes.research.attempts[0]?.validation).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'changed_files_observation_unavailable' })
      ])
    })
  }, 15_000)

  it('does not admit a ready node that already reached its effective attempt limit', async () => {
    const source = writableSource(1)
    const plan = testGraphPlan({
      nodes: [source],
      edges: [],
      budget: {
        ...testGraphPlan().budget,
        maxAttemptsPerNode: 1
      },
      completionNodeIds: [source.id],
      autoStart: false
    })
    let executions = 0
    const delegation = {
      enabled: () => true,
      runChild: async () => {
        executions += 1
        return testCompletedChild('unexpected_child', 'should not run')
      }
    } as unknown as DelegationRuntime
    const harness = await schedulerHarness(plan, () => delegation, {
      scheduler: { maxAttemptsPerNode: 1 }
    }, { autoLeadReview: false })
    let run = (await harness.store.get('run_harness'))!
    run = (await harness.store.append(run.id, {
      expectedSeq: run.lastEventSeq,
      graphRevision: run.currentRevision,
      commandId: 'ready_exhausted',
      idempotencyKey: 'ready_exhausted',
      event: {
        type: 'node_status_changed',
        payload: { nodeId: source.id, from: 'pending', to: 'ready' }
      }
    })).state
    const attempt = GraphNodeAttemptV1Schema.parse({
      version: GRAPH_CONTRACT_VERSION,
      id: 'attempt_exhausted',
      runId: run.id,
      nodeId: source.id,
      revision: run.currentRevision,
      attemptNumber: 1,
      iteration: 0,
      commandId: 'attempt_exhausted',
      idempotencyKey: 'attempt_exhausted',
      status: 'failed',
      assignment: {
        ...testAssignmentSnapshot(),
        workspaceRoot: harness.workspace,
        writeScopes: ['src']
      },
      queuedAt: new Date().toISOString(),
      failureClass: 'retryable',
      normalizedFailure: 'persisted failure',
      tokenUsage: 0,
      elapsedMs: 0
    })
    run = (await harness.store.append(run.id, {
      expectedSeq: run.lastEventSeq,
      graphRevision: run.currentRevision,
      commandId: 'persist_exhausted_attempt',
      idempotencyKey: 'persist_exhausted_attempt',
      event: { type: 'attempt_created', payload: { attempt } }
    })).state
    run = (await harness.store.append(run.id, {
      expectedSeq: run.lastEventSeq,
      graphRevision: run.currentRevision,
      commandId: 'fail_exhausted_node',
      idempotencyKey: 'fail_exhausted_node',
      event: {
        type: 'node_status_changed',
        payload: { nodeId: source.id, from: 'queued', to: 'failed' }
      }
    })).state
    await harness.store.append(run.id, {
      expectedSeq: run.lastEventSeq,
      graphRevision: run.currentRevision,
      commandId: 'stale_retry_exhausted_node',
      idempotencyKey: 'stale_retry_exhausted_node',
      event: {
        type: 'node_status_changed',
        payload: { nodeId: source.id, from: 'failed', to: 'ready' }
      }
    })
    harness.scheduler.start()

    const held = await waitFor(async () => {
      const current = await harness.store.get('run_harness')
      return current?.status === 'awaiting_supervision' ? current : null
    })
    await harness.scheduler.stop()

    expect(executions).toBe(0)
    expect(held.nodes.research.attempts).toHaveLength(1)
    expect(held.nodes.research.status).toBe('failed')
  }, 15_000)
})

function writableSource(maxAttempts: number) {
  const source = testGraphPlan().nodes[0]!
  if (source.assignment?.kind !== 'ephemeral') {
    throw new Error('expected ephemeral test assignment')
  }
  return {
    ...source,
    assignment: { ...source.assignment, toolPolicy: 'inherit' as const },
    completion: {
      ...source.completion,
      requiredResultFields: ['summary' as const]
    },
    readScopes: ['.'],
    writeScopes: ['src'],
    maxAttempts
  }
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
}
