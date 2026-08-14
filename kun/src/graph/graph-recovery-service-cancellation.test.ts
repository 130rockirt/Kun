import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileArtifactStore } from '../artifacts/artifact-store.js'
import { GRAPH_CONTRACT_VERSION, GraphNodeAttemptV1Schema } from '../contracts/graph.js'
import type { ChildRunRecord, DelegationRuntime } from '../delegation/delegation-runtime.js'
import { GraphControlService } from './graph-control-service.js'
import { GraphRecoveryService } from './graph-recovery-service.js'
import { FileGraphRunStore } from './graph-run-store.js'
import {
  testAssignmentSnapshot,
  testCompletedChild,
  testGraphConfig,
  testGraphPlan
} from './graph-test-fixtures.test-support.js'
import { FileGraphWriteCoordinator } from './graph-write-coordinator.js'
import { effectiveRunAttemptCount } from './graph-scheduler-policy.js'
import { checksumJson } from './graph-run-store-support.js'

const roots: string[] = []
const execFileAsync = promisify(execFile)

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('GraphRecoveryService', () => {
  it('recovers a legacy cancellation fence hidden behind an old snapshot high-water mark', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-graph-recovery-legacy-cancel-'))
    roots.push(root)
    const graphRoot = join(root, 'graphs')
    const config = testGraphConfig()
    let id = 0
    const nextId = (prefix: string) => `${prefix}_${++id}`
    const store = new FileGraphRunStore({
      rootDir: graphRoot,
      artifactStore: new FileArtifactStore(join(root, 'artifacts')),
      config: () => config,
      nextId
    })
    const control = new GraphControlService({ store, config: () => config, nextId })
    const created = await control.create({
      runId: 'run_legacy_cancel_recovery',
      threadId: 'thread_1',
      projectId: 'project_1',
      sourceTurnId: 'turn_1',
      plan: testGraphPlan(),
      commandId: 'create_legacy_cancel_recovery',
      idempotencyKey: 'create_legacy_cancel_recovery',
      start: true
    })
    await store.append(created.run.id, {
      expectedSeq: created.run.lastEventSeq,
      graphRevision: created.run.currentRevision,
      commandId: 'legacy_cancel_fence',
      idempotencyKey: 'legacy_cancel_fence',
      event: {
        type: 'run_status_changed',
        payload: {
          from: 'running',
          to: 'pausing',
          reason: 'cancellation dispatch fence'
        }
      }
    })
    await store.snapshot(created.run.id)
    const snapshotPath = join(graphRoot, created.run.id, 'snapshot.json')
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as {
      checksum: string
      state: Record<string, unknown>
      recentCommands: unknown[]
    }
    delete snapshot.state.pendingControlIntent
    snapshot.checksum = checksumJson({
      state: snapshot.state,
      recentCommands: snapshot.recentCommands
    })
    await writeFile(snapshotPath, `${JSON.stringify(snapshot)}\n`)

    const legacyStore = new FileGraphRunStore({
      rootDir: graphRoot,
      artifactStore: new FileArtifactStore(join(root, 'artifacts')),
      config: () => config,
      nextId
    })
    expect(await legacyStore.get(created.run.id)).toMatchObject({ status: 'pausing' })
    expect((await legacyStore.get(created.run.id))?.pendingControlIntent).toBeUndefined()
    const recovery = new GraphRecoveryService({
      store: legacyStore,
      config: () => config,
      writes: new FileGraphWriteCoordinator({
        rootDir: join(root, 'writes'),
        config: () => config,
        nextId
      }),
      delegation: () => undefined,
      nextId
    })

    expect(await recovery.reconcile()).toMatchObject({
      pausedRuns: 0,
      cancelledRuns: 1
    })
    expect(await legacyStore.get(created.run.id)).toMatchObject({ status: 'cancelled' })
  })

  it('preserves completing runs so the scheduler can resume finalization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-graph-recovery-completing-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const config = testGraphConfig()
    let id = 0
    const nextId = (prefix: string) => `${prefix}_${++id}`
    const store = new FileGraphRunStore({
      rootDir: join(root, 'graphs'),
      artifactStore: new FileArtifactStore(join(root, 'artifacts')),
      config: () => config,
      nextId
    })
    const control = new GraphControlService({ store, config: () => config, nextId })
    const created = await control.create({
      runId: 'run_completing',
      threadId: 'thread_1',
      projectId: 'project_1',
      sourceTurnId: 'turn_1',
      plan: testGraphPlan({ workspaceRoot: workspace }),
      commandId: 'create_completing',
      idempotencyKey: 'create_completing',
      start: true
    })
    await store.append(created.run.id, {
      expectedSeq: created.run.lastEventSeq,
      graphRevision: created.run.currentRevision,
      commandId: 'enter_completing',
      idempotencyKey: 'enter_completing',
      event: {
        type: 'run_status_changed',
        payload: { from: 'running', to: 'completing' }
      }
    })
    const recovery = new GraphRecoveryService({
      store,
      config: () => config,
      writes: new FileGraphWriteCoordinator({
        rootDir: join(root, 'writes'),
        config: () => config,
        nextId
      }),
      delegation: () => undefined,
      nextId
    })
    const report = await recovery.reconcile()
    expect(report.pausedRuns).toBe(0)
    expect((await store.get('run_completing'))?.status).toBe('completing')
  })
})

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
}
