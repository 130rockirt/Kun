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
  it('accepts duration-less SRT and atomically publishes safe render provenance', async () => {
      const test = await fixture()
      const subtitle = {
        ...test.generated,
        id: 'media_subtitle_123456',
        displayName: 'captions.srt',
        mimeType: 'application/x-subrip',
        byteSize: 42,
        completionIdentity: 'identity_subtitle_123456'
      }
      test.generatedMedia.set(subtitle.id, subtitle)
      test.ffmpeg.executeTransaction.mockResolvedValueOnce(
        test.transactionFor([test.generated, subtitle])
      )
      test.media.probe
        .mockResolvedValueOnce({
          schemaVersion: 1,
          handleId: test.generated.id,
          container: { formatNames: ['mov', 'mp4'], durationMicros: 1_500_000 },
          streams: [{
            index: 0,
            kind: 'video',
            codecName: 'h264',
            width: 1920,
            height: 1080,
            disposition: { default: true, forced: false, attachedPicture: false }
          }]
        })
        .mockResolvedValueOnce({
          schemaVersion: 1,
          handleId: subtitle.id,
          container: { formatNames: ['srt'] },
          streams: [{
            index: 0,
            kind: 'subtitle',
            codecName: 'subrip',
            disposition: { default: true, forced: false, attachedPicture: false }
          }]
        })
      const reference = await test.adapter.start(test.principal, {
        arguments: ['-i', '{{input:source}}', '{{output:video}}'],
        inputs: { source: 'media_abcdefghijklmnop' },
        outputs: { video: 'media_qrstuvwxyz12345' },
        textOutputs: {
          captions: {
            handleId: subtitle.id,
            mimeType: 'application/x-subrip',
            content: '1\n00:00:00,000 --> 00:00:01,000\nHello\n'
          }
        },
        metadata: {
          projectId: 'project-1',
          pinnedRevision: 7,
          sequenceId: 'sequence-main',
          renderIrDigest: 'd'.repeat(64),
          backendCapabilitiesDigest: 'e'.repeat(64),
          renderRange: { startFrame: 12, endFrame: 48 },
          playbackMode: 'composed-proof',
          renderKind: 'h264-mp4',
          canvasPreset: '9:16',
          proofFrame: 42,
          captionMode: 'both',
          subtitleFormat: 'srt',
          derivedId: 'derived-preview-1',
          assetId: 'asset-interview-1',
          dedupeKey: 'b'.repeat(64),
          derivedKind: 'preview',
          sourceFingerprint: 'c'.repeat(64),
          producerId: 'kun-video-editor.preview',
          producerVersion: '1.1.0',
          priority: 'interactive',
          derivedPhase: 'final',
          derivedPhaseIndex: 0,
          derivedPhaseCount: 1,
          sourcePath: '/must/not/leak',
          invalidRevision: -1
        }
      })
      await test.jobs.waitForIdle(reference.jobId)
      expect(await test.store.get(reference.jobId)).toMatchObject({
        state: 'completed',
        result: {
          generatedArtifacts: [
            { mediaKind: 'video', durationMicros: 1_500_000 },
            { mediaKind: 'subtitle', mimeType: 'application/x-subrip' }
          ]
        }
      })
      const expectedMetadata = {
        projectId: 'project-1',
        pinnedRevision: 7,
        sequenceId: 'sequence-main',
        renderIrDigest: 'd'.repeat(64),
        backendCapabilitiesDigest: 'e'.repeat(64),
        renderRange: { startFrame: 12, endFrame: 48 },
        playbackMode: 'composed-proof',
        renderKind: 'h264-mp4',
        canvasPreset: '9:16',
        proofFrame: 42,
        captionMode: 'both',
        subtitleFormat: 'srt',
        derivedId: 'derived-preview-1',
        assetId: 'asset-interview-1',
        dedupeKey: 'b'.repeat(64),
        derivedKind: 'preview',
        sourceFingerprint: 'c'.repeat(64),
        producerId: 'kun-video-editor.preview',
        producerVersion: '1.1.0',
        priority: 'interactive',
        derivedPhase: 'final',
        derivedPhaseIndex: 0,
        derivedPhaseCount: 1
      }
      expect(test.artifacts.createMany).toHaveBeenCalledWith(
        expect.any(Object),
        [
          expect.objectContaining({ provenance: { jobId: reference.jobId, operation: 'media.startFfmpegJob', metadata: expectedMetadata } }),
          expect.objectContaining({ provenance: { jobId: reference.jobId, operation: 'media.startFfmpegJob', metadata: expectedMetadata } })
        ]
      )
      const inputs = test.artifacts.createMany.mock.calls[0]?.[1]
      expect(inputs?.[1]).not.toHaveProperty('durationMicros')
    })

  it('publishes a text-only subtitle job as one durable generated artifact', async () => {
      const test = await fixture()
      const subtitle = {
        ...test.generated,
        id: 'media_subtitle_only_1234',
        displayName: 'captions.vtt',
        mimeType: 'text/vtt',
        byteSize: 52,
        completionIdentity: 'identity_subtitle_only_1234'
      }
      test.generatedMedia.set(subtitle.id, subtitle)
      test.ffmpeg.executeTransaction.mockResolvedValueOnce(test.transactionFor([subtitle]))
      test.media.probe.mockResolvedValueOnce({
        schemaVersion: 1,
        handleId: subtitle.id,
        container: { formatNames: ['webvtt'] },
        streams: [{
          index: 0,
          kind: 'subtitle',
          codecName: 'webvtt',
          disposition: { default: true, forced: false, attachedPicture: false }
        }]
      })
      const request = {
        arguments: [],
        inputs: {},
        outputs: {},
        textOutputs: {
          captions: {
            handleId: 'media_subtitle_target_01',
            mimeType: 'text/vtt' as const,
            content: 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n'
          }
        },
        metadata: {
          projectId: 'project-1',
          pinnedRevision: 8,
          renderKind: 'subtitles',
          captionMode: 'sidecar',
          subtitleFormat: 'vtt'
        }
      }

      const reference = await test.adapter.start(test.principal, request)
      await test.jobs.waitForIdle(reference.jobId)
      expect(test.ffmpeg.executeTransaction).toHaveBeenCalledWith(
        expect.any(Object),
        request,
        expect.objectContaining({ operationId: reference.jobId })
      )
      expect(await test.store.get(reference.jobId)).toMatchObject({
        kind: 'media.ffmpeg',
        state: 'completed',
        result: {
          data: {
            outputs: [{
              mediaHandleId: subtitle.id,
              displayName: 'captions.vtt',
              mimeType: 'text/vtt'
            }]
          },
          generatedArtifacts: [{
            mediaKind: 'subtitle',
            mimeType: 'text/vtt'
          }]
        }
      })
      expect(test.artifacts.createMany).toHaveBeenCalledWith(
        expect.any(Object),
        [expect.objectContaining({
          provenance: {
            jobId: reference.jobId,
            operation: 'media.startFfmpegJob',
            metadata: request.metadata
          }
        })]
      )
    })

  it('publishes a schema-validated OTIO document without probing it as media', async () => {
      const test = await fixture()
      const content = JSON.stringify({
        OTIO_SCHEMA: 'SerializableCollection.1',
        name: 'Revision 8',
        children: [],
        metadata: { kun: { projectId: 'project-1', projectRevision: 8 } }
      })
      const interchange = {
        ...test.generated,
        id: 'media_otio_document_0001',
        displayName: 'revision-8.otio',
        mimeType: 'application/x-otio+json',
        byteSize: Buffer.byteLength(content, 'utf8'),
        completionIdentity: 'identity_otio_document_0001'
      }
      test.generatedMedia.set(interchange.id, interchange)
      test.ffmpeg.executeTransaction.mockResolvedValueOnce(test.transactionFor([interchange]))
      const request = {
        arguments: [],
        inputs: {},
        outputs: {},
        textOutputs: {
          interchange: {
            handleId: 'media_otio_target_00001',
            mimeType: 'application/x-otio+json' as const,
            content
          }
        },
        metadata: {
          projectId: 'project-1',
          sequenceId: 'sequence-main',
          pinnedRevision: 8,
          interchangeAdapterId: 'kun.otio-json',
          interchangeAdapterVersion: '1.0.0',
          documentDigest: 'a'.repeat(64),
          projectDigest: 'b'.repeat(64),
          lossCount: 3,
          portableLossless: false,
          kunRoundTripLossless: true,
          sourcePath: '/must/not/leak'
        }
      }

      const reference = await test.adapter.start(test.principal, request)
      await test.jobs.waitForIdle(reference.jobId)

      expect(test.media.probe).not.toHaveBeenCalled()
      expect(await test.store.get(reference.jobId)).toMatchObject({
        state: 'completed',
        result: {
          generatedArtifacts: [{
            mediaKind: 'document',
            mimeType: 'application/x-otio+json',
            provenance: {
              metadata: {
                projectId: 'project-1',
                sequenceId: 'sequence-main',
                pinnedRevision: 8,
                interchangeAdapterId: 'kun.otio-json',
                documentDigest: 'a'.repeat(64),
                projectDigest: 'b'.repeat(64),
                lossCount: 3,
                portableLossless: false,
                kunRoundTripLossless: true
              }
            }
          }]
        }
      })
      expect(JSON.stringify(test.artifacts.createMany.mock.calls)).not.toContain('/must/not/leak')
    })
})
