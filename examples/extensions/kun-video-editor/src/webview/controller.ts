import {
  ExtensionApiError,
  ResultPreviewOpenPayloadSchema,
  type AgentRunEvent,
  type ExtensionHostClient,
  type GeneratedArtifact,
  type JobSnapshot,
  type JsonObject,
  type JsonValue,
  type MediaMetadata,
  type MediaResourceLease
} from '@kun/extension-api'
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import {
  containsAsciiControlCharacters,
  replaceNullOrLineBreaks
} from '../text-safety.js'
import {
  INITIAL_EDITOR_STATE,
  VIEW_LIMITS,
  editorReducer,
  generatedArtifacts,
  toPersistedState,
  type CanvasFit,
  type CanvasPreset,
  type AssetProjection,
  type AudioAnalysisCapabilitiesProjection,
  type AudioAnalysisRecordProjection,
  type AudioSyncPreviewProjection,
  type DenoiseMetadataCapabilityProjection,
  type DerivedMediaKind,
  type DerivedMediaRecordProjection,
  type DerivedStorageUsageProjection,
  type EditorAction,
  type EditorNotice,
  type EditorState,
  type EditorWorkspace,
  type GenerationRecordProjection,
  type GenerationStateProjection,
  type MediaLibraryPageProjection,
  type MediaIntelligenceEvidenceProjection,
  type MediaIntelligenceProgressProjection,
  type PersistedEditorState,
  type PreviewComparisonProjection,
  type PreviewHistoryEntryProjection,
  type PreviewHistoryProjection,
  type PreviewSourceProjection,
  type ProjectChange,
  type ProjectPackageMissingMediaPolicy,
  type ProjectPackageTicket,
  type InterchangeLossManifestProjection,
  type OtioExportTicket,
  type OtioImportPreview,
  type OtioTimecodeMappingProjection,
  type MulticamGroupProjection,
  type ProjectProjection,
  type ProjectSummary,
  type RenderTicket,
  type SpeakerAdapterProjection,
  type SpeakerAttributionPlanProjection,
  type SpeakerIdentityProjection,
  type TimelineOperation,
  type VisualMomentPageProjection,
  type VisualProvisioningProjection
} from './model.js'
import type {
  GenerationCatalog,
  GenerationConsent,
  GenerationModelDescriptor,
  GenerationProviderDescriptor
} from '../engine/generation.js'
import type { GenerationPanelRequest } from './generation-panel.js'
import { formatMessage, messagesFor, type MessageKey } from './i18n.js'
import { renderCapabilityDetails } from './render-capability.js'
import type {
  MulticamCreateRequest,
  MulticamLayoutRequest,
  MulticamRenameRequest,
  MulticamSelectionRequest,
  MulticamSwitchRequest,
  MulticamSyncConfirmation
} from './multicam-panel.js'

import {
  asRecord,
  assertOtioExportProjection,
  assertOtioExportSnapshot,
  assertProjectPackageProjection,
  assertProjectPackageSnapshot,
  classifyError,
  isOpaqueHostError,
  isProjectSummary,
  isRecord,
  isRenderTicket,
  isRevisionConflict,
  localSelectionProjection,
  mediaLibraryPageFrom,
  persistedState,
  projectFrom,
  requiredProject,
  revisionFromError,
  selectionFingerprint,
  selectionUpdateFrom
} from './controller-support.js'
export { artifactUsesPlayer, artifactsForJobs, classifyError } from './controller-support.js'
import type { EditorController, PreviewResource, ProjectPackageExportOptions } from './controller-types.js'
export type { EditorController, PreviewResource, ProjectPackageExportOptions } from './controller-types.js'
import type { EditorActionContext } from './controller-action-context.js'
import { useProjectMediaActions } from './controller-project-media-actions.js'
import { useIntelligenceActions } from './controller-intelligence-actions.js'
import { useTimelineActions } from './controller-timeline-actions.js'
import { useOutputActions } from './controller-output-actions.js'
import { useControllerDataLoaders } from './controller-data-loaders.js'
import { useControllerEffects } from './controller-effects.js'

const EDITOR_COMMAND = 'editor-request'

