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
import { agentEventChangesProject,artifactUsesPlayer,artifactsForJobs,asRecord,assertNoRawMediaLocation,assertOtioExportProjection,assertOtioExportSnapshot,assertProjectPackageProjection,assertProjectPackageSnapshot,assertRenderCapabilities,assetFromState,assetProjectionFrom,audioAnalysisCapabilitiesFrom,audioAnalysisRecordFrom,audioSnapTargetsFrom,audioSyncPreviewFrom,boundedIdentifier,boundedName,classifyError,containsGenerationSecretOrLocator,denoiseMetadataCapabilityFrom,denoiseMetadataRecordSummaryFrom,derivedParameters,derivedRecordFrom,derivedTarget,derivedUsageFrom,dispatchPreviewResult,generationCatalogFrom,generationEnumArray,generationModelFrom,generationOpaqueId,generationProviderFrom,generationProviderId,generationRecordFrom,interchangeLossManifestFrom,isDerivedKind,isDerivedStatus,isEditorWorkspace,isMulticamGroupProjection,isOpaqueHandleId,isOpaqueHostError,isOtioExportTicket,isProjectPackageTicket,isProjectSummary,isRecord,isRenderKind,isRenderTicket,isRevisionConflict,isRevokedMediaError,localId,localSelectionProjection,mediaIntelligenceEvidenceFrom,mediaIntelligenceProgressFrom,mediaLibraryPageFrom,numericProjection,otioExportJobProjectionFrom,otioExportTicketFrom,otioImportPreviewFrom,persistedState,positiveSafeInteger,previewComparisonFrom,previewEntryFrom,previewHistoryFrom,previewSourceFrom,projectChange,projectFrom,projectPackageJobProjectionFrom,projectPackageTicketFrom,renderCapabilityMessageKey,requiredOtioExportTicket,requiredProject,requiredProjectPackageTicket,revisionFromError,safeInteger,selectionFingerprint,selectionUpdateFrom,signedSafeInteger,speakerAdaptersFrom,speakerAttributionPlanFrom,speakerIdentitiesFrom,stableProjectionId,transcriptFormat,transcriptSegmentCount,visualAssetKind,visualMomentPageFrom,visualProvisioningFrom } from './controller-support.js'
import type { EditorActionContext } from './controller-action-context.js'

const TERMINAL_AGENT_STATES = new Set(['completed', 'failed', 'cancelled', 'budget-exhausted'])
const TERMINAL_JOB_STATES = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
const JOB_STATUS_RECONCILE_INTERVAL_MS = 1_000
const ACTIVE_PROJECT_RECONCILE_INTERVAL_MS = 5_000
const SELECTION_SYNC_DEBOUNCE_MS = 120
const COMMAND_PROGRESS_MESSAGE_KEYS: Readonly<Record<string, MessageKey>> = {
  'Probing Host-granted media': 'commandProgressProbingMedia',
  'Persisted probed asset metadata': 'commandProgressMediaMetadataSaved',
  'Media import complete': 'commandProgressImportComplete',
  'Probing replacement media grant': 'commandProgressProbingReplacement',
  'Replacement media grant saved': 'commandProgressReplacementSaved',
  'Submitting durable media job': 'commandProgressSubmittingJob',
  'Durable media job queued': 'commandProgressJobQueued',
  'Submitting durable project package job': 'commandProgressSubmittingProjectPackage',
  'Durable project package queued': 'commandProgressProjectPackageQueued'
}

type EffectsContext = Omit<EditorActionContext, 'withBusy'> & {
  state: EditorState
  localeRef: { current: EditorState['locale'] }
  initializationGeneration: { current: number }
  selectionSyncInFlight: { current: boolean }
  syncSelectionContext(): Promise<void>
  loadActiveProject(options: { skipUnchanged: boolean }): Promise<ProjectProjection | null | undefined>
  restoreRun(runId: string | undefined): Promise<void>
  refreshAll(): Promise<void>
  initializeEditor(retrying?: boolean): Promise<void>
}

