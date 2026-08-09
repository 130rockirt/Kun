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
  it('keeps the newest active project when an older project load resolves late', async () => {
    const first = { ...makeViewProject(), id: 'project-first', name: 'First' }
    const second = { ...makeViewProject(), id: 'project-second', name: 'Second' }
    let resolveFirst!: (value: { content: { project: typeof first } }) => void
    const firstLoad = new Promise<{ content: { project: typeof first } }>((resolve) => {
      resolveFirst = resolve
    })
    const executeCommand = vi.fn(async (_id: string, args?: JsonValue) => {
      const request = isRecord(args) ? args : {}
      const action = request.action
      const payload = isRecord(request.payload) ? request.payload : {}
      if (action === 'project.get' && payload.projectId === first.id) return await firstLoad
      if (action === 'project.get' && payload.projectId === second.id) return { content: { project: second } }
      if (action === 'project.list') return { content: { projects: [] } }
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
      emitMessage(projectChangedMessage(first.id))
      await Promise.resolve()
      emitMessage(projectChangedMessage(second.id))
      await flushAsync()
    })
    expect(controller?.state.project?.id).toBe(second.id)
    await act(async () => {
      resolveFirst({ content: { project: first } })
      await flushAsync()
    })
    expect(controller?.state.project?.id).toBe(second.id)
  })

  it('does not let a delayed startup active-project query overwrite a newer active-project event', async () => {
    const startupProject = { ...makeViewProject(), id: 'project-startup', name: 'Startup project' }
    const eventProject = { ...makeViewProject(), id: 'project-event', name: 'Event project' }
    let resolveActive!: (value: { content: { project: typeof startupProject } }) => void
    const activeRequest = new Promise<{ content: { project: typeof startupProject } }>((resolve) => {
      resolveActive = resolve
    })
    const executeCommand = vi.fn(async (_id: string, args?: JsonValue) => {
      const request = isRecord(args) ? args : {}
      const action = request.action
      const payload = isRecord(request.payload) ? request.payload : {}
      if (action === 'project.list') return { content: { projects: [] } }
      if (action === 'render.list') return { content: { records: [] } }
      if (action === 'project.active') return await activeRequest
      if (action === 'project.get' && payload.projectId === eventProject.id) {
        return { content: { project: eventProject } }
      }
      if (action === 'project.get' && payload.projectId === startupProject.id) {
        return { content: { project: startupProject } }
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
      emitMessage(projectChangedMessage(eventProject.id))
      await flushAsync()
    })
    expect(controller?.state.project?.id).toBe(eventProject.id)

    await act(async () => {
      resolveActive({ content: { project: startupProject } })
      await flushAsync()
    })
    expect(controller?.state.project?.id).toBe(eventProject.id)
    expect(executeCommand).not.toHaveBeenCalledWith('editor-request', {
      action: 'project.get',
      payload: { projectId: startupProject.id }
    })
  })

  it('reconciles the active project when its Host notification is missed', async () => {
    vi.useFakeTimers()
    const first = { ...makeViewProject(), id: 'project-first', name: 'First' }
    const second = { ...makeViewProject(), id: 'project-second', name: 'Second' }
    let activeProject = first
    const executeCommand = vi.fn(async (_id: string, args?: JsonValue) => {
      const request = isRecord(args) ? args : {}
      const action = request.action
      const payload = isRecord(request.payload) ? request.payload : {}
      if (action === 'project.list') return { content: { projects: [] } }
      if (action === 'render.list') return { content: { records: [] } }
      if (action === 'project.active') return { content: { project: activeProject } }
      if (action === 'project.get') {
        return { content: { project: payload.projectId === second.id ? second : first } }
      }
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
    expect(controller?.state.project?.id).toBe(first.id)

    activeProject = second
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
      await flushAsync()
    })

    expect(controller?.state.project?.id).toBe(second.id)
    expect(executeCommand).toHaveBeenCalledWith('editor-request', {
      action: 'project.get',
      payload: { projectId: second.id }
    })
  })

  it('routes sequence, media-folder, preview, and Agent-context commands through bounded revision-safe payloads', async () => {
    const project = makeViewProject()
    const previewHistory = {
      schemaVersion: 1 as const,
      generation: 1,
      activeEntryId: 'preview-a',
      entries: [{
        id: 'preview-a',
        projectId: project.id,
        createdAt: '2026-01-01T00:00:00.000Z',
        label: 'Timeline A',
        source: {
          kind: 'timeline' as const,
          sequenceId: project.activeSequenceId,
          revision: project.currentRevision,
          startFrame: 0,
          endFrame: 90
        }
      }, {
        id: 'preview-b',
        projectId: project.id,
        createdAt: '2026-01-01T00:01:00.000Z',
        label: 'Source B',
        source: { kind: 'asset' as const, assetId: project.assets[0]!.id, startUs: 0, endUs: 1_000_000 }
      }]
    }
    const executeCommand = vi.fn(async (_id: string, args?: JsonValue) => {
      const request = isRecord(args) ? args : {}
      const action = request.action
      if (action === 'project.list') return { content: { projects: [{
        id: project.id,
        name: project.name,
        currentRevision: project.currentRevision,
        updatedAt: project.updatedAt,
        durationFrames: project.durationFrames
      }] } }
      if (action === 'project.active' || action === 'project.get') return { content: { project } }
      if (action === 'render.list') return { content: { records: [] } }
      if (action === 'derived.list') return { content: { records: [] } }
      if (action === 'preview.list') return { content: { history: previewHistory } }
      if (action === 'preview.add' || action === 'preview.select') return { content: { history: previewHistory, entry: previewHistory.entries[0] } }
      if (action === 'preview.compare') return { content: {
        history: previewHistory,
        comparison: { leftEntryId: 'preview-a', rightEntryId: 'preview-b', mode: 'wipe', sameRevision: true }
      } }
      if (action === 'context.attach-selection') return { content: {
        attachment: {
          schemaVersion: 1,
          projectId: project.id,
          sequenceId: project.activeSequenceId,
          revision: project.currentRevision,
          selectionGeneration: project.selection.generation,
          playheadFrame: project.selection.playheadFrame,
          selectedAssetIds: project.selection.selectedAssetIds,
          selectedItemIds: project.selection.selectedItemIds,
          selectedCaptionIds: project.selection.selectedCaptionIds,
          selectedWordIds: project.selection.selectedWordIds,
          previewEntryIds: ['preview-a', 'preview-b']
        }
      } }
      return { content: {} }
    })
    const openViewResource = vi.fn(async ({ handleId }: { handleId: string }) => ({
      leaseId: `lease_${handleId}`,
      handleId,
      url: `kun-media://lease/${handleId}`,
      mimeType: 'video/mp4',
      expiresAt: '2099-01-01T00:00:00.000Z'
    }))
    const attachComposerContext = vi.fn(async (request) => ({
      ...request,
      attachmentId: `extension-context:${'a'.repeat(64)}`,
      provenance: {
        extensionId: 'kun-examples.kun-video-editor',
        extensionVersion: '0.1.0',
        viewContributionId: 'extension:kun-examples.kun-video-editor/video-editor',
        workspaceId: 'b'.repeat(64)
      }
    }))
    const { client } = fakeClient({ executeCommand, openViewResource, attachComposerContext })
    let controller: EditorController | undefined
    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client, capture: (value: EditorController) => { controller = value }
      }))
      await flushAsync()
    })
    await act(async () => { await flushAsync() })

    await act(async () => controller!.createSequence('Social cut', true))
    await act(async () => controller!.decomposeNested(project.items[0]!.id))
    await act(async () => controller!.createMediaFolder('Generated takes'))
    await act(async () => controller!.organizeMedia([project.assets[0]!.id, project.assets[0]!.id], 'folder-generated'))
    await act(async () => controller!.addPreview({
      kind: 'timeline',
      sequenceId: project.activeSequenceId,
      revision: project.currentRevision,
      startFrame: 0,
      endFrame: 90
    }, 'Timeline A'))
    await act(async () => controller!.selectPreview('preview-a'))
    await act(async () => controller!.comparePreviews('preview-a', 'preview-b', 'wipe'))
    let previewResource: Awaited<ReturnType<EditorController['openPreviewResource']>> = undefined
    await act(async () => {
      previewResource = await controller!.openPreviewResource('preview-b')
      await flushAsync()
    })
    await act(async () => controller!.attachSelection(['preview-a', 'preview-a', 'preview-b']))

    expect(previewResource).toMatchObject({
      entryId: 'preview-b',
      title: 'Source B',
      mediaKind: 'video',
      url: `kun-media://lease/${project.assets[0]!.mediaHandleId}`
    })
    expect(openViewResource).toHaveBeenCalledWith({ handleId: project.assets[0]!.mediaHandleId })

    const requests = executeCommand.mock.calls.map(([, args]) => isRecord(args) ? args : {})
    const request = (action: string): Record<string, unknown> | undefined =>
      requests.find((candidate) => candidate.action === action)
    expect(request('project.update')?.payload).toMatchObject({
      projectId: project.id,
      expectedRevision: project.currentRevision,
      operations: [{ type: 'create-sequence', name: 'Social cut', activate: true }]
    })
    expect(request('sequence.decompose')?.payload).toMatchObject({
      projectId: project.id, expectedRevision: project.currentRevision, itemId: project.items[0]!.id
    })
    expect(request('media.folder.create')?.payload).toMatchObject({
      projectId: project.id, expectedRevision: project.currentRevision, name: 'Generated takes'
    })
    expect(request('media.organize')?.payload).toMatchObject({
      projectId: project.id, expectedRevision: project.currentRevision,
      assetIds: [project.assets[0]!.id], folderId: 'folder-generated'
    })
    expect(request('preview.add')?.payload).toMatchObject({
      projectId: project.id, expectedRevision: project.currentRevision, label: 'Timeline A',
      source: { kind: 'timeline', sequenceId: project.activeSequenceId, revision: project.currentRevision, startFrame: 0, endFrame: 90 }
    })
    expect(request('preview.select')?.payload).toEqual({
      projectId: project.id,
      expectedRevision: project.currentRevision,
      entryId: 'preview-a'
    })
    expect(request('preview.compare')?.payload).toEqual({
      projectId: project.id,
      expectedRevision: project.currentRevision,
      leftEntryId: 'preview-a',
      rightEntryId: 'preview-b',
      mode: 'wipe'
    })
    expect(request('context.attach-selection')?.payload).toEqual({
      projectId: project.id,
      expectedRevision: project.currentRevision,
      previewEntryIds: ['preview-a', 'preview-b']
    })
    expect(attachComposerContext).toHaveBeenCalledWith({
      schemaVersion: 1,
      id: 'video-selection',
      title: `${project.name} selection`,
      summary: `Revision ${project.currentRevision} · ${project.selection.selectedItemIds.length} selected clips · 2 preview sources`,
      reference: expect.objectContaining({
        projectId: project.id,
        revision: project.currentRevision,
        previewEntryIds: ['preview-a', 'preview-b']
      }),
      revision: project.currentRevision,
      generation: project.selection.generation
    })
    const serialized = JSON.stringify(requests.filter(({ action }) => [
      'project.update', 'sequence.decompose', 'media.folder.create', 'media.organize',
      'preview.add', 'preview.select', 'preview.compare', 'context.attach-selection'
    ].includes(String(action))))
    expect(serialized).not.toMatch(/(?:file:\/\/|\/Users\/|workspaceRelativePath|mediaHandleId)/u)
  })
})
