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
  it('releases selected export handles when the Host reports a normal capability failure', async () => {
    const project = makeViewProject()
    const outputHandle = 'media_export_unavailable_1234'
    const executeCommand = vi.fn(async (_id: string, args?: JsonValue) => {
      const action = isRecord(args) ? args.action : undefined
      if (action === 'project.list') return { content: { projects: [{
        id: project.id, name: project.name, currentRevision: project.currentRevision,
        updatedAt: project.updatedAt, durationFrames: project.durationFrames
      }] } }
      if (action === 'project.active' || action === 'project.get') return { content: { project } }
      if (action === 'render.list') return { content: { records: [] } }
      if (action === 'render.start') {
        return { content: {
          outcome: 'unavailable',
          code: 'ADVANCED_EFFECT_UNSUPPORTED',
          currentRevision: project.currentRevision,
          changedIds: [],
          unsupportedNodes: [{
            nodeId: 'item-interview:effect-blur',
            nodeType: 'effect',
            capability: 'filter:boxblur',
            message: 'Blur is unavailable on the selected backend.',
            guidance: 'Install an FFmpeg build with boxblur or disable this effect.'
          }]
        } }
      }
      return { content: {} }
    })
    const pickSaveTarget = vi.fn(async () => ({
      outcome: 'selected' as const,
      target: {
        handleId: outputHandle, mode: 'write' as const, kind: 'video' as const,
        displayName: 'output.mp4', mimeType: 'video/mp4', byteSize: 0
      }
    }))
    const release = vi.fn(async () => ({ released: true }))
    const { client } = fakeClient({ executeCommand, pickSaveTarget, release })
    let controller: EditorController | undefined
    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client, capture: (value: EditorController) => { controller = value }
      }))
      await flushAsync()
    })

    await act(async () => {
      await controller!.startRender('h264-mp4', 'none')
      await flushAsync()
    })

    expect(release).toHaveBeenCalledWith({ resource: 'handle', handleId: outputHandle })
    expect(controller?.state.renderTickets).toEqual([])
    expect(controller?.state.notices.at(-1)).toMatchObject({
      severity: 'warning',
      messageKey: 'mediaCapabilitiesUnavailable',
      capabilityDetails: [{
        nodeId: 'item-interview:effect-blur',
        nodeType: 'effect',
        capability: 'filter:boxblur',
        message: 'Blur is unavailable on the selected backend.',
        guidance: 'Install an FFmpeg build with boxblur or disable this effect.'
      }]
    })
  })

  it('reconciles a completed durable job when its live terminal event is missed', async () => {
    const project = makeViewProject()
    const runningJob = makeJob('running')
    const completedJob = {
      ...makeJob('completed'),
      updatedAt: '2026-01-01T00:02:00.000Z',
      terminalAt: '2026-01-01T00:02:00.000Z',
      latestCursor: 'cursor_2',
      result: { schemaVersion: 1 as const, generatedArtifacts: [] }
    }
    const executeCommand = vi.fn(async (_id: string, args?: JsonValue) => {
      const action = isRecord(args) ? args.action : undefined
      if (action === 'project.list') return { content: { projects: [{
        id: project.id, name: project.name, currentRevision: project.currentRevision,
        updatedAt: project.updatedAt, durationFrames: project.durationFrames
      }] } }
      if (action === 'project.active' || action === 'project.get') return { content: { project } }
      if (action === 'render.list') return { content: { records: [] } }
      if (action === 'render.start') {
        return { content: {
          outcome: 'queued',
          jobId: runningJob.id,
          pinnedRevision: project.currentRevision,
          renderKind: 'h264-mp4'
        } }
      }
      return { content: {} }
    })
    const getJob = vi.fn()
      .mockResolvedValueOnce(runningJob)
      .mockResolvedValue(completedJob)
    const subscribeJob = vi.fn(async () => ({
      snapshot: runningJob,
      replayGap: false,
      cursor: runningJob.latestCursor,
      complete: false,
      onEvent: () => ({ dispose: () => undefined }),
      dispose: () => undefined
    }))
    const pickSaveTarget = vi.fn(async () => ({
      outcome: 'selected' as const,
      target: {
        handleId: 'media_export_reconcile_1234', mode: 'write' as const, kind: 'video' as const,
        displayName: 'output.mp4', mimeType: 'video/mp4', byteSize: 0
      }
    }))
    const { client } = fakeClient({ executeCommand, getJob, subscribeJob, pickSaveTarget })
    let controller: EditorController | undefined
    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client, capture: (value: EditorController) => { controller = value }
      }))
      await flushAsync()
    })

    vi.useFakeTimers()
    await act(async () => {
      await controller!.startRender('h264-mp4', 'none')
      await flushAsync()
    })
    expect(controller?.state.jobs).toMatchObject([{ id: runningJob.id, state: 'running' }])

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
      await flushAsync()
    })

    expect(subscribeJob).toHaveBeenCalledWith({
      jobId: runningJob.id,
      afterCursor: runningJob.latestCursor
    })
    expect(getJob).toHaveBeenCalledTimes(2)
    expect(controller?.state.jobs).toMatchObject([{ id: completedJob.id, state: 'completed' }])
  })

  it('registers replay delivery before reading the subscription snapshot', async () => {
    const project = makeViewProject()
    const runningJob = makeJob('running')
    const completedJob = {
      ...makeJob('completed'),
      updatedAt: '2026-01-01T00:02:00.000Z',
      terminalAt: '2026-01-01T00:02:00.000Z',
      latestCursor: 'cursor_2',
      result: { schemaVersion: 1 as const, generatedArtifacts: [] }
    }
    const terminalEvent: JobEvent = {
      schemaVersion: 1,
      jobId: runningJob.id,
      kind: runningJob.kind,
      type: 'completed',
      state: 'completed',
      timestamp: completedJob.updatedAt,
      executionAttempt: completedJob.executionAttempt,
      sequence: 2,
      cursor: completedJob.latestCursor,
      result: completedJob.result
    }
    const executeCommand = vi.fn(async (_id: string, args?: JsonValue) => {
      const action = isRecord(args) ? args.action : undefined
      if (action === 'project.list') return { content: { projects: [{
        id: project.id, name: project.name, currentRevision: project.currentRevision,
        updatedAt: project.updatedAt, durationFrames: project.durationFrames
      }] } }
      if (action === 'project.active' || action === 'project.get') return { content: { project } }
      if (action === 'render.list') return { content: { records: [] } }
      if (action === 'render.start') {
        return { content: {
          outcome: 'queued', jobId: runningJob.id,
          pinnedRevision: project.currentRevision, renderKind: 'h264-mp4'
        } }
      }
      return { content: {} }
    })
    const accessOrder: string[] = []
    let replaySnapshot = runningJob
    const subscribeJob = vi.fn(async () => ({
      get snapshot() {
        accessOrder.push('snapshot')
        return replaySnapshot
      },
      replayGap: false,
      cursor: runningJob.latestCursor,
      complete: false,
      onEvent: (listener: (event: JobEvent) => void) => {
        accessOrder.push('onEvent')
        replaySnapshot = completedJob
        listener(terminalEvent)
        return { dispose: () => undefined }
      },
      dispose: () => undefined
    }))
    const pickSaveTarget = vi.fn(async () => ({
      outcome: 'selected' as const,
      target: {
        handleId: 'media_export_replay_123456', mode: 'write' as const, kind: 'video' as const,
        displayName: 'output.mp4', mimeType: 'video/mp4', byteSize: 0
      }
    }))
    const { client } = fakeClient({
      executeCommand,
      getJob: vi.fn(async () => runningJob),
      subscribeJob,
      pickSaveTarget
    })
    let controller: EditorController | undefined
    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client, capture: (value: EditorController) => { controller = value }
      }))
      await flushAsync()
    })

    await act(async () => {
      await controller!.startRender('h264-mp4', 'none')
      await flushAsync()
    })

    expect(accessOrder.slice(0, 2)).toEqual(['onEvent', 'snapshot'])
    expect(controller?.state.jobs).toMatchObject([{ id: completedJob.id, state: 'completed' }])
  })

  it('does not let a late status read regress a live terminal job event', async () => {
    const project = makeViewProject()
    const runningJob = makeJob('running')
    const staleRunningJob = {
      ...runningJob,
      updatedAt: '2026-01-01T00:03:00.000Z',
      latestCursor: 'cursor_stale'
    }
    const completedJob = {
      ...makeJob('completed'),
      updatedAt: '2026-01-01T00:02:00.000Z',
      terminalAt: '2026-01-01T00:02:00.000Z',
      latestCursor: 'cursor_terminal',
      result: { schemaVersion: 1 as const, generatedArtifacts: [] }
    }
    const terminalEvent: JobEvent = {
      schemaVersion: 1,
      jobId: runningJob.id,
      kind: runningJob.kind,
      type: 'completed',
      state: 'completed',
      timestamp: completedJob.updatedAt,
      executionAttempt: completedJob.executionAttempt,
      sequence: 2,
      cursor: completedJob.latestCursor,
      result: completedJob.result
    }
    const executeCommand = vi.fn(async (_id: string, args?: JsonValue) => {
      const action = isRecord(args) ? args.action : undefined
      if (action === 'project.list') return { content: { projects: [{
        id: project.id, name: project.name, currentRevision: project.currentRevision,
        updatedAt: project.updatedAt, durationFrames: project.durationFrames
      }] } }
      if (action === 'project.active' || action === 'project.get') return { content: { project } }
      if (action === 'render.list') return { content: { records: [] } }
      if (action === 'render.start') {
        return { content: {
          outcome: 'queued', jobId: runningJob.id,
          pinnedRevision: project.currentRevision, renderKind: 'h264-mp4'
        } }
      }
      return { content: {} }
    })
    let resolveLateRead!: (snapshot: typeof staleRunningJob) => void
    const lateRead = new Promise<typeof staleRunningJob>((resolve) => { resolveLateRead = resolve })
    const getJob = vi.fn()
      .mockResolvedValueOnce(runningJob)
      .mockImplementationOnce(async () => await lateRead)
      .mockResolvedValue(completedJob)
    let deliverJobEvent: ((event: JobEvent) => void) | undefined
    const subscribeJob = vi.fn(async () => ({
      snapshot: runningJob,
      replayGap: false,
      cursor: runningJob.latestCursor,
      complete: false,
      onEvent: (listener: (event: JobEvent) => void) => {
        deliverJobEvent = listener
        return { dispose: () => undefined }
      },
      dispose: () => undefined
    }))
    const pickSaveTarget = vi.fn(async () => ({
      outcome: 'selected' as const,
      target: {
        handleId: 'media_export_interleave_1234', mode: 'write' as const, kind: 'video' as const,
        displayName: 'output.mp4', mimeType: 'video/mp4', byteSize: 0
      }
    }))
    const { client } = fakeClient({ executeCommand, getJob, subscribeJob, pickSaveTarget })
    let controller: EditorController | undefined
    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client, capture: (value: EditorController) => { controller = value }
      }))
      await flushAsync()
    })

    vi.useFakeTimers()
    await act(async () => {
      await controller!.startRender('h264-mp4', 'none')
      await flushAsync()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
      await flushAsync()
    })
    expect(getJob).toHaveBeenCalledTimes(2)
    expect(deliverJobEvent).toBeTypeOf('function')

    await act(async () => {
      deliverJobEvent!(terminalEvent)
      resolveLateRead(staleRunningJob)
      await flushAsync()
    })

    expect(controller?.state.jobs).toMatchObject([{ id: completedJob.id, state: 'completed' }])
  })

  it('opens result-preview media from the Host message without loading the full project editor', async () => {
    const openViewResource = vi.fn(async ({ handleId }: { handleId: string }) => ({
      leaseId: `lease_${handleId}`,
      handleId,
      url: `kun-media://lease/${handleId}`,
      mimeType: 'video/mp4',
      expiresAt: '2099-01-01T00:00:00.000Z'
    }))
    const { client, emitMessage } = fakeClient({ openViewResource })
    let controller: EditorController | undefined
    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client, capture: (value: EditorController) => { controller = value }
      }))
      await flushAsync()
    })
    await act(async () => {
      emitMessage({
        channel: 'kun.resultPreview.open',
        payload: {
          schemaVersion: 1, threadId: 'thread-1', turnId: 'turn-1',
          result: {
            sourceId: 'artifact-source', mimeType: 'video/mp4',
            mediaHandleId: 'media_preview_1234567890', availability: 'available'
          }
        }
      })
      await flushAsync()
    })
    expect(controller?.state.resultPreview?.result.sourceId).toBe('artifact-source')
    expect(openViewResource).toHaveBeenCalledWith({ handleId: 'media_preview_1234567890' })
    expect(controller?.state.activeMediaUrl).toContain('kun-media://lease/')
  })

  it('delegates rich caption generation to one revision-bound Host transaction', async () => {
    const project = makeViewProject()
    const executeCommand = vi.fn(async (_id: string, args?: JsonValue) => {
      const action = isRecord(args) ? args.action : undefined
      if (action === 'project.list') return { content: { projects: [{
        id: project.id,
        name: project.name,
        currentRevision: project.currentRevision,
        updatedAt: project.updatedAt,
        durationFrames: project.durationFrames
      }] } }
      if (action === 'project.active' || action === 'project.get') return { content: { project } }
      if (action === 'render.list') return { content: { records: [] } }
      if (action === 'caption.generate') return { content: {
        outcome: 'generated',
        currentRevision: project.currentRevision + 1,
        generatedCount: 3
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

    await act(async () => {
      await controller!.generateCaptions()
      await flushAsync()
    })

    const request = executeCommand.mock.calls.find(([, args]) =>
      isRecord(args) && args.action === 'caption.generate'
    )?.[1]
    expect(request).toMatchObject({
      action: 'caption.generate',
      payload: {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        assetId: project.assets[0]!.id,
        trackId: 'captions-1',
        placement: 'bottom',
        style: { fontSize: 42, maxWidthRatio: 0.84 },
        animation: { kind: 'none' }
      }
    })
    expect(executeCommand.mock.calls.filter(([, args]) =>
      isRecord(args) && args.action === 'project.update'
    )).toHaveLength(0)
    expect(controller?.state.notices.at(-1)).toMatchObject({
      severity: 'info',
      messageKey: 'generatedCaptions',
      messageValues: { count: 3 }
    })
  })

  it('debounces bounded selection context updates and ignores an older selection event', async () => {
    vi.useFakeTimers()
    const project = makeViewProject()
    let selectionGeneration = project.selection.generation
    let eventGeneration = project.eventGeneration
    const executeCommand = vi.fn(async (_id: string, args?: JsonValue) => {
      const request = isRecord(args) ? args : {}
      const action = request.action
      const payload = isRecord(request.payload) ? request.payload : {}
      if (action === 'project.list') {
        return { content: { projects: [{
          id: project.id,
          name: project.name,
          currentRevision: project.currentRevision,
          updatedAt: project.updatedAt,
          durationFrames: project.durationFrames
        }] } }
      }
      if (action === 'project.active' || action === 'project.get') return { content: { project } }
      if (action === 'render.list') return { content: { records: [] } }
      if (action === 'context.update') {
        selectionGeneration += 1
        eventGeneration += 1
        const range = isRecord(payload.range)
          ? { startFrame: Number(payload.range.startFrame), endFrame: Number(payload.range.endFrame) }
          : undefined
        const selection = {
          sequenceId: String(payload.sequenceId),
          revision: project.currentRevision,
          generation: selectionGeneration,
          playheadFrame: Number(payload.playheadFrame),
          selectedAssetIds: payload.selectedAssetIds as string[],
          selectedItemIds: payload.selectedItemIds as string[],
          selectedCaptionIds: payload.selectedCaptionIds as string[],
          selectedWordIds: payload.selectedWordIds as string[],
          ...(range ? { range } : {})
        }
        return { content: {
          outcome: 'context-updated',
          projectId: project.id,
          revision: project.currentRevision,
          generation: selectionGeneration,
          eventGeneration,
          selection
        } }
      }
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
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
      await flushAsync()
    })
    const initialGeneration = controller!.state.project!.selection.generation

    const selectedItemId = project.items[1]!.id
    await act(async () => {
      controller!.selectItem(selectedItemId)
      await flushAsync()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(121)
      await flushAsync()
    })
    const contextCalls = executeCommand.mock.calls.filter(([, args]) =>
      isRecord(args) && args.action === 'context.update'
    )
    expect(contextCalls.length).toBeGreaterThanOrEqual(1)
    expect(contextCalls.at(-1)).toEqual(['editor-request', {
      action: 'context.update',
      payload: {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        expectedGeneration: initialGeneration,
        sequenceId: project.activeSequenceId,
        playheadFrame: 0,
        selectedAssetIds: [project.assets[0]!.id],
        selectedItemIds: [selectedItemId],
        selectedCaptionIds: [],
        selectedWordIds: [],
        range: null
      }
    }])
    const latest = structuredClone(controller!.state.project!.selection)
    expect(latest).toMatchObject({
      generation: initialGeneration + 1,
      selectedItemIds: [selectedItemId]
    })

    await act(async () => {
      emitMessage({
        channel: 'kun-video-editor.selection-changed',
        payload: {
          schemaVersion: 1,
          projectId: project.id,
          revision: project.currentRevision,
          generation: latest.generation - 1,
          eventGeneration: controller!.state.project!.eventGeneration + 1,
          selection: {
            ...latest,
            generation: latest.generation - 1,
            selectedItemIds: []
          }
        }
      })
      await flushAsync()
    })
    expect(controller!.state.project!.selection).toEqual(latest)
  })

})
