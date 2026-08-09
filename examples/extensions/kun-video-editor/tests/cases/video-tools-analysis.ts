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
  it('runs revision-fenced local VAD, exposes cached evidence, applies only qualified silence, and reports beats unavailable', async () => {
    const harness = await projectWithTwoAudioAssets()
    const capabilities = await invoke(harness, 'video-analysis-status', {
      action: 'capabilities', projectId: 'audio-demo', expectedRevision: 2
    })
    expect(capabilities.content).toMatchObject({
      outcome: 'capabilities',
      denoiseMetadata: {
        outcome: 'unavailable',
        code: 'denoise_metadata_algorithm_unavailable',
        local: true,
        networkUsed: false
      },
      capabilities: {
        analyses: expect.arrayContaining([
          expect.objectContaining({ analysis: 'silence', available: true, networkUsed: false }),
          expect.objectContaining({ analysis: 'beat-grid', available: false, networkUsed: false })
        ])
      }
    })

    const pending = invoke(harness, 'video-analyze-audio', {
      action: 'vad', projectId: 'audio-demo', expectedRevision: 2, assetId: 'reference'
    })
    const jobId = await nextAudioAnalysisJob(harness)
    harness.jobs.start(jobId)
    harness.jobs.complete(jobId, {
      schemaVersion: 1,
      data: silenceAnalysisResult('fake_audio_reference_0001', 'a'.repeat(64)),
      generatedArtifacts: []
    })
    const analyzed = contentObject(await pending)
    expect(analyzed).toMatchObject({
      outcome: 'ready', currentRevision: 2,
      record: { kind: 'vad', silenceCount: 1, safeSuggestionCount: 1, immutable: true },
      evidence: {
        kind: 'vad', total: 1,
        evidence: [{ startUs: 200_000, endUs: 600_000, confidence: 1, disposition: 'safe-to-suggest' }]
      }
    })
    const analysisId = String((analyzed.record as JsonObject).id)
    const listed = await invoke(harness, 'video-analysis-status', {
      action: 'list', projectId: 'audio-demo', expectedRevision: 2
    })
    expect(listed.content).toMatchObject({
      records: [expect.objectContaining({ id: analysisId, kind: 'vad', currentGrant: true })]
    })

    const applied = await invoke(harness, 'video-analyze-audio', {
      action: 'vad-apply', projectId: 'audio-demo', expectedRevision: 2, analysisId
    })
    expect(applied.content).toMatchObject({
      outcome: 'applied', previousRevision: 2, currentRevision: 3, appliedRangeCount: 1,
      receipt: { attribution: { sourceOperation: 'audio-analysis.vad-apply' } }
    })
    await expect(invoke(harness, 'video-analyze-audio', {
      action: 'vad-apply', projectId: 'audio-demo', expectedRevision: 2, analysisId
    })).rejects.toMatchObject({ code: 'CONFLICT' })

    const beat = await invoke(harness, 'video-analyze-audio', {
      action: 'beat-grid', projectId: 'audio-demo', expectedRevision: 3, assetId: 'reference'
    })
    expect(beat.content).toMatchObject({
      outcome: 'unavailable',
      code: 'AUDIO_ANALYSIS_ALGORITHM_UNAVAILABLE',
      local: true,
      networkUsed: false
    })
    const denoise = await invoke(harness, 'video-analyze-audio', {
      action: 'denoise-metadata', projectId: 'audio-demo', expectedRevision: 3,
      assetId: 'reference', confidenceThreshold: 0.7
    })
    expect(denoise.content).toMatchObject({
      outcome: 'unavailable',
      code: 'denoise_metadata_algorithm_unavailable',
      local: true,
      networkUsed: false
    })
    await expect(invoke(harness, 'video-analyze-audio', {
      action: 'denoise-metadata', projectId: 'audio-demo', expectedRevision: 3,
      assetId: 'reference', confidenceThreshold: 1.1
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect((await invoke(harness, 'video-project', {
      action: 'get', projectId: 'audio-demo', expectedRevision: 3
    })).content).toMatchObject({ project: { currentRevision: 3 } })
    expect(JSON.stringify({ analyzed, listed, applied, beat, denoise })).not.toContain(harness.context.workspaceContext!.root)
    await harness.dispose()
  })

  it('projects verified local beat/downbeat evidence as bounded path-opaque timeline snap targets', async () => {
    const harness = await projectWithTwoAudioAssets()
    harness.media.setAudioAnalysisCapabilities({
      schemaVersion: 1,
      probedAt: '2026-01-01T00:00:00.000Z',
      analyses: [
        {
          analysis: 'silence', available: true,
          algorithm: 'ffmpeg.silencedetect', algorithmVersion: '1.0.0',
          local: true, networkUsed: false
        },
        {
          analysis: 'beat-grid', available: true,
          algorithm: 'kun.pcm-onset-autocorrelation', algorithmVersion: '1.0.0',
          local: true, networkUsed: false
        },
        {
          analysis: 'sync-features', available: true,
          algorithm: 'kun.pcm-energy-envelope', algorithmVersion: '1.0.0',
          local: true, networkUsed: false
        }
      ]
    })
    const pending = invoke(harness, 'video-analyze-audio', {
      action: 'beat-grid', projectId: 'audio-demo', expectedRevision: 2, assetId: 'reference'
    })
    const jobId = await nextAudioAnalysisJob(harness)
    harness.jobs.start(jobId)
    harness.jobs.complete(jobId, {
      schemaVersion: 1,
      data: beatAnalysisResult('fake_audio_reference_0001', 'b'.repeat(64)),
      generatedArtifacts: []
    })
    const analyzed = contentObject(await pending)
    expect(analyzed).toMatchObject({
      outcome: 'ready',
      record: {
        kind: 'beat-grid',
        markerCount: 2,
        tempoBpm: 120,
        snapTargets: [
          expect.objectContaining({ frame: 15, kind: 'downbeat', confidence: 0.91 }),
          expect.objectContaining({ frame: 30, kind: 'beat', confidence: 0.86 })
        ],
        snapTargetsTruncated: false,
        immutable: true
      }
    })
    const targets = (analyzed.record as JsonObject).snapTargets as JsonObject[]
    expect(targets.every(({ id }) => /^beat-[a-f0-9]{32}$/u.test(String(id)))).toBe(true)
    expect(JSON.stringify(analyzed)).not.toMatch(/(?:\/Users\/|\/private\/|\/tmp\/|mediaHandleId)/u)

    const listed = contentObject(await invoke(harness, 'video-analysis-status', {
      action: 'list', projectId: 'audio-demo', expectedRevision: 2
    }))
    expect(listed).toMatchObject({
      records: [expect.objectContaining({
        kind: 'beat-grid', currentGrant: true,
        snapTargets: expect.arrayContaining([expect.objectContaining({ frame: 15, kind: 'downbeat' })])
      })]
    })
    await harness.dispose()
  })

  it('keeps visual indexing explicitly opt-in and reports a missing verified Host package without accepting locations', async () => {
    const harness = await projectWithMedia()
    const initial = await invoke(harness, 'video-analysis-status', {
      action: 'capabilities', projectId: 'agent-demo', expectedRevision: 1
    })
    expect(initial.content).toMatchObject({
      outcome: 'capabilities',
      visual: {
        optIn: false,
        state: 'disabled',
        code: 'visual_model_disabled',
        local: true,
        networkUsedForInference: false,
        rawPathsExposed: false,
        urlsAccepted: false
      }
    })
    const disabled = await invoke(harness, 'video-analyze-visual', {
      projectId: 'agent-demo', expectedRevision: 1, assetId: 'interview'
    })
    expect(disabled.content).toMatchObject({
      outcome: 'unavailable',
      capability: { code: 'visual_model_disabled', state: 'disabled' }
    })
    await expect(invoke(harness, 'video-analyze-visual', {
      projectId: 'agent-demo', expectedRevision: 1, assetId: 'interview',
      modelUrl: 'https://example.invalid/model.bin'
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })

    const optedIn = await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'analysis.visual-opt-in',
      payload: { projectId: 'agent-demo', expectedRevision: 1, enabled: true }
    })
    expect(optedIn.content).toMatchObject({
      outcome: 'enabled',
      capability: {
        optIn: true,
        state: 'missing',
        code: 'visual_model_missing',
        installSupported: false,
        rawPathsExposed: false,
        urlsAccepted: false
      }
    })
    const install = await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'analysis.visual-install',
      payload: { projectId: 'agent-demo', expectedRevision: 1 }
    })
    expect(install.content).toMatchObject({
      outcome: 'unavailable',
      capability: { state: 'missing', code: 'visual_model_missing' }
    })
    const unavailable = await invoke(harness, 'video-analyze-visual', {
      projectId: 'agent-demo', expectedRevision: 1, assetId: 'interview',
      intervalUs: 2_000_000, maxFrames: 240, allowPartial: false
    })
    expect(unavailable.content).toMatchObject({
      outcome: 'unavailable',
      capability: {
        state: 'missing',
        code: 'visual_model_missing',
        local: true,
        networkUsedForInference: false
      }
    })
    expect(JSON.stringify({ initial, disabled, optedIn, install, unavailable }))
      .not.toMatch(/(?:https?:\/\/|file:\/\/|\/(?:Users|private|tmp)\/)/u)
    await harness.dispose()
  })

  it('lets the Agent index and search measured local visual evidence only after a manual opt-in and verified install', async () => {
    const harness = await projectWithMedia()
    const missing = visualModelStatus('missing')
    const installed = visualModelStatus('installed')
    harness.media.setVisualModelStatus(missing)
    harness.transport.handle('media.installVisualModel', () => {
      harness.media.setVisualModelStatus(installed)
      return installed
    })
    harness.transport.handle('media.analyzeVisualFrames', (params) => {
      const request = MediaAnalyzeVisualFramesRequestSchema.parse(params)
      return {
        outcome: 'ready',
        source: {
          handleId: request.inputHandleId,
          fingerprint: 'c'.repeat(64),
          fingerprintAlgorithm: 'sha256-file-identity-v1'
        },
        adapter: request.adapter,
        embeddings: request.samples.map((sample, index) => ({
          sampleId: sample.sampleId,
          vector: index === 0
            ? [1, ...Array.from({ length: 23 }, () => 0)]
            : [0, 1, ...Array.from({ length: 22 }, () => 0)]
        })),
        provenance: {
          algorithm: 'kun.rgb-edge-features', algorithmVersion: '1.0.0',
          decodedFrameWidth: 32, decodedFrameHeight: 32,
          local: true, networkUsed: false
        }
      }
    })
    harness.transport.handle('media.embedVisualQuery', (params) => {
      const request = MediaEmbedVisualQueryRequestSchema.parse(params)
      if (request.query !== 'red') {
        return {
          outcome: 'unavailable', code: 'VISUAL_QUERY_UNSUPPORTED',
          remediation: 'Use supported measured color, brightness, contrast, or edge concepts.',
          retryable: false, local: true, networkUsed: false
        }
      }
      return {
        outcome: 'ready', adapter: request.adapter,
        vector: [1, ...Array.from({ length: 23 }, () => 0)],
        matchedConcepts: ['red'], scoreSemantics: 'uncalibrated-cosine',
        local: true, networkUsed: false
      }
    })

    const beforeOptIn = await invoke(harness, 'video-analyze-visual', {
      projectId: 'agent-demo', expectedRevision: 1, assetId: 'interview', maxFrames: 2
    })
    expect(beforeOptIn.content).toMatchObject({
      outcome: 'unavailable', capability: { code: 'visual_model_disabled' }
    })
    await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'analysis.visual-opt-in',
      payload: { projectId: 'agent-demo', expectedRevision: 1, enabled: true }
    })
    const installedResult = await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'analysis.visual-install',
      payload: { projectId: 'agent-demo', expectedRevision: 1 }
    })
    expect(installedResult.content).toMatchObject({
      outcome: 'ready',
      capability: {
        state: 'ready', packageSource: 'bundled', local: true, networkUsedForInference: false,
        verification: {
          brokerAttested: true, downloadVerified: false,
          sourceVerified: true,
          installVerified: true, signatureVerified: true, manifestVerified: true
        }
      }
    })

    const indexed = await invoke(harness, 'video-analyze-visual', {
      projectId: 'agent-demo', expectedRevision: 1, assetId: 'interview',
      intervalUs: 1_500_000, maxFrames: 2, allowPartial: false
    })
    expect(indexed.content).toMatchObject({
      outcome: 'ready', deduplicated: false,
      record: {
        kind: 'visual-index', immutable: true,
        indexedSampleCount: 2, plannedSampleCount: 2,
        adapterId: 'kun.local.visual-features', modelId: 'kun-visual-features'
      }
    })
    const indexId = String(contentObject(indexed).record &&
      (contentObject(indexed).record as JsonObject).id)
    expect(indexId).toMatch(/^visual-index:/u)

    const searched = await invoke(harness, 'video-analysis-status', {
      action: 'visual-search', projectId: 'agent-demo', expectedRevision: 1,
      analysisId: indexId, query: 'red', pageSize: 20
    })
    expect(searched.content).toMatchObject({
      outcome: 'ready',
      page: {
        completeness: 'complete',
        ranking: { semantics: 'uncalibrated-cosine', calibratedConfidence: false, local: true, networkUsed: false }
      }
    })
    const searchedPage = contentObject(searched).page as JsonObject
    expect(searchedPage.results).toEqual(expect.arrayContaining([expect.objectContaining({
      assetId: 'interview', indexId,
      sourceRange: expect.objectContaining({ assetId: 'interview' })
    })]))
    const unsupported = await invoke(harness, 'video-analysis-status', {
      action: 'visual-search', projectId: 'agent-demo', expectedRevision: 1,
      analysisId: indexId, query: 'person smiling'
    })
    expect(unsupported.content).toMatchObject({
      outcome: 'unavailable', code: 'visual_query_unsupported',
      local: true, networkUsed: false
    })

    const repeated = await invoke(harness, 'video-analyze-visual', {
      projectId: 'agent-demo', expectedRevision: 1, assetId: 'interview',
      intervalUs: 1_500_000, maxFrames: 2, allowPartial: false
    })
    expect(repeated.content).toMatchObject({
      outcome: 'ready', deduplicated: true,
      record: { id: indexId, immutable: true }
    })
    const progress = harness.webview.messages
      .filter(isJsonObject)
      .filter((message) => message.channel === 'kun-video-editor.media-intelligence-progress')
      .map((message) => message.payload as JsonObject)
      .filter((message) => message.kind === 'visual-index')
    expect(progress).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'running', completed: 0, total: 2 }),
      expect.objectContaining({ status: 'ready', completed: 2, total: 2 })
    ]))
    expect(JSON.stringify({ installedResult, indexed, searched, unsupported, repeated, progress }))
      .not.toMatch(/(?:https?:\/\/|file:\/\/|\/(?:Users|private|tmp)\/|mediaHandleId)/u)
    await harness.dispose()
  })

  it('cancels an Agent visual-index operation without publishing a partial immutable record', async () => {
    const harness = await projectWithMedia()
    harness.media.setVisualModelStatus(visualModelStatus('installed'))
    await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'analysis.visual-opt-in',
      payload: { projectId: 'agent-demo', expectedRevision: 1, enabled: true }
    })
    harness.transport.handle('media.analyzeVisualFrames', async (params, options) => {
      MediaAnalyzeVisualFramesRequestSchema.parse(params)
      await new Promise<never>((_resolve, reject) => {
        const abort = (): void => reject(new ExtensionApiError({
          code: 'CANCELLED', message: 'Measured frame analysis cancelled',
          operation: 'media.analyzeVisualFrames', retryable: false
        }))
        if (options.signal?.aborted) abort()
        else options.signal?.addEventListener('abort', abort, { once: true })
      })
    })
    const pending = invoke(harness, 'video-analyze-visual', {
      projectId: 'agent-demo', expectedRevision: 1, assetId: 'interview', maxFrames: 2
    })
    const operationId = await waitForVisualOperation(harness)
    const cancelled = await invoke(harness, 'video-analysis-cancel', {
      projectId: 'agent-demo', expectedRevision: 1, operationId
    })
    expect(cancelled.content).toMatchObject({ outcome: 'cancelled', operationId, accepted: true })
    expect((await pending).content).toMatchObject({ outcome: 'cancelled', operationId })
    const listed = await invoke(harness, 'video-analysis-status', {
      action: 'list', projectId: 'agent-demo', expectedRevision: 1
    })
    expect(listed.content).toMatchObject({ outcome: 'listed', records: [] })
    const terminal = harness.webview.messages
      .filter(isJsonObject)
      .filter((message) => message.channel === 'kun-video-editor.media-intelligence-progress')
      .map((message) => message.payload as JsonObject)
      .filter((message) => message.operationId === operationId)
      .at(-1)
    expect(terminal).toMatchObject({ status: 'cancelled' })
    await harness.dispose()
  })

  it('imports reviewed speaker evidence in the sidebar and lets the Agent preview/apply safe attribution', async () => {
    const harness = await projectWithMedia()
    await invoke(harness, 'video-transcribe', {
      projectId: 'agent-demo', expectedRevision: 1, assetId: 'interview',
      transcriptId: 'transcript-speakers', mode: 'import', format: 'json', language: 'en',
      segments: [
        { id: 'segment-alice', startUs: 0, endUs: 1_000_000, text: 'Welcome' },
        { id: 'segment-unknown', startUs: 1_000_000, endUs: 2_000_000, text: 'Hello' }
      ]
    })
    const local = await invoke(harness, 'video-analyze-audio', {
      action: 'speaker', projectId: 'agent-demo', expectedRevision: 2, assetId: 'interview'
    })
    expect(local.content).toMatchObject({
      outcome: 'unavailable',
      importAvailable: true,
      local: true,
      networkUsed: false
    })
    expect(JSON.stringify(local)).not.toMatch(/speakerId.*(?:Alice|Bob)/u)

    const document: JsonObject = {
      schemaVersion: 1,
      adapterId: 'kun.imported-speaker-labels',
      identities: [{ id: 'speaker-alice', label: 'Alice', aliases: ['Host'], sourceEvidenceIds: ['review-alice'] }],
      turns: [
        { id: 'turn-alice', startUs: 0, endUs: 1_000_000, status: 'identified', speakerId: 'speaker-alice', confidence: 0.98 },
        { id: 'turn-unknown', startUs: 1_000_000, endUs: 2_000_000, status: 'unknown', confidence: 0.9 }
      ],
      confidenceThreshold: 0.7,
      completeness: 'complete'
    }
    await expect(harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'analysis.speaker-import',
      payload: {
        projectId: 'agent-demo', expectedRevision: 2, assetId: 'interview',
        document: { ...document, sourcePath: '/private/tmp/do-not-read.wav' }
      }
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    const imported = await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'analysis.speaker-import',
      payload: { projectId: 'agent-demo', expectedRevision: 2, assetId: 'interview', document }
    })
    expect(imported.content).toMatchObject({
      outcome: 'ready',
      record: { kind: 'speaker-diarization', turnCount: 2, identifiedTurnCount: 1, uncertainTurnCount: 1 },
      identities: [expect.objectContaining({ id: 'speaker-alice', label: 'Alice' })],
      evidence: {
        kind: 'speaker-diarization',
        evidence: [
          expect.objectContaining({ speakerId: 'speaker-alice', speakerLabel: 'Alice', uncertain: false }),
          expect.objectContaining({ uncertain: true, reason: 'unknown-speaker' })
        ]
      }
    })
    const analysisId = String((contentObject(imported).record as JsonObject).id)
    const listed = await invoke(harness, 'video-analysis-status', {
      action: 'list', projectId: 'agent-demo', expectedRevision: 2
    })
    expect(listed.content).toMatchObject({
      records: [expect.objectContaining({ id: analysisId, kind: 'speaker-diarization', currentGrant: true })]
    })
    const preview = await invoke(harness, 'video-analyze-audio', {
      action: 'speaker-attribution-preview', projectId: 'agent-demo', expectedRevision: 2, analysisId
    })
    expect(preview.content).toMatchObject({
      outcome: 'preview',
      plan: { analysisId, transcriptSegmentCount: 2, identifiedCount: 1, uncertainCount: 1 },
      transcriptSegments: [
        expect.objectContaining({ segmentId: 'segment-alice', status: 'identified', speakerLabel: 'Alice' }),
        expect.objectContaining({ segmentId: 'segment-unknown', status: 'unknown' })
      ]
    })
    const applied = await invoke(harness, 'video-analyze-audio', {
      action: 'speaker-attribution-apply', projectId: 'agent-demo', expectedRevision: 2, analysisId
    })
    expect(applied.content).toMatchObject({
      outcome: 'applied', currentRevision: 3,
      applied: { transcriptSegments: 2, identified: 1, uncertain: 1 },
      receipt: { attribution: { sourceOperation: 'audio-analysis.speaker-attribution-apply' } }
    })
    const loaded = contentObject(await invoke(harness, 'video-project', {
      action: 'get', projectId: 'agent-demo', expectedRevision: 3
    }))
    const transcripts = (loaded.project as JsonObject).transcripts as JsonObject[]
    expect((transcripts[0]!.segments as JsonObject[])).toEqual([
      expect.objectContaining({ speakerAttribution: expect.objectContaining({ status: 'identified', speakerLabel: 'Alice' }) }),
      expect.objectContaining({ speakerAttribution: expect.objectContaining({ status: 'unknown' }) })
    ])
    expect(JSON.stringify(loaded)).not.toContain(harness.context.workspaceContext!.root)

    await expect(invoke(harness, 'video-analyze-audio', {
      action: 'speaker-import', projectId: 'agent-demo', expectedRevision: 3,
      assetId: 'interview', document
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await harness.dispose()
  })

  it('previews seeded audio sync, commits one qualified move, and refuses uncertain evidence without mutation', async () => {
    const harness = await projectWithTwoAudioAssets()
    const referenceFeatures = [0.2, 0.8, 0.1, 0.5, 0.9, 0.3, 0.7, 0.05, 0.6, 0.4, 0.85, 0.15, 0.55, 0.25, 0.95, 0.35]
    const pending = invoke(harness, 'video-analyze-audio', {
      action: 'sync-preview', projectId: 'audio-demo', expectedRevision: 2,
      referenceAssetId: 'reference', targetAssetId: 'target',
      referenceItemId: 'item-reference', targetItemId: 'item-target',
      seed: 42, maximumOffsetUs: 500_000, threshold: 0.9, minimumSeparation: 0.01
    })
    const jobId = await nextAudioAnalysisJob(harness)
    harness.jobs.start(jobId)
    harness.jobs.complete(jobId, {
      schemaVersion: 1,
      data: syncAnalysisResult(
        'fake_audio_reference_0001',
        'fake_audio_target_0000001',
        42,
        referenceFeatures,
        [0, 0, ...referenceFeatures]
      ),
      generatedArtifacts: []
    })
    const previewed = contentObject(await pending)
    expect(previewed).toMatchObject({
      outcome: 'ready', currentRevision: 2,
      preview: { outcome: 'ready', targetFrameBefore: 90, targetFrameAfter: 84, deltaFrames: -6 }
    })
    const analysisId = String((previewed.record as JsonObject).id)
    const applied = await invoke(harness, 'video-analyze-audio', {
      action: 'sync-apply', projectId: 'audio-demo', expectedRevision: 2,
      analysisId, referenceItemId: 'item-reference', targetItemId: 'item-target'
    })
    expect(applied.content).toMatchObject({ outcome: 'applied', currentRevision: 3 })
    const moved = contentObject(await invoke(harness, 'video-project', {
      action: 'get', projectId: 'audio-demo', expectedRevision: 3
    }))
    expect(((moved.project as JsonObject).items as JsonObject[])
      .find(({ id }) => id === 'item-target')).toMatchObject({ timelineStartFrame: 84 })

    const uncertainPending = invoke(harness, 'video-analyze-audio', {
      action: 'sync-preview', projectId: 'audio-demo', expectedRevision: 3,
      referenceAssetId: 'reference', targetAssetId: 'target',
      referenceItemId: 'item-reference', targetItemId: 'item-target',
      seed: 43, maximumOffsetUs: 500_000, threshold: 0.9, minimumSeparation: 0.03
    })
    const uncertainJobId = await nextAudioAnalysisJob(harness, new Set([jobId]))
    harness.jobs.start(uncertainJobId)
    harness.jobs.complete(uncertainJobId, {
      schemaVersion: 1,
      data: syncAnalysisResult(
        'fake_audio_reference_0001',
        'fake_audio_target_0000001',
        43,
        Array(16).fill(1),
        Array(18).fill(1)
      ),
      generatedArtifacts: []
    })
    const uncertain = contentObject(await uncertainPending)
    expect(uncertain).toMatchObject({
      outcome: 'uncertain',
      preview: { outcome: 'uncertain', refusalReason: 'ambiguous-correlation' }
    })
    const refused = await invoke(harness, 'video-analyze-audio', {
      action: 'sync-apply', projectId: 'audio-demo', expectedRevision: 3,
      analysisId: String((uncertain.record as JsonObject).id),
      referenceItemId: 'item-reference', targetItemId: 'item-target'
    })
    expect(refused.content).toMatchObject({ outcome: 'refused', code: 'AUDIO_SYNC_UNCERTAIN', currentRevision: 3 })
    const unchanged = contentObject(await invoke(harness, 'video-project', {
      action: 'get', projectId: 'audio-demo', expectedRevision: 3
    }))
    expect(((unchanged.project as JsonObject).items as JsonObject[])
      .find(({ id }) => id === 'item-target')).toMatchObject({ timelineStartFrame: 84 })
    await harness.dispose()
  })

})
