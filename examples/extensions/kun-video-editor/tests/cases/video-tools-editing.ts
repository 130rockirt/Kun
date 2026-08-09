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
  it('exposes bounded raw, project-window, composed, and revision-bound selection inspection', async () => {
    const harness = await projectWithMedia()

    const initialContext = await invoke(harness, 'video-inspect', { action: 'context' })
    expect(initialContext.content).toMatchObject({
      outcome: 'context',
      context: {
        status: 'empty',
        projectId: 'agent-demo',
        revision: 1,
        generation: 0,
        selectedItemIds: []
      }
    })

    const projectWindow = await invoke(harness, 'video-inspect', {
      action: 'project-window',
      projectId: 'agent-demo',
      expectedRevision: 1,
      startFrame: 0,
      endFrame: 90,
      itemLimit: 1,
      captionLimit: 1
    })
    expect(projectWindow.content).toMatchObject({
      outcome: 'project-window',
      window: {
        projectId: 'agent-demo',
        revision: 1,
        sequence: { id: 'sequence-main' },
        requestedRange: { startFrame: 0, endFrame: 90 },
        items: [expect.objectContaining({ assetId: 'interview' })],
        captionSummary: { visible: 0, returned: 0, hidden: 0 },
        hiddenCounts: expect.objectContaining({ itemsInWindow: 0 }),
        selection: { status: 'empty', generation: 0 }
      }
    })
    const compactItem = ((contentObject(projectWindow).window as JsonObject).items as JsonObject[])[0]!
    expect(compactItem).not.toHaveProperty('transform')
    expect(compactItem).not.toHaveProperty('opacity')
    expect(compactItem).not.toHaveProperty('speed')

    const rawBeforeTranscript = await invoke(harness, 'video-inspect', {
      action: 'raw-media',
      projectId: 'agent-demo',
      expectedRevision: 1,
      assetId: 'interview',
      includeWords: true,
      sampleFrames: [0, 30, 30]
    })
    expect(rawBeforeTranscript.content).toMatchObject({
      outcome: 'raw-media',
      inspection: {
        asset: { id: 'interview', availability: 'online' },
        transcript: null,
        samples: [
          { frame: 0, status: 'unavailable' },
          { frame: 30, status: 'unavailable' }
        ],
        capability: {
          timedTranscript: 'missing',
          wordTimestamps: 'missing',
          sampledFrames: 'missing',
          visualUnderstanding: 'not-claimed'
        }
      }
    })

    const composed = await invoke(harness, 'video-inspect', {
      action: 'composed-frame',
      projectId: 'agent-demo',
      expectedRevision: 1,
      frame: 12
    })
    expect(composed.content).toMatchObject({
      outcome: 'composed-frame',
      inspection: {
        projectId: 'agent-demo',
        revision: 1,
        frame: 12,
        frameLabel: '00:00:00:12',
        visibleMediaLayers: [expect.objectContaining({ itemId: expect.any(String) })],
        proofArtifacts: [],
        proofStatus: 'missing'
      }
    })
    expect(composed.metadata).toMatchObject({
      technicallyValidated: false,
      visuallyInspected: false,
      proofStatus: 'missing'
    })

    const loaded = contentObject(await invoke(harness, 'video-project', {
      action: 'get', projectId: 'agent-demo'
    })).project as JsonObject
    const selectedItemId = String((loaded.items as JsonObject[])[0]!.id)
    const updated = await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'context.update',
      payload: {
        projectId: 'agent-demo',
        expectedRevision: 1,
        expectedGeneration: 0,
        sequenceId: 'sequence-main',
        playheadFrame: 12,
        selectedAssetIds: ['interview'],
        selectedItemIds: [selectedItemId],
        selectedCaptionIds: [],
        selectedWordIds: [],
        range: { startFrame: 10, endFrame: 20 }
      }
    })
    expect(updated.content).toMatchObject({
      outcome: 'context-updated',
      projectId: 'agent-demo',
      revision: 1,
      generation: 1,
      eventGeneration: 2,
      selection: {
        playheadFrame: 12,
        selectedAssetIds: ['interview'],
        selectedItemIds: [selectedItemId],
        range: { startFrame: 10, endFrame: 20 }
      }
    })
    expect(harness.webview.messages).toContainEqual({
      channel: 'kun-video-editor.selection-changed',
      payload: expect.objectContaining({
        projectId: 'agent-demo', revision: 1, generation: 1, eventGeneration: 2
      })
    })

    const current = await invoke(harness, 'video-inspect', {
      action: 'context', projectId: 'agent-demo', expectedRevision: 1, expectedGeneration: 1
    })
    expect(current.content).toMatchObject({
      context: {
        status: 'current',
        revision: 1,
        generation: 1,
        selectedItemIds: [selectedItemId]
      }
    })
    const stale = await invoke(harness, 'video-inspect', {
      action: 'context', projectId: 'agent-demo', expectedRevision: 1, expectedGeneration: 0
    })
    expect(stale.content).toMatchObject({
      context: { status: 'stale', staleReason: 'generation', generation: 1 }
    })
    await expect(harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'context.update',
      payload: {
        projectId: 'agent-demo', expectedRevision: 1, expectedGeneration: 0, playheadFrame: 20
      }
    })).rejects.toMatchObject({
      code: 'CONFLICT',
      retryable: true,
      details: {
        engineCode: 'revision_conflict',
        expectedRevision: 1,
        currentRevision: 1,
        expectedGeneration: 0,
        currentGeneration: 1
      }
    })
    const afterSelection = await invoke(harness, 'video-project', {
      action: 'get', projectId: 'agent-demo'
    })
    expect(afterSelection.content).toMatchObject({
      project: { currentRevision: 1, eventGeneration: 2, selection: { generation: 1 } }
    })
    await harness.dispose()
  })

  it('pages timed word evidence after transcript import without claiming sampled visual review', async () => {
    const harness = await projectWithMedia()
    await invoke(harness, 'video-transcribe', {
      projectId: 'agent-demo',
      expectedRevision: 1,
      assetId: 'interview',
      transcriptId: 'transcript-main',
      mode: 'import',
      language: 'en',
      segments: [{
        id: 'segment-main',
        startUs: 0,
        endUs: 3_000_000,
        text: 'Hello video world',
        words: [
          { id: 'word-hello', startUs: 0, endUs: 700_000, text: 'Hello', confidence: 0.98 },
          { id: 'word-video', startUs: 700_000, endUs: 1_500_000, text: 'video', confidence: 0.95 },
          { id: 'word-world', startUs: 1_500_000, endUs: 3_000_000, text: 'world', confidence: 0.93 }
        ]
      }]
    })
    const raw = await invoke(harness, 'video-inspect', {
      action: 'raw-media',
      projectId: 'agent-demo',
      expectedRevision: 2,
      assetId: 'interview',
      transcriptId: 'transcript-main',
      segmentOffset: 0,
      segmentLimit: 1,
      includeWords: true,
      sampleFrames: [0]
    })
    expect(raw.content).toMatchObject({
      inspection: {
        transcript: {
          id: 'transcript-main',
          offset: 0,
          returned: 1,
          total: 1,
          wordsReturned: 3,
          wordsHidden: 0,
          segments: [{
            id: 'segment-main',
            words: expect.arrayContaining([
              expect.objectContaining({ id: 'word-hello', startUs: 0 })
            ])
          }]
        },
        capability: {
          timedTranscript: 'ready',
          wordTimestamps: 'ready',
          sampledFrames: 'missing',
          visualUnderstanding: 'not-claimed'
        }
      }
    })
    await harness.dispose()
  })

  it('generates rich transcript captions as one revision-bound View transaction', async () => {
    const harness = await projectWithMedia()
    await invoke(harness, 'video-transcribe', {
      projectId: 'agent-demo',
      expectedRevision: 1,
      assetId: 'interview',
      transcriptId: 'transcript-captions',
      mode: 'import',
      language: 'en',
      segments: [{
        id: 'segment-captions',
        startUs: 0,
        endUs: 3_000_000,
        text: 'Hello caption world',
        words: [
          { id: 'word-caption-hello', startUs: 0, endUs: 800_000, text: 'Hello' },
          { id: 'word-caption-caption', startUs: 800_000, endUs: 1_800_000, text: 'caption' },
          { id: 'word-caption-world', startUs: 1_800_000, endUs: 3_000_000, text: 'world' }
        ]
      }]
    })
    const generated = await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'caption.generate',
      payload: {
        projectId: 'agent-demo',
        expectedRevision: 2,
        assetId: 'interview',
        trackId: 'captions-1',
        idPrefix: 'generated-caption',
        maxWords: 2,
        style: {
          fontSize: 40,
          color: '#FFFFFF',
          background: '#000000',
          fontFamily: 'sans-serif',
          fontWeight: 600,
          maxWidthRatio: 0.8
        },
        animation: { kind: 'word-highlight', durationFrames: 4 }
      }
    })
    expect(generated.content).toMatchObject({
      outcome: 'generated',
      projectId: 'agent-demo',
      previousRevision: 2,
      currentRevision: 3,
      generatedCount: 2,
      interpolatedWordCount: 0,
      receipt: {
        previousRevision: 2,
        newRevision: 3,
        attribution: { author: 'manual', sourceOperation: 'caption.generate' }
      },
      captions: expect.arrayContaining([expect.objectContaining({
        source: expect.objectContaining({
          transcriptId: 'transcript-captions', segmentIds: ['segment-captions']
        }),
        animation: { kind: 'word-highlight', durationFrames: 4 }
      })])
    })
    const durable = JSON.parse(await readFile(join(
      harness.context.workspaceContext!.root,
      '.kun-video/projects/agent-demo/project.json'
    ), 'utf8'))
    expect(durable.currentRevision).toBe(3)
    expect(durable.revisions.at(-1)).toMatchObject({
      parentRevision: 2,
      author: 'manual',
      sourceOperation: 'caption.generate'
    })
    expect(durable.captions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceTranscriptId: 'transcript-captions',
        sourceSegmentIds: ['segment-captions'],
        style: expect.objectContaining({ fontFamily: 'sans-serif', fontWeight: 600, maxWidthRatio: 0.8 }),
        words: expect.arrayContaining([expect.objectContaining({ sourceWordId: 'word-caption-hello' })]),
        animation: { kind: 'word-highlight', durationFrames: 4 }
      })
    ]))
    expect(harness.webview.messages).toContainEqual({
      channel: 'kun-video-editor.project-changed',
      payload: expect.objectContaining({
        projectId: 'agent-demo',
        revision: 3,
        reason: 'captions-generated',
        receipt: expect.objectContaining({ newRevision: 3 })
      })
    })
    await harness.dispose()
  })

  it('imports timed transcripts, exposes a revision-bound script, and rejects stale script edits', async () => {
    const harness = await projectWithMedia()
    const transcript = await invoke(harness, 'video-transcribe', {
      projectId: 'agent-demo',
      expectedRevision: 1,
      assetId: 'interview',
      transcriptId: 'transcript-main',
      mode: 'import',
      language: 'en',
      segments: [
        { id: 'hello', startUs: 0, endUs: 1_000_000, text: 'Hello' },
        { id: 'filler', startUs: 1_000_000, endUs: 1_400_000, text: 'um' },
        { id: 'world', startUs: 1_400_000, endUs: 3_000_000, text: 'world' }
      ]
    })
    expect(transcript.content).toMatchObject({
      outcome: 'transcribed', currentRevision: 2, changedIds: ['interview', 'transcript-main']
    })
    expect(JSON.stringify(transcript.content)).toContain('without network access')

    const script = await invoke(harness, 'video-read-script', {
      projectId: 'agent-demo', expectedRevision: 2
    })
    expect(script.content).toMatchObject({ outcome: 'script', currentRevision: 2, truncated: false })
    const markdown = String(contentObject(script).timelineMarkdown)
    expect(markdown).toContain('| `filler` |')

    await invoke(harness, 'video-update-timeline', {
      projectId: 'agent-demo',
      expectedRevision: 2,
      operations: [{ type: 'set-canvas', preset: '9:16', fit: 'pad' }]
    })
    await expect(invoke(harness, 'video-apply-script', {
      projectId: 'agent-demo',
      expectedRevision: 2,
      timelineMarkdown: markdown,
      ranges: [{ assetId: 'interview', startUs: 1_000_000, endUs: 1_400_000, reason: 'filler' }]
    })).rejects.toMatchObject({ code: 'CONFLICT', details: { engineCode: 'revision_conflict' } })
    await harness.dispose()
  })

  it('requires continuous timed evidence before destructive Agent transcript edits', async () => {
    const harness = await projectWithMedia()
    await expect(invoke(harness, 'video-apply-script', {
      projectId: 'agent-demo',
      expectedRevision: 1,
      timelineMarkdown: '# timeline\n',
      ranges: [{ assetId: 'interview', startUs: 0, endUs: 500_000, reason: 'selection' }]
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(invoke(harness, 'video-apply-script', {
      projectId: 'agent-demo',
      expectedRevision: 1,
      timelineMarkdown: '# timeline\n',
      ranges: [{ assetId: 'interview', startUs: 0, endUs: 500_000, reason: 'selection' }]
    })).rejects.toThrow(/continuous timed transcript evidence/u)
    const loaded = await invoke(harness, 'video-project', { action: 'get', projectId: 'agent-demo' })
    expect(loaded.content).toMatchObject({ project: { currentRevision: 1 } })
    await harness.dispose()
  })

  it('returns attributable receipts and fences Agent undo after intervening manual work', async () => {
    const harness = await projectWithMedia()
    const agentEdit = await invoke(harness, 'video-update-timeline', {
      projectId: 'agent-demo',
      expectedRevision: 1,
      operations: [{ type: 'set-canvas', preset: '9:16', fit: 'pad' }],
      summary: 'Agent portrait edit'
    })
    expect(agentEdit.content).toMatchObject({
      outcome: 'updated',
      previousRevision: 1,
      currentRevision: 2,
      receipt: {
        previousRevision: 1,
        newRevision: 2,
        generation: 2,
        attribution: {
          author: 'agent',
          actorId: 'kun-agent',
          sourceOperation: 'video-update-timeline'
        },
        proofInvalidated: true
      }
    })
    expect(harness.webview.messages).toContainEqual({
      channel: 'kun-video-editor.project-changed',
      payload: expect.objectContaining({
        projectId: 'agent-demo',
        revision: 2,
        generation: 2,
        selectionGeneration: 0,
        attribution: expect.objectContaining({ author: 'agent', actorId: 'kun-agent' }),
        proofInvalidated: true,
        receipt: expect.objectContaining({ newRevision: 2 })
      })
    })

    const undone = await invoke(harness, 'video-undo', {
      projectId: 'agent-demo', expectedRevision: 2
    })
    expect(undone.content).toMatchObject({
      outcome: 'undone', previousRevision: 2, currentRevision: 3,
      receipt: { attribution: { author: 'agent', actorId: 'kun-agent', sourceOperation: 'history.agent-undo' } }
    })
    const restored = await invoke(harness, 'video-project', { action: 'get', projectId: 'agent-demo' })
    expect(restored.content).toMatchObject({ project: { currentRevision: 3, canvas: { preset: '16:9' } } })

    await invoke(harness, 'video-update-timeline', {
      projectId: 'agent-demo',
      expectedRevision: 3,
      operations: [{ type: 'set-canvas', preset: '9:16', fit: 'pad' }]
    })
    await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'project.update',
      payload: {
        projectId: 'agent-demo',
        expectedRevision: 4,
        operations: [{ type: 'set-canvas', preset: '1:1', fit: 'crop' }],
        summary: 'Manual square edit'
      }
    })
    await expect(invoke(harness, 'video-undo', {
      projectId: 'agent-demo', expectedRevision: 5
    })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      retryable: false,
      details: { engineCode: 'agent_undo_fenced' }
    })
    const preserved = await invoke(harness, 'video-project', { action: 'get', projectId: 'agent-demo' })
    expect(preserved.content).toMatchObject({
      project: { currentRevision: 5, canvas: { preset: '1:1', fit: 'crop' } }
    })
    await harness.dispose()
  })

  it('serializes manual/Agent races and never overwrites a stale expected revision', async () => {
    const harness = await projectWithMedia()
    const first = invoke(harness, 'video-update-timeline', {
      projectId: 'agent-demo',
      expectedRevision: 1,
      operations: [{ type: 'set-canvas', preset: '9:16', fit: 'pad' }],
      summary: 'Portrait cut'
    })
    const second = invoke(harness, 'video-update-timeline', {
      projectId: 'agent-demo',
      expectedRevision: 1,
      operations: [{ type: 'set-canvas', preset: '1:1', fit: 'crop' }],
      summary: 'Square cut'
    })
    const outcomes = await Promise.allSettled([first, second])
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.find(({ status }) => status === 'rejected')
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { code: 'CONFLICT', details: { engineCode: 'revision_conflict' } }
    })
    const loaded = await invoke(harness, 'video-project', { action: 'get', projectId: 'agent-demo' })
    expect(loaded.content).toMatchObject({ project: { currentRevision: 2 } })
    await harness.dispose()
  })

  it('offers one bounded View RPC and records manual provenance with shared undo history', async () => {
    const harness = await projectWithMedia()
    const updated = await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'project.update',
      payload: {
        projectId: 'agent-demo',
        expectedRevision: 1,
        operations: [{ type: 'set-canvas', preset: '9:16', fit: 'pad' }],
        summary: 'Manual portrait edit'
      }
    })
    expect(updated.content).toMatchObject({ outcome: 'updated', currentRevision: 2 })
    const projectAfterUpdate = JSON.parse(await readFile(join(
      harness.context.workspaceContext!.root,
      '.kun-video/projects/agent-demo/project.json'
    ), 'utf8'))
    expect(projectAfterUpdate.revisions.at(-1)).toMatchObject({
      author: 'manual', sourceOperation: 'video-update-timeline'
    })

    const undone = await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'project.undo',
      payload: { projectId: 'agent-demo', expectedRevision: 2 }
    })
    expect(undone.content).toMatchObject({ outcome: 'undone', currentRevision: 3 })
    const projectAfterUndo = JSON.parse(await readFile(join(
      harness.context.workspaceContext!.root,
      '.kun-video/projects/agent-demo/project.json'
    ), 'utf8'))
    expect(projectAfterUndo).toMatchObject({ canvas: { preset: '16:9' }, currentRevision: 3 })
    expect(projectAfterUndo.revisions.at(-1)).toMatchObject({ author: 'manual', sourceOperation: 'history.undo' })
    await harness.dispose()
  })

  it('accepts schema-v2 track, item, and link operations through the strict Host boundary', async () => {
    const harness = await projectWithMedia()
    const addedItem = {
      id: 'item-interview-linked',
      assetId: 'interview',
      trackId: 'video-1',
      timelineStartFrame: 90,
      durationFrames: 90,
      sourceStartUs: 0,
      sourceEndUs: 3_000_000,
      speed: { numerator: 1, denominator: 1 },
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      opacity: 1,
      fadeInFrames: 3,
      fadeOutFrames: 4,
      crop: { left: 0.05, top: 0, right: 0.05, bottom: 0 },
      volume: 1.25,
      muted: false,
      visible: true,
      locked: false,
      effects: [{ id: 'effect-interview', type: 'blur', enabled: false, parameters: { radius: 2 } }],
      keyframes: [{
        id: 'keyframes-interview',
        property: 'opacity',
        interpolation: 'linear',
        points: [
          { id: 'point-interview-0', frame: 0, value: 0.5 },
          { id: 'point-interview-1', frame: 30, value: 1 }
        ]
      }]
    }
    const updated = await invoke(harness, 'video-update-timeline', {
      projectId: 'agent-demo',
      expectedRevision: 1,
      operations: [
        { type: 'add-item', item: addedItem },
        {
          type: 'set-link-group',
          group: {
            id: 'link-interview', kind: 'sync',
            itemIds: ['item-interview', 'item-interview-linked'], locked: false
          }
        },
        { type: 'update-track-state', trackId: 'video-1', muted: true, syncLocked: true },
        {
          type: 'update-item-properties', itemId: 'item-interview',
          volume: 0.75, fadeInFrames: 2, fadeOutFrames: 5, muted: true, visible: false, locked: true
        }
      ]
    })
    expect(updated.content).toMatchObject({ outcome: 'updated', currentRevision: 2 })
    const durable = JSON.parse(await readFile(join(
      harness.context.workspaceContext!.root,
      '.kun-video/projects/agent-demo/project.json'
    ), 'utf8'))
    expect(durable.tracks.find(({ id }: { id: string }) => id === 'video-1')).toMatchObject({
      muted: true, syncLocked: true
    })
    expect(durable.items.find(({ id }: { id: string }) => id === 'item-interview')).toMatchObject({
      volume: 0.75, muted: true, visible: false, locked: true
    })
    expect(durable.items.find(({ id }: { id: string }) => id === 'item-interview-linked')).toMatchObject({
      crop: { left: 0.05, right: 0.05 },
      effects: [{ id: 'effect-interview' }],
      keyframes: [{ id: 'keyframes-interview' }]
    })
    expect(durable.linkGroups).toContainEqual(expect.objectContaining({
      id: 'link-interview', itemIds: ['item-interview', 'item-interview-linked']
    }))

    const removed = await invoke(harness, 'video-update-timeline', {
      projectId: 'agent-demo', expectedRevision: 2,
      operations: [
        { type: 'update-item-properties', itemId: 'item-interview', locked: false },
        { type: 'delete-link-group', linkGroupId: 'link-interview' }
      ]
    })
    expect(removed.content).toMatchObject({ outcome: 'updated', currentRevision: 3 })
    await harness.dispose()
  })

})
