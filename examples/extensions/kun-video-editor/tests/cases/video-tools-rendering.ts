import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ExtensionApiError,
  MediaAnalyzeVisualFramesRequestSchema,
  MediaEmbedVisualQueryRequestSchema,
  type JsonObject,
  type ToolResult
} from '@kun/extension-api'
import { createGeneratedArtifactFixture, type ExtensionTestHarness } from '@kun/extension-test'
import { describe, expect, it } from 'vitest'
import { VIDEO_TOOL_DECLARATIONS, VIDEO_TOOL_IDS } from '../../src/host/extension.js'
import { DerivedMediaService } from '../../src/host/derived-media-service.js'
import type { GenerationExecutionBroker } from '../../src/host/generation-service.js'
import {
  activatedHarness,
  artifactFor,
  audioProbe,
  beatAnalysisResult,
  contentObject,
  generationAuthorization,
  generationBrokerSnapshot,
  generationCatalogFixture,
  generationHarness,
  generationOutputFixture,
  imageDerivedArtifact,
  invoke,
  isJsonObject,
  latestRenderMetadata,
  loadManifest,
  mediaHandle,
  multiGenerationOutputFixture,
  nextAudioAnalysisJob,
  permissions,
  projectWithMedia,
  projectWithTwoAudioAssets,
  roots,
  silenceAnalysisResult,
  subtitleProbe,
  syncAnalysisResult,
  videoProbe,
  visualModelStatus,
  waitForVisualOperation
} from './video-tools-support.js'

