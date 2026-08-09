import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { GeneratedArtifact, MediaProbeResult } from '@kun/extension-api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { extensionWorkspaceKey } from '../extensions/paths.js'
import type { ExtensionPrincipal } from './extension-agent-service.js'
import type { CreateGeneratedArtifactInput } from './extension-artifact-service.js'
import { ExtensionArtifactService } from './extension-artifact-service.js'
import { ExtensionJobService } from './extension-job-service.js'
import { ExtensionJobStore } from './extension-job-store.js'
import {
  ExtensionMediaFfmpegError,
  ExtensionMediaFfmpegService
} from './extension-media-ffmpeg-service.js'
import { ExtensionMediaHandleService } from './extension-media-handle-service.js'
import { ExtensionMediaJobService } from './extension-media-job-service.js'
import { ExtensionMediaProcessError } from './extension-media-process-service.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(options: {
  maxConcurrent?: number
  retryDelay?: (delayMs: number, signal: AbortSignal) => Promise<void>
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'kun-media-job-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const store = new ExtensionJobStore({ path: join(root, 'jobs.json') })
  const jobs = new ExtensionJobService({ store, progressIntervalMs: 0 })
  const generated = {
    id: 'media_123456789012',
    displayName: 'final.mp4',
    mode: 'read' as const,
    source: 'generated' as const,
    mimeType: 'video/mp4',
    byteSize: 14,
    modifiedAt: '2026-01-01T00:00:00.000Z',
    completionIdentity: 'identity_1234567890',
    available: true,
    createdAt: '2026-01-01T00:00:00.000Z'
  }
  const generatedMedia = new Map<string, {
    id: string
    displayName: string
    mimeType: string
    byteSize: number
    completionIdentity: string
  }>([[generated.id, generated]])
  const transactions: Array<{
    generatedMedia: Array<typeof generated>
    commit: ReturnType<typeof vi.fn>
    rollback: ReturnType<typeof vi.fn>
  }> = []
  const transactionFor = (media: typeof generated[] = [generated]) => {
    const transaction = {
      generatedMedia: media,
      commit: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined)
    }
    transactions.push(transaction)
    return transaction
  }
  const ffmpeg = {
    executeTransaction: vi.fn(async (_principal, _request, options) => {
      options.onProgress({ frame: 12, outputBytes: 14, terminal: false })
      options.onProgress({ frame: 12, outputBytes: 14, terminal: true })
      return transactionFor()
    }),
    rollbackInterruptedTransaction: vi.fn(async () => undefined),
    commitRecoveredTransaction: vi.fn(async () => undefined)
  }
  const media = {
    probe: vi.fn(async (_principal: ExtensionPrincipal, handleId: string): Promise<MediaProbeResult> => ({
      schemaVersion: 1,
      handleId,
      container: { formatNames: ['mov', 'mp4'], durationMicros: 1_500_000 },
      streams: [{
        index: 0,
        kind: 'video',
        codecName: 'h264',
        width: 1920,
        height: 1080,
        disposition: { default: true, forced: false, attachedPicture: false }
      }]
    }))
  }
  const durableArtifacts = new Map<string, GeneratedArtifact>()
  const buildArtifacts = (inputs: readonly CreateGeneratedArtifactInput[]) =>
    inputs.map((input, index): GeneratedArtifact => {
      const media = generatedMedia.get(input.mediaHandleId)
      if (!media) throw new Error('Unknown generated media in test fixture')
      return {
        schemaVersion: 1 as const,
        artifactId: `artifact_123456789${index}`,
        ownerExtensionId: 'kun.video-editor',
        ownerExtensionVersion: '1.1.0',
        workspaceId: input.workspaceId,
        mediaHandleId: media.id,
        displayName: media.displayName,
        mediaKind: media.mimeType.startsWith('video/')
          ? 'video' as const
          : media.mimeType.startsWith('audio/')
            ? 'audio' as const
            : media.mimeType.startsWith('image/')
              ? 'image' as const
              : media.mimeType === 'application/x-otio+json'
                ? 'document' as const
                : 'subtitle' as const,
        mimeType: media.mimeType,
        byteSize: media.byteSize,
        completionIdentity: media.completionIdentity,
        availability: 'available' as const,
        ...(input.width !== undefined ? { width: input.width } : {}),
        ...(input.height !== undefined ? { height: input.height } : {}),
        ...(input.durationMicros !== undefined ? { durationMicros: input.durationMicros } : {}),
        provenance: input.provenance
      }
    })
  const artifacts = {
    createMany: vi.fn(async (
      _principal: ExtensionPrincipal,
      inputs: readonly CreateGeneratedArtifactInput[]
    ) => {
      const created = buildArtifacts(inputs)
      for (const artifact of created) durableArtifacts.set(artifact.artifactId, artifact)
      return created
    }),
    discardUncommittedJobArtifacts: vi.fn(async (
      _principal: ExtensionPrincipal,
      jobId: string,
      discarded: readonly GeneratedArtifact[]
    ) => {
      let count = 0
      for (const artifact of discarded) {
        const current = durableArtifacts.get(artifact.artifactId)
        if (!current) continue
        if (current.provenance.jobId !== jobId) throw new Error('foreign artifact')
        durableArtifacts.delete(artifact.artifactId)
        count += 1
      }
      return count
    }),
    discardUncommittedJobArtifactsByJob: vi.fn(async (
      _principal: ExtensionPrincipal,
      jobId: string
    ) => {
      let count = 0
      for (const [artifactId, artifact] of durableArtifacts) {
        if (artifact.provenance.jobId !== jobId) continue
        durableArtifacts.delete(artifactId)
        count += 1
      }
      return count
    })
  }
  const adapter = new ExtensionMediaJobService({
    jobs,
    ffmpeg: ffmpeg as never,
    media: media as never,
    artifacts: artifacts as never,
    ...options
  })
  const principal: ExtensionPrincipal = {
    extensionId: 'kun.video-editor',
    extensionVersion: '1.1.0',
    permissions: [
      'jobs.manage',
      'media.read',
      'media.process',
      'media.export',
      'workspace.read',
      'workspace.write'
    ],
    workspaceRoots: [workspace],
    workspaceTrusted: true
  }
  return {
    root,
    workspace,
    workspaceId: extensionWorkspaceKey(workspace),
    store,
    jobs,
    generated,
    generatedMedia,
    transactions,
    transactionFor,
    ffmpeg,
    media,
    artifacts,
    durableArtifacts,
    buildArtifacts,
    adapter,
    principal
  }
}

