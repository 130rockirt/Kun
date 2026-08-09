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

describe('ExtensionJobService conformance', () => {
  it('lists only owned jobs with deterministic filters and cursors', async () => {
      const { service } = await createService()
      await service.createJob(jobInput())
      await service.createJob(jobInput({
        kind: 'media.ffprobe',
        owner: { ...jobInput().owner, workspaceId: OTHER_WORKSPACE_ID },
        workspaceRoot: OTHER_WORKSPACE_ROOT
      }))
      await service.createJob(jobInput({
        owner: { ...jobInput().owner, extensionId: 'other.extension' }
      }))

      const firstPage = await service.listOwned({
        extensionId: 'video.editor',
        workspaceIds: [WORKSPACE_ID, OTHER_WORKSPACE_ID]
      }, { limit: 1 })
      expect(firstPage.items).toHaveLength(1)
      expect(firstPage.page).toMatchObject({ hasMore: true })
      const secondPage = await service.listOwned({
        extensionId: 'video.editor',
        workspaceIds: [WORKSPACE_ID, OTHER_WORKSPACE_ID]
      }, { limit: 1, cursor: firstPage.page.nextCursor })
      expect(secondPage.items).toHaveLength(1)
      expect(secondPage.items[0]?.id).not.toBe(firstPage.items[0]?.id)

      const filtered = await service.listOwned(caller(), {
        filter: { kinds: ['media.ffmpeg'], workspaceId: WORKSPACE_ID }
      })
      expect(filtered.items).toHaveLength(1)
      expect(filtered.items[0]).toMatchObject({
        ownerExtensionId: 'video.editor',
        workspaceId: WORKSPACE_ID,
        kind: 'media.ffmpeg'
      })
    })

  it('returns the opaque not-found policy for foreign reads and subscriptions', async () => {
      const { service } = await createService()
      const created = await service.createJob(jobInput())
      const foreign = { extensionId: 'other.extension', workspaceIds: [WORKSPACE_ID] }

      await expect(service.getOwned(foreign, created.snapshot.id)).rejects.toMatchObject({ code: 'not_found' })
      await expect(service.subscribe(foreign, created.snapshot.id)).rejects.toMatchObject({ code: 'not_found' })
    })

  it('rejects an invalid state transition without mutating the queued job', async () => {
      const { store, service } = await createService()
      const created = await service.createJob(jobInput())

      await expect(service.complete(created.snapshot.id, 0)).rejects.toMatchObject({
        code: 'invalid_transition'
      })
      expect(await store.get(created.snapshot.id)).toEqual(created.snapshot)
    })

  it('persists public-schema-valid snapshots and events', async () => {
      const { store, service } = await createService()
      const execution = controllableExecutor('media.ffmpeg')
      service.registerCoreExecutor(execution.executor)
      const created = await service.createAndDispatch(jobInput())
      execution.resolve({ schemaVersion: 1, generatedArtifacts: [] })
      await service.waitForIdle(created.snapshot.id)

      const snapshot = await store.get(created.snapshot.id)
      expect(() => JobSnapshotSchema.parse(snapshot)).not.toThrow()
      for (const event of (await store.replay(created.snapshot.id))?.events ?? []) {
        expect(() => JobEventSchema.parse(event)).not.toThrow()
      }
    })

  it('redacts credentials, media URLs, and local paths before durable failure storage', async () => {
      const { store, service } = await createService()
      const execution = controllableExecutor('media.ffmpeg')
      service.registerCoreExecutor(execution.executor)
      const created = await service.createAndDispatch(jobInput())
      const error = Object.assign(
        new Error('Authorization: Bearer abc123 /Users/alice/private.mov kun-media://lease-secret'),
        {
          code: 'oauth failure',
          category: 'internal',
          details: {
            apiKey: 'hidden-key',
            nested: { token: 'nested-secret' },
            path: '/home/alice/project/private.mov'
          }
        }
      )
      execution.reject(error)
      await service.waitForIdle(created.snapshot.id)

      const persisted = JSON.stringify({
        snapshot: await store.get(created.snapshot.id),
        replay: await store.replay(created.snapshot.id)
      })
      expect(persisted).not.toContain('abc123')
      expect(persisted).not.toContain('hidden-key')
      expect(persisted).not.toContain('nested-secret')
      expect(persisted).not.toContain('/Users/alice')
      expect(persisted).not.toContain('/home/alice')
      expect(persisted).not.toContain('lease-secret')
      expect(persisted).toContain('OAUTH_FAILURE')
      expect(persisted).toContain('<redacted>')
    })

  it('runs through the same durable API in a headless process with no renderer dependencies', async () => {
      const { store, service } = await createService()
      service.registerCoreExecutor({
        kind: 'media.ffmpeg',
        async execute() {
          return { schemaVersion: 1, data: { mode: 'headless' }, generatedArtifacts: [] }
        }
      })
      const created = await service.createAndDispatch(jobInput())
      await service.waitForIdle(created.snapshot.id)

      expect(await store.get(created.snapshot.id)).toMatchObject({
        state: 'completed',
        result: { data: { mode: 'headless' } }
      })
    })
})