describe('video editor Agent tools', () => {
  it('reauthorizes a revoked asset without changing timeline or transcript identity', async () => {
    const harness = await projectWithMedia()
    const derived = await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'derived.start',
      payload: {
        projectId: 'agent-demo', expectedRevision: 1, assetId: 'interview', kind: 'thumbnail'
      }
    })
    expect(derived.content).toMatchObject({
      outcome: 'queued',
      record: { status: 'running' },
      jobId: expect.any(String)
    })
    const derivedRecordId = String((contentObject(derived).record as JsonObject).id)
    const derivedJobId = String(contentObject(derived).jobId)
    const replacementHandle = 'fake_media_replacement_001'
    harness.media.addHandle(mediaHandle(replacementHandle, 'read', 'replacement.mp4', 'video'))
    harness.media.setProbe(replacementHandle, videoProbe(replacementHandle))

    const result = await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'media.reauthorize',
      payload: {
        projectId: 'agent-demo',
        expectedRevision: 1,
        assetId: 'interview',
        mediaHandleId: replacementHandle
      }
    })
    expect(result.content).toMatchObject({
      outcome: 'reauthorized',
      currentRevision: 2,
      asset: { id: 'interview', mediaHandleId: replacementHandle }
    })
    const loaded = await invoke(harness, 'video-project', {
      action: 'get', projectId: 'agent-demo'
    })
    expect(loaded.content).toMatchObject({
      project: {
        assets: [{ id: 'interview', mediaHandleId: replacementHandle }],
        items: [{ assetId: 'interview' }]
      }
    })
    const listed = await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'derived.list', payload: { projectId: 'agent-demo' }
    })
    expect(listed.content).toMatchObject({
      records: [expect.objectContaining({
        id: derivedRecordId,
        status: 'invalid',
        jobId: null,
        bytes: 0,
        error: expect.objectContaining({ code: 'source_changed' })
      })]
    })
    expect(harness.jobs.get(derivedJobId).state).toBe('cancelled')
    await harness.dispose()
  })

  it('projects authoritative undo and redo availability instead of inferring it from revision', async () => {
    const harness = await activatedHarness()
    await invoke(harness, 'video-project', {
      action: 'create', projectId: 'history-flags', name: 'History Flags'
    })
    await invoke(harness, 'video-update-timeline', {
      projectId: 'history-flags',
      expectedRevision: 0,
      operations: [{ type: 'set-canvas', preset: '9:16', fit: 'pad' }]
    })
    const changed = await invoke(harness, 'video-project', {
      action: 'get', projectId: 'history-flags'
    })
    expect(changed.content).toMatchObject({
      project: { currentRevision: 1, canUndo: true, canRedo: false }
    })

    const undone = await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'project.undo',
      payload: { projectId: 'history-flags', expectedRevision: 1 }
    })
    expect(undone.content).toMatchObject({
      details: { project: { currentRevision: 2, canUndo: false, canRedo: true } }
    })
    const redone = await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'project.redo',
      payload: { projectId: 'history-flags', expectedRevision: 2 }
    })
    expect(redone.content).toMatchObject({
      details: { project: { currentRevision: 3, canUndo: true, canRedo: false } }
    })
    await harness.dispose()
  })

  it('clears a damaged active project and still lists healthy projects with diagnostics', async () => {
    const harness = await activatedHarness()
    await invoke(harness, 'video-project', {
      action: 'create', projectId: 'healthy-project', name: 'Healthy'
    })
    const projectsRoot = join(harness.context.workspaceContext!.root, '.kun-video/projects')
    await mkdir(join(projectsRoot, 'damaged-project'), { recursive: true })
    await writeFile(join(projectsRoot, 'damaged-project/project.json'), '{broken json', 'utf8')
    harness.storage.workspace.set('active-project', {
      schemaVersion: 1, projectId: 'damaged-project'
    })

    const active = await invoke(harness, 'video-project', { action: 'active' })
    expect(active.content).toMatchObject({
      outcome: 'stale-active-project',
      projectId: 'damaged-project',
      diagnosticCode: 'invalid_project'
    })
    expect(harness.storage.workspace.get('active-project')).toBeUndefined()
    const listed = await invoke(harness, 'video-project', { action: 'list' })
    expect(listed.content).toMatchObject({
      projects: [expect.objectContaining({ id: 'healthy-project' })],
      diagnostics: [{ id: 'damaged-project', code: 'invalid_project' }]
    })
    await harness.dispose()
  })

  it('returns structured interaction-required in headless mode and rejects path-shaped inputs', async () => {
    const harness = await activatedHarness()
    await invoke(harness, 'video-project', {
      action: 'create', projectId: 'agent-demo', name: 'Agent Demo'
    })
    harness.transport.handle('media.pickFiles', () => {
      throw new ExtensionApiError({
        code: 'INTERACTION_REQUIRED',
        message: 'No protected desktop picker is attached.',
        operation: 'media.pickFiles',
        retryable: true
      })
    })
    const gated = await invoke(harness, 'video-probe', {
      projectId: 'agent-demo', expectedRevision: 0
    })
    expect(gated.content).toEqual(expect.objectContaining({
      outcome: 'interaction-required',
      code: 'MEDIA_INTERACTION_REQUIRED'
    }))
    await expect(invoke(harness, 'video-probe', {
      projectId: 'agent-demo',
      expectedRevision: 0,
      mediaHandleId: '/tmp/raw-video.mp4'
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(invoke(harness, 'video-render', {
      projectId: 'agent-demo',
      expectedRevision: 0,
      kind: 'h264-mp4',
      outputHandleId: '../output.mp4'
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(invoke(harness, 'video-update-timeline', {
      projectId: 'agent-demo',
      expectedRevision: 0,
      operations: [{ type: 'set-canvas', preset: '9:16', fit: 'pad', command: 'rm -rf .' }]
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await harness.dispose()
  })

  it('returns actionable unavailable results before picker or job admission when render capabilities are missing', async () => {
    const harness = await projectWithMedia()
    await invoke(harness, 'video-update-timeline', {
      projectId: 'agent-demo',
      expectedRevision: 1,
      operations: [{
        type: 'add-caption',
        caption: {
          id: 'caption-capability-check',
          trackId: 'captions-1',
          startFrame: 0,
          endFrame: 45,
          text: 'Capability preflight',
          placement: 'bottom'
        }
      }]
    })

    const cases = [
      {
        code: 'FFPROBE_UNAVAILABLE',
        name: 'ffprobe executable',
        kind: 'proof-frame' as const,
        captionMode: 'none' as const,
        ffprobeAvailable: false,
        ffmpegAvailable: true,
        features: ['libx264-encoder', 'aac-encoder', 'drawtext-filter']
      },
      {
        code: 'FFMPEG_UNAVAILABLE',
        name: 'FFmpeg executable',
        kind: 'proof-frame' as const,
        captionMode: 'none' as const,
        ffprobeAvailable: true,
        ffmpegAvailable: false,
        features: []
      },
      {
        code: 'LIBX264_ENCODER_UNAVAILABLE',
        name: 'libx264 encoder',
        kind: 'preview' as const,
        captionMode: 'none' as const,
        ffprobeAvailable: true,
        ffmpegAvailable: true,
        features: ['aac-encoder', 'drawtext-filter']
      },
      {
        code: 'AAC_ENCODER_UNAVAILABLE',
        name: 'AAC encoder',
        kind: 'audio-aac' as const,
        captionMode: 'none' as const,
        ffprobeAvailable: true,
        ffmpegAvailable: true,
        features: ['libx264-encoder', 'drawtext-filter']
      },
      {
        code: 'DRAWTEXT_FILTER_UNAVAILABLE',
        name: 'drawtext filter',
        kind: 'h264-mp4' as const,
        captionMode: 'burned' as const,
        ffprobeAvailable: true,
        ffmpegAvailable: true,
        features: ['libx264-encoder', 'aac-encoder']
      }
    ]
    const capabilityRequestsBefore = harness.transport.requests
      .filter(({ method }) => method === 'media.getCapabilities').length

    for (const testCase of cases) {
      harness.media.setCapabilities({
        probedAt: new Date().toISOString(),
        ffprobe: {
          name: 'ffprobe',
          available: testCase.ffprobeAvailable,
          features: []
        },
        ffmpeg: {
          name: 'ffmpeg',
          available: testCase.ffmpegAvailable,
          features: testCase.features
        }
      })
      const unavailable = await invoke(harness, 'video-render', {
        projectId: 'agent-demo',
        expectedRevision: 2,
        kind: testCase.kind,
        captionMode: testCase.captionMode
      })
      expect(unavailable.content).toMatchObject({
        outcome: 'unavailable',
        code: testCase.code,
        projectId: 'agent-demo',
        currentRevision: 2,
        changedIds: [],
        retryable: true,
        renderKind: testCase.kind,
        captionMode: testCase.captionMode
      })
      expect(String(contentObject(unavailable).message)).toContain(testCase.name)
      expect(String(contentObject(unavailable).message)).toContain('No output target was selected')
      expect(String(contentObject(unavailable).message)).toContain('no render job was started')
    }

    const requests = harness.transport.requests.map(({ method }) => method)
    expect(requests.filter((method) => method === 'media.getCapabilities'))
      .toHaveLength(capabilityRequestsBefore + cases.length)
    expect(requests).not.toContain('media.pickSaveTarget')
    expect(requests).not.toContain('media.startFfmpegJob')
    const loaded = await invoke(harness, 'video-project', {
      action: 'get', projectId: 'agent-demo'
    })
    expect(loaded.content).toMatchObject({ project: { currentRevision: 2 } })
    await harness.dispose()
  })

  it('returns a bounded unavailable result when render capability inspection itself fails', async () => {
    const harness = await projectWithMedia()
    harness.transport.handle('media.getCapabilities', () => {
      throw new Error('simulated capability inspection failure')
    })

    const unavailable = await invoke(harness, 'video-render', {
      projectId: 'agent-demo',
      expectedRevision: 1,
      kind: 'h264-mp4'
    })
    expect(unavailable.content).toMatchObject({
      outcome: 'unavailable',
      code: 'MEDIA_CAPABILITIES_UNAVAILABLE',
      projectId: 'agent-demo',
      currentRevision: 1,
      changedIds: [],
      retryable: true,
      renderKind: 'h264-mp4',
      captionMode: 'none',
      missingCapabilities: ['capability-inspection']
    })
    expect(String(contentObject(unavailable).message)).toContain('No output target was selected')
    const requests = harness.transport.requests.map(({ method }) => method)
    expect(requests).not.toContain('media.pickSaveTarget')
    expect(requests).not.toContain('media.startFfmpegJob')
    const loaded = await invoke(harness, 'video-project', {
      action: 'get', projectId: 'agent-demo'
    })
    expect(loaded.content).toMatchObject({ project: { currentRevision: 1 } })
    await harness.dispose()
  })

  it('cancels durable renders and fences late completion without publishing artifacts', async () => {
    const harness = await projectWithMedia()
    const outputHandle = 'fake_render_cancel_0001'
    harness.media.addHandle(mediaHandle(outputHandle, 'export', 'cancelled.mp4', 'video'))
    const render = await invoke(harness, 'video-render', {
      projectId: 'agent-demo',
      expectedRevision: 1,
      kind: 'h264-mp4',
      outputHandleId: outputHandle,
      idempotencyKey: 'cancel-test'
    })
    const jobId = String(contentObject(render).jobId)
    harness.jobs.start(jobId)
    const cancelled = await invoke(harness, 'video-render-cancel', {
      jobId, projectId: 'agent-demo', reason: 'User requested cancellation'
    })
    expect(cancelled.content).toMatchObject({ outcome: 'cancelled', technicallyValidated: false })
    expect(cancelled.generatedArtifacts).toBeUndefined()
    const artifact = artifactFor(harness, jobId, outputHandle, 'cancelled.mp4')
    expect(harness.jobs.complete(jobId, { schemaVersion: 1, generatedArtifacts: [artifact] }).state)
      .toBe('cancelled')
    const after = await invoke(harness, 'video-render-status', { jobId, projectId: 'agent-demo' })
    expect(after.generatedArtifacts).toBeUndefined()
    await harness.dispose()
  })

  it('keeps status read-only and refuses project-mismatched or untracked cancellation', async () => {
    const harness = await projectWithMedia()
    const outputHandle = 'fake_render_scope_guard_001'
    harness.media.addHandle(mediaHandle(outputHandle, 'export', 'scope-guard.mp4', 'video'))
    const render = await invoke(harness, 'video-render', {
      projectId: 'agent-demo',
      expectedRevision: 1,
      kind: 'h264-mp4',
      outputHandleId: outputHandle
    })
    const jobId = String(contentObject(render).jobId)
    harness.jobs.start(jobId)

    await expect(invoke(harness, 'video-render-status', {
      jobId,
      action: 'cancel'
    } as unknown as JsonObject)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(invoke(harness, 'video-render-status', {
      jobId,
      projectId: 'another-project'
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(invoke(harness, 'video-render-cancel', {
      jobId,
      projectId: 'another-project'
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(harness.jobs.get(jobId).state).toBe('running')

    harness.storage.workspace.set(`render-job:${jobId}`, {
      schemaVersion: 1,
      jobId,
      projectId: '../outside-workspace',
      pinnedRevision: 1,
      renderKind: 'h264-mp4',
      captionMode: 'none',
      subtitleFormat: 'srt',
      canvasPreset: '16:9',
      expectedArtifacts: [{ mediaKind: 'video', mimeType: 'video/mp4' }],
      createdAt: new Date().toISOString()
    })
    const untracked = await invoke(harness, 'video-render-status', { jobId })
    expect(untracked.content).toMatchObject({
      outcome: 'running',
      state: 'running',
      tracked: false,
      artifacts: []
    })
    expect(untracked.content).not.toHaveProperty('projectId')
    await expect(invoke(harness, 'video-render-cancel', { jobId }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(harness.jobs.get(jobId).state).toBe('running')
    await harness.dispose()
  })

  it('cancels an admitted render when its extension tracking record cannot be persisted', async () => {
    const harness = await projectWithMedia()
    const outputHandle = 'fake_render_tracking_fail_01'
    harness.media.addHandle(mediaHandle(outputHandle, 'export', 'tracking-failed.mp4', 'video'))
    harness.transport.handle('storage.set', () => {
      throw new Error('simulated extension storage failure')
    })

    const failure = await invoke(harness, 'video-render', {
      projectId: 'agent-demo',
      expectedRevision: 1,
      kind: 'h264-mp4',
      outputHandleId: outputHandle
    }).then(() => undefined, (error: unknown) => error)
    expect(failure).toMatchObject({
      code: 'INTERNAL_ERROR',
      retryable: false,
      details: {
        state: 'cancelled',
        cancellationAttempted: true,
        cancellationAccepted: true,
        trackingPersisted: false
      }
    })
    const details = (failure as { details: JsonObject }).details
    const jobId = String(details.jobId)
    expect((failure as Error).message).toContain(jobId)
    expect(harness.jobs.get(jobId).state).toBe('cancelled')
    expect(harness.storage.workspace.has(`render-job:${jobId}`)).toBe(false)

    const status = await invoke(harness, 'video-render-status', { jobId })
    expect(status.content).toMatchObject({ outcome: 'cancelled', jobId, technicallyValidated: false })
    await harness.dispose()
  })

  it('confirms a tracking write after an ambiguous Host acknowledgement without cancelling the job', async () => {
    const harness = await projectWithMedia()
    const outputHandle = 'fake_render_tracking_ack_001'
    harness.media.addHandle(mediaHandle(outputHandle, 'export', 'tracking-confirmed.mp4', 'video'))
    harness.transport.handle('storage.set', (params) => {
      const request = params as JsonObject
      harness.storage.workspace.set(String(request.key), request.value!)
      throw new Error('simulated lost storage acknowledgement')
    })

    const render = await invoke(harness, 'video-render', {
      projectId: 'agent-demo',
      expectedRevision: 1,
      kind: 'h264-mp4',
      outputHandleId: outputHandle
    })
    const jobId = String(contentObject(render).jobId)
    expect(render.content).toMatchObject({ outcome: 'queued', jobId })
    expect(harness.jobs.get(jobId).state).toBe('queued')
    expect(harness.jobs.get(jobId)).not.toHaveProperty('cancelRequestedAt')
    expect(harness.storage.workspace.get(`render-job:${jobId}`)).toMatchObject({ jobId })
    await harness.dispose()
  })

  it('recovers missing extension tracking from core artifact provenance without claiming visual review', async () => {
    const harness = await projectWithMedia()
    const outputHandle = 'fake_render_output_0001'
    harness.media.addHandle({
      ...mediaHandle(outputHandle, 'export', 'output.mp4', 'video'),
      byteSize: 8192,
      completionIdentity: 'render-complete-0001'
    })
    harness.media.setProbe(outputHandle, videoProbe(outputHandle))
    const render = await invoke(harness, 'video-render', {
      projectId: 'agent-demo', expectedRevision: 1, kind: 'h264-mp4', outputHandleId: outputHandle
    })
    const jobId = String(contentObject(render).jobId)
    harness.jobs.start(jobId)
    const artifact = artifactFor(harness, jobId, outputHandle, 'output.mp4')
    harness.jobs.complete(jobId, { schemaVersion: 1, generatedArtifacts: [artifact] })
    harness.storage.workspace.delete(`render-job:${jobId}`)
    const status = await invoke(harness, 'video-render-status', { jobId, projectId: 'agent-demo' })
    expect(status.content).toMatchObject({
      outcome: 'completed',
      tracked: true,
      projectId: 'agent-demo',
      technicallyValidated: true,
      proofStale: false,
      artifacts: [{ artifactId: artifact.artifactId }]
    })
    expect(status.generatedArtifacts).toEqual([artifact])
    expect(status.metadata).toEqual({
      machineValidatedOnly: true,
      visuallyInspected: false,
      proofStale: false,
      evidenceCurrent: true
    })
    expect(status.summary).toContain('No visual inspection is implied')
    expect(harness.storage.workspace.get(`render-job:${jobId}`)).toMatchObject({
      jobId,
      projectId: 'agent-demo',
      pinnedRevision: 1,
      renderKind: 'h264-mp4'
    })

    const replay = await invoke(harness, 'video-render-status', { jobId, projectId: 'agent-demo' })
    expect(replay.generatedArtifacts).toEqual(status.generatedArtifacts)
    expect(replay.content).toEqual(status.content)

    const recoveredRecord = harness.storage.workspace.get(`render-job:${jobId}`) as JsonObject
    harness.storage.workspace.set(`render-job:${jobId}`, {
      ...recoveredRecord,
      projectId: 'wrong-project'
    })
    const corrected = await invoke(harness, 'video-render-status', {
      jobId,
      projectId: 'agent-demo'
    })
    expect(corrected.content).toMatchObject({
      outcome: 'completed', tracked: true, projectId: 'agent-demo', technicallyValidated: true
    })
    expect(harness.storage.workspace.get(`render-job:${jobId}`)).toMatchObject({
      projectId: 'agent-demo'
    })
    await harness.dispose()
  })

})
