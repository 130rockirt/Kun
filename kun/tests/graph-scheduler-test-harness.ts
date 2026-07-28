import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileArtifactStore } from '../src/artifacts/artifact-store.js'
import type { ChildRunRecord, DelegationRuntime } from '../src/delegation/delegation-runtime.js'
import { GraphAssignmentResolver } from '../src/graph/graph-assignment.js'
import { GraphControlService } from '../src/graph/graph-control-service.js'
import { GraphMailbox } from '../src/graph/graph-mailbox.js'
import { FileGraphRunStore } from '../src/graph/graph-run-store.js'
import { GraphScheduler } from '../src/graph/graph-scheduler.js'
import type { GraphSupervisionPort } from '../src/graph/graph-scheduler-types.js'
import { GraphWorkerSessionRegistry } from '../src/graph/graph-worker-sessions.js'
import { FileGraphWriteCoordinator } from '../src/graph/graph-write-coordinator.js'
import { FileProjectAgentRegistry } from '../src/graph/project-agent-registry.js'
import {
  testGraphConfig,
  testGraphPlan
} from '../src/graph/graph-test-fixtures.test-support.js'

export const schedulerTestRoots: string[] = []

export async function schedulerHarness(
  plan: ReturnType<typeof testGraphPlan>,
  delegation: () => DelegationRuntime | undefined,
  configPatch: Parameters<typeof testGraphConfig>[0] = {},
  options: { autoLeadReview?: boolean } = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'kun-graph-scheduler-harness-'))
  schedulerTestRoots.push(root)
  const workspace = join(root, 'workspace')
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
    ...(options.autoLeadReview === false
      ? {}
      : { supervision: () => autoLeadSupervision(store, control, nextId) }),
    nextId,
    tickIntervalMs: 5
  })
  return { store, control, scheduler, identity, workspace, writes }
}

export function autoLeadSupervision(
  store: FileGraphRunStore,
  control: GraphControlService,
  nextId: (prefix: string) => string
): GraphSupervisionPort {
  return {
    signal: async (input) => {
      if (input.reason !== 'submitted') return
      for (const nodeId of input.nodeIds) {
        const run = await store.get(input.runId)
        const node = run?.nodes[nodeId]
        const attempt = node?.attempts.at(-1)
        if (
          !run ||
          !node ||
          !attempt?.result ||
          !attempt.validation ||
          run.reviews.some((review) =>
            review.nodeId === nodeId &&
            review.attemptId === attempt.id &&
            review.reviewerKind === 'lead')
        ) continue
        const outcome = attempt.validation.valid ? 'pass' as const : 'revise' as const
        await control.recordReview(run.id, {
          version: 1,
          reviewId: nextId('test_lead_review'),
          nodeId,
          attemptId: attempt.id,
          reviewerKind: 'lead',
          outcome,
          summary: outcome === 'pass'
            ? 'Test source Lead inspected and accepted the executor result.'
            : 'Test source Lead requested repair of host validation errors.',
          evidence: ['Test-only emulation of the durable source Lead review.'],
          artifactRefs: [],
          ...(outcome === 'revise'
            ? { repairInstructions: 'Repair the recorded host validation errors.' }
            : {}),
          createdAt: new Date().toISOString()
        }, {
          commandId: nextId('test_lead_command'),
          idempotencyKey: `test-lead:${attempt.id}:${outcome}`
        }, 'lead')
      }
    }
  }
}

export async function waitFor<T>(
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

export function rejectWhenAborted(
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
