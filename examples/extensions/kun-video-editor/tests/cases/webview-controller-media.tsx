import type { HostMessage, JobEvent, JobSnapshot, JsonValue, Locale, Theme } from '@kun/extension-api'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { artifactUsesPlayer, type EditorController } from '../../src/webview/controller.js'
import { formatMessage, messagesFor } from '../../src/webview/i18n.js'
import { VIEW_LIMITS, type EditorNotice } from '../../src/webview/model.js'
import { makeArtifact, makeJob, makeSubtitleArtifact, makeViewProject } from '../webview-fixtures.js'
import {
  CaptureController,
  darkTheme,
  enLocale,
  fakeClient,
  flushAsync,
  generationCatalogProjection,
  generationRecordProjection,
  isRecord,
  lightTheme,
  localizedNotice,
  makeArchiveJob,
  projectChangedMessage,
  zhLocale
} from './webview-controller-support.js'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

let renderer: ReactTestRenderer | undefined

afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount())
  renderer = undefined
  vi.useRealTimers()
})

describe('video editor artifact controller integration', () => {
  it('loads revision-fenced audio capabilities and folds bounded Host progress into the mounted sidebar state', async () => {
    const project = makeViewProject()
    const snapTargets = [
      ...Array.from({ length: 4_096 }, (_, index) => ({
        id: `beat-${index}`,
        frame: index * 12,
        kind: index % 4 === 0 ? 'downbeat' : 'beat',
        confidence: 0.9
      })),
      { id: 'ignored-after-bound', frame: -1, kind: 'bar', confidence: 2 }
    ]
    const executeCommand = vi.fn(async (_id: string, args?: JsonValue) => {
      const request = isRecord(args) ? args : {}
      const action = request.action
      if (action === 'project.list') return { content: { projects: [{
        id: project.id, name: project.name, currentRevision: project.currentRevision,
        updatedAt: project.updatedAt, durationFrames: project.durationFrames
      }] } }
      if (action === 'project.active' || action === 'project.get') return { content: { project } }
      if (action === 'render.list' || action === 'derived.list') return { content: { records: [] } }
      if (action === 'preview.list') return { content: { history: { schemaVersion: 1, generation: 0, entries: [] } } }
      if (action === 'analysis.capabilities') return { content: {
        outcome: 'capabilities', projectId: project.id, currentRevision: project.currentRevision,
        capabilities: {
          schemaVersion: 1, probedAt: '2026-07-14T00:00:00.000Z',
          analyses: [
            { analysis: 'silence', available: true, algorithm: 'ffmpeg.silencedetect', algorithmVersion: '1.0.0', local: true, networkUsed: false },
            { analysis: 'beat-grid', available: false, code: 'AUDIO_ANALYSIS_ALGORITHM_UNAVAILABLE', remediation: 'Unavailable.', retryable: false, local: true, networkUsed: false },
            { analysis: 'sync-features', available: true, algorithm: 'kun.pcm-energy-envelope', algorithmVersion: '1.0.0', local: true, networkUsed: false }
          ]
        },
        denoiseMetadata: {
          outcome: 'ready', local: true, networkUsed: false,
          descriptor: {
            adapterId: 'kun.fixture.denoise', adapterVersion: '1.0.0',
            algorithm: 'noise-profile', algorithmVersion: '1.0.0'
          }
        }
      } }
      if (action === 'analysis.list') return { content: {
        outcome: 'listed', projectId: project.id, currentRevision: project.currentRevision,
        records: [{
          schemaVersion: 1, id: 'analysis:vad:fixture', kind: 'vad', assetId: 'asset-1',
          completeness: 'complete', silenceCount: 1, safeSuggestionCount: 1,
          suggestionConfidenceThreshold: 0.82, currentGrant: true, immutable: true
        }, {
          schemaVersion: 1, id: 'analysis:beat-grid:fixture', kind: 'beat-grid', assetId: 'asset-1',
          completeness: 'complete', markerCount: 4_097, tempoBpm: 120,
          snapTargets, currentGrant: true, immutable: true
        }, {
          schemaVersion: 1, id: 'analysis:beat-grid:invalid', kind: 'beat-grid', assetId: 'asset-1',
          completeness: 'complete', markerCount: 1, tempoBpm: 120,
          snapTargets: [{ id: 'invalid-target', frame: 12, kind: 'beat', confidence: 1.1 }],
          currentGrant: true, immutable: true
        }, {
          schemaVersion: 1, id: 'analysis:denoise:fixture', kind: 'denoise-metadata', assetId: 'asset-1',
          completeness: 'complete', status: 'ready', confidence: 0.86, confidenceThreshold: 0.7,
          noiseProfile: {
            analyzedDurationUs: 2_000_000, sampleWindowCount: 20,
            levels: { noiseFloorDbfs: -54.5, averageRmsDbfs: -31, peakDbfs: -4, estimatedSnrDb: 23.5 },
            spectralBands: [{ id: 'speech', lowerFrequencyHz: 250, upperFrequencyHz: 4_000, noiseLevelDbfs: -57, confidence: 0.88 }]
          },
          recommendation: {
            reductionDb: 8.5, confidence: 0.86, disposition: 'preview-suggested',
            autoApplyAllowed: false, audioMutation: 'none'
          },
          metadataOnly: true, currentGrant: true, immutable: true
        }],
        operations: []
      } }
      if (action === 'analysis.evidence') return { content: {
        outcome: 'evidence', projectId: project.id, currentRevision: project.currentRevision,
        evidence: {
          schemaVersion: 1, recordId: 'analysis:vad:fixture', kind: 'vad',
          offset: 0, returned: 1, total: 1, completeness: 'complete',
          evidence: [{
            suggestionId: 'silence-cache', startUs: 100_000, endUs: 500_000,
            confidence: 1, disposition: 'safe-to-suggest'
          }]
        }
      } }
      if (action === 'analysis.vad') return { content: {
        outcome: 'ready', projectId: project.id, currentRevision: project.currentRevision,
        record: { id: 'analysis:vad:fixture' },
        evidence: {
          schemaVersion: 1, recordId: 'analysis:vad:fixture', kind: 'vad',
          offset: 0, returned: 1, total: 1, completeness: 'complete',
          evidence: [{ suggestionId: 'silence-1', startUs: 100_000, endUs: 500_000, confidence: 1, disposition: 'safe-to-suggest' }]
        }
      } }
      if (action === 'analysis.denoise-metadata') return { content: {
        outcome: 'ready', projectId: project.id, currentRevision: project.currentRevision,
        record: { id: 'analysis:denoise:fixture' },
        evidence: {
          schemaVersion: 1, recordId: 'analysis:denoise:fixture', kind: 'denoise-metadata',
          offset: 0, returned: 1, total: 1, completeness: 'complete',
          evidence: [{
            evidenceKind: 'noise-profile', noiseFloorDbfs: -54.5,
            recommendedReductionDb: 8.5, metadataOnly: true, audioMutation: 'none'
          }]
        }
      } }
      return { content: {} }
    })
    const { client, emitMessage } = fakeClient({ executeCommand })
    let controller: EditorController | undefined
    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client, capture: (value: EditorController) => { controller = value }
      }))
      await flushAsync()
    })
    await act(async () => { await flushAsync() })

    expect(controller?.state.audioAnalysisCapabilities?.analyses).toEqual(expect.arrayContaining([
      expect.objectContaining({ analysis: 'silence', available: true, algorithm: 'ffmpeg.silencedetect' }),
      expect.objectContaining({ analysis: 'beat-grid', available: false })
    ]))
    expect(controller?.state.denoiseMetadataCapability).toMatchObject({
      outcome: 'ready', descriptor: { algorithm: 'noise-profile' }, local: true, networkUsed: false
    })
    expect(controller?.state.audioAnalysisRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'analysis:vad:fixture', safeSuggestionCount: 1, currentGrant: true
      }),
      expect.objectContaining({
        id: 'analysis:beat-grid:fixture', markerCount: 4_097, tempoBpm: 120
      }),
      expect.objectContaining({
        id: 'analysis:denoise:fixture', status: 'ready', metadataOnly: true,
        noiseProfile: expect.objectContaining({ spectralBandCount: 1 }),
        recommendation: expect.objectContaining({ reductionDb: 8.5, audioMutation: 'none' })
      })
    ]))
    expect(controller?.state.audioAnalysisRecords).toHaveLength(3)
    expect(controller?.state.audioAnalysisRecords[1]?.snapTargets).toHaveLength(4_096)
    expect(controller?.state.audioAnalysisRecords[1]?.snapTargets?.[0]).toEqual({
      id: 'beat-0', frame: 0, kind: 'downbeat', confidence: 0.9
    })
    expect(controller?.state.audioAnalysisRecords[1]?.snapTargets?.at(-1)).toEqual({
      id: 'beat-4095', frame: 49_140, kind: 'beat', confidence: 0.9
    })
    expect(controller?.state.mediaIntelligenceEvidence).toMatchObject({
      recordId: 'analysis:vad:fixture',
      evidence: [expect.objectContaining({ suggestionId: 'silence-cache' })]
    })
    expect(executeCommand).toHaveBeenCalledWith('editor-request', {
      action: 'analysis.evidence',
      payload: {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        analysisId: 'analysis:vad:fixture',
        offset: 0,
        limit: 200
      }
    })

    await act(async () => {
      emitMessage({
        channel: 'kun-video-editor.media-intelligence-progress',
        payload: {
          schemaVersion: 1,
          operationId: 'media-analysis-fixture',
          projectId: project.id,
          projectRevision: project.currentRevision,
          kind: 'vad', generation: 3, status: 'running', completed: 50, total: 100
        }
      })
      await flushAsync()
    })
    expect(controller?.state.mediaIntelligenceOperations).toEqual([
      expect.objectContaining({ operationId: 'media-analysis-fixture', completed: 50, total: 100 })
    ])

    await act(async () => {
      await controller!.analyzeVad('asset-1')
      await flushAsync()
    })
    expect(executeCommand).toHaveBeenCalledWith('editor-request', {
      action: 'analysis.vad',
      payload: {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        assetId: 'asset-1'
      }
    })
    expect(controller?.state.mediaIntelligenceEvidence).toMatchObject({
      recordId: 'analysis:vad:fixture', evidence: [{ disposition: 'safe-to-suggest' }]
    })

    await act(async () => {
      await controller!.analyzeDenoiseMetadata('asset-1')
      await flushAsync()
    })
    expect(executeCommand).toHaveBeenCalledWith('editor-request', {
      action: 'analysis.denoise-metadata',
      payload: {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        assetId: 'asset-1',
        confidenceThreshold: 0.7
      }
    })
  })

  it('imports reviewed speaker evidence and keeps preview/apply as separate revision-bound actions', async () => {
    const project = makeViewProject()
    let imported = false
    const identity = {
      id: 'speaker-alice', label: 'Alice', aliases: ['Host'],
      sourceEvidenceIds: Array.from({ length: 65 }, (_, index) => `review-alice-${index}`),
      createdAt: '2026-07-14T00:00:00.000Z', updatedAt: '2026-07-14T00:00:00.000Z'
    }
    const record = {
      schemaVersion: 1, id: 'speaker:controller-fixture', kind: 'speaker-diarization',
      assetId: 'asset-1', completeness: 'complete', turnCount: 2, identifiedTurnCount: 1,
      uncertainTurnCount: 1, currentGrant: true, immutable: true
    }
    const evidence = {
      schemaVersion: 1, recordId: record.id, kind: 'speaker-diarization', offset: 0,
      returned: 2, total: 2, completeness: 'complete', evidence: [{
        id: 'turn-alice', startUs: 0, endUs: 1_000_000, status: 'identified',
        speakerId: identity.id, speakerLabel: identity.label, confidence: 0.98, uncertain: false
      }, {
        id: 'turn-unknown', startUs: 1_000_000, endUs: 2_000_000, status: 'unknown',
        confidence: 0.4, uncertain: true, reason: 'unknown-speaker'
      }]
    }
    const plan = {
      schemaVersion: 1, analysisId: record.id, transcriptSegmentCount: 2, captionCount: 1,
      identifiedCount: 1, uncertainCount: 2, warnings: ['Unknown stays unlabelled.']
    }
    const executeCommand = vi.fn(async (_id: string, args?: JsonValue) => {
      const request = isRecord(args) ? args : {}
      const action = request.action
      if (action === 'project.list') return { content: { projects: [{
        id: project.id, name: project.name, currentRevision: project.currentRevision,
        updatedAt: project.updatedAt, durationFrames: project.durationFrames
      }] } }
      if (action === 'project.active' || action === 'project.get') return { content: { project } }
      if (action === 'render.list' || action === 'derived.list') return { content: { records: [] } }
      if (action === 'preview.list') return { content: { history: { schemaVersion: 1, generation: 0, entries: [] } } }
      if (action === 'analysis.capabilities') return { content: {
        outcome: 'capabilities', projectId: project.id, currentRevision: project.currentRevision,
        capabilities: {
          schemaVersion: 1, probedAt: '2026-07-14T00:00:00.000Z', analyses: [
            { analysis: 'silence', available: false, local: true, networkUsed: false },
            { analysis: 'beat-grid', available: false, local: true, networkUsed: false },
            { analysis: 'sync-features', available: false, local: true, networkUsed: false }
          ]
        },
        speakerAdapters: [{
          descriptor: { id: 'kun.imported-speaker-labels', version: '1.0.0', execution: 'import', format: 'kun-speaker-json-v1' },
          outcome: 'ready', local: true, networkUsed: false
        }, {
          descriptor: { id: 'kun.host.local-speaker', version: '1.0.0', execution: 'local-model', modelId: 'speaker-diarization', modelVersion: 'unavailable' },
          outcome: 'unavailable', code: 'speaker_inference_broker_unavailable', remediation: 'No verified broker.',
          local: true, networkUsed: false
        }],
        speakerIdentities: imported ? [identity] : []
      } }
      if (action === 'analysis.list') return { content: {
        outcome: 'listed', projectId: project.id, currentRevision: project.currentRevision,
        records: imported ? [record] : [], operations: []
      } }
      if (action === 'analysis.evidence') return { content: {
        outcome: 'evidence', projectId: project.id, currentRevision: project.currentRevision, evidence
      } }
      if (action === 'analysis.speaker-import') {
        imported = true
        return { content: {
          outcome: 'ready', projectId: project.id, currentRevision: project.currentRevision,
          operationId: 'speaker-import-op', deduplicated: false, record, evidence, identities: [identity]
        } }
      }
      if (action === 'analysis.speaker-preview') return { content: {
        outcome: 'preview', projectId: project.id, currentRevision: project.currentRevision, plan
      } }
      if (action === 'analysis.speaker-apply') return { content: {
        outcome: 'applied', projectId: project.id, previousRevision: 0, currentRevision: 1, plan
      } }
      return { content: {} }
    })
    const { client } = fakeClient({ executeCommand })
    let controller: EditorController | undefined
    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client, capture: (value: EditorController) => { controller = value }
      }))
      await flushAsync()
    })
    await act(async () => { await flushAsync() })
    expect(controller?.state.speakerAdapters).toEqual(expect.arrayContaining([
      expect.objectContaining({ descriptor: expect.objectContaining({ execution: 'import' }), outcome: 'ready' }),
      expect.objectContaining({ descriptor: expect.objectContaining({ execution: 'local-model' }), outcome: 'unavailable' })
    ]))

    const reviewedDocument = JSON.stringify({
      schemaVersion: 1, adapterId: 'kun.imported-speaker-labels', identities: [identity],
      turns: [{ id: 'turn-alice', startUs: 0, endUs: 1_000_000, status: 'identified', speakerId: identity.id, confidence: 0.98 }]
    })
    await act(async () => {
      await controller!.importSpeakerEvidence('asset-1', reviewedDocument)
      await flushAsync()
    })
    expect(controller?.state.speakerIdentities).toEqual([expect.objectContaining({ id: identity.id, label: 'Alice' })])
    expect(controller?.state.mediaIntelligenceEvidence).toMatchObject({ recordId: record.id, kind: 'speaker-diarization' })
    expect(executeCommand).toHaveBeenCalledWith('editor-request', {
      action: 'analysis.speaker-import',
      payload: expect.objectContaining({
        projectId: project.id, expectedRevision: 0, assetId: 'asset-1',
        document: expect.objectContaining({ adapterId: 'kun.imported-speaker-labels' })
      })
    })

    await act(async () => controller!.previewSpeakerAttribution(record.id))
    expect(controller?.state.speakerAttributionPlan).toMatchObject({ analysisId: record.id, uncertainCount: 2 })
    await act(async () => {
      await controller!.applySpeakerAttribution(record.id)
      await flushAsync()
    })
    expect(executeCommand).toHaveBeenCalledWith('editor-request', {
      action: 'analysis.speaker-apply',
      payload: { projectId: project.id, expectedRevision: 0, analysisId: record.id }
    })
    expect(controller?.state.notices).toEqual(expect.arrayContaining([
      expect.objectContaining({ messageKey: 'speakerAttributionApplied' })
    ]))
    expect(JSON.stringify(executeCommand.mock.calls)).not.toMatch(/\/Users\/|file:\/\//u)
  })

  it('imports a protected transcript as bounded UTF-8 and releases its source handle', async () => {
    const project = makeViewProject()
    const transcriptHandle = 'media_transcript_1234567890'
    const executeCommand = vi.fn(async (_id: string, args?: JsonValue) => {
      const action = isRecord(args) ? args.action : undefined
      if (action === 'project.list') return { content: { projects: [{
        id: project.id, name: project.name, currentRevision: project.currentRevision,
        updatedAt: project.updatedAt, durationFrames: project.durationFrames
      }] } }
      if (action === 'project.active' || action === 'project.get') return { content: { project } }
      if (action === 'transcript.import') return { content: { outcome: 'transcribed', currentRevision: 1, details: { segmentCount: 1 } } }
      return { content: {} }
    })
    const pickFiles = vi.fn(async () => ({
      outcome: 'selected' as const,
      files: [{
        handleId: transcriptHandle, mode: 'read' as const, kind: 'subtitle' as const,
        displayName: 'interview.srt', mimeType: 'application/x-subrip', byteSize: 48
      }]
    }))
    const readText = vi.fn(async () => ({
      handleId: transcriptHandle,
      displayName: 'interview.srt',
      mimeType: 'application/x-subrip',
      content: '1\n00:00:00,000 --> 00:00:01,000\nHello\n',
      byteSize: 44
    }))
    const release = vi.fn(async () => ({ released: true }))
    const { client } = fakeClient({ executeCommand, pickFiles, readText, release })
    let controller: EditorController | undefined

    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client, capture: (value: EditorController) => { controller = value }
      }))
      await flushAsync()
    })
    await act(async () => {
      await controller!.importTranscript()
      await flushAsync()
    })

    expect(readText).toHaveBeenCalledWith({ handleId: transcriptHandle, maxBytes: 512 * 1024 })
    expect(executeCommand).toHaveBeenCalledWith('editor-request', {
      action: 'transcript.import',
      payload: expect.objectContaining({
        projectId: project.id,
        assetId: project.assets[0]!.id,
        format: 'srt',
        source: expect.stringContaining('Hello')
      })
    })
    expect(release).toHaveBeenCalledWith({ resource: 'handle', handleId: transcriptHandle })
  })

  it('keeps the revision unchanged and releases selected handles when media import is unavailable', async () => {
    const project = makeViewProject()
    const mediaHandle = 'media_unavailable_1234567890'
    const executeCommand = vi.fn(async (_id: string, args?: JsonValue) => {
      const action = isRecord(args) ? args.action : undefined
      if (action === 'project.list') return { content: { projects: [{
        id: project.id, name: project.name, currentRevision: project.currentRevision,
        updatedAt: project.updatedAt, durationFrames: project.durationFrames
      }] } }
      if (action === 'project.active' || action === 'project.get') return { content: { project } }
      if (action === 'render.list') return { content: { records: [] } }
      if (action === 'media.import-batch') {
        return { content: {
          outcome: 'unavailable',
          code: 'FFPROBE_UNAVAILABLE',
          currentRevision: project.currentRevision,
          changedIds: []
        } }
      }
      return { content: {} }
    })
    const pickFiles = vi.fn(async () => ({
      outcome: 'selected' as const,
      files: [{
        handleId: mediaHandle, mode: 'read' as const, kind: 'video' as const,
        displayName: 'interview.mp4', mimeType: 'video/mp4', byteSize: 1_024
      }]
    }))
    const release = vi.fn(async () => ({ released: true }))
    const { client } = fakeClient({ executeCommand, pickFiles, release })
    let controller: EditorController | undefined

    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client, capture: (value: EditorController) => { controller = value }
      }))
      await flushAsync()
    })
    const projectReadsBeforeImport = executeCommand.mock.calls.filter(([, args]) =>
      isRecord(args) && args.action === 'project.get'
    ).length

    await act(async () => {
      await controller!.importMedia()
      await flushAsync()
    })

    expect(release).toHaveBeenCalledWith({ resource: 'handle', handleId: mediaHandle })
    expect(controller?.state.project?.currentRevision).toBe(project.currentRevision)
    expect(controller?.state.notices.at(-1)).toMatchObject({
      severity: 'warning',
      messageKey: 'ffprobeUnavailable'
    })
    expect(executeCommand.mock.calls.filter(([, args]) =>
      isRecord(args) && args.action === 'project.get'
    )).toHaveLength(projectReadsBeforeImport + 1)
  })

  it('keeps a failed multi-file import atomic and releases every unbound picker handle', async () => {
    const project = makeViewProject()
    const firstHandle = 'media_batch_first_1234567890'
    const secondHandle = 'media_batch_second_123456789'
    const executeCommand = vi.fn(async (_id: string, args?: JsonValue) => {
      const action = isRecord(args) ? args.action : undefined
      if (action === 'project.list') return { content: { projects: [{
        id: project.id, name: project.name, currentRevision: project.currentRevision,
        updatedAt: project.updatedAt, durationFrames: project.durationFrames
      }] } }
      if (action === 'project.active' || action === 'project.get') return { content: { project } }
      if (action === 'render.list') return { content: { records: [] } }
      if (action === 'media.import-batch') throw new Error('The second media file could not be probed')
      return { content: {} }
    })
    const pickFiles = vi.fn(async () => ({
      outcome: 'selected' as const,
      files: [firstHandle, secondHandle].map((handleId, index) => ({
        handleId, mode: 'read' as const, kind: 'video' as const,
        displayName: `${index + 1}.mp4`, mimeType: 'video/mp4', byteSize: 1_024
      }))
    }))
    const release = vi.fn(async () => ({ released: true }))
    const { client } = fakeClient({ executeCommand, pickFiles, release })
    let controller: EditorController | undefined
    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client, capture: (value: EditorController) => { controller = value }
      }))
      await flushAsync()
    })

    await act(async () => {
      await controller!.importMedia()
      await flushAsync()
    })

    expect(controller?.state.project?.currentRevision).toBe(0)
    expect(executeCommand.mock.calls.filter(([, args]) =>
      isRecord(args) && args.action === 'media.import-batch'
    )).toHaveLength(1)
    expect(executeCommand.mock.calls.find(([, args]) =>
      isRecord(args) && args.action === 'media.import-batch'
    )?.[1]).toMatchObject({
      payload: {
        projectId: project.id,
        expectedRevision: 0,
        items: [{ mediaHandleId: firstHandle }, { mediaHandleId: secondHandle }]
      }
    })
    expect(release).toHaveBeenCalledWith({ resource: 'handle', handleId: firstHandle })
    expect(release).toHaveBeenCalledWith({ resource: 'handle', handleId: secondHandle })
    expect(controller?.state.notices).not.toContainEqual(expect.objectContaining({
      messageKey: 'mediaImportPartial'
    }))
  })

})