export function useControllerEffects(context: EffectsContext): void {
  const { client, state, dispatch, stateRef, localeRef, ownedLeaseIds, derivedLeaseCache, derivedLeaseRequests, pendingOtioImportHandle, initializationGeneration, activeProjectResolutionGeneration, projectLoadGeneration, mediaLibraryLoadGeneration, selectionSyncInFlight, openMediaHandleRef, copy, pushNotice, execute, releaseAllLeases, loadDerived, loadPreviewHistory, loadMediaIntelligence, loadGeneration, loadProject, loadMediaLibraryPage, syncSelectionContext, loadProjects, loadActiveProject, loadProjectPackageSnapshot, loadOtioExportSnapshot, refreshJobs, restoreRun, refreshAll, initializeEditor } = context
  const activeDerivedKey = useMemo(() => state.derivedRecords
    .filter(({ status }) => ['queued', 'running', 'partial'].includes(status))
    .map(({ id, generation }) => `${id}:${generation}`)
    .sort()
    .join('|'), [state.derivedRecords])

  useEffect(() => {
    if (!state.initialized || !state.project) return
    const local = localSelectionProjection(state, state.project)
    if (selectionFingerprint(local) === selectionFingerprint(state.project.selection)) return
    const timeout = globalThis.setTimeout(() => {
      void syncSelectionContext()
    }, SELECTION_SYNC_DEBOUNCE_MS)
    return () => globalThis.clearTimeout(timeout)
  }, [
    state.initialized,
    state.playheadFrame,
    state.project,
    state.selectedAssetId,
    state.selectedCaptionId,
    state.selectedItemId,
    syncSelectionContext
  ])

  useEffect(() => {
    let disposed = false
    let themeChanged = false
    let localeChanged = false
    const themeSubscription = client.ui.onDidChangeTheme((value) => {
      themeChanged = true
      dispatch({ type: 'theme', value })
    })
    const localeSubscription = client.ui.onDidChangeLocale((value) => {
      localeChanged = true
      localeRef.current = value
      dispatch({ type: 'locale', value })
    })
    void client.ui.getTheme().then((value) => {
      if (!disposed && !themeChanged) dispatch({ type: 'theme', value })
    }).catch((error) => {
      if (!disposed) pushNotice(classifyError(
        error,
        copy('hostClientError'),
        copy('completeProtectedInteraction'),
        true,
        'hostClientError'
      ))
    })
    void client.ui.getLocale().then((value) => {
      if (disposed || localeChanged) return
      localeRef.current = value
      dispatch({ type: 'locale', value })
    }).catch((error) => {
      if (!disposed) pushNotice(classifyError(
        error,
        copy('hostClientError'),
        copy('completeProtectedInteraction'),
        true,
        'hostClientError'
      ))
    })
    return () => {
      disposed = true
      void themeSubscription.dispose()
      void localeSubscription.dispose()
    }
  }, [client, copy, pushNotice])

  useEffect(() => {
    let disposed = false
    void client.media.getCapabilities().then((value) => {
      if (!disposed) dispatch({ type: 'media-capabilities', value })
    }).catch((error) => {
      if (!disposed) pushNotice(classifyError(
        error,
        copy('mediaCapabilitiesUnavailable'),
        copy('completeProtectedInteraction'),
        true,
        'mediaCapabilitiesUnavailable'
      ))
    })
    return () => { disposed = true }
  }, [client, copy, pushNotice])

  useEffect(() => {
    void initializeEditor()
    return () => { initializationGeneration.current += 1 }
  }, [initializeEditor])

  useEffect(() => {
    if (!state.initialized) return
    let disposed = false
    let reconciling = false
    const reconcile = (): void => {
      if (disposed || reconciling) return
      reconciling = true
      void loadActiveProject({ skipUnchanged: true })
        .then(async (project) => {
          if (disposed || project !== null || !stateRef.current.project) return
          await releaseAllLeases()
          if (!disposed) dispatch({ type: 'clear-project' })
        })
        .catch(() => undefined)
        .finally(() => { reconciling = false })
    }
    const interval = globalThis.setInterval(reconcile, ACTIVE_PROJECT_RECONCILE_INTERVAL_MS)
    return () => {
      disposed = true
      globalThis.clearInterval(interval)
    }
  }, [loadActiveProject, releaseAllLeases, state.initialized])

  useEffect(() => {
    const errorSubscription = client.onDidError((error) => pushNotice(classifyError(
      error,
      copy('hostClientError'),
      copy('completeProtectedInteraction'),
      true,
      'hostClientError'
    )))
    const messageSubscription = client.ui.onDidReceiveMessage((message) => {
      if (message.channel === 'kun.extension.view.overflow') {
        void refreshAll()
        return
      }
      if (message.channel === 'kun-video-editor.project-changed') {
        const change = projectChange(message.payload, copy('projectChanged'))
        if (change) dispatch({ type: 'project-change', value: change })
        if (
          change &&
          (change.projectId === stateRef.current.project?.id || change.reason === 'active-project-changed')
        ) {
          if (change.reason === 'active-project-changed') activeProjectResolutionGeneration.current += 1
          void loadProject(change.projectId)
        }
        return
      }
      if (message.channel === 'kun-video-editor.selection-changed') {
        const updated = selectionUpdateFrom(message.payload)
        if (updated) dispatch({ type: 'selection-synced', ...updated })
        return
      }
      if (message.channel === 'kun-video-editor.derived-changed') {
        const payload = isRecord(message.payload) ? message.payload : undefined
        const record = derivedRecordFrom(payload?.record)
        if (record) dispatch({ type: 'derived-record', value: record })
        const projectId = record?.projectId
        if (projectId && projectId === stateRef.current.project?.id) {
          void loadDerived(projectId)
        }
        return
      }
      if (message.channel === 'kun-video-editor.media-intelligence-progress') {
        const progress = mediaIntelligenceProgressFrom(message.payload)
        if (progress) dispatch({ type: 'media-intelligence-progress', value: progress })
        return
      }
      if (message.channel === 'kun-video-editor.generation-progress') {
        const payload = isRecord(message.payload) ? message.payload : undefined
        const record = generationRecordFrom(payload?.record)
        if (record) dispatch({ type: 'generation-record', value: record })
        return
      }
      if (message.channel === 'kun-video-editor.active-project-changed') {
        const change = projectChange(message.payload, copy('projectChanged'))
        if (change) {
          activeProjectResolutionGeneration.current += 1
          dispatch({ type: 'project-change', value: change })
          void loadProject(change.projectId)
        }
        return
      }
      if (message.channel === 'kun.resultPreview.open') {
        const preview = ResultPreviewOpenPayloadSchema.safeParse(message.payload)
        if (preview.success) {
          dispatch({ type: 'result-preview', value: preview.data })
          if (preview.data.result.mediaHandleId) {
            void openMediaHandleRef.current?.(preview.data.result.mediaHandleId)
          }
        }
        return
      }
      if (message.channel === 'kun-video-editor.command-progress') {
        const progress = isRecord(message.payload) ? message.payload : {}
        if (typeof progress.message === 'string') {
          const key = COMMAND_PROGRESS_MESSAGE_KEYS[progress.message] ?? 'commandProgressGeneric'
          pushNotice({
            id: 'command-progress',
            severity: 'info',
            message: copy(key),
            messageKey: key
          })
        }
      }
    })
    return () => {
      void errorSubscription.dispose()
      void messageSubscription.dispose()
    }
  }, [client, copy, loadDerived, loadProject, pushNotice, refreshAll])

  const activeGenerationKey = useMemo(() => state.generation.records
    .filter(({ state: recordState }) => ['placeholder', 'queued', 'running', 'cancelling'].includes(recordState))
    .map(({ id, generation }) => `${id}:${generation}`)
    .sort()
    .join('|'), [state.generation.records])

  useEffect(() => {
    const projectId = state.project?.id
    if (!projectId) return
    let disposed = false
    let loading = false
    const refresh = (): void => {
      if (disposed || loading) return
      loading = true
      void loadGeneration(projectId).catch(() => undefined).finally(() => { loading = false })
    }
    if (activeGenerationKey) refresh()
    const timer = activeGenerationKey
      ? setInterval(refresh, JOB_STATUS_RECONCILE_INTERVAL_MS)
      : undefined
    return () => {
      disposed = true
      if (timer !== undefined) clearInterval(timer)
    }
  }, [activeGenerationKey, loadGeneration, state.project?.id])

  useEffect(() => {
    const projectId = state.project?.id
    if (!projectId) return
    let disposed = false
    let loading = false
    const refresh = (): void => {
      if (disposed || loading) return
      loading = true
      void loadDerived(projectId).catch((error) => {
        if (!disposed) pushNotice(classifyError(
          error,
          copy('derivedStatusUnavailable'),
          copy('completeProtectedInteraction'),
          true,
          'derivedStatusUnavailable'
        ))
      }).finally(() => { loading = false })
    }
    refresh()
    const timer = activeDerivedKey
      ? setInterval(refresh, JOB_STATUS_RECONCILE_INTERVAL_MS)
      : undefined
    return () => {
      disposed = true
      if (timer !== undefined) clearInterval(timer)
    }
  }, [activeDerivedKey, copy, loadDerived, pushNotice, state.project?.id])

  useEffect(() => {
    if (!state.initialized) return
    const timeout = setTimeout(() => {
      void client.ui.setViewState(toPersistedState(stateRef.current)).catch((error) => {
        pushNotice(classifyError(
          error,
          copy('viewStateSaveFailed'),
          copy('completeProtectedInteraction'),
          true,
          'viewStateSaveFailed'
        ))
      })
    }, 180)
    return () => clearTimeout(timeout)
  }, [
    client,
    copy,
    pushNotice,
    state.activeWorkspace,
    state.agentRun?.id,
    state.initialized,
    state.playheadFrame,
    state.otioExportTickets,
    state.project?.id,
    state.projectPackageTickets,
    state.renderTickets,
    state.selectedItemId,
    state.transcriptWindowStart
  ])

  useEffect(() => {
    const run = state.agentRun
    if (!run || TERMINAL_AGENT_STATES.has(run.state)) return
    let disposed = false
    let subscription: Awaited<ReturnType<typeof client.agent.subscribe>> | undefined
    let eventSubscription: { dispose(): void | Promise<void> } | undefined
    void client.agent.subscribe({
      runId: run.id,
      afterSequence: stateRef.current.agentEvents.at(-1)?.sequence ?? 0
    }).then((created) => {
      if (disposed) return void created.dispose()
      subscription = created
      eventSubscription = created.onEvent((event) => {
        dispatch({ type: 'agent-event', value: event })
        if (event.type === 'state' || event.type === 'terminal') {
          void client.agent.getRun(run.id).then((value) => dispatch({ type: 'agent-run', value }))
        }
        if (agentEventChangesProject(event) && stateRef.current.project) {
          void loadProject(stateRef.current.project.id)
        }
      })
    }).catch((error) => pushNotice(classifyError(
      error,
      copy('agentStreamDisconnected'),
      copy('completeProtectedInteraction'),
      true,
      'agentStreamDisconnected'
    )))
    return () => {
      disposed = true
      void eventSubscription?.dispose()
      void subscription?.dispose()
    }
  }, [client, copy, loadProject, pushNotice, state.agentRun?.id, state.reconnectToken])

  const activeJobsKey = useMemo(() => state.jobs
    .filter(({ state: jobState }) => !TERMINAL_JOB_STATES.has(jobState))
    .map(({ id, state: jobState }) => `${id}:${jobState}`)
    .sort()
    .join('|'), [state.jobs])

  useEffect(() => {
    const active = state.jobs.filter(({ state: jobState }) => !TERMINAL_JOB_STATES.has(jobState))
    const disposables: Array<{ dispose(): void | Promise<void> }> = []
    let disposed = false
    let reconcileInFlight = false
    for (const job of active) {
      void client.jobs.subscribe({ jobId: job.id, afterCursor: job.latestCursor }).then((subscription) => {
        if (disposed) return void subscription.dispose()
        disposables.push(subscription)
        // Register first: the SDK delivers buffered/replayed events synchronously
        // from onEvent() and folds them into the subscription snapshot.
        disposables.push(subscription.onEvent((event) => dispatch({ type: 'job-event', value: event })))
        dispatch({
          type: 'jobs',
          value: [
            ...stateRef.current.jobs.filter(({ id }) => id !== subscription.snapshot.id),
            subscription.snapshot
          ]
        })
        if (subscription.replayGap) {
          pushNotice({
            id: `job-gap-${job.id}`,
            severity: 'warning',
            message: copy('jobProgressExpired'),
            messageKey: 'jobProgressExpired'
          })
        }
      }).catch((error) => {
        const values = { id: job.id }
        pushNotice(classifyError(
          error,
          formatMessage(copy('jobDisconnected'), values),
          copy('completeProtectedInteraction'),
          true,
          'jobDisconnected',
          values
        ))
      })
    }
    const reconcileTimer = active.length > 0
      ? setInterval(() => {
        if (disposed || reconcileInFlight) return
        const tracked = stateRef.current.jobs.filter(({ state: jobState }) =>
          !TERMINAL_JOB_STATES.has(jobState)
        )
        if (tracked.length === 0) return
        reconcileInFlight = true
        void Promise.all(tracked.map(async (job) => {
          try {
            return await client.jobs.get(job.id)
          } catch {
            // The live subscription remains the primary path. A transient status
            // read must not disconnect it or spam the user with duplicate errors.
            return job
          }
        })).then((snapshots) => {
          if (disposed) return
          const refreshed = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]))
          dispatch({
            type: 'jobs',
            value: stateRef.current.jobs.map((job) => refreshed.get(job.id) ?? job)
          })
        }).finally(() => { reconcileInFlight = false })
      }, JOB_STATUS_RECONCILE_INTERVAL_MS)
      : undefined
    return () => {
      disposed = true
      if (reconcileTimer !== undefined) clearInterval(reconcileTimer)
      for (const disposable of disposables) void disposable.dispose()
    }
  }, [activeJobsKey, client, copy, pushNotice, state.reconnectToken])

  useEffect(() => () => {
    for (const leaseId of ownedLeaseIds.current) {
      void client.media.release({ resource: 'lease', leaseId }).catch(() => undefined)
    }
    const handleId = pendingOtioImportHandle.current
    if (handleId) {
      pendingOtioImportHandle.current = undefined
      void client.media.release({ resource: 'handle', handleId }).catch(() => undefined)
    }
  }, [client])
}
