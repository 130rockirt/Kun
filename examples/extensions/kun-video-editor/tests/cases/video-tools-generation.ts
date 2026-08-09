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
  it('reports generation honestly unavailable by default without disturbing ordinary editing', async () => {
    const harness = await activatedHarness()
    await invoke(harness, 'video-project', {
      action: 'create', projectId: 'generation-unavailable', name: 'Generation unavailable'
    })

    const catalog = await invoke(harness, 'video-generation-catalog', {})
    expect(catalog.content).toMatchObject({
      outcome: 'unavailable',
      catalog: { schemaVersion: 1, providers: [] },
      message: expect.stringContaining('No approved generation broker')
    })
    const request = await invoke(harness, 'video-generation-request', {
      task: 'video',
      projectId: 'generation-unavailable',
      projectRevision: 0,
      providerId: 'unconfigured-provider',
      modelId: 'unconfigured-video',
      prompt: 'A bounded test clip',
      referenceAssetIds: [],
      variants: 1,
      output: { kind: 'video' },
      outputPolicy: 'resolve-placeholder',
      idempotencyKey: 'generation-unavailable-request',
      consent: {
        providerPermissionApproved: false,
        mediaUploadApproved: false,
        costApproved: false,
        approvedMaximumMinor: 0,
        currency: 'USD',
        confirmedAt: '2026-07-14T00:00:00.000Z'
      }
    })
    expect(request.content).toMatchObject({ outcome: 'unavailable' })
    const loaded = await invoke(harness, 'video-project', {
      action: 'get', projectId: 'generation-unavailable', expectedRevision: 0
    })
    expect(loaded.content).toMatchObject({
      outcome: 'loaded',
      project: { currentRevision: 0, counts: { assets: 0, items: 0 } }
    })
    await harness.dispose()
  })

  it('persists an authorized generated variant and inserts it into the revision-fenced timeline', async () => {
    let completed = false
    let currentGenerationExecutionId = ''
    const broker: GenerationExecutionBroker = {
      catalog: async () => generationCatalogFixture(),
      authorize: async (challenge) => generationAuthorization(challenge),
      prepare: async (request) => {
        currentGenerationExecutionId = String(request.executionId)
        return generationBrokerSnapshot(request, 'prepared')
      },
      recover: async () => undefined,
      dispatch: async (_jobId, owner) => generationBrokerSnapshot({
        executionId: currentGenerationExecutionId,
        owner
      }, 'running'),
      status: async (_jobId, owner) => generationBrokerSnapshot({
        executionId: currentGenerationExecutionId,
        owner
      }, completed ? 'completed' : 'running', completed ? generationOutputFixture() : undefined),
      cancel: async (_jobId, owner) => generationBrokerSnapshot({
        executionId: currentGenerationExecutionId,
        owner
      }, 'cancelled'),
      verifyOutputs: async () => generationOutputFixture()
    }
    const { harness, tools } = await generationHarness(broker)
    await invoke(harness, 'video-project', {
      action: 'create', projectId: 'generation-demo', name: 'Generation Demo'
    })
    const sourceHandle = 'generation_reference_0001'
    harness.media.addHandle(mediaHandle(sourceHandle, 'read', 'reference.mp4', 'video'))
    harness.media.setProbe(sourceHandle, videoProbe(sourceHandle))
    await invoke(harness, 'video-probe', {
      projectId: 'generation-demo',
      expectedRevision: 0,
      mediaHandleId: sourceHandle,
      assetId: 'reference'
    })

    const requested = contentObject(await invoke(harness, 'video-generation-request', {
      task: 'video',
      projectId: 'generation-demo',
      projectRevision: 1,
      providerId: 'remote-provider',
      modelId: 'remote-video',
      prompt: 'Create a calm five-second intro',
      referenceAssetIds: ['reference'],
      variants: 1,
      output: { kind: 'video', width: 1_920, height: 1_080, durationUs: 5_000_000 },
      outputPolicy: 'resolve-placeholder',
      idempotencyKey: 'generation-timeline-request',
      consent: {
        providerPermissionApproved: true,
        mediaUploadApproved: true,
        costApproved: true,
        approvedMaximumMinor: 25,
        currency: 'USD',
        confirmedAt: '2026-07-14T00:00:00.000Z'
      }
    }))
    expect(requested).toMatchObject({ outcome: 'queued', record: { state: 'running' } })
    const record = requested.record as JsonObject
    completed = true

    const status = contentObject(await invoke(harness, 'video-generation-status', {
      action: 'status',
      projectId: 'generation-demo',
      recordId: String(record.id)
    }))
    expect(status).toMatchObject({
      outcome: 'status',
      state: 'ready',
      outputs: [{ id: 'variant-primary', primary: true }]
    })
    expect(JSON.stringify(status)).not.toMatch(/Create a calm|generation_output_handle|completion-primary|authorization_/u)

    const inserted = await tools.editorRequest({
      action: 'generation.insert',
      payload: {
        projectId: 'generation-demo',
        expectedRevision: 1,
        recordId: String(record.id),
        outputId: 'variant-primary',
        addToTimeline: true,
        timelineStartFrame: 150,
        stillDurationFrames: 150
      }
    }) as ToolResult
    expect(inserted.content).toMatchObject({
      outcome: 'inserted',
      previousRevision: 1,
      currentRevision: 2,
      asset: {
        kind: 'video',
        generatedLineage: {
          providerId: 'remote-provider',
          modelId: 'remote-video',
          promptDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
          referenceAssetIds: ['reference']
        }
      }
    })
    const insertedJson = JSON.stringify(inserted)
    expect(insertedJson).not.toMatch(/Create a calm|generation_output_handle|completion-primary|authorization_|https?:\/\//u)

    const loaded = contentObject(await invoke(harness, 'video-project', {
      action: 'get', projectId: 'generation-demo', expectedRevision: 2
    }))
    expect(loaded).toMatchObject({
      project: {
        currentRevision: 2,
        counts: { assets: 2, items: 2 },
        assets: expect.arrayContaining([expect.objectContaining({
          generatedLineage: expect.objectContaining({ promptDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) })
        })])
      }
    })
    await harness.dispose()
  })

  it('atomically materializes every owned multi-output variant and stays idempotent', async () => {
    let completed = false
    let currentGenerationExecutionId = ''
    const outputs = multiGenerationOutputFixture()
    const broker: GenerationExecutionBroker = {
      catalog: async () => generationCatalogFixture(),
      authorize: async (challenge) => generationAuthorization(challenge),
      prepare: async (request) => {
        currentGenerationExecutionId = String(request.executionId)
        return generationBrokerSnapshot(request, 'prepared')
      },
      recover: async () => undefined,
      dispatch: async (_jobId, owner) => generationBrokerSnapshot({
        executionId: currentGenerationExecutionId,
        owner
      }, 'running'),
      status: async (_jobId, owner) => generationBrokerSnapshot({
        executionId: currentGenerationExecutionId,
        owner
      }, completed ? 'completed' : 'running', completed ? outputs : undefined),
      cancel: async (_jobId, owner) => generationBrokerSnapshot({
        executionId: currentGenerationExecutionId,
        owner
      }, 'cancelled'),
      verifyOutputs: async () => outputs
    }
    const { harness } = await generationHarness(broker)
    await invoke(harness, 'video-project', {
      action: 'create', projectId: 'generation-variants', name: 'Generation Variants'
    })
    const sourceHandle = 'generation_variants_reference_0001'
    harness.media.addHandle(mediaHandle(sourceHandle, 'read', 'reference.mp4', 'video'))
    harness.media.setProbe(sourceHandle, videoProbe(sourceHandle))
    await invoke(harness, 'video-probe', {
      projectId: 'generation-variants',
      expectedRevision: 0,
      mediaHandleId: sourceHandle,
      assetId: 'reference'
    })
    const requested = contentObject(await invoke(harness, 'video-generation-request', {
      task: 'video',
      projectId: 'generation-variants',
      projectRevision: 1,
      providerId: 'remote-provider',
      modelId: 'remote-video',
      prompt: 'Generate two private review variants',
      referenceAssetIds: ['reference'],
      variants: 2,
      output: { kind: 'video', width: 1_920, height: 1_080, durationUs: 5_000_000 },
      outputPolicy: 'add-variants',
      idempotencyKey: 'generation-multi-output-request',
      consent: {
        providerPermissionApproved: true,
        mediaUploadApproved: true,
        costApproved: true,
        approvedMaximumMinor: 50,
        currency: 'USD',
        confirmedAt: '2026-07-14T00:00:00.000Z'
      }
    }))
    const record = requested.record as JsonObject

    await invoke(harness, 'video-project', {
      action: 'create', projectId: 'generation-other-project', name: 'Other Project'
    })
    await expect(invoke(harness, 'video-generation-status', {
      action: 'status',
      projectId: 'generation-other-project',
      recordId: String(record.id)
    })).rejects.toThrow(/not owned by this project/u)

    completed = true
    const status = contentObject(await invoke(harness, 'video-generation-status', {
      action: 'status',
      projectId: 'generation-variants',
      recordId: String(record.id)
    }))
    expect(status).toMatchObject({
      outcome: 'status',
      state: 'ready',
      outputPolicy: 'add-variants',
      outputs: [
        expect.objectContaining({ id: 'variant-primary', primary: true }),
        expect.objectContaining({ id: 'variant-secondary', primary: false })
      ]
    })
    const materialized = contentObject(await invoke(harness, 'video-project', {
      action: 'get', projectId: 'generation-variants', expectedRevision: 2
    }))
    expect(materialized).toMatchObject({
      project: {
        currentRevision: 2,
        counts: { assets: 3, items: 1 },
        assets: expect.arrayContaining([
          expect.objectContaining({
            id: 'generated-primary',
            generatedLineage: expect.objectContaining({
              providerId: 'remote-provider',
              modelId: 'remote-video',
              jobId: 'job_generation_tools_0001',
              promptDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
              referenceAssetIds: ['reference'],
              variantOfAssetId: null
            })
          }),
          expect.objectContaining({
            id: 'generated-secondary',
            generatedLineage: expect.objectContaining({
              jobId: 'job_generation_tools_0001',
              variantOfAssetId: 'generated-primary'
            })
          })
        ])
      }
    })
    const safeProjection = JSON.stringify(status)
    expect(safeProjection).not.toMatch(
      /Generate two private|generation_output_handle|completion-(?:primary|secondary)|host-account|https?:\/\/|\/Users\//u
    )
    expect(JSON.stringify(materialized)).not.toMatch(/Generate two private|completion-(?:primary|secondary)|host-account|https?:\/\/|\/Users\//u)

    await invoke(harness, 'video-generation-status', {
      action: 'status',
      projectId: 'generation-variants',
      recordId: String(record.id)
    })
    const repeated = contentObject(await invoke(harness, 'video-project', {
      action: 'get', projectId: 'generation-variants', expectedRevision: 2
    }))
    expect(repeated).toMatchObject({ project: { currentRevision: 2, counts: { assets: 3, items: 1 } } })
    await harness.dispose()
  })

  it('fences automatic multi-output materialization and bulk-inserts variants explicitly', async () => {
    let completed = false
    let currentGenerationExecutionId = ''
    const outputs = multiGenerationOutputFixture()
    const broker: GenerationExecutionBroker = {
      catalog: async () => generationCatalogFixture(),
      authorize: async (challenge) => generationAuthorization(challenge),
      prepare: async (request) => {
        currentGenerationExecutionId = String(request.executionId)
        return generationBrokerSnapshot(request, 'prepared')
      },
      recover: async () => undefined,
      dispatch: async (_jobId, owner) => generationBrokerSnapshot({
        executionId: currentGenerationExecutionId,
        owner
      }, 'running'),
      status: async (_jobId, owner) => generationBrokerSnapshot({
        executionId: currentGenerationExecutionId,
        owner
      }, completed ? 'completed' : 'running', completed ? outputs : undefined),
      cancel: async (_jobId, owner) => generationBrokerSnapshot({
        executionId: currentGenerationExecutionId,
        owner
      }, 'cancelled'),
      verifyOutputs: async () => outputs
    }
    const { harness, tools } = await generationHarness(broker)
    await invoke(harness, 'video-project', {
      action: 'create', projectId: 'generation-fenced', name: 'Generation Fenced'
    })
    const firstHandle = 'generation_fenced_reference_0001'
    harness.media.addHandle(mediaHandle(firstHandle, 'read', 'reference.mp4', 'video'))
    harness.media.setProbe(firstHandle, videoProbe(firstHandle))
    await invoke(harness, 'video-probe', {
      projectId: 'generation-fenced', expectedRevision: 0,
      mediaHandleId: firstHandle, assetId: 'reference'
    })
    const requested = contentObject(await invoke(harness, 'video-generation-request', {
      task: 'video',
      projectId: 'generation-fenced',
      projectRevision: 1,
      providerId: 'remote-provider',
      modelId: 'remote-video',
      prompt: 'Generate two fenced variants',
      referenceAssetIds: ['reference'],
      variants: 2,
      output: { kind: 'video', width: 1_920, height: 1_080, durationUs: 5_000_000 },
      outputPolicy: 'resolve-placeholder',
      idempotencyKey: 'generation-fenced-multi-output',
      consent: {
        providerPermissionApproved: true,
        mediaUploadApproved: true,
        costApproved: true,
        approvedMaximumMinor: 50,
        currency: 'USD',
        confirmedAt: '2026-07-14T00:00:00.000Z'
      }
    }))
    const record = requested.record as JsonObject
    const placeholder = record.placeholder as JsonObject

    const interveningHandle = 'generation_fenced_intervening_01'
    harness.media.addHandle(mediaHandle(interveningHandle, 'read', 'intervening.mp4', 'video'))
    harness.media.setProbe(interveningHandle, videoProbe(interveningHandle))
    await invoke(harness, 'video-probe', {
      projectId: 'generation-fenced', expectedRevision: 1,
      mediaHandleId: interveningHandle, assetId: 'intervening'
    })
    completed = true
    await invoke(harness, 'video-generation-status', {
      action: 'status', projectId: 'generation-fenced', recordId: String(record.id)
    })
    const fenced = contentObject(await invoke(harness, 'video-project', {
      action: 'get', projectId: 'generation-fenced', expectedRevision: 2
    }))
    expect(fenced).toMatchObject({ project: { currentRevision: 2, counts: { assets: 2, items: 2 } } })

    const inserted = await tools.editorRequest({
      action: 'generation.insert',
      payload: {
        projectId: 'generation-fenced',
        expectedRevision: 2,
        recordId: String(record.id),
        outputId: 'variant-secondary',
        addToTimeline: false
      }
    }) as ToolResult
    expect(inserted.content).toMatchObject({
      outcome: 'inserted',
      previousRevision: 2,
      currentRevision: 3,
      materializedVariantCount: 2,
      addedToTimeline: false
    })
    const loaded = contentObject(await invoke(harness, 'video-project', {
      action: 'get', projectId: 'generation-fenced', expectedRevision: 3
    }))
    expect(loaded).toMatchObject({
      project: {
        currentRevision: 3,
        counts: { assets: 4, items: 2 },
        assets: expect.arrayContaining([
          expect.objectContaining({ id: String(placeholder.assetId) }),
          expect.objectContaining({
            id: 'generated-secondary',
            generatedLineage: expect.objectContaining({ variantOfAssetId: String(placeholder.assetId) })
          })
        ])
      }
    })
    const repeated = await tools.editorRequest({
      action: 'generation.insert',
      payload: {
        projectId: 'generation-fenced',
        expectedRevision: 3,
        recordId: String(record.id),
        outputId: 'variant-secondary',
        addToTimeline: false
      }
    }) as ToolResult
    expect(repeated.content).toMatchObject({
      outcome: 'already-in-project',
      currentRevision: 3,
      materializedVariantCount: 2
    })
    expect(JSON.stringify({ inserted, repeated })).not.toMatch(
      /Generate two fenced|generation_output_handle|completion-(?:primary|secondary)|host-account|https?:\/\/|\/Users\//u
    )
    expect(JSON.stringify(loaded)).not.toMatch(/Generate two fenced|completion-(?:primary|secondary)|host-account|https?:\/\/|\/Users\//u)
    await harness.dispose()
  })

  it('creates and reads bounded projects, imports media, and publishes derived-media jobs', async () => {
    const harness = await activatedHarness()
    const created = await invoke(harness, 'video-project', {
      action: 'create', projectId: 'agent-demo', name: 'Agent Demo'
    })
    expect(created.content).toMatchObject({
      outcome: 'created',
      project: {
        id: 'agent-demo',
        currentRevision: 0,
        canUndo: false,
        canRedo: false
      },
      truncated: false
    })
    const active = await invoke(harness, 'video-project', { action: 'active' })
    expect(active.content).toMatchObject({
      outcome: 'active',
      project: { id: 'agent-demo', currentRevision: 0 }
    })

    const sourceHandle = 'fake_media_source_0001'
    const thumbnailHandle = 'fake_media_thumb_0001'
    const waveformHandle = 'fake_media_wave_00001'
    harness.media.queueFileSelection(mediaHandle(sourceHandle, 'read', 'interview.mp4', 'video'))
    harness.media.addHandle(mediaHandle(thumbnailHandle, 'export', 'thumb.png', 'image'))
    harness.media.addHandle(mediaHandle(waveformHandle, 'export', 'wave.png', 'image'))
    harness.media.setProbe(sourceHandle, videoProbe(sourceHandle))
    const imported = await invoke(harness, 'video-probe', {
      projectId: 'agent-demo',
      expectedRevision: 0,
      assetId: 'interview',
      thumbnailOutputHandleId: thumbnailHandle,
      waveformOutputHandleId: waveformHandle
    })
    expect(imported.content).toMatchObject({
      outcome: 'imported',
      projectId: 'agent-demo',
      currentRevision: 1,
      asset: { id: 'interview', mediaHandleId: sourceHandle },
      jobs: [{ purpose: 'thumbnail' }, { purpose: 'waveform' }]
    })
    expect(JSON.stringify(imported)).not.toContain(harness.context.workspaceContext!.root)

    const loaded = await invoke(harness, 'video-project', {
      action: 'get', projectId: 'agent-demo', expectedRevision: 1
    })
    expect(loaded.content).toMatchObject({
      outcome: 'loaded',
      project: {
        counts: { assets: 1, items: 1 },
        currentRevision: 1,
        playback: {
          mode: 'source-fast-path',
          sourceAssetId: 'interview',
          irDigest: expect.stringMatching(/^[a-f0-9]{64}$/u)
        }
      }
    })
    await harness.dispose()
  })

})
