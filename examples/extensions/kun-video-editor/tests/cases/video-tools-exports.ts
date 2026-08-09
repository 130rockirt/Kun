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
  createSafeSuffix,
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
  it('keeps technical validation but withdraws stale artifacts as current visual evidence', async () => {
    const harness = await projectWithMedia()
    const outputHandle = 'fake_render_stale_proof_001'
    harness.media.addHandle({
      ...mediaHandle(outputHandle, 'export', 'stale-proof.mp4', 'video'),
      byteSize: 8192,
      completionIdentity: 'render-complete-0001'
    })
    harness.media.setProbe(outputHandle, videoProbe(outputHandle))
    const render = await invoke(harness, 'video-render', {
      projectId: 'agent-demo', expectedRevision: 1, kind: 'h264-mp4', outputHandleId: outputHandle
    })
    const jobId = String(contentObject(render).jobId)
    harness.jobs.start(jobId)
    const artifact = artifactFor(harness, jobId, outputHandle, 'stale-proof.mp4')
    harness.jobs.complete(jobId, { schemaVersion: 1, generatedArtifacts: [artifact] })

    await invoke(harness, 'video-update-timeline', {
      projectId: 'agent-demo',
      expectedRevision: 1,
      operations: [{ type: 'set-canvas', preset: '9:16', fit: 'pad' }]
    })
    const status = await invoke(harness, 'video-render-status', { jobId, projectId: 'agent-demo' })
    expect(status.content).toMatchObject({
      outcome: 'completed',
      pinnedRevision: 1,
      currentRevision: 2,
      proofStale: true,
      technicallyValidated: true,
      visualInspection: 'not-performed',
      evidenceCurrent: false
    })
    expect(status.generatedArtifacts).toBeUndefined()
    expect(status.metadata).toMatchObject({
      machineValidatedOnly: true,
      visuallyInspected: false,
      proofStale: true,
      evidenceCurrent: false
    })
    expect(status.summary).toContain('proof is stale')
    await harness.dispose()
  })

  it('submits burned captions as a bounded drawtext filter without generated file inputs', async () => {
    const harness = await projectWithMedia()
    await invoke(harness, 'video-update-timeline', {
      projectId: 'agent-demo',
      expectedRevision: 1,
      operations: [{
        type: 'add-caption',
        caption: {
          id: 'caption-main',
          trackId: 'captions-1',
          startFrame: 5,
          endFrame: 60,
          text: "Crime d'Amour: [x], y; \\ %",
          placement: 'bottom',
          style: { fontSize: 42, color: '#F0F0F0', background: '#101010' }
        }
      }]
    })
    const outputHandle = 'fake_render_burned_0001'
    harness.media.addHandle(mediaHandle(outputHandle, 'export', 'burned.mp4', 'video'))

    await invoke(harness, 'video-render', {
      projectId: 'agent-demo',
      expectedRevision: 2,
      kind: 'h264-mp4',
      outputHandleId: outputHandle,
      captionMode: 'burned'
    })

    const request = harness.transport.requests
      .filter(({ method }) => method === 'media.startFfmpegJob')
      .at(-1)
    expect(request?.params).toMatchObject({
      inputs: { 'clip-0': 'fake_media_source_0001' },
      outputs: { video: outputHandle },
      metadata: { pinnedRevision: 2, captionMode: 'burned' }
    })
    const argumentsValue = (request?.params as JsonObject | undefined)?.arguments
    expect(Array.isArray(argumentsValue)).toBe(true)
    const filterGraph = (argumentsValue as unknown[])[
      (argumentsValue as unknown[]).indexOf('-filter_complex') + 1
    ]
    expect(filterGraph).toEqual(expect.stringContaining('drawtext='))
    expect(filterGraph).toEqual(expect.stringContaining('expansion=none'))
    expect(filterGraph).not.toEqual(expect.stringContaining('fontfile='))
    expect(filterGraph).not.toEqual(expect.stringContaining('textfile='))
    expect(JSON.stringify(request?.params)).not.toContain('generated-text')

    const proofOutput = 'fake_render_burned_proof_01'
    harness.media.addHandle(mediaHandle(proofOutput, 'export', 'burned-proof.png', 'image'))
    await invoke(harness, 'video-render', {
      projectId: 'agent-demo',
      expectedRevision: 2,
      kind: 'proof-frame',
      outputHandleId: proofOutput,
      captionMode: 'burned',
      proofFrame: 5
    })
    const proofRequest = harness.transport.requests
      .filter(({ method }) => method === 'media.startFfmpegJob')
      .at(-1)?.params as JsonObject
    expect(proofRequest.metadata).toMatchObject({
      pinnedRevision: 2,
      renderKind: 'proof-frame',
      captionMode: 'burned',
      proofFrame: 5
    })
    expect(JSON.stringify(proofRequest.arguments)).toContain('drawtext=')
    expect(JSON.stringify(proofRequest.arguments)).toContain('trim=start_frame=5:end_frame=6')
    await harness.dispose()
  })

  it('publishes burned video and deterministic SRT sidecar artifacts from one durable job', async () => {
    const harness = await projectWithMedia()
    await invoke(harness, 'video-update-timeline', {
      projectId: 'agent-demo',
      expectedRevision: 1,
      operations: [{
        type: 'add-caption',
        caption: {
          id: 'caption-sidecar',
          trackId: 'captions-1',
          startFrame: 0,
          endFrame: 45,
          text: 'A deterministic caption',
          placement: 'bottom'
        }
      }]
    })
    const videoTarget = 'fake_render_both_video_0001'
    const subtitleTarget = 'fake_render_both_sub_00001'
    harness.media.addHandle(mediaHandle(videoTarget, 'export', 'both.mp4', 'video'))
    harness.media.addHandle(mediaHandle(subtitleTarget, 'export', 'both.srt', 'subtitle'))

    const render = await invoke(harness, 'video-render', {
      projectId: 'agent-demo',
      expectedRevision: 2,
      kind: 'h264-mp4',
      outputHandleId: videoTarget,
      captionMode: 'both',
      subtitleOutputHandleId: subtitleTarget,
      subtitleFormat: 'srt'
    })
    const jobId = String(contentObject(render).jobId)
    const request = harness.transport.requests
      .filter(({ method }) => method === 'media.startFfmpegJob')
      .at(-1)?.params as JsonObject
    expect(request.textOutputs).toMatchObject({
      'sidecar-captions': {
        handleId: subtitleTarget,
        mimeType: 'application/x-subrip'
      }
    })
    expect(JSON.stringify(request.textOutputs)).toContain('00:00:00,000 --> 00:00:01,500')

    const generatedVideo = 'fake_generated_video_00001'
    const generatedSubtitle = 'fake_generated_subtitle_001'
    harness.media.addHandle({
      ...mediaHandle(generatedVideo, 'read', 'both.mp4', 'video'),
      byteSize: 16_384,
      completionIdentity: 'both-video-complete'
    })
    harness.media.addHandle({
      ...mediaHandle(generatedSubtitle, 'read', 'both.srt', 'subtitle'),
      byteSize: 96,
      completionIdentity: 'both-subtitle-complete'
    })
    harness.media.setProbe(generatedVideo, videoProbe(generatedVideo))
    harness.media.setProbe(generatedSubtitle, subtitleProbe(generatedSubtitle))
    harness.jobs.start(jobId)
    const videoArtifact = createGeneratedArtifactFixture({
      artifactId: `artifact_${createSafeSuffix(jobId)}_video`,
      ownerExtensionId: harness.identity.id,
      ownerExtensionVersion: harness.identity.version,
      workspaceId: harness.context.workspaceContext!.id,
      mediaHandleId: generatedVideo,
      displayName: 'both.mp4',
      mediaKind: 'video',
      mimeType: 'video/mp4',
      byteSize: 16_384,
      completionIdentity: 'both-video-complete',
      provenance: {
        jobId,
        operation: 'media.startFfmpegJob',
        metadata: request.metadata as JsonObject
      }
    })
    const subtitleArtifact = createGeneratedArtifactFixture({
      artifactId: `artifact_${createSafeSuffix(jobId)}_subtitle`,
      ownerExtensionId: harness.identity.id,
      ownerExtensionVersion: harness.identity.version,
      workspaceId: harness.context.workspaceContext!.id,
      mediaHandleId: generatedSubtitle,
      displayName: 'both.srt',
      mediaKind: 'subtitle',
      mimeType: 'application/x-subrip',
      byteSize: 96,
      completionIdentity: 'both-subtitle-complete',
      provenance: {
        jobId,
        operation: 'media.startFfmpegJob',
        metadata: request.metadata as JsonObject
      }
    })
    harness.jobs.complete(jobId, {
      schemaVersion: 1,
      generatedArtifacts: [videoArtifact, subtitleArtifact]
    })
    harness.storage.workspace.delete(`render-job:${jobId}`)

    const status = await invoke(harness, 'video-render-status', { jobId, projectId: 'agent-demo' })
    expect(status.content).toMatchObject({
      outcome: 'completed',
      tracked: true,
      projectId: 'agent-demo',
      technicallyValidated: true,
      artifacts: [
        { artifactId: videoArtifact.artifactId },
        { artifactId: subtitleArtifact.artifactId }
      ]
    })
    expect(status.generatedArtifacts).toHaveLength(2)
    expect(harness.storage.workspace.get(`render-job:${jobId}`)).toMatchObject({
      expectedArtifacts: [
        { mediaKind: 'subtitle', mimeType: 'application/x-subrip' },
        { mediaKind: 'video', mimeType: 'video/mp4' }
      ]
    })
    await harness.dispose()
  })

  it('releases a Host-selected primary export handle when sidecar target selection is cancelled', async () => {
    const harness = await projectWithMedia()
    await invoke(harness, 'video-update-timeline', {
      projectId: 'agent-demo',
      expectedRevision: 1,
      operations: [{
        type: 'add-caption',
        caption: {
          id: 'caption-cancel-sidecar',
          trackId: 'captions-1',
          startFrame: 0,
          endFrame: 30,
          text: 'Keep the first target bounded',
          placement: 'bottom'
        }
      }]
    })
    const primaryTarget = 'fake_render_cancel_sidecar_001'
    harness.media.queueSaveTarget(mediaHandle(primaryTarget, 'export', 'cancelled-sidecar.mp4', 'video'))
    harness.media.queueSaveTarget()

    const response = await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'render.start',
      payload: {
        projectId: 'agent-demo',
        expectedRevision: 2,
        kind: 'h264-mp4',
        captionMode: 'sidecar',
        subtitleFormat: 'srt'
      }
    })

    expect(contentObject(response)).toMatchObject({ outcome: 'cancelled', code: 'MEDIA_CANCELLED' })
    expect(harness.media.handles.get(primaryTarget)?.revoked).toBe(true)
    expect(harness.transport.requests.map(({ method }) => method)).not.toContain('media.startFfmpegJob')
    await harness.dispose()
  })

  it('exports standalone WebVTT through a text-only durable job and validates its artifact', async () => {
    const harness = await projectWithMedia()
    await invoke(harness, 'video-update-timeline', {
      projectId: 'agent-demo',
      expectedRevision: 1,
      operations: [{
        type: 'add-caption',
        caption: {
          id: 'caption-standalone',
          trackId: 'captions-1',
          startFrame: 0,
          endFrame: 45,
          text: 'Standalone caption',
          placement: 'bottom'
        }
      }]
    })
    const target = 'fake_standalone_vtt_00001'
    harness.media.addHandle({
      ...mediaHandle(target, 'export', 'captions.vtt', 'subtitle'),
      mimeType: 'text/vtt'
    })
    const capabilityRequestsBefore = harness.transport.requests
      .filter(({ method }) => method === 'media.getCapabilities').length
    harness.media.executablesAvailable = false
    const render = await invoke(harness, 'video-render', {
      projectId: 'agent-demo',
      expectedRevision: 2,
      kind: 'subtitles',
      outputHandleId: target,
      subtitleFormat: 'vtt'
    })
    const jobId = String(contentObject(render).jobId)
    const request = harness.transport.requests
      .filter(({ method }) => method === 'media.startFfmpegJob')
      .at(-1)?.params as JsonObject
    expect(request).toMatchObject({
      arguments: [],
      inputs: {},
      outputs: {},
      metadata: {
        projectId: 'agent-demo',
        pinnedRevision: 2,
        renderKind: 'subtitles',
        captionMode: 'none',
        subtitleFormat: 'vtt'
      },
      textOutputs: {
        subtitles: { handleId: target, mimeType: 'text/vtt' }
      }
    })
    expect(JSON.stringify(request.textOutputs)).toContain('WEBVTT')
    expect(harness.transport.requests.filter(({ method }) => method === 'media.getCapabilities'))
      .toHaveLength(capabilityRequestsBefore)
    harness.media.executablesAvailable = true

    const generated = 'fake_generated_vtt_000001'
    harness.media.addHandle({
      ...mediaHandle(generated, 'read', 'captions.vtt', 'subtitle'),
      mimeType: 'text/vtt',
      byteSize: 96,
      completionIdentity: 'standalone-vtt-complete'
    })
    harness.media.setProbe(generated, subtitleProbe(generated))
    harness.jobs.start(jobId)
    const artifact = createGeneratedArtifactFixture({
      artifactId: `artifact_${createSafeSuffix(jobId)}_vtt`,
      ownerExtensionId: harness.identity.id,
      ownerExtensionVersion: harness.identity.version,
      workspaceId: harness.context.workspaceContext!.id,
      mediaHandleId: generated,
      displayName: 'captions.vtt',
      mediaKind: 'subtitle',
      mimeType: 'text/vtt',
      byteSize: 96,
      completionIdentity: 'standalone-vtt-complete',
      provenance: {
        jobId,
        operation: 'media.startFfmpegJob',
        metadata: request.metadata as JsonObject
      }
    })
    harness.jobs.complete(jobId, { schemaVersion: 1, generatedArtifacts: [artifact] })
    const status = await invoke(harness, 'video-render-status', { jobId, projectId: 'agent-demo' })
    expect(status.content).toMatchObject({
      outcome: 'completed', renderKind: 'subtitles', technicallyValidated: true
    })
    expect(status.generatedArtifacts).toEqual([expect.objectContaining({ artifactId: artifact.artifactId })])
    await harness.dispose()
  })

  it('preflights, queues, observes, and cancels atomic self-contained project packages', async () => {
    const harness = await projectWithMedia()
    const preflight = await invoke(harness, 'video-project-package', {
      action: 'preflight',
      projectId: 'agent-demo',
      expectedRevision: 1,
      missingMediaPolicy: 'fail',
      includeReceipts: true,
      includeChatProvenance: true
    })
    expect(preflight.content).toMatchObject({
      outcome: 'preflight',
      projectId: 'agent-demo',
      pinnedRevision: 1,
      complete: true,
      selectedAssetCount: 1,
      embeddedAssetCount: 1,
      uniqueMediaCount: 1,
      executable: true,
      provenance: { chatCount: 0, chatScope: 'not-requested' }
    })

    const outputHandleId = 'fake_package_output_0001'
    harness.media.addHandle({
      handleId: outputHandleId,
      mode: 'export',
      kind: 'data',
      displayName: 'agent-demo.kun-video.zip',
      mimeType: 'application/zip'
    })
    const queued = await invoke(harness, 'video-project-package', {
      action: 'export',
      projectId: 'agent-demo',
      expectedRevision: 1,
      missingMediaPolicy: 'fail',
      outputHandleId
    })
    expect(queued.content).toMatchObject({
      outcome: 'queued',
      job: {
        kind: 'media.archive',
        state: 'queued',
        projectId: 'agent-demo',
        pinnedRevision: 1,
        complete: true
      }
    })
    const jobId = String((contentObject(queued).job as JsonObject).jobId)
    const request = harness.transport.requests.find(({ method, params }) =>
      method === 'media.startArchiveJob' &&
      (params as JsonObject).outputHandleId === outputHandleId)
    expect(request?.params).toMatchObject({
      format: 'zip',
      outputHandleId,
      idempotencyKey: expect.stringMatching(/^project-package:[a-f0-9]{64}$/u),
      entries: expect.arrayContaining([
        expect.objectContaining({ archivePath: 'manifest/package.json', kind: 'inline-text' }),
        expect.objectContaining({ archivePath: 'project/project.json', kind: 'inline-text' }),
        expect.objectContaining({ kind: 'media', inputHandleId: 'fake_media_source_0001' })
      ])
    })
    expect(JSON.stringify((request?.params as JsonObject).entries))
      .not.toContain(harness.context.workspaceContext!.root)

    expect((await invoke(harness, 'video-project-package-status', {
      projectId: 'agent-demo', jobId
    })).content).toMatchObject({ outcome: 'status', job: { state: 'queued' } })
    harness.jobs.start(jobId)
    harness.jobs.complete(jobId, {
      schemaVersion: 1,
      data: {
        schemaVersion: 1,
        format: 'zip',
        entryCount: 7,
        inputBytes: 4096,
        archiveBytes: 8192,
        sha256: 'b'.repeat(64),
        generatedMedia: {
          handleId: 'fake_package_generated_0001',
          mode: 'read',
          kind: 'data',
          displayName: 'agent-demo.kun-video.zip',
          mimeType: 'application/zip',
          byteSize: 8192,
          completionIdentity: 'package-completion-1',
          revoked: false
        }
      }
    })
    expect((await invoke(harness, 'video-project-package-status', {
      projectId: 'agent-demo', jobId
    })).content).toMatchObject({
      outcome: 'status',
      job: {
        state: 'completed',
        result: {
          format: 'zip',
          sha256: 'b'.repeat(64),
          generatedMedia: { handleId: 'fake_package_generated_0001' }
        }
      }
    })

    const cancelOutput = 'fake_package_output_cancel_1'
    harness.media.addHandle({
      handleId: cancelOutput,
      mode: 'export',
      kind: 'data',
      displayName: 'cancelled.kun-video.zip',
      mimeType: 'application/zip'
    })
    const second = await invoke(harness, 'video-project-package', {
      action: 'export',
      projectId: 'agent-demo',
      expectedRevision: 1,
      missingMediaPolicy: 'fail',
      outputHandleId: cancelOutput
    })
    const secondJobId = String((contentObject(second).job as JsonObject).jobId)
    expect((await invoke(harness, 'video-project-package-cancel', {
      projectId: 'agent-demo', jobId: secondJobId
    })).content).toMatchObject({
      outcome: 'cancellation-requested',
      accepted: true,
      job: { state: 'cancelled' }
    })
    await harness.dispose()
  })
})
