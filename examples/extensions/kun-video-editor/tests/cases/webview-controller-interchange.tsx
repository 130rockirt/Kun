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
  it('tracks durable OTIO export and enforces picker-preview-confirm import without persisting grants', async () => {
    const project = makeViewProject()
    const importedProject = { ...makeViewProject(), id: 'imported-cut', name: 'Imported cut', currentRevision: 2 }
    const lossManifest = {
      adapterId: 'kun.otio-json', adapterVersion: '1.0.0',
      portableLossless: false, kunRoundTripLossless: true,
      entries: [{
        code: 'effects-custom-metadata', severity: 'warning', feature: 'effects',
        nodeId: 'item-interview', preservation: 'kun-metadata',
        message: 'Effect parameters use Kun metadata.'
      }],
      truncated: 0
    }
    const projection = {
      jobId: 'job_otio_export_12345678',
      kind: 'media.ffmpeg',
      state: 'running',
      cursor: 'cursor_otio_1',
      projectId: project.id,
      sequenceId: project.activeSequenceId,
      pinnedRevision: project.currentRevision,
      currentRevision: project.currentRevision,
      stale: false,
      adapterId: 'kun.otio-json',
      adapterVersion: '1.0.0',
      documentDigest: 'a'.repeat(64),
      projectDigest: 'b'.repeat(64),
      documentBytes: 4096,
      lossManifest
    }
    const runningJob = { ...makeJob('running'), id: projection.jobId }
    const cancelledJob = {
      ...runningJob,
      state: 'cancelled' as const,
      latestCursor: 'cursor_otio_2',
      terminalAt: '2026-01-01T00:02:00.000Z'
    }
    let cancelled = false
    let imported = false
    const executeCommand = vi.fn(async (_id: string, args?: JsonValue) => {
      const request = isRecord(args) ? args : {}
      const action = request.action
      const payload = isRecord(request.payload) ? request.payload : {}
      if (action === 'project.list') {
        const projects = [project, ...(imported ? [importedProject] : [])]
        return { content: { projects: projects.map((entry) => ({
          id: entry.id, name: entry.name, currentRevision: entry.currentRevision,
          updatedAt: entry.updatedAt, durationFrames: entry.durationFrames
        })) } }
      }
      if (action === 'project.active') return { content: { project } }
      if (action === 'project.get') {
        return { content: { project: payload.projectId === importedProject.id ? importedProject : project } }
      }
      if (action === 'render.list' || action === 'derived.list') return { content: { records: [] } }
      if (action === 'interchange.export') return { content: { outcome: 'queued', job: projection } }
      if (action === 'interchange.status') return { content: {
        outcome: cancelled ? 'cancelled' : 'running',
        technicallyValidated: false,
        job: { ...projection, state: cancelled ? 'cancelled' : 'running' }
      } }
      if (action === 'interchange.cancel') {
        cancelled = true
        return { content: { outcome: 'cancelled', technicallyValidated: false, job: {
          ...projection, state: 'cancelled', cursor: 'cursor_otio_2'
        } } }
      }
      if (action === 'interchange.import-preview') return { content: {
        outcome: 'interchange-import-preview',
        inputHandleId: payload.inputHandleId,
        displayName: 'external-cut.otio',
        adapterId: 'kun.otio-json', adapterVersion: '1.0.0',
        sourceDocumentDigest: 'c'.repeat(64),
        sourceProjectId: 'external-cut', sourceProjectRevision: 1,
        suggestedProjectId: importedProject.id,
        fidelity: 'portable-otio',
        project: {
          id: 'external-cut', name: 'External cut', schemaVersion: 2, revision: 1,
          activeSequenceId: 'sequence-main', fps: { numerator: 30, denominator: 1 },
          canvas: project.canvas,
          counts: { assets: 1, sequences: 1, tracks: 3, items: 1, captions: 0, transcripts: 0 }
        },
        mediaRelinkRequired: ['external-asset'],
        timecodeMappings: [{
          id: 'external-item', sequenceId: 'sequence-main', startFrame: 0, endFrame: 30,
          startTimecode: '00:00:00:00', endTimecode: '00:00:01:00',
          frameRate: { numerator: 30, denominator: 1 }
        }],
        timecodeMappingsTruncated: 0,
        lossManifest: { ...lossManifest, kunRoundTripLossless: false },
        persisted: false, confirmationRequired: true
      } }
      if (action === 'interchange.import') {
        imported = true
        return { content: {
          outcome: 'interchange-imported', persisted: true, overwritten: false,
          project: importedProject
        } }
      }
      return { content: {} }
    })
    let saved: JsonValue | undefined
    const setViewState = vi.fn(async (value: JsonValue) => { saved = value })
    const getJob = vi.fn(async () => cancelled ? cancelledJob : runningJob)
    const pickFiles = vi.fn(async () => ({
      outcome: 'selected' as const,
      files: [{
        handleId: 'opaque_otio_input_000001', mode: 'read' as const, kind: 'data' as const,
        displayName: 'external-cut.otio', mimeType: 'application/x-otio+json', byteSize: 2048
      }]
    }))
    const release = vi.fn(async () => ({ released: true }))
    const subscribeJob = vi.fn(async () => ({
      snapshot: cancelled ? cancelledJob : runningJob,
      replayGap: false,
      cursor: runningJob.latestCursor,
      complete: cancelled,
      onEvent: () => ({ dispose: () => undefined }),
      dispose: () => undefined
    }))
    const { client } = fakeClient({
      executeCommand, setViewState, getJob, pickFiles, release, subscribeJob
    })
    let controller: EditorController | undefined
    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client, capture: (value: EditorController) => { controller = value }
      }))
      await flushAsync()
    })

    await act(async () => {
      await controller!.startOtioExport()
      await flushAsync()
    })
    expect(executeCommand).toHaveBeenCalledWith('editor-request', {
      action: 'interchange.export',
      payload: { projectId: project.id, expectedRevision: project.currentRevision }
    })
    expect(controller?.state.otioExportTickets).toEqual([
      expect.objectContaining({ jobId: projection.jobId, documentDigest: projection.documentDigest })
    ])
    expect(saved).toMatchObject({
      otioExportTickets: [expect.objectContaining({ jobId: projection.jobId })]
    })
    expect(JSON.stringify(saved)).not.toMatch(/(?:inputHandleId|outputHandleId|file:\/\/|\/Users\/)/u)

    await act(async () => {
      await controller!.refreshOtioExport(projection.jobId)
      await controller!.cancelOtioExport(projection.jobId)
      await flushAsync()
    })
    expect(controller?.state.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: projection.jobId, state: 'cancelled' })
    ]))

    await act(async () => {
      await controller!.previewOtioImport()
      await flushAsync()
    })
    expect(controller?.state.otioImportPreview).toMatchObject({
      inputHandleId: 'opaque_otio_input_000001',
      suggestedProjectId: importedProject.id,
      fidelity: 'portable-otio',
      lossManifest: { kunRoundTripLossless: false }
    })
    expect(JSON.stringify(saved)).not.toContain('opaque_otio_input_000001')
    expect(release).not.toHaveBeenCalledWith({
      resource: 'handle', handleId: 'opaque_otio_input_000001'
    })

    await act(async () => {
      await controller!.confirmOtioImport(importedProject.id)
      await flushAsync()
    })
    expect(executeCommand).toHaveBeenCalledWith('editor-request', {
      action: 'interchange.import',
      payload: {
        inputHandleId: 'opaque_otio_input_000001',
        expectedDocumentDigest: 'c'.repeat(64),
        expectedSourceProjectId: 'external-cut',
        expectedSourceRevision: 1,
        targetProjectId: importedProject.id
      }
    })
    expect(controller?.state.otioImportPreview).toBeUndefined()
    expect(controller?.state.project?.id).toBe(importedProject.id)
    expect(release).toHaveBeenCalledWith({
      resource: 'handle', handleId: 'opaque_otio_input_000001'
    })

    release.mockClear()
    await act(async () => {
      await controller!.previewOtioImport()
      await controller!.cancelOtioImportPreview()
      await flushAsync()
    })
    expect(controller?.state.otioImportPreview).toBeUndefined()
    expect(release).toHaveBeenCalledWith({
      resource: 'handle', handleId: 'opaque_otio_input_000001'
    })
  })

  it('loads a revision-bound Host media page beyond asset 100 and opens its opaque resource', async () => {
    const project = makeViewProject()
    project.mediaFolders = [{ id: 'folder-archive', name: 'Archive' }]
    project.assets = Array.from({ length: 100 }, (_, index) => ({
      ...project.assets[0]!,
      id: `asset-${String(index).padStart(4, '0')}`,
      name: `asset-${String(index).padStart(4, '0')}.mp4`,
      mediaHandleId: `media_page_${String(index).padStart(4, '0')}_000000`,
      folderId: 'folder-archive'
    }))
    project.truncated = true
    const pageAssets = Array.from({ length: 21 }, (_, pageIndex) => {
      const index = pageIndex + 80
      return {
        ...project.assets[0]!,
        id: `asset-${String(index).padStart(4, '0')}`,
        name: `asset-${String(index).padStart(4, '0')}.mp4`,
        mediaHandleId: `media_page_${String(index).padStart(4, '0')}_000000`,
        folderId: 'folder-archive',
        ...(index === 100 ? {
          generatedLineage: {
            providerId: 'fixture-provider', modelId: 'fixture-model', jobId: 'job-0100',
            referenceAssetIds: ['asset-0000']
          }
        } : {})
      }
    })
    const executeCommand = vi.fn(async (_id: string, args?: JsonValue) => {
      const request = isRecord(args) ? args : {}
      if (request.action === 'project.list') return { content: { projects: [{
        id: project.id, name: project.name, currentRevision: project.currentRevision,
        updatedAt: project.updatedAt, durationFrames: project.durationFrames
      }] } }
      if (request.action === 'project.active' || request.action === 'project.get') {
        return { content: { project } }
      }
      if (request.action === 'media.list') return { content: {
        outcome: 'media-library', projectId: project.id, revision: project.currentRevision,
        page: {
          assets: pageAssets, offset: 80, limit: 80, total: 101,
          hiddenBefore: 80, hiddenAfter: 0
        }
      } }
      if (request.action === 'render.list') return { content: { records: [] } }
      return { content: {} }
    })
    const openViewResource = vi.fn(async ({ handleId }: { handleId: string }) => ({
      leaseId: 'lease_media_page_0100_0000', handleId,
      url: 'kun-media://lease/media-page-0100', mimeType: 'video/mp4',
      expiresAt: '2099-01-01T00:00:00.000Z'
    }))
    const { client } = fakeClient({ executeCommand, openViewResource })
    let controller: EditorController | undefined
    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client, capture: (value: EditorController) => { controller = value }
      }))
      await flushAsync()
    })

    await act(async () => {
      await controller!.loadMediaLibraryPage({
        folderId: 'folder-archive', query: 'asset', offset: 80, limit: 80
      })
      await flushAsync()
    })
    expect(controller?.state.mediaLibrary).toMatchObject({
      projectId: project.id, revision: project.currentRevision,
      folderId: 'folder-archive', query: 'asset', offset: 80, limit: 80,
      total: 101, hiddenBefore: 80, hiddenAfter: 0
    })
    expect(controller?.state.mediaLibrary?.assets).toHaveLength(21)
    expect(controller?.state.mediaLibrary?.assets.at(-1)).toMatchObject({
      id: 'asset-0100', folderId: 'folder-archive',
      generatedLineage: { jobId: 'job-0100', referenceAssetIds: ['asset-0000'] }
    })
    expect(executeCommand).toHaveBeenCalledWith('editor-request', {
      action: 'media.list',
      payload: {
        projectId: project.id, expectedRevision: project.currentRevision,
        folderId: 'folder-archive', query: 'asset', offset: 80, limit: 80
      }
    })

    await act(async () => {
      await controller!.openAsset('asset-0100')
      await flushAsync()
    })
    expect(openViewResource).toHaveBeenCalledWith({ handleId: 'media_page_0100_000000' })
    expect(controller?.state.selectedAssetId).toBe('asset-0100')
  })

  it('silently drops stale media-library success and failure across project, revision, and request generations', async () => {
    const projectA = makeViewProject()
    const projectB = {
      ...structuredClone(projectA),
      id: 'video-project-b',
      name: 'Project B',
      playback: { ...projectA.playback, projectId: 'video-project-b' }
    }
    let currentProject = projectA
    const mediaRequests: Array<{
      resolve(value: unknown): void
      reject(error: unknown): void
    }> = []
    const executeCommand = vi.fn(async (_id: string, args?: JsonValue) => {
      const request = isRecord(args) ? args : {}
      if (request.action === 'project.list') return { content: { projects: [{
        id: projectA.id,
        name: projectA.name,
        currentRevision: projectA.currentRevision,
        updatedAt: projectA.updatedAt,
        durationFrames: projectA.durationFrames
      }] } }
      if (request.action === 'project.active' || request.action === 'project.get') {
        return { content: { project: currentProject } }
      }
      if (request.action === 'media.list') {
        return await new Promise((resolve, reject) => mediaRequests.push({ resolve, reject }))
      }
      if (request.action === 'render.list') return { content: { records: [] } }
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

    const response = (project: typeof projectA, name: string) => ({ content: {
      outcome: 'media-library',
      projectId: project.id,
      revision: project.currentRevision,
      page: {
        assets: [{ ...project.assets[0]!, name }],
        offset: 0,
        limit: VIEW_LIMITS.virtualWindow,
        total: 1,
        hiddenBefore: 0,
        hiddenAfter: 0
      }
    } })
    const startMediaRequest = (): Promise<void> => controller!.loadMediaLibraryPage({
      offset: 0,
      limit: VIEW_LIMITS.virtualWindow
    })

    const oldProjectRequest = startMediaRequest()
    expect(mediaRequests).toHaveLength(1)
    currentProject = projectB
    await act(async () => {
      emitMessage({
        channel: 'kun-video-editor.project-changed',
        payload: {
          schemaVersion: 1,
          projectId: projectB.id,
          revision: projectB.currentRevision,
          reason: 'active-project-changed',
          changedIds: []
        }
      })
      await flushAsync()
    })
    expect(controller?.state.project?.id).toBe(projectB.id)
    await act(async () => {
      mediaRequests[0]!.resolve(response(projectA, 'stale-project.mp4'))
      await oldProjectRequest
      await flushAsync()
    })
    expect(controller?.state.mediaLibrary).toBeUndefined()

    const oldRevisionRequest = startMediaRequest()
    expect(mediaRequests).toHaveLength(2)
    currentProject = {
      ...currentProject,
      currentRevision: currentProject.currentRevision + 1,
      eventGeneration: currentProject.eventGeneration + 1,
      selection: {
        ...currentProject.selection,
        revision: currentProject.currentRevision + 1
      },
      playback: {
        ...currentProject.playback,
        revision: currentProject.currentRevision + 1
      }
    }
    await act(async () => {
      emitMessage({
        channel: 'kun-video-editor.project-changed',
        payload: {
          schemaVersion: 1,
          projectId: currentProject.id,
          revision: currentProject.currentRevision,
          reason: 'timeline-updated',
          changedIds: []
        }
      })
      await flushAsync()
    })
    expect(controller?.state.project?.currentRevision).toBe(currentProject.currentRevision)
    await act(async () => {
      mediaRequests[1]!.reject(new Error('stale revision failed'))
      await oldRevisionRequest
      await flushAsync()
    })
    expect(controller?.state.notices.some(({ id }) => id === 'media-library-load-failed')).toBe(false)

    const oldGenerationRequest = startMediaRequest()
    const currentGenerationRequest = startMediaRequest()
    expect(mediaRequests).toHaveLength(4)
    await act(async () => {
      mediaRequests[2]!.reject(new Error('stale generation failed'))
      await oldGenerationRequest
      mediaRequests[3]!.resolve(response(currentProject, 'authoritative-page.mp4'))
      await currentGenerationRequest
      await flushAsync()
    })
    expect(controller?.state.notices.some(({ id }) => id === 'media-library-load-failed')).toBe(false)
    expect(controller?.state.mediaLibrary?.assets[0]?.name).toBe('authoritative-page.mp4')

    const currentFailure = startMediaRequest()
    expect(mediaRequests).toHaveLength(5)
    await act(async () => {
      mediaRequests[4]!.reject(new Error('current request failed'))
      await currentFailure
      await flushAsync()
    })
    expect(controller?.state.notices.at(-1)).toMatchObject({
      id: 'media-library-load-failed',
      message: 'current request failed',
      severity: 'error'
    })
  })

  it('refreshes timeline markdown against the committed revision after applying a range', async () => {
    let project = makeViewProject()
    const scriptReadRevisions: number[] = []
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
      if (action === 'script.read') {
        const expectedRevision = Number(payload.expectedRevision)
        scriptReadRevisions.push(expectedRevision)
        if (expectedRevision !== project.currentRevision) throw new Error('REVISION_CONFLICT')
        return {
          content: {
            currentRevision: project.currentRevision,
            digest: `digest-r${project.currentRevision}`,
            timelineMarkdown: `# Timeline r${project.currentRevision}`
          }
        }
      }
      if (action === 'script.apply') {
        expect(payload.expectedRevision).toBe(project.currentRevision)
        project = { ...project, currentRevision: project.currentRevision + 1 }
        return { content: { currentRevision: project.currentRevision } }
      }
      return { content: {} }
    })
    const openViewResource = vi.fn(async ({ handleId }: { handleId: string }) => ({
      leaseId: `lease_${handleId}`,
      handleId,
      url: `kun-media://lease/${handleId}`,
      mimeType: 'video/mp4',
      expiresAt: '2099-01-01T00:00:00.000Z'
    }))
    const { client } = fakeClient({ executeCommand, openViewResource })
    let controller: EditorController | undefined

    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client, capture: (value: EditorController) => { controller = value }
      }))
      await flushAsync()
    })
    const segment = project.transcripts[0]!.segments[1]!
    await act(async () => {
      await controller!.applyScript([{
        assetId: project.assets[0]!.id,
        startUs: segment.startUs,
        endUs: segment.endUs,
        reason: 'filler'
      }])
      await flushAsync()
    })

    expect(scriptReadRevisions).toEqual([0, 1])
    expect(controller?.state.project?.currentRevision).toBe(1)
    expect(controller?.state.script).toMatchObject({
      revision: 1,
      digest: 'digest-r1',
      markdown: '# Timeline r1'
    })
    expect(controller?.state.notices.filter(({ severity }) => severity === 'error')).toEqual([])
  })

})