export function useEditorController(client: ExtensionHostClient): EditorController {
  const [state, dispatch] = useReducer(editorReducer, INITIAL_EDITOR_STATE)
  const stateRef = useRef(state)
  const localeRef = useRef(state.locale)
  const ownedLeaseIds = useRef(new Set<string>())
  const derivedLeaseCache = useRef(new Map<string, MediaResourceLease>())
  const derivedLeaseRequests = useRef(new Map<string, Promise<MediaResourceLease>>())
  const pendingOtioImportHandle = useRef<string | undefined>(undefined)
  const initializationGeneration = useRef(0)
  const projectLoadGeneration = useRef(0)
  const activeProjectResolutionGeneration = useRef(0)
  const mediaLibraryLoadGeneration = useRef(0)
  const selectionSyncInFlight = useRef(false)
  const openMediaHandleRef = useRef<((handleId: string) => Promise<void>) | undefined>(undefined)
  stateRef.current = state

  const copy = useCallback((key: MessageKey, values?: Readonly<Record<string, string | number>>): string => {
    return formatMessage(messagesFor(localeRef.current)[key], values)
  }, [])

  const pushNotice = useCallback((notice: Omit<EditorNotice, 'id'> & { id?: string }) => {
    dispatch({
      type: 'notice',
      value: { ...notice, id: notice.id ?? `notice-${Date.now().toString(36)}` }
    })
  }, [])

  const execute = useCallback(async (action: string, payload: JsonObject = {}): Promise<Record<string, unknown>> => {
    const result = await client.commands.executeCommand<JsonValue>(EDITOR_COMMAND, { action, payload })
    const outer = asRecord(result, copy('invalidHostResponse'))
    return isRecord(outer.content) ? outer.content : outer
  }, [client, copy])

  const releaseAllLeases = useCallback(async (): Promise<void> => {
    const leaseIds = [...ownedLeaseIds.current]
    ownedLeaseIds.current.clear()
    derivedLeaseCache.current.clear()
    derivedLeaseRequests.current.clear()
    await Promise.all(leaseIds.map((leaseId) =>
      client.media.release({ resource: 'lease', leaseId }).catch(() => undefined)
    ))
    dispatch({ type: 'active-media', handleId: undefined, url: undefined })
  }, [client])

  const { loadDerived, loadPreviewHistory, loadMediaIntelligence, loadGeneration } = useControllerDataLoaders({ dispatch, stateRef, execute, copy })

  const loadProject = useCallback(async (projectId: string): Promise<ProjectProjection> => {
    const generation = ++projectLoadGeneration.current
    mediaLibraryLoadGeneration.current += 1
    const content = await execute('project.get', { projectId })
    const project = projectFrom(content, copy('invalidProjectProjection'))
    if (generation !== projectLoadGeneration.current) return project
    if (stateRef.current.project && stateRef.current.project.id !== project.id) {
      await releaseAllLeases()
      if (generation !== projectLoadGeneration.current) return project
    }
    dispatch({ type: 'project', value: project })
    await loadPreviewHistory(project.id).catch(() => undefined)
    void loadMediaIntelligence(
      project.id,
      project.currentRevision,
      project.selection.selectedAssetIds[0] ?? project.assets[0]?.id
    ).catch(() => undefined)
    void loadGeneration(project.id).catch(() => undefined)
    return project
  }, [copy, execute, loadGeneration, loadMediaIntelligence, loadPreviewHistory, releaseAllLeases])

  const loadMediaLibraryPage = useCallback(async (
    options: { folderId?: string; query?: string; offset?: number; limit?: number } = {}
  ): Promise<void> => {
    const project = requiredProject(stateRef.current, copy('openProjectFirst'))
    const generation = ++mediaLibraryLoadGeneration.current
    const query = options.query?.trim().slice(0, 256) ?? ''
    const offset = Number.isSafeInteger(options.offset) && Number(options.offset) >= 0
      ? Number(options.offset)
      : 0
    const limit = Number.isSafeInteger(options.limit) && Number(options.limit) >= 1 && Number(options.limit) <= 100
      ? Number(options.limit)
      : VIEW_LIMITS.virtualWindow
    try {
      const content = await execute('media.list', {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        ...(options.folderId ? { folderId: options.folderId } : {}),
        ...(query ? { query } : {}),
        offset,
        limit
      })
      const page = mediaLibraryPageFrom(content, {
        projectId: project.id,
        revision: project.currentRevision,
        ...(options.folderId ? { folderId: options.folderId } : {}),
        query
      }, copy('invalidHostResponse'))
      if (
        generation !== mediaLibraryLoadGeneration.current ||
        stateRef.current.project?.id !== page.projectId ||
        stateRef.current.project.currentRevision !== page.revision
      ) return
      dispatch({ type: 'media-library', value: page })
    } catch (error) {
      if (
        generation !== mediaLibraryLoadGeneration.current ||
        stateRef.current.project?.id !== project.id ||
        stateRef.current.project.currentRevision !== project.currentRevision
      ) return
      pushNotice({
        ...classifyError(
          error,
          copy('editorOperationFailed'),
          copy('completeProtectedInteraction'),
          isOpaqueHostError(error) || error instanceof ExtensionApiError,
          'editorOperationFailed'
        ),
        id: 'media-library-load-failed'
      })
    }
  }, [copy, execute, pushNotice])

  const syncSelectionContext = useCallback(async (): Promise<void> => {
    if (selectionSyncInFlight.current) return
    const snapshot = stateRef.current
    const project = snapshot.project
    if (!snapshot.initialized || !project) return
    const local = localSelectionProjection(snapshot, project)
    if (selectionFingerprint(local) === selectionFingerprint(project.selection)) return
    selectionSyncInFlight.current = true
    try {
      const content = await execute('context.update', {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        expectedGeneration: project.selection.generation,
        sequenceId: local.sequenceId,
        playheadFrame: local.playheadFrame,
        selectedAssetIds: local.selectedAssetIds,
        selectedItemIds: local.selectedItemIds,
        selectedCaptionIds: local.selectedCaptionIds,
        selectedWordIds: local.selectedWordIds,
        range: local.range ?? null
      })
      const updated = selectionUpdateFrom(content)
      if (
        updated &&
        stateRef.current.project?.id === updated.projectId &&
        stateRef.current.project.currentRevision === updated.revision
      ) {
        dispatch({ type: 'selection-synced', ...updated })
      }
    } catch (error) {
      if (stateRef.current.project?.id === project.id) {
        const notice = classifyError(
          error,
          copy('projectChanged'),
          copy('completeProtectedInteraction'),
          false
        )
        if (notice.retryable) void loadProject(project.id)
        else pushNotice({ ...notice, id: 'selection-sync-failed' })
      }
    } finally {
      selectionSyncInFlight.current = false
    }
  }, [copy, execute, loadProject, pushNotice])

  const loadProjects = useCallback(async (): Promise<ProjectSummary[]> => {
    const content = await execute('project.list')
    const projects = Array.isArray(content.projects)
      ? content.projects.filter(isProjectSummary).slice(0, VIEW_LIMITS.projects)
      : []
    const invalidProjectIds = Array.isArray(content.diagnostics)
      ? content.diagnostics
        .filter((value): value is Record<string, unknown> => isRecord(value) && typeof value.id === 'string')
        .map(({ id }) => String(id))
        .slice(0, VIEW_LIMITS.projects)
      : []
    if (invalidProjectIds.length > 0) {
      const values = {
        count: invalidProjectIds.length,
        projects: invalidProjectIds.join(', ')
      }
      pushNotice({
        id: 'invalid-projects-skipped',
        severity: 'warning',
        message: formatMessage(copy('invalidProjectsSkipped'), values),
        messageKey: 'invalidProjectsSkipped',
        messageValues: values
      })
    }
    dispatch({ type: 'projects', value: projects })
    return projects
  }, [copy, execute, pushNotice])

  const loadActiveProject = useCallback(async (
    options: { skipUnchanged?: boolean } = {}
  ): Promise<ProjectProjection | null | undefined> => {
    const generation = ++activeProjectResolutionGeneration.current
    const active = await execute('project.active')
    if (generation !== activeProjectResolutionGeneration.current) return undefined
    if (!isRecord(active.project)) return null
    const resolved = projectFrom(active, copy('invalidProjectProjection'))
    const current = stateRef.current.project
    if (
      options.skipUnchanged &&
      current?.id === resolved.id &&
      current.currentRevision === resolved.currentRevision &&
      current.eventGeneration === resolved.eventGeneration
    ) return resolved
    return await loadProject(resolved.id)
  }, [copy, execute, loadProject])

  const loadProjectPackageSnapshot = useCallback(async (
    ticket: ProjectPackageTicket
  ): Promise<JobSnapshot> => {
    const content = await execute('project-package.status', {
      projectId: ticket.projectId,
      jobId: ticket.jobId
    })
    assertProjectPackageProjection(content.job, ticket, copy('invalidHostResponse'))
    const snapshot = await client.jobs.get(ticket.jobId)
    assertProjectPackageSnapshot(snapshot, ticket, copy('invalidHostResponse'))
    return snapshot
  }, [client, copy, execute])

  const loadOtioExportSnapshot = useCallback(async (
    ticket: OtioExportTicket
  ): Promise<JobSnapshot> => {
    const content = await execute('interchange.status', {
      projectId: ticket.projectId,
      jobId: ticket.jobId
    })
    assertOtioExportProjection(content.job, ticket, copy('invalidHostResponse'))
    const snapshot = await client.jobs.get(ticket.jobId)
    assertOtioExportSnapshot(snapshot, ticket, copy('invalidHostResponse'))
    if (snapshot.state === 'completed' && content.technicallyValidated !== true) {
      throw new Error(copy('interchangeInvalidOutput'))
    }
    return snapshot
  }, [client, copy, execute])

  const refreshJobs = useCallback(async (
    packageTickets: ProjectPackageTicket[] = stateRef.current.projectPackageTickets,
    otioTickets: OtioExportTicket[] = stateRef.current.otioExportTickets
  ): Promise<JobSnapshot[]> => {
    const [page, tracked] = await Promise.all([
      client.jobs.list({ limit: VIEW_LIMITS.jobs }),
      execute('render.list')
    ])
    if (Array.isArray(tracked.records)) {
      for (const record of tracked.records) {
        if (isRenderTicket(record)) dispatch({ type: 'render-ticket', value: record })
      }
    }
    const restoredPackages = (await Promise.all(packageTickets.slice(-VIEW_LIMITS.jobs).map(async (ticket) => {
      try {
        return await loadProjectPackageSnapshot(ticket)
      } catch {
        // The workspace-scoped jobs page remains a safe fallback. A transient
        // tracking read must not discard a persisted package ticket.
        return undefined
      }
    }))).filter((snapshot): snapshot is JobSnapshot => snapshot !== undefined)
    const restoredOtio = (await Promise.all(otioTickets.slice(-VIEW_LIMITS.jobs).map(async (ticket) => {
      try {
        return await loadOtioExportSnapshot(ticket)
      } catch {
        return undefined
      }
    }))).filter((snapshot): snapshot is JobSnapshot => snapshot !== undefined)
    const jobs = [...page.items, ...restoredPackages, ...restoredOtio]
    dispatch({ type: 'jobs', value: jobs })
    return jobs
  }, [client, execute, loadOtioExportSnapshot, loadProjectPackageSnapshot])

  const restoreRun = useCallback(async (runId: string | undefined): Promise<void> => {
    if (!runId) return
    try {
      dispatch({ type: 'agent-run', value: await client.agent.getRun(runId) })
    } catch {
      pushNotice({
        id: 'run-unavailable',
        severity: 'warning',
        message: copy('previousAgentUnavailable'),
        messageKey: 'previousAgentUnavailable'
      })
    }
  }, [client, copy, pushNotice])

  const refreshAll = useCallback(async (): Promise<void> => {
    dispatch({ type: 'reconnect' })
    try {
      await Promise.all([
        loadProjects(),
        refreshJobs(),
        loadActiveProject().then(async (project) => {
          if (project === null) {
            await releaseAllLeases()
            dispatch({ type: 'clear-project' })
          }
        })
      ])
      if (stateRef.current.agentRun) await restoreRun(stateRef.current.agentRun.id)
      dispatch({ type: 'connection', value: 'online' })
    } catch (error) {
      dispatch({ type: 'connection', value: 'offline' })
      pushNotice(classifyError(
        error,
        copy('reconnectFailed'),
        copy('completeProtectedInteraction'),
        true,
        'reconnectFailed'
      ))
    }
  }, [copy, loadActiveProject, loadProjects, pushNotice, refreshJobs, releaseAllLeases, restoreRun])

  const initializeEditor = useCallback(async (retrying = false): Promise<void> => {
    const generation = ++initializationGeneration.current
    if (retrying) dispatch({ type: 'reconnect' })
    try {
      const [restored] = await Promise.all([
        client.ui.getViewState<JsonValue>(),
        loadProjects()
      ])
      if (generation !== initializationGeneration.current) return
      const persisted = persistedState(restored)
      dispatch({ type: 'initialized', ...(persisted ? { persisted } : {}) })
      await refreshJobs(
        persisted?.projectPackageTickets ?? [],
        persisted?.otioExportTickets ?? []
      )
      if (generation !== initializationGeneration.current) return
      await loadActiveProject()
      if (generation !== initializationGeneration.current) return
      await restoreRun(persisted?.activeRunId)
      if (generation !== initializationGeneration.current) return
      dispatch({ type: 'dismiss-notice', id: 'initialization-failed' })
      dispatch({ type: 'connection', value: 'online' })
    } catch (error) {
      if (generation !== initializationGeneration.current) return
      dispatch({ type: 'initialized' })
      dispatch({ type: 'connection', value: 'offline' })
      pushNotice({
        ...classifyError(
          error,
          copy('editorInitializeFailed'),
          copy('completeProtectedInteraction'),
          true,
          'editorInitializeFailed'
        ),
        id: 'initialization-failed'
      })
    }
  }, [client, copy, loadActiveProject, loadProjects, pushNotice, refreshJobs, restoreRun])

  useControllerEffects({
    client,
    state,
    dispatch,
    stateRef,
    localeRef,
    ownedLeaseIds,
    derivedLeaseCache,
    derivedLeaseRequests,
    pendingOtioImportHandle,
    initializationGeneration,
    activeProjectResolutionGeneration,
    projectLoadGeneration,
    mediaLibraryLoadGeneration,
    selectionSyncInFlight,
    openMediaHandleRef,
    copy,
    pushNotice,
    execute,
    releaseAllLeases,
    loadDerived,
    loadPreviewHistory,
    loadMediaIntelligence,
    loadGeneration,
    loadProject,
    loadMediaLibraryPage,
    syncSelectionContext,
    loadProjects,
    loadActiveProject,
    loadProjectPackageSnapshot,
    loadOtioExportSnapshot,
    refreshJobs,
    restoreRun,
    refreshAll,
    initializeEditor
  })

  const withBusy = useCallback(async (operation: () => Promise<void>): Promise<void> => {
    dispatch({ type: 'busy', value: true })
    try {
      await operation()
    } catch (error) {
      const currentRevision = revisionFromError(error)
      if (isRevisionConflict(error) && stateRef.current.project) {
        dispatch({
          type: 'conflict',
          expectedRevision: stateRef.current.project.currentRevision,
          ...(currentRevision === undefined ? {} : { currentRevision })
        })
        await loadProject(stateRef.current.project.id).catch(() => undefined)
      }
      pushNotice(classifyError(
        error,
        copy('editorOperationFailed'),
        copy('completeProtectedInteraction'),
        isOpaqueHostError(error) || error instanceof ExtensionApiError,
        'editorOperationFailed'
      ))
    } finally {
      dispatch({ type: 'busy', value: false })
    }
  }, [copy, loadProject, pushNotice])

  const actionContext: EditorActionContext = {
    client,
    dispatch,
    stateRef,
    ownedLeaseIds,
    derivedLeaseCache,
    derivedLeaseRequests,
    pendingOtioImportHandle,
    activeProjectResolutionGeneration,
    projectLoadGeneration,
    mediaLibraryLoadGeneration,
    openMediaHandleRef,
    copy,
    pushNotice,
    execute,
    releaseAllLeases,
    loadDerived,
    loadPreviewHistory,
    loadMediaIntelligence,
    loadGeneration,
    loadProject,
    loadMediaLibraryPage,
    loadProjects,
    loadProjectPackageSnapshot,
    loadOtioExportSnapshot,
    refreshJobs,
    withBusy
  }

  const projectMediaActions = useProjectMediaActions(actionContext)
  const { createProject, openProject, refreshGeneration, requestGeneration, retryGeneration, cancelGeneration, insertGeneratedVariant, importMedia, importTranscript, checkLocalTranscriber, generateCaptions, openMediaHandle, openAsset, openPassiveMediaHandle, openDerivedResource, refreshActiveLease, recoverMedia, refreshDerived } = projectMediaActions

  const { refreshMediaIntelligence, setVisualOptIn, requestVisualModelInstall, indexVisual, searchVisualMoments, analyzeVad, applyVadAnalysis, importSpeakerEvidence, previewSpeakerAttribution, applySpeakerAttribution, analyzeBeats, analyzeDenoiseMetadata, previewAudioSync, applyAudioSync, cancelMediaIntelligence, startDerivedRequest, startDerived, retryDerived, cancelDerived, cleanupDerived } = useIntelligenceActions(actionContext)

  const { applyOperations, createSequence, duplicateSequence, renameSequence, selectSequence, closeSequence, deleteSequence, setSequenceView, decomposeNested, createMediaFolder, updateMediaFolder, deleteMediaFolder, organizeMedia, refreshPreviewHistory, addPreview, selectPreview, openPreviewResource, comparePreviews, replaceSelectedFromPreview, attachSelection, history, undo, redo, readScript, editScript, applyScript, startAgent, steerAgent, cancelAgent } = useTimelineActions({ ...actionContext, ...projectMediaActions })

  const { startRender, runMulticamMutation, createMulticam, renameMulticamLabels, confirmMulticamSync, switchMulticam, mergeMulticam, applyMulticamLayout, previewMulticam, cancelJob, startProjectPackage, refreshProjectPackage, cancelProjectPackage, startOtioExport, refreshOtioExport, cancelOtioExport, previewOtioImport, confirmOtioImport, cancelOtioImportPreview, openArtifact, revealArtifact } = useOutputActions({ ...actionContext, ...projectMediaActions })

  return {
    state,
    refreshAll,
    retryInitialization: () => initializeEditor(true),
    setActiveWorkspace: (workspace) => dispatch({ type: 'active-workspace', value: workspace }),
    createProject,
    openProject,
    importMedia,
    loadMediaLibraryPage,
    importTranscript,
    checkLocalTranscriber,
    generateCaptions,
    openAsset,
    openDerivedResource,
    refreshActiveLease,
    recoverMedia,
    refreshDerived,
    startDerived,
    retryDerived,
    cancelDerived,
    cleanupDerived,
    refreshMediaIntelligence,
    setVisualOptIn,
    requestVisualModelInstall,
    indexVisual,
    searchVisualMoments,
    analyzeVad,
    applyVadAnalysis,
    importSpeakerEvidence,
    previewSpeakerAttribution,
    applySpeakerAttribution,
    analyzeBeats,
    analyzeDenoiseMetadata,
    previewAudioSync,
    applyAudioSync,
    cancelMediaIntelligence,
    refreshGeneration,
    requestGeneration,
    retryGeneration,
    cancelGeneration,
    insertGeneratedVariant,
    createMulticam,
    renameMulticamLabels,
    confirmMulticamSync,
    switchMulticam,
    mergeMulticam,
    applyMulticamLayout,
    previewMulticam,
    applyOperations,
    createSequence,
    duplicateSequence,
    renameSequence,
    selectSequence,
    closeSequence,
    deleteSequence,
    setSequenceView,
    decomposeNested,
    createMediaFolder,
    updateMediaFolder,
    deleteMediaFolder,
    organizeMedia,
    refreshPreviewHistory,
    addPreview,
    selectPreview,
    openPreviewResource,
    comparePreviews,
    replaceSelectedFromPreview,
    attachSelection,
    undo,
    redo,
    readScript,
    editScript,
    applyScript,
    seek: (frame) => dispatch({ type: 'seek', frame }),
    togglePlaying: () => dispatch({ type: 'playing', value: !stateRef.current.playing }),
    selectItem: (itemId) => dispatch({ type: 'selection', itemId, captionId: undefined }),
    selectCaption: (captionId) => dispatch({ type: 'selection', captionId, itemId: undefined }),
    setTranscriptWindow: (start) => dispatch({ type: 'transcript-window', start }),
    setTimelineWindow: (start) => dispatch({ type: 'timeline-window', start }),
    startAgent,
    steerAgent,
    cancelAgent,
    startRender,
    cancelJob,
    startProjectPackage,
    refreshProjectPackage,
    cancelProjectPackage,
    startOtioExport,
    refreshOtioExport,
    cancelOtioExport,
    previewOtioImport,
    confirmOtioImport,
    cancelOtioImportPreview,
    openArtifact,
    revealArtifact,
    dismissNotice: (id) => dispatch({ type: 'dismiss-notice', id })
  }
}
