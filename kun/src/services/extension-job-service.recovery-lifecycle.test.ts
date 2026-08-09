import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JobEventSchema, JobSnapshotSchema } from '@kun/extension-api'
import { extensionWorkspaceKey } from '../extensions/paths.js'
import { ExtensionJobStore } from './extension-job-store.js'
import {
  ExtensionJobService,
  ExtensionJobServiceError,
  type ExtensionJobCoreExecutor,
  type ExtensionJobCreateInput,
  type ExtensionJobExecutionContext
} from './extension-job-service.js'
import type { ExtensionJobResult } from './extension-job-types.js'

const roots: string[] = []

const WORKSPACE_ROOT = '/private/workspaces/one'

const OTHER_WORKSPACE_ROOT = '/private/workspaces/two'

const WORKSPACE_ID = extensionWorkspaceKey(WORKSPACE_ROOT)

const OTHER_WORKSPACE_ID = extensionWorkspaceKey(OTHER_WORKSPACE_ROOT)

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createService(
  options: Omit<ConstructorParameters<typeof ExtensionJobService>[0], 'store'> = {}
): Promise<{ store: ExtensionJobStore; service: ExtensionJobService }> {
  const root = await mkdtemp(join(tmpdir(), 'kun-extension-job-service-'))
  roots.push(root)
  const store = new ExtensionJobStore({ path: join(root, 'jobs.json') })
  return { store, service: new ExtensionJobService({ store, ...options }) }
}

function jobInput(overrides: Partial<ExtensionJobCreateInput> = {}): ExtensionJobCreateInput {
  return {
    owner: {
      extensionId: 'video.editor',
      extensionVersion: '1.1.0',
      workspaceId: WORKSPACE_ID
    },
    workspaceRoot: WORKSPACE_ROOT,
    kind: 'media.ffmpeg',
    kindSchemaVersion: 1,
    initiatingOperation: 'media.startFfmpegJob',
    permissionsSnapshot: ['jobs.manage', 'media.process'],
    ...overrides
  }
}

function caller() {
  return { extensionId: 'video.editor', workspaceIds: [WORKSPACE_ID] }
}

async function persistRunning(
  store: ExtensionJobStore,
  jobId: string,
  cancelRequested = false
): Promise<void> {
  const timestamp = new Date().toISOString()
  await store.mutate(jobId, (record) => ({
    snapshot: {
      ...record.snapshot,
      state: 'running',
      executionAttempt: 1,
      startedAt: timestamp,
      updatedAt: timestamp,
      ...(cancelRequested ? { cancelRequestedAt: timestamp } : {})
    },
    ...(cancelRequested ? { cancellationReason: 'shutdown_request' } : {}),
    event: { type: cancelRequested ? 'cancellation-requested' : 'state' }
  }))
}

function controllableExecutor(kind: string): {
  executor: ExtensionJobCoreExecutor
  context(): Promise<ExtensionJobExecutionContext>
  resolve(value: ExtensionJobResult): void
  reject(error: unknown): void
} {
  let resolveContext!: (context: ExtensionJobExecutionContext) => void
  const contextPromise = new Promise<ExtensionJobExecutionContext>((resolve) => {
    resolveContext = resolve
  })
  let resolveExecution!: (value: ExtensionJobResult) => void
  let rejectExecution!: (error: unknown) => void
  const execution = new Promise<ExtensionJobResult>((resolve, reject) => {
    resolveExecution = resolve
    rejectExecution = reject
  })
  return {
    executor: {
      kind,
      async execute(_snapshot, context) {
        resolveContext(context)
        return execution
      }
    },
    context: () => contextPromise,
    resolve: resolveExecution,
    reject: rejectExecution
  }
}

