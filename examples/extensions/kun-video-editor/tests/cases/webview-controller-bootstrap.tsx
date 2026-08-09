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
  it('loads bounded generation state and keeps retry authority free of persisted prompts and handles', async () => {
    const project = makeViewProject()
    const catalog = generationCatalogProjection()
    const record = generationRecordProjection(project.id, project.currentRevision)
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
      if (action === 'generation.catalog') return { content: { outcome: 'available', catalog } }
      if (action === 'generation.list') return { content: { records: [record], recoveryDiagnostics: [] } }
      if (action === 'generation.request' || action === 'generation.retry') {
        return { content: { outcome: 'queued', record } }
      }
      if (action === 'generation.insert') return { content: { outcome: 'inserted', currentRevision: project.currentRevision + 1 } }
      if (action === 'render.list' || action === 'derived.list') return { content: { records: [] } }
      return { content: {} }
    })
    const { client, emitMessage } = fakeClient({ executeCommand })
    let controller: EditorController | undefined
    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client,
        capture: (value: EditorController) => { controller = value }
      }))
      await flushAsync()
      await flushAsync()
    })

    expect(controller?.state.generation).toMatchObject({
      outcome: 'available',
      records: [{ id: record.id, promptDigest: record.promptDigest, state: 'failed' }]
    })
    expect(JSON.stringify(controller?.state.generation)).not.toMatch(/raw persisted prompt|generation_output_handle|authorization_/u)

    const consent = {
      providerPermissionApproved: true,
      mediaUploadApproved: true,
      costApproved: true,
      approvedMaximumMinor: 25,
      currency: 'USD',
      confirmedAt: '2026-07-14T01:00:00.000Z'
    }
    await act(async () => {
      await controller!.retryGeneration(record.id, consent)
      await flushAsync()
    })
    expect(executeCommand).toHaveBeenCalledWith('editor-request', {
      action: 'generation.retry',
      payload: {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        recordId: record.id,
        consent
      }
    })
    const retryCall = executeCommand.mock.calls.find(([, args]) =>
      isRecord(args) && args.action === 'generation.retry'
    )
    expect(JSON.stringify(retryCall)).not.toMatch(/prompt|mediaHandle|outputHandle|authorization_/u)

    await act(async () => {
      emitMessage({
        channel: 'kun-video-editor.generation-progress',
        payload: { record: { ...record, prompt: 'raw persisted prompt' } }
      })
      await flushAsync()
    })
    expect(controller?.state.generation.records[0]?.generation).toBe(record.generation)
  })

  it('opens a derived waveform with an opaque Host lease and reuses the unexpired lease', async () => {
    const project = makeViewProject()
    const handleId = 'media_waveform_ready_0001'
    const openViewResource = vi.fn(async () => ({
      leaseId: 'lease_waveform_ready_0001',
      handleId,
      url: 'kun-media://lease/waveform-ready',
      mimeType: 'image/png',
      expiresAt: '2099-01-01T00:00:00.000Z'
    }))
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
      if (action === 'derived.list') return { content: {
        records: [{
          schemaVersion: 1,
          id: 'waveform-record-1',
          generation: 1,
          statusGeneration: 1,
          kind: 'waveform',
          projectId: project.id,
          assetId: project.assets[0]!.id,
          status: 'ready',
          priority: 'interactive',
          bytes: 512,
          pinned: false,
          attempt: 1,
          artifactHandleId: handleId,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:01.000Z'
        }]
      } }
      if (action === 'render.list') return { content: { records: [] } }
      return { content: {} }
    })
    const { client } = fakeClient({ executeCommand, openViewResource })
    let controller: EditorController | undefined

    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client,
        capture: (value: EditorController) => { controller = value }
      }))
      await flushAsync()
    })
    await act(async () => {
      await flushAsync()
      await flushAsync()
    })

    expect(controller?.state.derivedRecords[0]?.artifactHandleId).toBe(handleId)
    let firstUrl: string | undefined
    let secondUrl: string | undefined
    await act(async () => {
      firstUrl = await controller!.openDerivedResource!('waveform-record-1')
      secondUrl = await controller!.openDerivedResource!('waveform-record-1')
      await flushAsync()
    })
    expect(firstUrl).toBe('kun-media://lease/waveform-ready')
    expect(secondUrl).toBe('kun-media://lease/waveform-ready')
    expect(openViewResource).toHaveBeenCalledTimes(1)
    expect(openViewResource).toHaveBeenCalledWith({ handleId })
  })

  it('keeps player media on leases and routes subtitle open/reveal through the trusted Host action', async () => {
    const openViewResource = vi.fn(async ({ handleId }: { handleId: string }) => ({
      leaseId: `lease_${handleId}`,
      handleId,
      url: `kun-media://lease/${handleId}`,
      mimeType: 'image/png',
      expiresAt: '2099-01-01T00:00:00.000Z'
    }))
    const performArtifactAction = vi.fn(async () => ({ performed: true as const }))
    const executeCommand = vi.fn(async (_id: string, args?: JsonValue) => {
      const action = isRecord(args) ? args.action : undefined
      if (action === 'project.list') return { content: { projects: [] } }
      return { content: {} }
    })
    const { client } = fakeClient({ openViewResource, performArtifactAction, executeCommand })
    let controller: EditorController | undefined

    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client,
        capture: (value: EditorController) => { controller = value }
      }))
      await Promise.resolve()
      await Promise.resolve()
    })

    const proof = makeArtifact('job_12345678')
    const subtitle = makeSubtitleArtifact('job_12345678')
    expect(artifactUsesPlayer(proof)).toBe(true)
    expect(artifactUsesPlayer(subtitle)).toBe(false)

    await act(async () => controller!.openArtifact(proof))
    expect(openViewResource).toHaveBeenCalledWith({
      handleId: proof.mediaHandleId
    })
    expect(performArtifactAction).not.toHaveBeenCalled()

    await act(async () => controller!.openArtifact(subtitle))
    await act(async () => controller!.revealArtifact(subtitle))
    expect(performArtifactAction).toHaveBeenNthCalledWith(1, {
      artifactId: subtitle.artifactId,
      action: 'open'
    })
    expect(performArtifactAction).toHaveBeenNthCalledWith(2, {
      artifactId: subtitle.artifactId,
      action: 'reveal'
    })
    expect(openViewResource).toHaveBeenCalledTimes(1)
    expect(executeCommand).not.toHaveBeenCalledWith('reveal-artifact', expect.anything())
  })

  it('keeps Kun theme and locale when initialization fails and retries the full controller bootstrap', async () => {
    let resolveLocale!: (value: Locale) => void
    let recoveryEnabled = false
    const project = makeViewProject()
    const executeCommand = vi.fn(async (_id: string, args?: JsonValue) => {
      const action = isRecord(args) ? args.action : undefined
      if (action === 'project.list') {
        if (!recoveryEnabled) {
          await Promise.resolve()
          throw new Error('Extension operation failed')
        }
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
      return { content: {} }
    })
    const getViewState = vi.fn(async () => undefined)
    const { client } = fakeClient({
      executeCommand,
      getViewState,
      getTheme: async () => lightTheme(),
      getLocale: () => new Promise<Locale>((resolve) => { resolveLocale = resolve })
    })
    let controller: EditorController | undefined

    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client,
        capture: (value: EditorController) => { controller = value }
      }))
      await flushAsync()
    })

    expect(controller?.state.initialized).toBe(true)
    expect(controller?.state.connection).toBe('offline')
    expect(controller?.state.theme?.kind).toBe('light')
    expect(controller?.state.locale).toBeUndefined()
    expect(controller?.state.notices.at(-1)?.messageKey).toBe('editorInitializeFailed')

    await act(async () => {
      resolveLocale(zhLocale())
      await flushAsync()
    })

    expect(controller?.state.locale?.language).toBe('zh-CN')
    expect(localizedNotice(controller!.state.notices.at(-1)!, controller!.state.locale)).toBe('视频编辑器初始化失败。')

    recoveryEnabled = true
    await act(async () => {
      await controller!.retryInitialization()
      await flushAsync()
    })

    expect(getViewState).toHaveBeenCalledTimes(2)
    expect(controller?.state.connection).toBe('online')
    expect(controller?.state.project?.id).toBe(project.id)
    expect(controller?.state.notices.some(({ messageKey }) => messageKey === 'editorInitializeFailed')).toBe(false)
  })

  it('applies live Kun theme and language changes', async () => {
    const { client, emitTheme, emitLocale, emitMessage } = fakeClient()
    let controller: EditorController | undefined

    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client,
        capture: (value: EditorController) => { controller = value }
      }))
      await flushAsync()
    })
    expect(controller?.state.theme?.kind).toBe('dark')
    expect(controller?.state.locale?.language).toBe('en')

    await act(async () => {
      emitMessage({
        channel: 'kun-video-editor.command-progress',
        payload: { schemaVersion: 1, message: 'Submitting durable media job' }
      })
      await flushAsync()
    })

    expect(controller?.state.notices.at(-1)?.message).toBe('Submitting the media job…')

    await act(async () => {
      emitTheme(lightTheme())
      emitLocale(zhLocale())
      await flushAsync()
    })

    expect(controller?.state.theme?.kind).toBe('light')
    expect(controller?.state.locale?.language).toBe('zh-CN')
    expect(localizedNotice(controller!.state.notices.at(-1)!, controller!.state.locale)).toBe('正在提交媒体任务…')
  })

  it('persists the active workspace across a View reopen and rejects invalid persisted values', async () => {
    vi.useFakeTimers()
    let saved: JsonValue = {
      schemaVersion: 1,
      playheadFrame: 0,
      activeWorkspace: 'not-a-workspace',
      renderTickets: [],
      projectPackageTickets: [],
      transcriptWindowStart: 0
    }
    const getViewState = vi.fn(async () => saved)
    const setViewState = vi.fn(async (value: JsonValue) => { saved = value })
    const { client } = fakeClient({ getViewState, setViewState })
    let controller: EditorController | undefined

    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client,
        capture: (value: EditorController) => { controller = value }
      }))
      await flushAsync()
    })
    expect(controller?.state.activeWorkspace).toBe('script')

    await act(async () => {
      controller!.setActiveWorkspace('output')
      await flushAsync()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
      await flushAsync()
    })
    expect(saved).toMatchObject({ schemaVersion: 1, activeWorkspace: 'output' })

    await act(async () => renderer?.unmount())
    renderer = undefined
    controller = undefined
    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client,
        capture: (value: EditorController) => { controller = value }
      }))
      await flushAsync()
    })
    expect((controller as EditorController | undefined)?.state.activeWorkspace).toBe('output')
  })

  it('starts, persists, restores, refreshes, and cancels a revision-fenced project package without View-side handles', async () => {
    const project = makeViewProject()
    const packageProjection = {
      jobId: 'job_project_package_12345678',
      kind: 'media.archive',
      state: 'running',
      cursor: 'cursor_package_1',
      projectId: project.id,
      sequenceId: project.activeSequenceId,
      pinnedRevision: project.currentRevision,
      packageId: `pkg-${'a'.repeat(32)}`,
      manifestDigest: 'b'.repeat(64),
      complete: true,
      selectedAssetCount: 1,
      embeddedAssetCount: 1,
      uniqueMediaCount: 1,
      deduplicatedAssetCount: 0,
      missingAssetIds: [],
      missingMediaPolicy: 'fail'
    }
    let cancelled = false
    const runningJob = makeArchiveJob(packageProjection.jobId, 'running')
    const cancelledJob = { ...runningJob, state: 'cancelled' as const, latestCursor: 'cursor_package_2' }
    const executeCommand = vi.fn(async (_id: string, args?: JsonValue) => {
      const action = isRecord(args) ? args.action : undefined
      if (action === 'project.list') return { content: { projects: [{
        id: project.id, name: project.name, currentRevision: project.currentRevision,
        updatedAt: project.updatedAt, durationFrames: project.durationFrames
      }] } }
      if (action === 'project.active' || action === 'project.get') return { content: { project } }
      if (action === 'render.list' || action === 'derived.list') return { content: { records: [] } }
      if (action === 'project-package.export') return { content: {
        outcome: 'queued', job: packageProjection
      } }
      if (action === 'project-package.status') return { content: {
        outcome: 'status', job: { ...packageProjection, state: cancelled ? 'cancelled' : 'running' }
      } }
      if (action === 'project-package.cancel') {
        cancelled = true
        return { content: {
          outcome: 'cancellation-requested', accepted: true,
          job: { ...packageProjection, state: 'cancelled', cursor: 'cursor_package_2' }
        } }
      }
      return { content: {} }
    })
    let saved: JsonValue | undefined
    const getViewState = vi.fn(async () => saved)
    const setViewState = vi.fn(async (value: JsonValue) => { saved = value })
    const getJob = vi.fn(async () => cancelled ? cancelledJob : runningJob)
    const pickSaveTarget = vi.fn()
    const subscribeJob = vi.fn(async () => ({
      snapshot: runningJob,
      replayGap: false,
      cursor: runningJob.latestCursor,
      complete: false,
      onEvent: () => ({ dispose: () => undefined }),
      dispose: () => undefined
    }))
    const { client } = fakeClient({
      executeCommand, getViewState, setViewState, getJob, subscribeJob, pickSaveTarget
    })
    let controller: EditorController | undefined
    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client, capture: (value: EditorController) => { controller = value }
      }))
      await flushAsync()
    })
    await act(async () => {
      await controller!.startProjectPackage({
        missingMediaPolicy: 'fail',
        includeReceipts: true,
        includeAgentProvenance: true,
        mediaScope: 'selected',
        assetIds: [project.assets[0]!.id]
      })
      await flushAsync()
    })

    expect(executeCommand).toHaveBeenCalledWith('editor-request', {
      action: 'project-package.export',
      payload: {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        assetIds: [project.assets[0]!.id],
        missingMediaPolicy: 'fail',
        includeReceipts: true,
        includeChatProvenance: true
      }
    })
    expect(pickSaveTarget).not.toHaveBeenCalled()
    expect(controller?.state.projectPackageTickets).toEqual([
      expect.objectContaining({
        jobId: packageProjection.jobId,
        projectId: project.id,
        pinnedRevision: project.currentRevision,
        mediaScope: 'selected',
        receiptsRequested: true,
        agentProvenanceRequested: true
      })
    ])
    expect(saved).toMatchObject({
      schemaVersion: 1,
      projectPackageTickets: [expect.objectContaining({
        jobId: packageProjection.jobId,
        manifestDigest: packageProjection.manifestDigest
      })]
    })
    expect(JSON.stringify(saved)).not.toMatch(/(?:outputHandleId|mediaHandleId|file:\/\/|\/Users\/|prompt|chatText)/u)

    await act(async () => {
      await controller!.refreshProjectPackage(packageProjection.jobId)
      await controller!.cancelProjectPackage(packageProjection.jobId)
      await flushAsync()
    })
    expect(executeCommand).toHaveBeenCalledWith('editor-request', {
      action: 'project-package.status',
      payload: { projectId: project.id, jobId: packageProjection.jobId }
    })
    expect(executeCommand).toHaveBeenCalledWith('editor-request', {
      action: 'project-package.cancel',
      payload: { projectId: project.id, jobId: packageProjection.jobId }
    })
    expect(controller?.state.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: packageProjection.jobId, state: 'cancelled' })
    ]))

    await act(async () => renderer?.unmount())
    renderer = undefined
    controller = undefined
    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client, capture: (value: EditorController) => { controller = value }
      }))
      await flushAsync()
    })
    expect((controller as EditorController | undefined)?.state.projectPackageTickets).toHaveLength(1)
    expect((controller as EditorController | undefined)?.state.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: packageProjection.jobId, state: 'cancelled' })
    ]))
    expect(executeCommand.mock.calls.filter(([, args]) =>
      isRecord(args) && args.action === 'project-package.status'
    ).length).toBeGreaterThanOrEqual(2)
  })

  it('rejects a project-package response that is not pinned to the requested revision', async () => {
    const project = makeViewProject()
    const executeCommand = vi.fn(async (_id: string, args?: JsonValue) => {
      const action = isRecord(args) ? args.action : undefined
      if (action === 'project.list') return { content: { projects: [{
        id: project.id, name: project.name, currentRevision: project.currentRevision,
        updatedAt: project.updatedAt, durationFrames: project.durationFrames
      }] } }
      if (action === 'project.active' || action === 'project.get') return { content: { project } }
      if (action === 'render.list') return { content: { records: [] } }
      if (action === 'project-package.export') return { content: {
        outcome: 'queued',
        job: {
          jobId: 'job_wrong_revision_12345678', kind: 'media.archive', state: 'queued',
          projectId: project.id, sequenceId: project.activeSequenceId,
          pinnedRevision: project.currentRevision + 1,
          packageId: `pkg-${'c'.repeat(32)}`, manifestDigest: 'd'.repeat(64), complete: true,
          selectedAssetCount: 1, embeddedAssetCount: 1, uniqueMediaCount: 1,
          deduplicatedAssetCount: 0, missingAssetIds: [], missingMediaPolicy: 'fail'
        }
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
      await controller!.startProjectPackage({
        missingMediaPolicy: 'fail', includeReceipts: false,
        includeAgentProvenance: false, mediaScope: 'all'
      })
      await flushAsync()
    })
    expect(controller?.state.projectPackageTickets).toEqual([])
    expect(controller?.state.notices.at(-1)).toMatchObject({ severity: 'error' })
  })

  it('does not let delayed initial values overwrite newer Kun events', async () => {
    let resolveTheme!: (value: Theme) => void
    let resolveLocale!: (value: Locale) => void
    const { client, emitTheme, emitLocale } = fakeClient({
      getTheme: () => new Promise<Theme>((resolve) => { resolveTheme = resolve }),
      getLocale: () => new Promise<Locale>((resolve) => { resolveLocale = resolve })
    })
    let controller: EditorController | undefined

    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client,
        capture: (value: EditorController) => { controller = value }
      }))
      await flushAsync()
    })
    await act(async () => {
      emitTheme(lightTheme())
      emitLocale(zhLocale())
      resolveTheme(darkTheme())
      resolveLocale(enLocale())
      await flushAsync()
    })

    expect(controller?.state.theme?.kind).toBe('light')
    expect(controller?.state.locale?.language).toBe('zh-CN')
  })

})
