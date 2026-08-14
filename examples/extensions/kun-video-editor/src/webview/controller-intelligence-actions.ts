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
import type { PreviewResource, ProjectPackageExportOptions } from './controller-types.js'
export function useIntelligenceActions(context: EditorActionContext) {
  const { client, dispatch, stateRef, ownedLeaseIds, derivedLeaseCache, derivedLeaseRequests, pendingOtioImportHandle, activeProjectResolutionGeneration, projectLoadGeneration, mediaLibraryLoadGeneration, openMediaHandleRef, copy, pushNotice, execute, releaseAllLeases, loadDerived, loadPreviewHistory, loadMediaIntelligence, loadGeneration, loadProject, loadMediaLibraryPage, loadProjects, loadProjectPackageSnapshot, loadOtioExportSnapshot, refreshJobs, withBusy } = context
  const refreshMediaIntelligence = useCallback(async (): Promise<void> => {
    const project = requiredProject(stateRef.current, copy('openProjectFirst'))
    await loadMediaIntelligence(project.id, project.currentRevision)
  }, [copy, loadMediaIntelligence])

  const setVisualOptIn = useCallback(async (enabled: boolean): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      const content = await execute('analysis.visual-opt-in', {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        enabled
      })
      const visualProvisioning = visualProvisioningFrom(content.capability)
      dispatch({
        type: 'audio-analysis-state',
        projectId: project.id,
        revision: project.currentRevision,
        ...(visualProvisioning ? { visualProvisioning } : {}),
        clearVisualMomentPage: true
      })
      await loadMediaIntelligence(project.id, project.currentRevision)
    })
  }, [copy, execute, loadMediaIntelligence, withBusy])

  const requestVisualModelInstall = useCallback(async (): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      const content = await execute('analysis.visual-install', {
        projectId: project.id,
        expectedRevision: project.currentRevision
      })
      const visualProvisioning = visualProvisioningFrom(content.capability)
      if (visualProvisioning) {
        dispatch({
          type: 'audio-analysis-state',
          projectId: project.id,
          revision: project.currentRevision,
          visualProvisioning
        })
      }
      if (content.outcome !== 'ready') {
        pushNotice({
          id: 'visual-model-install-unavailable',
          severity: 'warning',
          message: visualProvisioning?.remediation ?? copy('visualModelUnavailable'),
          retryable: false
        })
      }
    })
  }, [copy, execute, pushNotice, withBusy])

  const indexVisual = useCallback(async (assetId: string): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      const content = await execute('analysis.visual-index', {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        assetId,
        intervalUs: 2_000_000,
        maxFrames: 240,
        allowPartial: false
      })
      if (content.outcome === 'unavailable') {
        const capability = visualProvisioningFrom(content.capability)
        if (capability) {
          dispatch({
            type: 'audio-analysis-state',
            projectId: project.id,
            revision: project.currentRevision,
            visualProvisioning: capability
          })
        }
        pushNotice({
          id: 'visual-index-unavailable',
          severity: 'warning',
          message: capability?.remediation ?? copy('visualModelUnavailable'),
          retryable: false
        })
        return
      }
      await loadMediaIntelligence(project.id, project.currentRevision)
    })
  }, [copy, execute, loadMediaIntelligence, pushNotice, withBusy])

  const searchVisualMoments = useCallback(async (
    indexId: string,
    query: string,
    offset = 0
  ): Promise<void> => {
    const project = requiredProject(stateRef.current, copy('openProjectFirst'))
    const normalized = query.normalize('NFKC').trim()
    if (!normalized || normalized.length > 256) return
    const content = await execute('analysis.visual-search', {
      projectId: project.id,
      expectedRevision: project.currentRevision,
      analysisId: indexId,
      query: normalized,
      minimumScore: -1,
      offset: Math.max(0, Math.floor(offset)),
      pageSize: 20
    })
    if (content.outcome !== 'ready') {
      pushNotice({
        id: 'visual-search-unavailable',
        severity: 'warning',
        message: typeof content.remediation === 'string'
          ? content.remediation.slice(0, 1_024)
          : copy('visualModelUnavailable'),
        retryable: false
      })
      return
    }
    const visualMomentPage = visualMomentPageFrom(content.page, indexId)
    if (visualMomentPage) {
      dispatch({
        type: 'audio-analysis-state',
        projectId: project.id,
        revision: project.currentRevision,
        visualMomentPage
      })
    }
  }, [copy, execute, pushNotice])

  const analyzeVad = useCallback(async (assetId: string): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      const content = await execute('analysis.vad', {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        assetId
      })
      const evidence = mediaIntelligenceEvidenceFrom(content.evidence)
      if (evidence) dispatch({ type: 'audio-analysis-state', projectId: project.id, revision: project.currentRevision, evidence })
      if (content.outcome === 'unavailable') {
        pushNotice({
          id: 'audio-vad-unavailable',
          severity: 'warning',
          message: copy('audioVadUnavailable'),
          messageKey: 'audioVadUnavailable'
        })
      }
      await loadMediaIntelligence(project.id, project.currentRevision)
    })
  }, [copy, execute, loadMediaIntelligence, pushNotice, withBusy])

  const applyVadAnalysis = useCallback(async (analysisId: string): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      const content = await execute('analysis.vad-apply', {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        analysisId
      })
      if (content.outcome === 'refused') {
        pushNotice({
          id: 'audio-vad-refused',
          severity: 'warning',
          message: copy('audioAnalysisConfidenceRefused'),
          messageKey: 'audioAnalysisConfidenceRefused'
        })
        return
      }
      await loadProject(project.id)
      await loadProjects()
    })
  }, [copy, execute, loadProject, loadProjects, pushNotice, withBusy])

  const importSpeakerEvidence = useCallback(async (
    assetId: string,
    serializedDocument: string
  ): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      if (serializedDocument.length < 2 || serializedDocument.length > 2_097_152) {
        throw new Error(copy('speakerImportInvalid'))
      }
      let document: unknown
      try {
        document = JSON.parse(serializedDocument)
      } catch {
        throw new Error(copy('speakerImportInvalid'))
      }
      if (!isRecord(document)) throw new Error(copy('speakerImportInvalid'))
      const content = await execute('analysis.speaker-import', {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        assetId,
        document: document as JsonObject
      })
      const evidence = mediaIntelligenceEvidenceFrom(content.evidence)
      const identities = speakerIdentitiesFrom(content.identities)
      const record = audioAnalysisRecordFrom(content.record)
      if (content.outcome !== 'ready' || !evidence || !record || record.kind !== 'speaker-diarization') {
        throw new Error(copy('speakerImportInvalid'))
      }
      await loadMediaIntelligence(project.id, project.currentRevision, assetId)
      dispatch({
        type: 'audio-analysis-state',
        projectId: project.id,
        revision: project.currentRevision,
        evidence,
        speakerIdentities: identities,
        clearSpeakerAttributionPlan: true
      })
      const count = record.turnCount ?? evidence.total
      pushNotice({
        id: `speaker-imported-${record.id}`,
        severity: 'info',
        message: formatMessage(copy('speakerImportComplete'), { count }),
        messageKey: 'speakerImportComplete',
        messageValues: { count }
      })
    })
  }, [copy, execute, loadMediaIntelligence, pushNotice, withBusy])

  const previewSpeakerAttribution = useCallback(async (analysisId: string): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      const content = await execute('analysis.speaker-preview', {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        analysisId
      })
      const plan = speakerAttributionPlanFrom(content.plan)
      if (content.outcome !== 'preview' || !plan || plan.analysisId !== analysisId) {
        throw new Error(copy('speakerAttributionPreviewInvalid'))
      }
      dispatch({
        type: 'audio-analysis-state',
        projectId: project.id,
        revision: project.currentRevision,
        speakerAttributionPlan: plan
      })
    })
  }, [copy, execute, withBusy])

  const applySpeakerAttribution = useCallback(async (analysisId: string): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      const content = await execute('analysis.speaker-apply', {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        analysisId
      })
      if (content.outcome === 'refused') {
        pushNotice({
          id: 'speaker-attribution-refused',
          severity: 'warning',
          message: copy('speakerAttributionNoOverlap'),
          messageKey: 'speakerAttributionNoOverlap'
        })
        return
      }
      const plan = speakerAttributionPlanFrom(content.plan)
      if (content.outcome !== 'applied' || !plan || plan.analysisId !== analysisId) {
        throw new Error(copy('speakerAttributionPreviewInvalid'))
      }
      await loadProject(project.id)
      await loadProjects()
      pushNotice({
        id: `speaker-attribution-applied-${analysisId}`,
        severity: 'info',
        message: formatMessage(copy('speakerAttributionApplied'), {
          identified: plan.identifiedCount,
          uncertain: plan.uncertainCount
        }),
        messageKey: 'speakerAttributionApplied',
        messageValues: { identified: plan.identifiedCount, uncertain: plan.uncertainCount }
      })
    })
  }, [copy, execute, loadProject, loadProjects, pushNotice, withBusy])

  const analyzeBeats = useCallback(async (assetId: string): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      const content = await execute('analysis.beats', {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        assetId
      })
      if (content.outcome === 'unavailable') {
        pushNotice({
          id: 'audio-beats-unavailable',
          severity: 'warning',
          message: copy('audioBeatUnavailable'),
          messageKey: 'audioBeatUnavailable'
        })
      }
      const evidence = mediaIntelligenceEvidenceFrom(content.evidence)
      if (evidence) dispatch({ type: 'audio-analysis-state', projectId: project.id, revision: project.currentRevision, evidence })
      await loadMediaIntelligence(project.id, project.currentRevision)
    })
  }, [copy, execute, loadMediaIntelligence, pushNotice, withBusy])

  const analyzeDenoiseMetadata = useCallback(async (assetId: string): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      const content = await execute('analysis.denoise-metadata', {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        assetId,
        confidenceThreshold: 0.7
      })
      if (content.outcome === 'unavailable') {
        pushNotice({
          id: 'audio-denoise-unavailable',
          severity: 'warning',
          message: copy('audioDenoiseUnavailable'),
          messageKey: 'audioDenoiseUnavailable',
          retryable: content.retryable === true
        })
      }
      const evidence = mediaIntelligenceEvidenceFrom(content.evidence)
      if (evidence) {
        dispatch({
          type: 'audio-analysis-state',
          projectId: project.id,
          revision: project.currentRevision,
          evidence
        })
      }
      await loadMediaIntelligence(project.id, project.currentRevision, assetId)
    })
  }, [copy, execute, loadMediaIntelligence, pushNotice, withBusy])

  const previewAudioSync = useCallback(async (
    referenceItemId: string,
    targetItemId: string,
    seed = 0
  ): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      const reference = project.items.find(({ id }) => id === referenceItemId)
      const target = project.items.find(({ id }) => id === targetItemId)
      if (!reference || !target) throw new Error(copy('audioSyncSelectTwoClips'))
      const content = await execute('analysis.sync-preview', {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        referenceAssetId: reference.assetId,
        targetAssetId: target.assetId,
        referenceItemId,
        targetItemId,
        seed: Math.max(0, Math.min(0x7fffffff, Math.floor(seed))),
        maximumOffsetUs: 10_000_000,
        threshold: 0.82,
        minimumSeparation: 0.03
      })
      if (content.outcome === 'unavailable') {
        pushNotice({
          id: 'audio-sync-unavailable',
          severity: 'warning',
          message: copy('audioSyncUnavailable'),
          messageKey: 'audioSyncUnavailable'
        })
        return
      }
      const preview = audioSyncPreviewFrom(content.preview)
      const evidence = mediaIntelligenceEvidenceFrom(content.evidence)
      dispatch({
        type: 'audio-analysis-state',
        projectId: project.id,
        revision: project.currentRevision,
        ...(preview ? { syncPreview: preview } : {}),
        ...(evidence ? { evidence } : {})
      })
      await loadMediaIntelligence(project.id, project.currentRevision)
    })
  }, [copy, execute, loadMediaIntelligence, pushNotice, withBusy])

  const applyAudioSync = useCallback(async (
    analysisId: string,
    referenceItemId: string,
    targetItemId: string
  ): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      const content = await execute('analysis.sync-apply', {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        analysisId,
        referenceItemId,
        targetItemId
      })
      if (content.outcome === 'refused') {
        pushNotice({
          id: 'audio-sync-refused',
          severity: 'warning',
          message: copy('audioSyncConfidenceRefused'),
          messageKey: 'audioSyncConfidenceRefused'
        })
        return
      }
      dispatch({ type: 'audio-analysis-state', projectId: project.id, revision: project.currentRevision, clearSyncPreview: true })
      await loadProject(project.id)
      await loadProjects()
    })
  }, [copy, execute, loadProject, loadProjects, pushNotice, withBusy])

  const cancelMediaIntelligence = useCallback(async (operationId: string): Promise<void> => {
    const project = requiredProject(stateRef.current, copy('openProjectFirst'))
    await execute('analysis.cancel', {
      projectId: project.id,
      expectedRevision: project.currentRevision,
      operationId
    })
    await loadMediaIntelligence(project.id, project.currentRevision)
  }, [copy, execute, loadMediaIntelligence])

  const startDerivedRequest = useCallback(async (
    kind: 'waveform' | 'thumbnail' | 'filmstrip' | 'proxy',
    retryRecord?: DerivedMediaRecordProjection
  ): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      const assetId = retryRecord?.assetId ?? stateRef.current.selectedAssetId
      const asset = assetFromState(stateRef.current, assetId)
      if (!asset?.mediaHandleId) throw new Error(copy('selectAssetForDerived'))
      const target = derivedTarget(kind, project.id, asset.id, copy)
      const selection = await client.media.pickSaveTarget({
        suggestedName: target.suggestedName,
        filters: [{
          name: target.filterName,
          extensions: [target.extension],
          mimeTypes: [target.mimeType]
        }]
      })
      if (selection.outcome === 'cancelled') return
      let content: Record<string, unknown>
      try {
        content = await execute(retryRecord ? 'derived.retry' : 'derived.start', {
          projectId: project.id,
          expectedRevision: project.currentRevision,
          assetId: asset.id,
          kind,
          outputHandleId: selection.target.handleId,
          priority: kind === 'thumbnail' || kind === 'waveform' ? 'interactive' : 'user',
          parameters: derivedParameters(kind, asset.durationUs),
          ...(retryRecord ? { recordId: retryRecord.id } : {})
        })
      } catch (error) {
        // The Host service persists the opaque output grant before admission.
        // Keep it alive after an ambiguous transport failure for safe recovery.
        if (!isOpaqueHostError(error)) {
          await client.media.release({
            resource: 'handle',
            handleId: selection.target.handleId
          }).catch(() => undefined)
        }
        throw error
      }
      const record = derivedRecordFrom(content.record)
      if (record) dispatch({ type: 'derived-record', value: record })
      if (content.outcome !== 'queued') {
        await client.media.release({
          resource: 'handle',
          handleId: selection.target.handleId
        }).catch(() => undefined)
      } else {
        dispatch({ type: 'media', value: [selection.target] })
        if (typeof content.jobId === 'string') {
          const snapshot = await client.jobs.get(content.jobId)
          dispatch({ type: 'jobs', value: [...stateRef.current.jobs, snapshot] })
        }
      }
      if (content.outcome === 'unavailable') {
        pushNotice({
          id: 'derived-media-unavailable',
          severity: 'warning',
          message: copy('derivedFfmpegUnavailable'),
          messageKey: 'derivedFfmpegUnavailable'
        })
      }
      await loadDerived(project.id)
    })
  }, [client, copy, execute, loadDerived, pushNotice, withBusy])

  const startDerived = useCallback(async (
    kind: 'waveform' | 'thumbnail' | 'filmstrip' | 'proxy'
  ): Promise<void> => await startDerivedRequest(kind), [startDerivedRequest])

  const retryDerived = useCallback(async (record: DerivedMediaRecordProjection): Promise<void> => {
    if (!['waveform', 'thumbnail', 'filmstrip', 'proxy'].includes(record.kind)) {
      pushNotice({
        id: `derived-retry-unsupported-${record.id}`,
        severity: 'warning',
        message: copy('derivedRetryUnsupported'),
        messageKey: 'derivedRetryUnsupported'
      })
      return
    }
    await startDerivedRequest(record.kind as 'waveform' | 'thumbnail' | 'filmstrip' | 'proxy', record)
  }, [copy, pushNotice, startDerivedRequest])

  const cancelDerived = useCallback(async (recordId: string): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      await execute('derived.cancel', { projectId: project.id, recordId })
      await loadDerived(project.id)
    })
  }, [copy, execute, loadDerived, withBusy])

  const cleanupDerived = useCallback(async (includeReady = false): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      await execute('derived.cleanup', { projectId: project.id, includeReady })
      await loadDerived(project.id)
    })
  }, [copy, execute, loadDerived, withBusy])

  return { refreshMediaIntelligence, setVisualOptIn, requestVisualModelInstall, indexVisual, searchVisualMoments, analyzeVad, applyVadAnalysis, importSpeakerEvidence, previewSpeakerAttribution, applySpeakerAttribution, analyzeBeats, analyzeDenoiseMetadata, previewAudioSync, applyAudioSync, cancelMediaIntelligence, startDerivedRequest, startDerived, retryDerived, cancelDerived, cleanupDerived }
}
