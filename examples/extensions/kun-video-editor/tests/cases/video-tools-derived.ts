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
  it('runs, reconciles, reports, and cleans sidebar-derived media without exposing paths', async () => {
    const harness = await projectWithMedia()
    const outputHandle = 'fake_derived_waveform_0001'
    harness.media.addHandle(mediaHandle(outputHandle, 'export', 'waveform.png', 'image'))
    const started = await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'derived.start',
      payload: {
        projectId: 'agent-demo',
        expectedRevision: 1,
        assetId: 'interview',
        kind: 'waveform',
        outputHandleId: outputHandle,
        priority: 'interactive',
        parameters: { width: 1200, height: 240 }
      }
    })
    expect(started.content).toMatchObject({
      outcome: 'queued',
      projectId: 'agent-demo',
      currentRevision: 1,
      record: {
        kind: 'waveform',
        status: 'running',
        generation: expect.any(Number),
        statusGeneration: expect.any(Number)
      },
      jobId: expect.any(String)
    })
    const startedContent = contentObject(started)
    const record = startedContent.record as JsonObject
    const jobId = String(startedContent.jobId)
    const request = harness.transport.requests
      .filter(({ method }) => method === 'media.startFfmpegJob')
      .at(-1)?.params as JsonObject
    const partialOutputHandle = String((request.outputs as JsonObject).derived)
    expect(request).toMatchObject({
      inputs: { source: 'fake_media_source_0001' },
      outputs: { derived: expect.stringMatching(/^fake_cache_target_/u) },
      metadata: {
        derivedId: record.id,
        dedupeKey: expect.any(String),
        derivedKind: 'waveform',
        priority: 'interactive',
        derivedPhase: 'partial',
        derivedPhaseIndex: 0,
        derivedPhaseCount: 2
      }
    })
    expect(request.arguments).toEqual(expect.arrayContaining(['{{input:source}}', '{{output:derived}}']))
    expect(JSON.stringify(request)).not.toContain(harness.context.workspaceContext!.root)

    harness.jobs.start(jobId)
    const partialArtifactHandle = 'fake_derived_wave_partial_01'
    harness.media.addHandle({
      ...mediaHandle(partialArtifactHandle, 'read', 'waveform-partial.png', 'image'),
      byteSize: 1024,
      completionIdentity: 'derived-waveform-partial'
    })
    const partialArtifact = createGeneratedArtifactFixture({
      artifactId: `artifact_derived_${createSafeSuffix(jobId)}`,
      ownerExtensionId: harness.identity.id,
      ownerExtensionVersion: harness.identity.version,
      workspaceId: harness.context.workspaceContext!.id,
      mediaHandleId: partialArtifactHandle,
      displayName: 'waveform-partial.png',
      mediaKind: 'image',
      mimeType: 'image/png',
      byteSize: 1024,
      completionIdentity: 'derived-waveform-partial',
      provenance: {
        jobId,
        operation: 'media.startFfmpegJob',
        metadata: request.metadata as JsonObject
      }
    })
    harness.jobs.complete(jobId, { schemaVersion: 1, generatedArtifacts: [partialArtifact] })
    const competingExport = harness.jobs.create('media.ffmpeg', 'media.startFfmpegJob')
    harness.jobs.start(competingExport.id)

    const partialListed = await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'derived.list',
      payload: { projectId: 'agent-demo' }
    })
    expect(partialListed.content).toMatchObject({
      outcome: 'listed',
      records: [{
        id: record.id,
        kind: 'waveform',
        status: 'partial',
        artifactHandleId: partialArtifactHandle,
        progress: { completed: 1, total: 2, unit: 'phase' },
        jobId: null
      }]
    })
    expect(harness.transport.requests.filter(({ method }) => method === 'media.startFfmpegJob'))
      .toHaveLength(1)

    harness.jobs.complete(competingExport.id)
    const resumed = await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'derived.list',
      payload: { projectId: 'agent-demo' }
    })
    expect(resumed.content).toMatchObject({
      records: [{
        id: record.id,
        status: 'partial',
        artifactHandleId: partialArtifactHandle,
        jobId: expect.any(String)
      }]
    })
    const finalRequest = harness.transport.requests
      .filter(({ method }) => method === 'media.startFfmpegJob')
      .at(-1)?.params as JsonObject
    expect(finalRequest).toMatchObject({
      outputs: { derived: outputHandle },
      metadata: {
        derivedId: record.id,
        derivedPhase: 'final',
        derivedPhaseIndex: 1,
        derivedPhaseCount: 2
      }
    })
    const finalJobId = String((contentObject(resumed).records as JsonObject[])[0]!.jobId)
    harness.jobs.start(finalJobId)
    harness.media.addHandle({
      ...mediaHandle(outputHandle, 'read', 'waveform.png', 'image'),
      byteSize: 4096,
      completionIdentity: 'derived-waveform-complete'
    })
    const artifact = createGeneratedArtifactFixture({
      artifactId: `artifact_derived_${createSafeSuffix(finalJobId)}`,
      ownerExtensionId: harness.identity.id,
      ownerExtensionVersion: harness.identity.version,
      workspaceId: harness.context.workspaceContext!.id,
      mediaHandleId: outputHandle,
      displayName: 'waveform.png',
      mediaKind: 'image',
      mimeType: 'image/png',
      byteSize: 4096,
      completionIdentity: 'derived-waveform-complete',
      provenance: {
        jobId: finalJobId,
        operation: 'media.startFfmpegJob',
        metadata: finalRequest.metadata as JsonObject
      }
    })
    harness.jobs.complete(finalJobId, { schemaVersion: 1, generatedArtifacts: [artifact] })

    const listed = await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'derived.list',
      payload: { projectId: 'agent-demo' }
    })
    expect(listed.content).toMatchObject({
      outcome: 'listed',
      records: [{
        id: record.id,
        kind: 'waveform',
        status: 'ready',
        artifactHandleId: outputHandle,
        bytes: 4096,
        generation: expect.any(Number),
        statusGeneration: expect.any(Number)
      }],
      usage: { usedBytes: 4096, readyBytes: 4096, recordCount: 1 }
    })
    const ready = (contentObject(listed).records as JsonObject[])[0]!
    expect(ready.artifactHandleId).toBe(outputHandle)
    expect(JSON.stringify(ready)).not.toContain(harness.context.workspaceContext!.root)
    expect(Number(ready.generation)).toBeGreaterThan(Number(record.generation))
    expect(ready.statusGeneration).toBe(ready.generation)
    expect(harness.webview.messages).toContainEqual({
      channel: 'kun-video-editor.derived-changed',
      payload: expect.objectContaining({
        projectId: 'agent-demo',
        generation: ready.generation,
        statusGeneration: ready.statusGeneration,
        reason: 'ready'
      })
    })

    const cleaned = await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'derived.cleanup',
      payload: { projectId: 'agent-demo', includeReady: true }
    })
    expect(cleaned.content).toMatchObject({
      outcome: 'cleaned',
      removedIds: [record.id],
      usage: { usedBytes: 0, recordCount: 0 }
    })
    expect(harness.media.handles.get(outputHandle)?.revoked).toBe(true)
    await harness.dispose()
  })

  it('yields derived work to active exports, deduplicates it, resumes it, and cancels durably', async () => {
    const harness = await projectWithMedia()
    const exportJob = harness.jobs.create('media.ffmpeg', 'media.startFfmpegJob')
    harness.jobs.start(exportJob.id)
    const requestCount = () => harness.transport.requests
      .filter(({ method }) => method === 'media.startFfmpegJob').length
    const startCount = requestCount()
    const payload = {
      projectId: 'agent-demo',
      expectedRevision: 1,
      assetId: 'interview',
      kind: 'filmstrip',
      priority: 'background',
      parameters: { width: 960, filmstripIntervalUs: 1_000_000 }
    }
    const queued = await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'derived.start', payload
    })
    const queuedRecord = contentObject(queued).record as JsonObject
    expect(queued.content).toMatchObject({
      outcome: 'queued',
      jobId: null,
      record: { kind: 'filmstrip', status: 'queued', jobId: null }
    })
    expect(requestCount()).toBe(startCount)

    const duplicate = await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'derived.start', payload
    })
    expect(duplicate.content).toMatchObject({
      outcome: 'deduplicated',
      jobId: null,
      record: { id: queuedRecord.id, status: 'queued' }
    })
    expect(requestCount()).toBe(startCount)

    harness.jobs.complete(exportJob.id)
    const resumed = await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'derived.list', payload: { projectId: 'agent-demo' }
    })
    const resumedRecord = (contentObject(resumed).records as JsonObject[])[0]!
    expect(resumedRecord).toMatchObject({
      id: queuedRecord.id,
      status: 'running',
      jobId: expect.any(String)
    })
    expect(requestCount()).toBe(startCount + 1)

    const cancelled = await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'derived.cancel',
      payload: { projectId: 'agent-demo', recordId: queuedRecord.id }
    })
    expect(cancelled.content).toMatchObject({
      outcome: 'cancelled',
      record: { id: queuedRecord.id, status: 'cancelled', artifactHandleId: null }
    })
    expect(harness.jobs.get(String(resumedRecord.jobId)).state).toBe('cancelled')
    const cacheTargets = [...harness.media.handles.values()]
      .filter(({ handleId }) => handleId.startsWith('fake_cache_target_'))
    expect(cacheTargets).toHaveLength(2)
    expect(cacheTargets.every(({ revoked }) => revoked)).toBe(true)
    expect(harness.storage.workspace.has(`derived-media:output:${String(queuedRecord.id)}`)).toBe(false)
    await harness.dispose()
  })

  it('reconciles an in-flight Host cache job after service restart and publishes the final artifact', async () => {
    const harness = await projectWithMedia()
    const started = await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'derived.start',
      payload: {
        projectId: 'agent-demo', expectedRevision: 1, assetId: 'interview', kind: 'thumbnail'
      }
    })
    const startedContent = contentObject(started)
    const record = startedContent.record as JsonObject
    const jobId = String(startedContent.jobId)
    const request = harness.transport.requests
      .filter(({ method }) => method === 'media.startFfmpegJob')
      .at(-1)?.params as JsonObject
    const outputHandle = String((request.outputs as JsonObject).derived)
    expect(outputHandle).toMatch(/^fake_cache_target_/u)

    const restarted = new DerivedMediaService(harness.context)
    await expect(restarted.list('agent-demo')).resolves.toMatchObject({
      records: [{ id: record.id, status: 'running', jobId }]
    })

    harness.jobs.start(jobId)
    const artifact = imageDerivedArtifact(harness, {
      jobId,
      handleId: outputHandle,
      displayName: 'thumbnail.png',
      byteSize: 2048,
      metadata: request.metadata as JsonObject
    })
    harness.jobs.complete(jobId, { schemaVersion: 1, generatedArtifacts: [artifact] })
    const listed = await restarted.list('agent-demo')
    expect(listed).toMatchObject({
      records: [{
        id: record.id,
        kind: 'thumbnail',
        status: 'ready',
        artifactHandleId: outputHandle,
        bytes: 2048
      }]
    })
    expect(harness.storage.workspace.has(`derived-media:output:${String(record.id)}`)).toBe(false)
    await restarted.cleanup('agent-demo', true)
    expect(harness.media.handles.get(outputHandle)?.revoked).toBe(true)
    await harness.dispose()
  })

  it('rejects a mismatched derived phase and applies bounded retry backoff without reallocating cache', async () => {
    const harness = await projectWithMedia()
    const payload = {
      projectId: 'agent-demo', expectedRevision: 1, assetId: 'interview', kind: 'thumbnail'
    }
    const started = await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'derived.start', payload
    })
    const startedContent = contentObject(started)
    const record = startedContent.record as JsonObject
    const jobId = String(startedContent.jobId)
    const request = harness.transport.requests
      .filter(({ method }) => method === 'media.startFfmpegJob')
      .at(-1)?.params as JsonObject
    const outputHandle = String((request.outputs as JsonObject).derived)
    harness.jobs.start(jobId)
    const artifact = imageDerivedArtifact(harness, {
      jobId,
      handleId: outputHandle,
      displayName: 'thumbnail.png',
      byteSize: 1024,
      metadata: { ...(request.metadata as JsonObject), derivedPhase: 'partial' }
    })
    harness.jobs.complete(jobId, { schemaVersion: 1, generatedArtifacts: [artifact] })

    const failed = await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'derived.list', payload: { projectId: 'agent-demo' }
    })
    expect(failed.content).toMatchObject({
      records: [{
        id: record.id,
        status: 'failed',
        error: { code: 'invalid_output', retryable: true },
        retryAfter: expect.any(String),
        artifactHandleId: null
      }]
    })
    expect(harness.media.handles.get(outputHandle)?.revoked).toBe(true)
    expect(harness.storage.workspace.has(`derived-media:output:${String(record.id)}`)).toBe(false)
    const cacheAllocations = harness.transport.requests
      .filter(({ method }) => method === 'media.createCacheTarget').length
    const jobStarts = harness.transport.requests
      .filter(({ method }) => method === 'media.startFfmpegJob').length

    const backedOff = await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'derived.start', payload
    })
    expect(backedOff.content).toMatchObject({
      outcome: 'backoff',
      jobId: jobId,
      record: { id: record.id, status: 'failed', retryAfter: expect.any(String) }
    })
    expect(harness.transport.requests.filter(({ method }) => method === 'media.createCacheTarget'))
      .toHaveLength(cacheAllocations)
    expect(harness.transport.requests.filter(({ method }) => method === 'media.startFfmpegJob'))
      .toHaveLength(jobStarts)
    await harness.dispose()
  })

  it('fails oversized derived results at the cache quota and releases their Host cache grant', async () => {
    const harness = await projectWithMedia()
    const started = await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'derived.start',
      payload: {
        projectId: 'agent-demo', expectedRevision: 1, assetId: 'interview', kind: 'thumbnail',
        parameters: { seekUs: 1_000_000 }
      }
    })
    const startedContent = contentObject(started)
    const record = startedContent.record as JsonObject
    const jobId = String(startedContent.jobId)
    const request = harness.transport.requests
      .filter(({ method }) => method === 'media.startFfmpegJob')
      .at(-1)?.params as JsonObject
    const outputHandle = String((request.outputs as JsonObject).derived)
    harness.jobs.start(jobId)
    const artifact = imageDerivedArtifact(harness, {
      jobId,
      handleId: outputHandle,
      displayName: 'oversized-thumbnail.png',
      byteSize: 2 * 1024 * 1024 * 1024 + 1,
      metadata: request.metadata as JsonObject
    })
    harness.jobs.complete(jobId, { schemaVersion: 1, generatedArtifacts: [artifact] })

    const listed = await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'derived.list', payload: { projectId: 'agent-demo' }
    })
    expect(listed.content).toMatchObject({
      records: [{
        id: record.id,
        status: 'failed',
        bytes: 0,
        error: { code: 'cache_quota', retryable: false },
        artifactHandleId: null
      }],
      usage: { usedBytes: 0, readyBytes: 0 }
    })
    expect(harness.media.handles.get(outputHandle)?.revoked).toBe(true)
    expect(harness.storage.workspace.has(`derived-media:output:${String(record.id)}`)).toBe(false)
    await harness.dispose()
  })

  it('returns an actionable ffprobe-unavailable outcome before selecting media or mutating a project', async () => {
    const harness = await activatedHarness()
    await invoke(harness, 'video-project', {
      action: 'create', projectId: 'agent-demo', name: 'Agent Demo'
    })
    harness.media.setCapabilities({
      probedAt: new Date().toISOString(),
      ffprobe: { name: 'ffprobe', available: false, features: [] },
      ffmpeg: {
        name: 'ffmpeg',
        available: true,
        features: ['libx264-encoder', 'aac-encoder', 'drawtext-filter']
      }
    })

    const unavailable = await invoke(harness, 'video-probe', {
      projectId: 'agent-demo', expectedRevision: 0
    })
    expect(unavailable.content).toMatchObject({
      outcome: 'unavailable',
      code: 'FFPROBE_UNAVAILABLE',
      projectId: 'agent-demo',
      currentRevision: 0,
      changedIds: [],
      retryable: true
    })
    expect(String(contentObject(unavailable).message)).toContain('Install or configure ffprobe')
    expect(JSON.stringify(unavailable)).not.toContain(harness.context.workspaceContext!.root)

    const loaded = await invoke(harness, 'video-project', {
      action: 'get', projectId: 'agent-demo'
    })
    expect(loaded.content).toMatchObject({
      project: { currentRevision: 0, counts: { assets: 0, items: 0 } }
    })
    const mediaRequests = harness.transport.requests.map(({ method }) => method)
    expect(mediaRequests.filter((method) => method === 'media.getCapabilities')).toHaveLength(1)
    expect(mediaRequests).not.toContain('media.pickFiles')
    expect(mediaRequests).not.toContain('media.probe')
    await harness.dispose()
  })

  it('keeps project.get pure and makes create/select the explicit active-project transitions', async () => {
    const harness = await activatedHarness()
    await invoke(harness, 'video-project', {
      action: 'create', projectId: 'project-one', name: 'Project One'
    })
    await invoke(harness, 'video-project', {
      action: 'create', projectId: 'project-two', name: 'Project Two'
    })

    const beforeRead = await invoke(harness, 'video-project', { action: 'active' })
    expect(beforeRead.content).toMatchObject({ project: { id: 'project-two' } })
    const read = await invoke(harness, 'video-project', {
      action: 'get', projectId: 'project-one'
    })
    expect(read.content).toMatchObject({ outcome: 'loaded', project: { id: 'project-one' } })
    const afterRead = await invoke(harness, 'video-project', { action: 'active' })
    expect(afterRead.content).toMatchObject({ project: { id: 'project-two' } })

    const selected = await invoke(harness, 'video-project', {
      action: 'select', projectId: 'project-one', expectedRevision: 0
    })
    expect(selected.content).toMatchObject({ outcome: 'selected', project: { id: 'project-one' } })
    const afterSelect = await invoke(harness, 'video-project', { action: 'active' })
    expect(afterSelect.content).toMatchObject({ project: { id: 'project-one' } })
    expect(harness.webview.messages).toContainEqual({
      channel: 'kun-video-editor.project-changed',
      payload: expect.objectContaining({
        projectId: 'project-one',
        activeProjectId: 'project-one',
        previousProjectId: 'project-two',
        revision: 0,
        reason: 'active-project-changed',
        transition: 'selected',
        source: 'agent'
      })
    })
    const manuallySelected = await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'project.select',
      payload: { projectId: 'project-two' }
    })
    expect(manuallySelected.content).toMatchObject({
      outcome: 'selected', project: { id: 'project-two' }
    })
    expect(harness.webview.messages).toContainEqual({
      channel: 'kun-video-editor.project-changed',
      payload: expect.objectContaining({
        projectId: 'project-two',
        previousProjectId: 'project-one',
        reason: 'active-project-changed',
        transition: 'selected',
        source: 'manual'
      })
    })
    await harness.dispose()
  })

  it('returns explicit empty and stale active-project outcomes without guessing', async () => {
    const harness = await activatedHarness()
    const empty = await invoke(harness, 'video-project', { action: 'active' })
    expect(empty.content).toMatchObject({ outcome: 'no-active-project' })

    harness.storage.workspace.set('active-project', {
      schemaVersion: 1,
      projectId: 'missing-project'
    })
    const stale = await invoke(harness, 'video-project', { action: 'active' })
    expect(stale.content).toMatchObject({
      outcome: 'stale-active-project',
      projectId: 'missing-project'
    })
    expect(harness.storage.workspace.has('active-project')).toBe(false)
    await harness.dispose()
  })

})