describe('ExtensionJobService restart recovery', () => {
  it('makes a persisted queued job eligible for bounded dispatch with the same ID', async () => {
      const { store, service: firstRuntime } = await createService()
      const created = await firstRuntime.createJob(jobInput({
        checkpoint: { schemaVersion: 1, data: { source: 'durable-input' } }
      }))
      const reauthorize = vi.fn(async (_snapshot, workspaceRoot: string) =>
        workspaceRoot === WORKSPACE_ROOT)
      const recovered = new ExtensionJobService({ store, reauthorize })
      const execution = controllableExecutor('media.ffmpeg')
      recovered.registerCoreExecutor(execution.executor)

      await expect(recovered.initialize()).resolves.toMatchObject({ queued: 1, interrupted: 0 })
      expect(await store.get(created.snapshot.id)).toMatchObject({
        id: created.snapshot.id,
        state: 'running',
        executionAttempt: 1
      })
      const context = await execution.context()
      expect(context.checkpoint).toEqual({
        schemaVersion: 1,
        data: { source: 'durable-input' }
      })
      expect(context.workspaceRoot).toBe(WORKSPACE_ROOT)
      expect(reauthorize).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: WORKSPACE_ID }),
        WORKSPACE_ROOT
      )
      execution.resolve({ schemaVersion: 1, generatedArtifacts: [] })
      await recovered.waitForIdle(created.snapshot.id)
    })

  it('interrupts a formerly running job unless its core adapter proves recovery is safe', async () => {
      const { store, service: firstRuntime } = await createService()
      const created = await firstRuntime.createJob(jobInput())
      await persistRunning(store, created.snapshot.id)
      const recovered = new ExtensionJobService({ store })
      const execute = vi.fn(async () => ({ schemaVersion: 1 as const, generatedArtifacts: [] }))
      recovered.registerCoreExecutor({ kind: 'media.ffmpeg', execute })

      await expect(recovered.initialize()).resolves.toMatchObject({ interrupted: 1 })
      expect(execute).not.toHaveBeenCalled()
      expect(await store.get(created.snapshot.id)).toMatchObject({
        state: 'interrupted',
        error: { code: 'JOB_RECOVERY_UNSAFE' }
      })
    })

  it('reauthorizes recovery with the private root and interrupts a denied workspace', async () => {
      const { store, service: firstRuntime } = await createService()
      const created = await firstRuntime.createJob(jobInput())
      const reauthorize = vi.fn(async (_snapshot, workspaceRoot: string) => {
        expect(workspaceRoot).toBe(WORKSPACE_ROOT)
        return false
      })
      const recovered = new ExtensionJobService({ store, reauthorize })
      const execute = vi.fn(async () => ({ schemaVersion: 1 as const, generatedArtifacts: [] }))
      recovered.registerCoreExecutor({ kind: 'media.ffmpeg', execute })

      await expect(recovered.initialize()).resolves.toMatchObject({ interrupted: 1 })
      expect(reauthorize).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: WORKSPACE_ID }),
        WORKSPACE_ROOT
      )
      expect(execute).not.toHaveBeenCalled()
      expect(await store.get(created.snapshot.id)).toMatchObject({
        state: 'interrupted',
        error: { code: 'JOB_RECOVERY_UNAUTHORIZED' }
      })
    })

  it('records a new attempt when a recovery adapter explicitly resumes', async () => {
      const { store, service: firstRuntime } = await createService()
      const created = await firstRuntime.createJob(jobInput({
        checkpoint: { schemaVersion: 1, data: { frame: 120 } }
      }))
      await persistRunning(store, created.snapshot.id)
      const recovered = new ExtensionJobService({ store })
      const execution = controllableExecutor('media.ffmpeg')
      execution.executor.recover = async (_snapshot, checkpoint, context) => {
        expect(context.workspaceRoot).toBe(WORKSPACE_ROOT)
        return checkpoint?.data !== undefined ? 'resume' : 'interrupt'
      }
      recovered.registerCoreExecutor(execution.executor)

      await expect(recovered.initialize()).resolves.toMatchObject({ resumed: 1 })
      expect(await store.get(created.snapshot.id)).toMatchObject({ state: 'running', executionAttempt: 2 })
      expect((await store.replay(created.snapshot.id))?.events.at(-1)).toMatchObject({
        type: 'recovery',
        executionAttempt: 2
      })
      execution.resolve({ schemaVersion: 1, generatedArtifacts: [] })
      await recovered.waitForIdle(created.snapshot.id)
    })

  it('gives durable cancellation intent priority over normal restart', async () => {
      const { store, service: firstRuntime } = await createService()
      const created = await firstRuntime.createJob(jobInput())
      await persistRunning(store, created.snapshot.id, true)
      const recovered = new ExtensionJobService({ store })
      const cancel = vi.fn(async () => undefined)
      const execute = vi.fn(async () => ({ schemaVersion: 1 as const, generatedArtifacts: [] }))
      recovered.registerCoreExecutor({ kind: 'media.ffmpeg', execute, cancel, recover: () => 'resume' })

      await expect(recovered.initialize()).resolves.toMatchObject({ cancelled: 1 })
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(execute).not.toHaveBeenCalled()
      expect(await store.get(created.snapshot.id)).toMatchObject({ state: 'cancelled' })
    })

  it('defers excess queued recovery when the current concurrency policy is stricter', async () => {
      const { store, service: firstRuntime } = await createService()
      await firstRuntime.createJob(jobInput())
      await firstRuntime.createJob(jobInput())
      const recovered = new ExtensionJobService({
        store,
        quotas: { maxActivePerExtension: 1 }
      })
      const execution = controllableExecutor('media.ffmpeg')
      recovered.registerCoreExecutor(execution.executor)

      await expect(recovered.initialize()).resolves.toMatchObject({ queued: 1, deferred: 1 })
      const snapshots = await store.list()
      expect(snapshots.filter((snapshot) => snapshot.state === 'running')).toHaveLength(1)
      expect(snapshots.filter((snapshot) => snapshot.state === 'queued')).toHaveLength(1)
      execution.resolve({ schemaVersion: 1, generatedArtifacts: [] })
      await recovered.waitForIdle(snapshots.find((snapshot) => snapshot.state === 'running')!.id)
    })
})

