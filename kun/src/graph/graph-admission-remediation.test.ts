import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileArtifactStore } from '../artifacts/artifact-store.js'
import type { DelegationRuntime } from '../delegation/delegation-runtime.js'
import { GraphAssignmentResolver } from './graph-assignment.js'
import { GraphControlService } from './graph-control-service.js'
import { GraphMailbox } from './graph-mailbox.js'
import { FileGraphRunStore } from './graph-run-store.js'
import { GraphScheduler } from './graph-scheduler.js'
import type { GraphSupervisionPort } from './graph-scheduler-types.js'
import {
  testCompletedChild,
  testGraphConfig,
  testGraphPlan
} from './graph-test-fixtures.test-support.js'
import { GraphWorkerSessionRegistry } from './graph-worker-sessions.js'
import { FileGraphWriteCoordinator } from './graph-write-coordinator.js'
import { FileProjectAgentRegistry } from './project-agent-registry.js'
import {
  GRAPH_WORKER_TOOL_NAMES,
  graphParentAuthorityToolNames
} from './graph-tool-boundary.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })))
})

describe('Graph admission remediation', () => {
  it('executes a requested missing profile through the graph-scoped fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-graph-profile-fallback-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    await mkdir(join(workspace, 'src'), { recursive: true })
    const config = testGraphConfig({ supervision: { requireFinalReview: false } })
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
    const source = testGraphPlan().nodes[0]!
    const plan = testGraphPlan({
      workspaceRoot: workspace,
      autoStart: true,
      nodes: [{
        ...source,
        assignment: { kind: 'existing', profileId: 'explore' }
      }],
      edges: [],
      completionNodeIds: [source.id]
    })
    const control = new GraphControlService({ store, config: () => config, nextId })
    await control.create({
      runId: 'run_fallback',
      threadId: 'thread_fallback',
      projectId: identity.projectId,
      sourceTurnId: 'turn_fallback',
      plan,
      commandId: 'command_fallback',
      idempotencyKey: 'create_fallback',
      start: true
    })
    const mailbox = new GraphMailbox({ store, config: () => config })
    const writes = new FileGraphWriteCoordinator({
      rootDir: join(root, 'resources'),
      config: () => config,
      artifactStore: artifacts,
      nextId
    })
    const runChild = vi.fn(async (
      input: Parameters<DelegationRuntime['runChild']>[0]
    ) => {
      const childId = nextId('child')
      await input.onQueued?.(childId)
      await input.onRunning?.(childId)
      return testCompletedChild(childId, 'Fallback worker completed the node.')
    })
    const delegation = {
      enabled: () => true,
      runChild
    } as unknown as DelegationRuntime
    const scheduler = new GraphScheduler({
      store,
      config: () => config,
      delegation: () => delegation,
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
        allowedTools: graphParentAuthorityToolNames([
          'read',
          'delegate_task',
          'list_subagent_profiles',
          'task_graph',
          'design_component'
        ]),
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

    scheduler.start()
    const completed = await waitForRun(store, 'run_fallback', 'completed')
    await scheduler.stop()
    const attempt = completed.nodes.research.attempts[0]!

    expect(runChild).toHaveBeenCalledOnce()
    expect(runChild.mock.calls[0]?.[0].inlineProfile).toMatchObject({
      id: attempt.assignment.profileId,
      source: 'custom'
    })
    expect(runChild.mock.calls[0]?.[0].security).toMatchObject({
      allowedToolNames: expect.arrayContaining([
        'read',
        ...GRAPH_WORKER_TOOL_NAMES
      ]),
      blockedToolNames: expect.arrayContaining([
        'delegate_task',
        'list_subagent_profiles',
        'task_graph',
        'design_component',
        'graph_control_run'
      ])
    })
    expect(attempt.assignment).toMatchObject({
      profileOrigin: 'ephemeral',
      requestedProfileId: 'explore'
    })
    expect(attempt.assignment.routingReason).toContain('explore')
    expect(completed.nodes.research.status).toBe('accepted')
  }, 15_000)

  it('settles a pre-attempt admission failure once instead of retrying every tick', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-graph-admission-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    await mkdir(join(workspace, 'src'), { recursive: true })
    const config = testGraphConfig({ supervision: { requireFinalReview: false } })
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
    const control = new GraphControlService({ store, config: () => config, nextId })
    await control.create({
      runId: 'run_admission',
      threadId: 'thread_admission',
      projectId: identity.projectId,
      sourceTurnId: 'turn_admission',
      plan: testGraphPlan({ workspaceRoot: workspace, autoStart: true }),
      commandId: 'command_create',
      idempotencyKey: 'create_admission',
      start: true
    })
    const mailbox = new GraphMailbox({ store, config: () => config })
    const writes = new FileGraphWriteCoordinator({
      rootDir: join(root, 'resources'),
      config: () => config,
      artifactStore: artifacts,
      nextId
    })
    const resolve = vi.fn(async () => {
      throw new Error('assignment policy unavailable')
    })
    const signal = vi.fn<GraphSupervisionPort['signal']>(async () => undefined)
    const supervision: GraphSupervisionPort = { signal }
    const delegation = {
      enabled: () => true,
      runChild: vi.fn(async () => {
        throw new Error('child execution must not start')
      })
    } as unknown as DelegationRuntime
    const scheduler = new GraphScheduler({
      store,
      config: () => config,
      delegation: () => delegation,
      registry,
      assignments: { resolve } as unknown as GraphAssignmentResolver,
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
        allowedTools: ['read'],
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
      supervision: () => supervision,
      nextId
    })

    await scheduler.tick()
    const awaiting = await store.get('run_admission')
    expect(awaiting).toMatchObject({
      status: 'awaiting_supervision',
      nodes: {
        research: {
          status: 'failed',
          attempts: [],
          lastTransitionReason: 'Graph node admission failed: assignment policy unavailable'
        }
      }
    })

    await scheduler.tick()
    await scheduler.tick()
    await scheduler.stop()
    const settled = await store.get('run_admission')

    expect(settled?.status).toBe('failed')
    expect(resolve).toHaveBeenCalledOnce()
    expect(delegation.runChild).not.toHaveBeenCalled()
    expect(signal.mock.calls.filter(([request]) =>
      request.digest.includes('assignment policy unavailable'))).toHaveLength(1)
  })
})

async function waitForRun(
  store: FileGraphRunStore,
  runId: string,
  status: 'completed' | 'failed'
) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const run = await store.get(runId)
    if (run?.status === status) return run
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${runId} to reach ${status}`)
}