async function transactionalFixture(options: {
  probe?: (handleId: string, signal: AbortSignal) => Promise<MediaProbeResult>
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'kun-media-job-transaction-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const exportsDirectory = join(workspace, 'exports')
  const targetPath = join(exportsDirectory, 'final.mp4')
  await mkdir(exportsDirectory, { recursive: true })
  await writeFile(join(workspace, 'source.mp4'), 'source-video')
  await writeFile(targetPath, 'sentinel-original')
  const principal: ExtensionPrincipal = {
    extensionId: 'kun.video-editor',
    extensionVersion: '1.1.0',
    permissions: [
      'jobs.manage',
      'media.read',
      'media.process',
      'media.export',
      'workspace.read',
      'workspace.write'
    ],
    workspaceRoots: [workspace],
    workspaceTrusted: true
  }
  const handles = new ExtensionMediaHandleService({ dataDir: join(root, 'data') })
  const source = await handles.register(principal, {
    workspaceRoot: workspace,
    path: 'source.mp4',
    mode: 'read',
    source: 'workspace',
    mimeType: 'video/mp4'
  })
  const output = await handles.register(principal, {
    workspaceRoot: workspace,
    path: 'exports/final.mp4',
    mode: 'write',
    source: 'workspace',
    mimeType: 'video/mp4'
  })
  const processService = {
    async runFfmpegForCore(
      _principal: ExtensionPrincipal,
      args: string[],
      runOptions: { signal?: AbortSignal; onProgressChunk?: (chunk: Buffer) => void }
    ) {
      runOptions.signal?.throwIfAborted()
      await writeFile(args.at(-1)!, 'replacement-video')
      runOptions.onProgressChunk?.(Buffer.from('progress=end\n'))
      return { exitCode: 0 }
    }
  }
  const ffmpeg = new ExtensionMediaFfmpegService({
    handleService: handles,
    processService: processService as never
  })
  const artifacts = new ExtensionArtifactService({
    dataDir: join(root, 'data'),
    handleService: handles
  })
  const media = {
    probe: vi.fn(async (
      _principal: ExtensionPrincipal,
      handleId: string,
      probeOptions: { signal?: AbortSignal } = {}
    ) => options.probe
      ? options.probe(handleId, probeOptions.signal ?? new AbortController().signal)
      : {
          schemaVersion: 1 as const,
          handleId,
          container: { formatNames: ['mov', 'mp4'], durationMicros: 1_000_000 },
          streams: [{
            index: 0,
            kind: 'video' as const,
            codecName: 'h264',
            width: 320,
            height: 180,
            durationMicros: 1_000_000,
            disposition: { default: true, forced: false, attachedPicture: false }
          }]
        })
  }
  const store = new ExtensionJobStore({ path: join(root, 'jobs.json') })
  const jobs = new ExtensionJobService({ store, progressIntervalMs: 0 })
  const adapter = new ExtensionMediaJobService({
    jobs,
    ffmpeg,
    media: media as never,
    artifacts
  })
  return {
    workspace,
    workspaceId: extensionWorkspaceKey(workspace),
    exportsDirectory,
    targetPath,
    principal,
    handles,
    source,
    output,
    artifacts,
    store,
    jobs,
    adapter
  }
}

async function startTransactionalJob(test: Awaited<ReturnType<typeof transactionalFixture>>) {
  return test.adapter.start(test.principal, {
    arguments: ['-i', '{{input:source}}', '{{output:video}}'],
    inputs: { source: test.source.id },
    outputs: { video: test.output.id }
  })
}

async function expectTransactionalRollback(
  test: Awaited<ReturnType<typeof transactionalFixture>>
): Promise<void> {
  expect(await readFile(test.targetPath, 'utf8')).toBe('sentinel-original')
  expect(await readdir(test.exportsDirectory)).toEqual(['final.mp4'])
  expect(await test.artifacts.listOwned(test.principal, test.workspaceId)).toEqual([])
  expect((await test.handles.list(test.principal)).filter(({ source }) => source === 'generated'))
    .toEqual([])
  await expect(test.handles.reserveOutput(test.principal, test.output.id, 'next-job'))
    .resolves.toBeDefined()
  await test.handles.releaseOutputReservation(test.principal, test.output.id, 'next-job')
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('ExtensionMediaJobService', () => {
  it('fails before publication when generated output does not match its MIME contract', async () => {
      const invalidCases: Array<{
        name: string
        mimeType: string
        byteSize?: number
        probe: MediaProbeResult
      }> = [{
        name: 'video without a video stream',
        mimeType: 'video/mp4',
        probe: {
          schemaVersion: 1,
          handleId: 'media_123456789012',
          container: { formatNames: ['mov', 'mp4'], durationMicros: 1_000_000 },
          streams: [{
            index: 0,
            kind: 'audio',
            disposition: { default: true, forced: false, attachedPicture: false }
          }]
        }
      }, {
        name: 'audio without positive duration',
        mimeType: 'audio/aac',
        probe: {
          schemaVersion: 1,
          handleId: 'media_123456789012',
          container: { formatNames: ['aac'], durationMicros: 0 },
          streams: [{
            index: 0,
            kind: 'audio',
            durationMicros: 0,
            disposition: { default: true, forced: false, attachedPicture: false }
          }]
        }
      }, {
        name: 'image without bounded dimensions',
        mimeType: 'image/png',
        probe: {
          schemaVersion: 1,
          handleId: 'media_123456789012',
          container: { formatNames: ['png_pipe'] },
          streams: [{
            index: 0,
            kind: 'video',
            width: 1920,
            disposition: { default: true, forced: false, attachedPicture: false }
          }]
        }
      }, {
        name: 'subtitle without a subtitle stream',
        mimeType: 'text/vtt',
        probe: {
          schemaVersion: 1,
          handleId: 'media_123456789012',
          container: { formatNames: ['webvtt'] },
          streams: []
        }
      }, {
        name: 'empty subtitle output',
        mimeType: 'application/x-subrip',
        byteSize: 0,
        probe: {
          schemaVersion: 1,
          handleId: 'media_123456789012',
          container: { formatNames: ['srt'] },
          streams: [{
            index: 0,
            kind: 'subtitle',
            disposition: { default: true, forced: false, attachedPicture: false }
          }]
        }
      }]

      for (const invalid of invalidCases) {
        const test = await fixture()
        const generated = {
          ...test.generated,
          displayName: `invalid-${invalid.name}`,
          mimeType: invalid.mimeType,
          ...(invalid.byteSize !== undefined ? { byteSize: invalid.byteSize } : {})
        }
        test.generatedMedia.set(generated.id, generated)
        test.ffmpeg.executeTransaction.mockResolvedValueOnce(test.transactionFor([generated]))
        test.media.probe.mockResolvedValueOnce(invalid.probe)
        const reference = await test.adapter.start(test.principal, {
          arguments: ['-i', '{{input:source}}', '{{output:video}}'],
          inputs: { source: 'media_abcdefghijklmnop' },
          outputs: { video: 'media_qrstuvwxyz12345' }
        })
        await test.jobs.waitForIdle(reference.jobId)
        expect(await test.store.get(reference.jobId), invalid.name).toMatchObject({
          state: 'failed',
          error: { code: 'INVALID_OUTPUT' }
        })
        expect(test.artifacts.createMany, invalid.name).not.toHaveBeenCalled()
      }
    })

  it('does not complete the job when atomic artifact publication fails', async () => {
      const test = await fixture()
      test.artifacts.createMany.mockRejectedValueOnce(
        Object.assign(new Error('Generated artifact limit reached'), { code: 'artifact_limit' })
      )
      const reference = await test.adapter.start(test.principal, {
        arguments: ['-i', '{{input:source}}', '{{output:video}}'],
        inputs: { source: 'media_abcdefghijklmnop' },
        outputs: { video: 'media_qrstuvwxyz12345' }
      })
      await test.jobs.waitForIdle(reference.jobId)
      expect(await test.store.get(reference.jobId)).toMatchObject({
        state: 'failed',
        error: { code: 'ARTIFACT_LIMIT' }
      })
      expect(test.artifacts.createMany).toHaveBeenCalledTimes(1)
    })

  it('discards artifacts published after cancellation wins the terminal fence', async () => {
      const test = await fixture()
      const publicationStarted = deferred<void>()
      const finishPublication = deferred<void>()
      test.artifacts.createMany.mockImplementationOnce(async (_principal, inputs) => {
        publicationStarted.resolve()
        await finishPublication.promise
        const created = test.buildArtifacts(inputs)
        for (const artifact of created) test.durableArtifacts.set(artifact.artifactId, artifact)
        return created
      })
      const reference = await test.adapter.start(test.principal, {
        arguments: ['-i', '{{input:source}}', '{{output:video}}'],
        inputs: { source: 'media_abcdefghijklmnop' },
        outputs: { video: 'media_qrstuvwxyz12345' }
      })
      await publicationStarted.promise

      const cancellation = test.jobs.cancel({
        extensionId: test.principal.extensionId,
        workspaceIds: [test.workspaceId]
      }, reference.jobId)
      await expect.poll(async () => Boolean(
        (await test.store.get(reference.jobId))?.cancelRequestedAt
      )).toBe(true)
      finishPublication.resolve()

      await expect(cancellation).resolves.toMatchObject({
        accepted: true,
        snapshot: { state: 'cancelled' }
      })
      expect(test.durableArtifacts.size).toBe(0)
      expect(test.artifacts.discardUncommittedJobArtifacts).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceRoots: [test.workspace] }),
        reference.jobId,
        [expect.objectContaining({
          provenance: expect.objectContaining({ jobId: reference.jobId })
        })]
      )
    })

  it('marks cancellation interrupted when late artifact discard fails', async () => {
      const test = await fixture()
      const publicationStarted = deferred<void>()
      const finishPublication = deferred<void>()
      test.artifacts.createMany.mockImplementationOnce(async (_principal, inputs) => {
        publicationStarted.resolve()
        await finishPublication.promise
        const created = test.buildArtifacts(inputs)
        for (const artifact of created) test.durableArtifacts.set(artifact.artifactId, artifact)
        return created
      })
      test.artifacts.discardUncommittedJobArtifacts.mockRejectedValueOnce(
        new Error('artifact registry write failed')
      )
      const reference = await test.adapter.start(test.principal, {
        arguments: ['-i', '{{input:source}}', '{{output:video}}'],
        inputs: { source: 'media_abcdefghijklmnop' },
        outputs: { video: 'media_qrstuvwxyz12345' }
      })
      await publicationStarted.promise

      const cancellation = test.jobs.cancel({
        extensionId: test.principal.extensionId,
        workspaceIds: [test.workspaceId]
      }, reference.jobId)
      await expect.poll(async () => Boolean(
        (await test.store.get(reference.jobId))?.cancelRequestedAt
      )).toBe(true)
      finishPublication.resolve()

      await expect(cancellation).resolves.toMatchObject({
        snapshot: {
          state: 'interrupted',
          error: { code: 'CANCELLATION_CLEANUP_INCOMPLETE' }
        }
      })
      expect(test.durableArtifacts.size).toBe(1)
    })

  it('keeps published artifacts when completion wins before cancellation', async () => {
      const test = await fixture()
      const publicationStarted = deferred<void>()
      const finishPublication = deferred<void>()
      test.artifacts.createMany.mockImplementationOnce(async (_principal, inputs) => {
        publicationStarted.resolve()
        await finishPublication.promise
        const created = test.buildArtifacts(inputs)
        for (const artifact of created) test.durableArtifacts.set(artifact.artifactId, artifact)
        return created
      })
      const reference = await test.adapter.start(test.principal, {
        arguments: ['-i', '{{input:source}}', '{{output:video}}'],
        inputs: { source: 'media_abcdefghijklmnop' },
        outputs: { video: 'media_qrstuvwxyz12345' }
      })
      await publicationStarted.promise
      finishPublication.resolve()
      await test.jobs.waitForIdle(reference.jobId)

      await expect(test.jobs.cancel({
        extensionId: test.principal.extensionId,
        workspaceIds: [test.workspaceId]
      }, reference.jobId)).resolves.toMatchObject({
        accepted: false,
        snapshot: { state: 'completed' }
      })
      expect(test.durableArtifacts.size).toBe(1)
      expect(test.artifacts.discardUncommittedJobArtifacts).not.toHaveBeenCalled()
    })

  it('checks permissions and active workspace before creating a durable record', async () => {
      const test = await fixture()
      const request = {
        arguments: ['-i', '{{input:source}}', '{{output:video}}'],
        inputs: { source: 'media_abcdefghijklmnop' },
        outputs: { video: 'media_qrstuvwxyz12345' }
      }
      await expect(test.adapter.start({ ...test.principal, permissions: [] }, request))
        .rejects.toMatchObject({ code: 'permission_denied' })
      await expect(test.adapter.start({ ...test.principal, workspaceRoots: [] }, request))
        .rejects.toMatchObject({ code: 'workspace_denied' })
      expect(await test.store.list()).toHaveLength(0)
    })

  it('restores an existing target when post-probe semantic validation fails', async () => {
      const test = await transactionalFixture({
        probe: async (handleId) => ({
          schemaVersion: 1,
          handleId,
          container: { formatNames: ['mov', 'mp4'], durationMicros: 1_000_000 },
          streams: []
        })
      })
      const reference = await startTransactionalJob(test)
      await test.jobs.waitForIdle(reference.jobId)

      expect(await test.store.get(reference.jobId)).toMatchObject({
        state: 'failed',
        error: { code: 'INVALID_OUTPUT' }
      })
      await expectTransactionalRollback(test)
    })

  it('restores an existing target when artifact publication fails', async () => {
      const test = await transactionalFixture()
      vi.spyOn(test.artifacts, 'createMany').mockRejectedValueOnce(
        Object.assign(new Error('Generated artifact limit reached'), { code: 'artifact_limit' })
      )
      const reference = await startTransactionalJob(test)
      await test.jobs.waitForIdle(reference.jobId)

      expect(await test.store.get(reference.jobId)).toMatchObject({
        state: 'failed',
        error: { code: 'ARTIFACT_LIMIT' }
      })
      await expectTransactionalRollback(test)
    })

  it('restores an existing target when cancellation wins after promotion', async () => {
      const probeStarted = deferred<void>()
      const test = await transactionalFixture({
        probe: async (_handleId, signal) => {
          probeStarted.resolve()
          return await new Promise<MediaProbeResult>((_resolve, reject) => {
            const abort = () => reject(Object.assign(new Error('cancelled'), { code: 'process_cancelled' }))
            if (signal.aborted) abort()
            else signal.addEventListener('abort', abort, { once: true })
          })
        }
      })
      const reference = await startTransactionalJob(test)
      await probeStarted.promise
      expect(await readFile(test.targetPath, 'utf8')).toBe('replacement-video')

      await expect(test.jobs.cancel({
        extensionId: test.principal.extensionId,
        workspaceIds: [test.workspaceId]
      }, reference.jobId)).resolves.toMatchObject({
        accepted: true,
        snapshot: { state: 'cancelled' }
      })
      await expectTransactionalRollback(test)
    })
})