describe('ExtensionJobService lifecycle fencing', () => {
  it('fences disablement before cleanup, revokes subscriptions, and never publishes late success', async () => {
      const { store, service } = await createService()
      const execution = controllableExecutor('media.ffmpeg')
      execution.executor.cancel = vi.fn(async () => {
        execution.resolve({
          schemaVersion: 1,
          data: { mustNotPublish: true },
          generatedArtifacts: []
        })
      })
      service.registerCoreExecutor(execution.executor)
      const created = await service.createAndDispatch(jobInput())
      await execution.context()
      const running = await service.getOwned(caller(), created.snapshot.id)
      await service.subscribe(caller(), created.snapshot.id, running.latestCursor)

      await expect(service.handleExtensionDisabled('video.editor')).resolves.toMatchObject({
        matched: 1,
        cancelled: 1
      })
      expect(service.subscriptionCount).toBe(0)
      await expect(service.createJob(jobInput())).rejects.toMatchObject({ code: 'lifecycle_fenced' })
      await service.waitForIdle(created.snapshot.id)
      expect(await store.get(created.snapshot.id)).toMatchObject({ state: 'cancelled' })

      service.clearExtensionFence('video.editor')
      await expect(service.createJob(jobInput())).resolves.toMatchObject({ created: true })
      expect(await store.get(created.snapshot.id)).toMatchObject({ state: 'cancelled' })
    })

  it('lets independently supervised work survive a Node Host crash but cancels connection-bound work', async () => {
      const { store, service } = await createService()
      const independent = controllableExecutor('media.ffmpeg')
      service.registerCoreExecutor(independent.executor)
      const first = await service.createAndDispatch(jobInput())
      await independent.context()
      await service.subscribe(caller(), first.snapshot.id)

      await expect(service.handleExtensionHostCrash('video.editor')).resolves.toMatchObject({ matched: 0 })
      expect(service.subscriptionCount).toBe(0)
      expect(await store.get(first.snapshot.id)).toMatchObject({ state: 'running' })
      independent.resolve({ schemaVersion: 1, generatedArtifacts: [] })
      await service.waitForIdle(first.snapshot.id)

      const connectionBound = controllableExecutor('media.connection-bound')
      connectionBound.executor.connectionBound = true
      connectionBound.executor.cancel = vi.fn(async () => {
        connectionBound.resolve({ schemaVersion: 1, generatedArtifacts: [] })
      })
      service.registerCoreExecutor(connectionBound.executor)
      const second = await service.createAndDispatch(jobInput({ kind: 'media.connection-bound' }))
      await connectionBound.context()
      await expect(service.handleExtensionHostCrash('video.editor')).resolves.toMatchObject({
        matched: 1,
        cancelled: 1
      })
      await service.waitForIdle(second.snapshot.id)
      expect(await store.get(second.snapshot.id)).toMatchObject({ state: 'cancelled' })
    })

  it('fences a crashed workspace Host without cancelling a peer workspace job', async () => {
      const { store, service } = await createService()
      service.registerCoreExecutor({
        kind: 'media.connection-bound',
        connectionBound: true,
        async execute() {
          return { schemaVersion: 1, generatedArtifacts: [] }
        }
      })
      const first = await service.createJob(jobInput({ kind: 'media.connection-bound' }))
      const second = await service.createJob(jobInput({
        kind: 'media.connection-bound',
        owner: { ...jobInput().owner, workspaceId: OTHER_WORKSPACE_ID },
        workspaceRoot: OTHER_WORKSPACE_ROOT
      }))

      await expect(service.handleExtensionHostCrash('video.editor', [WORKSPACE_ID]))
        .resolves.toMatchObject({ matched: 1, cancelled: 1 })

      expect(await store.get(first.snapshot.id)).toMatchObject({ state: 'cancelled' })
      expect(await store.get(second.snapshot.id)).toMatchObject({ state: 'queued' })
    })

  it('scopes workspace revocation without affecting another authorized workspace', async () => {
      const { store, service } = await createService()
      const first = await service.createJob(jobInput())
      const second = await service.createJob(jobInput({
        owner: { ...jobInput().owner, workspaceId: OTHER_WORKSPACE_ID },
        workspaceRoot: OTHER_WORKSPACE_ROOT
      }))

      await expect(service.handleWorkspaceRevoked('video.editor', WORKSPACE_ID)).resolves.toMatchObject({
        matched: 1,
        cancelled: 1
      })
      expect(await store.get(first.snapshot.id)).toMatchObject({ state: 'cancelled' })
      expect(await store.get(second.snapshot.id)).toMatchObject({ state: 'queued' })
      await expect(service.createJob(jobInput())).rejects.toMatchObject({ code: 'lifecycle_fenced' })
      await expect(service.createJob(jobInput({
        owner: { ...jobInput().owner, workspaceId: OTHER_WORKSPACE_ID },
        workspaceRoot: OTHER_WORKSPACE_ROOT
      }))).resolves.toMatchObject({ created: true })
    })

  it('fences every active job during runtime shutdown', async () => {
      const { store, service } = await createService()
      const execution = controllableExecutor('media.ffmpeg')
      service.registerCoreExecutor(execution.executor)
      const running = await service.createAndDispatch(jobInput())
      const context = await execution.context()
      await service.createJob(jobInput({
        owner: { ...jobInput().owner, workspaceId: OTHER_WORKSPACE_ID },
        workspaceRoot: OTHER_WORKSPACE_ROOT
      }))

      let shutdownSettled = false
      const shutdown = service.handleRuntimeShutdown().finally(() => {
        shutdownSettled = true
      })
      await expect.poll(() => context.signal.aborted).toBe(true)
      expect(shutdownSettled).toBe(false)
      expect(await store.get(running.snapshot.id)).toMatchObject({
        state: 'running',
        cancelRequestedAt: expect.any(String)
      })
      execution.resolve({ schemaVersion: 1, generatedArtifacts: [] })
      await expect(shutdown).resolves.toMatchObject({ matched: 2, cancelled: 2 })
      await expect(service.createJob(jobInput())).rejects.toMatchObject({ code: 'lifecycle_fenced' })
    })

  it('allows a compatible upgraded version to read retained jobs without rewriting creator audit metadata', async () => {
      const { service } = await createService()
      const created = await service.createJob(jobInput())
      await service.cancel(caller(), created.snapshot.id)

      await expect(service.getOwned({
        extensionId: 'video.editor',
        workspaceIds: [WORKSPACE_ID]
      }, created.snapshot.id)).resolves.toMatchObject({
        ownerExtensionVersion: '1.1.0',
        state: 'cancelled'
      })
    })
})
