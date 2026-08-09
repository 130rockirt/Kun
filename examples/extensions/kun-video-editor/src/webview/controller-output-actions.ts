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
import type { EditorMediaActionContext } from './controller-action-context.js'
import type { PreviewResource, ProjectPackageExportOptions } from './controller-types.js'
export function useOutputActions(context: EditorMediaActionContext) {
  const { client, dispatch, stateRef, ownedLeaseIds, derivedLeaseCache, derivedLeaseRequests, pendingOtioImportHandle, activeProjectResolutionGeneration, projectLoadGeneration, mediaLibraryLoadGeneration, openMediaHandleRef, copy, pushNotice, execute, releaseAllLeases, loadDerived, loadPreviewHistory, loadMediaIntelligence, loadGeneration, loadProject, loadMediaLibraryPage, loadProjects, loadProjectPackageSnapshot, loadOtioExportSnapshot, refreshJobs, withBusy, openMediaHandle } = context
  const startRender = useCallback(async (
    kind: RenderTicket['renderKind'],
    captionMode: 'none' | 'burned' | 'sidecar' | 'both',
    subtitleFormat: 'srt' | 'vtt' = 'srt',
    options: {
      multicamGroupId?: string
      range?: { startFrame: number; endFrame: number }
    } = {}
  ): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      assertRenderCapabilities(stateRef.current, kind, captionMode, copy)
      const extension = kind === 'proof-frame'
        ? 'png'
        : kind === 'audio-aac'
          ? 'm4a'
          : kind === 'subtitles'
            ? subtitleFormat
            : 'mp4'
      const mimeType = kind === 'proof-frame'
        ? 'image/png'
        : kind === 'audio-aac'
          ? 'audio/mp4'
          : kind === 'subtitles'
            ? subtitleFormat === 'srt' ? 'application/x-subrip' : 'text/vtt'
            : 'video/mp4'
      const picked = await client.media.pickSaveTarget({
        suggestedName: `${project.id}-revision-${project.currentRevision}.${extension}`,
        filters: [{ name: copy('chooseRenderedMedia'), extensions: [extension], mimeTypes: [mimeType] }]
      })
      if (picked.outcome === 'cancelled') return
      const selectedTargets = [picked.target]
      const releaseSelectedTargets = async (): Promise<void> => {
        await Promise.all(selectedTargets.map(({ handleId }) =>
          client.media.release({ resource: 'handle', handleId }).catch(() => undefined)
        ))
      }
      let subtitleTarget: typeof picked.target | undefined
      if (captionMode === 'sidecar' || captionMode === 'both') {
        let subtitle
        try {
          subtitle = await client.media.pickSaveTarget({
            suggestedName: `${project.id}-revision-${project.currentRevision}.${subtitleFormat}`,
            filters: [{
              name: subtitleFormat === 'srt' ? copy('chooseSubRipCaptions') : copy('chooseWebVttCaptions'),
              extensions: [subtitleFormat],
              mimeTypes: [subtitleFormat === 'srt' ? 'application/x-subrip' : 'text/vtt']
            }]
          })
        } catch (error) {
          await releaseSelectedTargets()
          throw error
        }
        if (subtitle.outcome === 'cancelled') {
          await releaseSelectedTargets()
          return
        }
        subtitleTarget = subtitle.target
        selectedTargets.push(subtitle.target)
      }
      let content: Record<string, unknown>
      try {
        content = await execute('render.start', {
          projectId: project.id,
          expectedRevision: project.currentRevision,
          kind,
          outputHandleId: picked.target.handleId,
          ...(kind === 'proof-frame' ? { proofFrame: stateRef.current.playheadFrame } : {}),
          ...(options.multicamGroupId ? { multicamGroupId: options.multicamGroupId } : {}),
          ...(options.range ?? {}),
          captionMode,
          ...(kind === 'subtitles' ? { subtitleFormat } : {}),
          ...(subtitleTarget ? {
            subtitleOutputHandleId: subtitleTarget.handleId,
            subtitleFormat
          } : {}),
          idempotencyKey: `${project.id}-${project.currentRevision}-${kind}-${options.multicamGroupId ?? 'timeline'}-${Date.now().toString(36)}`
        })
      } catch (error) {
        // An opaque transport failure may have happened after the durable job
        // accepted these handles. Keep them alive so recovery/status can work.
        if (!isOpaqueHostError(error)) await releaseSelectedTargets()
        throw error
      }
      if (content.outcome === 'unavailable') {
        await releaseSelectedTargets()
        const messageKey = renderCapabilityMessageKey(content.code)
        const capabilityDetails = renderCapabilityDetails(content)
        pushNotice({
          id: 'render-capability-unavailable',
          severity: 'warning',
          message: copy(messageKey),
          messageKey,
          ...(capabilityDetails.length > 0 ? { capabilityDetails } : {})
        })
        return
      }
      if (content.outcome === 'cancelled') {
        await releaseSelectedTargets()
        return
      }
      if (content.outcome !== 'queued' || typeof content.jobId !== 'string') {
        await releaseSelectedTargets()
        throw new Error(copy('renderJobMissing'))
      }
      dispatch({ type: 'media', value: selectedTargets })
      const ticket: RenderTicket = {
        jobId: content.jobId,
        projectId: project.id,
        pinnedRevision: safeInteger(content.pinnedRevision) ?? project.currentRevision,
        renderKind: isRenderKind(content.renderKind) ? content.renderKind : kind,
        createdAt: new Date().toISOString()
      }
      dispatch({ type: 'render-ticket', value: ticket })
      const snapshot = await client.jobs.get(ticket.jobId)
      dispatch({ type: 'jobs', value: [...stateRef.current.jobs, snapshot] })
    })
  }, [client, copy, execute, pushNotice, withBusy])

  const runMulticamMutation = useCallback(async (
    action:
      | 'multicam.create'
      | 'multicam.labels'
      | 'multicam.sync-confirm'
      | 'multicam.switch'
      | 'multicam.layout'
      | 'multicam.merge',
    payload: Record<string, unknown>
  ): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      await execute(action, {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        ...payload
      })
      await loadProject(project.id)
      await loadProjects()
    })
  }, [copy, execute, loadProject, loadProjects, withBusy])

  const createMulticam = useCallback(async (request: MulticamCreateRequest): Promise<void> => {
    const project = requiredProject(stateRef.current, copy('openProjectFirst'))
    const name = boundedName(request.name, copy('multicamNameRequired'))
    const groupId = localId('multicam', name)
    const selectedAssets = request.assetIds.map((assetId) => {
      const asset = project.assets.find((candidate) => candidate.id === assetId)
      if (!asset || asset.kind !== 'video' || (asset.availability ?? 'online') !== 'online') {
        throw new Error(copy('multicamSourceUnavailable'))
      }
      return asset
    })
    const members = selectedAssets.map((asset, index) => ({
      id: `${groupId.slice(0, 118)}-m${index + 1}`,
      assetId: asset.id,
      memberLabel: asset.name.normalize('NFKC').trim().slice(0, 96),
      angleLabel: `${index + 1}. ${asset.name.normalize('NFKC').trim()}`.slice(0, 96)
    }))
    const referenceIndex = request.assetIds.indexOf(request.referenceAssetId)
    if (referenceIndex < 0 || !members[referenceIndex]) throw new Error(copy('multicamReferenceRequired'))
    await runMulticamMutation('multicam.create', {
      groupId,
      sequenceId: project.activeSequenceId,
      name,
      referenceMemberId: members[referenceIndex].id,
      members,
      createDefaultLayout: true
    })
  }, [copy, runMulticamMutation])

  const renameMulticamLabels = useCallback(async (request: MulticamRenameRequest): Promise<void> => {
    await runMulticamMutation('multicam.labels', {
      groupId: request.groupId,
      ...(request.groupName ? { name: request.groupName } : {}),
      ...(request.memberId ? {
        members: [{
          memberId: request.memberId,
          ...(request.memberLabel ? { memberLabel: request.memberLabel } : {}),
          ...(request.angleLabel ? { angleLabel: request.angleLabel } : {})
        }]
      } : {})
    })
  }, [runMulticamMutation])

  const confirmMulticamSync = useCallback(async (
    request: MulticamSyncConfirmation
  ): Promise<void> => {
    await runMulticamMutation('multicam.sync-confirm', request)
  }, [runMulticamMutation])

  const switchMulticam = useCallback(async (request: MulticamSwitchRequest): Promise<void> => {
    await runMulticamMutation('multicam.switch', {
      groupId: request.groupId,
      memberId: request.memberId,
      ...request.range,
      coveragePolicy: request.coveragePolicy
    })
  }, [runMulticamMutation])

  const mergeMulticam = useCallback(async (groupId: string): Promise<void> => {
    await runMulticamMutation('multicam.merge', { groupId })
  }, [runMulticamMutation])

  const applyMulticamLayout = useCallback(async (request: MulticamLayoutRequest): Promise<void> => {
    await runMulticamMutation('multicam.layout', {
      groupId: request.groupId,
      layoutId: request.layoutId,
      ...request.range,
      coveragePolicy: request.coveragePolicy
    })
  }, [runMulticamMutation])

  const previewMulticam = useCallback(async (request: MulticamSelectionRequest): Promise<void> => {
    await startRender('preview', 'none', 'srt', {
      multicamGroupId: request.groupId,
      range: request.range
    })
  }, [startRender])

  const cancelJob = useCallback(async (jobId: string): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      await execute('render.cancel', {
        jobId,
        projectId: project.id,
        reason: copy('renderCanceledByUser')
      })
      const snapshot = await client.jobs.get(jobId)
      dispatch({
        type: 'jobs',
        value: stateRef.current.jobs.map((job) => job.id === jobId ? snapshot : job)
      })
    })
  }, [client, copy, execute, withBusy])

  const startProjectPackage = useCallback(async (
    options: ProjectPackageExportOptions
  ): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      const selectedAssetIds = options.mediaScope === 'selected'
        ? [...new Set(options.assetIds ?? [])]
          .filter((assetId) => project.assets.some(({ id }) => id === assetId))
          .slice(0, VIEW_LIMITS.assets)
        : []
      if (options.mediaScope === 'selected' && selectedAssetIds.length === 0) {
        throw new Error(copy('projectPackageSelectMediaFirst'))
      }
      const content = await execute('project-package.export', {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        ...(options.mediaScope === 'selected' ? { assetIds: selectedAssetIds } : {}),
        missingMediaPolicy: options.missingMediaPolicy,
        includeReceipts: options.includeReceipts,
        includeChatProvenance: options.includeAgentProvenance
      })
      if (content.outcome === 'cancelled') return
      if (content.outcome !== 'queued') throw new Error(copy('projectPackageJobMissing'))
      const ticket = projectPackageTicketFrom(
        content.job,
        project,
        options,
        copy('invalidHostResponse')
      )
      const action = { type: 'project-package-ticket', value: ticket } as const
      const nextState = editorReducer(stateRef.current, action)
      dispatch(action)
      try {
        // Persist immediately after the Host has durably accepted the job so a
        // View close/reopen cannot lose the project/revision ownership fence.
        await client.ui.setViewState(toPersistedState(nextState))
      } catch (error) {
        pushNotice({
          ...classifyError(
            error,
            copy('projectPackageTrackingSaveFailed'),
            copy('completeProtectedInteraction'),
            true,
            'projectPackageTrackingSaveFailed'
          ),
          id: `project-package-track-${ticket.jobId}`
        })
      }
      try {
        const snapshot = await client.jobs.get(ticket.jobId)
        assertProjectPackageSnapshot(snapshot, ticket, copy('invalidHostResponse'))
        dispatch({ type: 'jobs', value: [...stateRef.current.jobs, snapshot] })
      } catch (error) {
        pushNotice({
          ...classifyError(
            error,
            copy('projectPackageStatusUnavailable'),
            copy('completeProtectedInteraction'),
            true,
            'projectPackageStatusUnavailable'
          ),
          id: `project-package-status-${ticket.jobId}`
        })
      }
    })
  }, [client, copy, execute, pushNotice, withBusy])

  const refreshProjectPackage = useCallback(async (jobId: string): Promise<void> => {
    await withBusy(async () => {
      const ticket = requiredProjectPackageTicket(stateRef.current, jobId, copy('projectPackageNotTracked'))
      const snapshot = await loadProjectPackageSnapshot(ticket)
      dispatch({
        type: 'jobs',
        value: [...stateRef.current.jobs.filter(({ id }) => id !== snapshot.id), snapshot]
      })
    })
  }, [copy, loadProjectPackageSnapshot, withBusy])

  const cancelProjectPackage = useCallback(async (jobId: string): Promise<void> => {
    await withBusy(async () => {
      const ticket = requiredProjectPackageTicket(stateRef.current, jobId, copy('projectPackageNotTracked'))
      const content = await execute('project-package.cancel', {
        projectId: ticket.projectId,
        jobId: ticket.jobId
      })
      assertProjectPackageProjection(content.job, ticket, copy('invalidHostResponse'))
      const snapshot = await client.jobs.get(ticket.jobId)
      assertProjectPackageSnapshot(snapshot, ticket, copy('invalidHostResponse'))
      dispatch({
        type: 'jobs',
        value: [...stateRef.current.jobs.filter(({ id }) => id !== snapshot.id), snapshot]
      })
    })
  }, [client, copy, execute, withBusy])

  const startOtioExport = useCallback(async (): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      const content = await execute('interchange.export', {
        projectId: project.id,
        expectedRevision: project.currentRevision
      })
      if (content.outcome === 'cancelled') return
      if (content.outcome !== 'queued') throw new Error(copy('interchangeJobMissing'))
      const ticket = otioExportTicketFrom(content.job, project, copy('invalidHostResponse'))
      const action = { type: 'otio-export-ticket', value: ticket } as const
      const nextState = editorReducer(stateRef.current, action)
      dispatch(action)
      try {
        await client.ui.setViewState(toPersistedState(nextState))
      } catch (error) {
        pushNotice({
          ...classifyError(
            error,
            copy('interchangeTrackingSaveFailed'),
            copy('completeProtectedInteraction'),
            true,
            'interchangeTrackingSaveFailed'
          ),
          id: `otio-track-${ticket.jobId}`
        })
      }
      try {
        const snapshot = await client.jobs.get(ticket.jobId)
        assertOtioExportSnapshot(snapshot, ticket, copy('invalidHostResponse'))
        dispatch({ type: 'jobs', value: [...stateRef.current.jobs, snapshot] })
      } catch (error) {
        pushNotice({
          ...classifyError(
            error,
            copy('interchangeStatusUnavailable'),
            copy('completeProtectedInteraction'),
            true,
            'interchangeStatusUnavailable'
          ),
          id: `otio-status-${ticket.jobId}`
        })
      }
    })
  }, [client, copy, execute, pushNotice, withBusy])

  const refreshOtioExport = useCallback(async (jobId: string): Promise<void> => {
    await withBusy(async () => {
      const ticket = requiredOtioExportTicket(stateRef.current, jobId, copy('interchangeNotTracked'))
      const snapshot = await loadOtioExportSnapshot(ticket)
      dispatch({
        type: 'jobs',
        value: [...stateRef.current.jobs.filter(({ id }) => id !== snapshot.id), snapshot]
      })
    })
  }, [copy, loadOtioExportSnapshot, withBusy])

  const cancelOtioExport = useCallback(async (jobId: string): Promise<void> => {
    await withBusy(async () => {
      const ticket = requiredOtioExportTicket(stateRef.current, jobId, copy('interchangeNotTracked'))
      const content = await execute('interchange.cancel', {
        projectId: ticket.projectId,
        jobId: ticket.jobId
      })
      assertOtioExportProjection(content.job, ticket, copy('invalidHostResponse'))
      const snapshot = await client.jobs.get(ticket.jobId)
      assertOtioExportSnapshot(snapshot, ticket, copy('invalidHostResponse'))
      dispatch({
        type: 'jobs',
        value: [...stateRef.current.jobs.filter(({ id }) => id !== snapshot.id), snapshot]
      })
    })
  }, [client, copy, execute, withBusy])

  const previewOtioImport = useCallback(async (): Promise<void> => {
    await withBusy(async () => {
      const selection = await client.media.pickFiles({
        multiple: false,
        maxFiles: 1,
        filters: [{
          name: copy('interchangeChooseDocument'),
          extensions: ['otio', 'json'],
          mimeTypes: ['application/x-otio+json', 'application/json']
        }]
      })
      if (selection.outcome === 'cancelled') return
      const selected = selection.files[0]
      if (!selected) throw new Error(copy('interchangePreviewInvalid'))
      try {
        const content = await execute('interchange.import-preview', {
          inputHandleId: selected.handleId
        })
        const preview = otioImportPreviewFrom(content, copy('interchangePreviewInvalid'))
        const previous = pendingOtioImportHandle.current
        pendingOtioImportHandle.current = preview.inputHandleId
        dispatch({ type: 'otio-import-preview', value: preview })
        if (previous && previous !== preview.inputHandleId) {
          await client.media.release({ resource: 'handle', handleId: previous }).catch(() => undefined)
        }
      } catch (error) {
        await client.media.release({ resource: 'handle', handleId: selected.handleId }).catch(() => undefined)
        throw error
      }
    })
  }, [client, copy, execute, withBusy])

  const confirmOtioImport = useCallback(async (targetProjectId: string): Promise<void> => {
    await withBusy(async () => {
      const preview = stateRef.current.otioImportPreview
      if (!preview || pendingOtioImportHandle.current !== preview.inputHandleId) {
        throw new Error(copy('interchangePreviewRequired'))
      }
      const normalizedTarget = targetProjectId.trim()
      if (!stableProjectionId(normalizedTarget)) throw new Error(copy('interchangeTargetInvalid'))
      const content = await execute('interchange.import', {
        inputHandleId: preview.inputHandleId,
        expectedDocumentDigest: preview.sourceDocumentDigest,
        expectedSourceProjectId: preview.sourceProjectId,
        expectedSourceRevision: preview.sourceProjectRevision,
        targetProjectId: normalizedTarget
      })
      if (
        content.outcome !== 'interchange-imported' ||
        content.persisted !== true ||
        content.overwritten !== false ||
        !isRecord(content.project) ||
        content.project.id !== normalizedTarget
      ) throw new Error(copy('invalidHostResponse'))
      pendingOtioImportHandle.current = undefined
      dispatch({ type: 'otio-import-preview', value: undefined })
      await client.media.release({
        resource: 'handle',
        handleId: preview.inputHandleId
      }).catch(() => undefined)
      await loadProjects()
      await loadProject(normalizedTarget)
    })
  }, [client, copy, execute, loadProject, loadProjects, withBusy])

  const cancelOtioImportPreview = useCallback(async (): Promise<void> => {
    const handleId = pendingOtioImportHandle.current
    pendingOtioImportHandle.current = undefined
    dispatch({ type: 'otio-import-preview', value: undefined })
    if (handleId) {
      await client.media.release({ resource: 'handle', handleId }).catch(() => undefined)
    }
  }, [client])

  const openArtifact = useCallback(async (artifact: GeneratedArtifact): Promise<void> => {
    if (artifact.availability !== 'available') {
      pushNotice({
        id: `artifact-${artifact.artifactId}`,
        severity: 'warning',
        message: copy('artifactUnavailable'),
        messageKey: 'artifactUnavailable'
      })
      return
    }
    if (artifactUsesPlayer(artifact)) {
      await withBusy(() => openMediaHandle(artifact.mediaHandleId))
      return
    }
    await withBusy(async () => {
      await client.media.performArtifactAction({ artifactId: artifact.artifactId, action: 'open' })
    })
  }, [client, copy, openMediaHandle, pushNotice, withBusy])

  const revealArtifact = useCallback(async (artifact: GeneratedArtifact): Promise<void> => {
    if (artifact.availability !== 'available') {
      pushNotice({
        id: `artifact-${artifact.artifactId}`,
        severity: 'warning',
        message: copy('artifactUnavailable'),
        messageKey: 'artifactUnavailable'
      })
      return
    }
    await withBusy(async () => {
      await client.media.performArtifactAction({ artifactId: artifact.artifactId, action: 'reveal' })
    })
  }, [client, copy, pushNotice, withBusy])

  return { startRender, runMulticamMutation, createMulticam, renameMulticamLabels, confirmMulticamSync, switchMulticam, mergeMulticam, applyMulticamLayout, previewMulticam, cancelJob, startProjectPackage, refreshProjectPackage, cancelProjectPackage, startOtioExport, refreshOtioExport, cancelOtioExport, previewOtioImport, confirmOtioImport, cancelOtioImportPreview, openArtifact, revealArtifact }
}
