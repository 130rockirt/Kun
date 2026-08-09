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

type DataLoaderContext = {
  dispatch(action: EditorAction): void
  stateRef: { current: EditorState }
  execute(action: string, payload?: JsonObject): Promise<Record<string, unknown>>
  copy(key: MessageKey, values?: Readonly<Record<string, string | number>>): string
}

export function useControllerDataLoaders({ dispatch, stateRef, execute, copy }: DataLoaderContext) {
  const loadDerived = useCallback(async (
    projectId: string,
    expectedRevision = stateRef.current.project?.id === projectId
      ? stateRef.current.project.currentRevision
      : -1
  ): Promise<void> => {
    const content = await execute('derived.list', { projectId })
    const records = Array.isArray(content.records)
      ? content.records.map(derivedRecordFrom).filter((value): value is DerivedMediaRecordProjection => value !== undefined)
      : []
    const usage = derivedUsageFrom(content.usage)
    const recoveryDiagnostics = Array.isArray(content.recoveryDiagnostics)
      ? content.recoveryDiagnostics.filter((value): value is string => typeof value === 'string').slice(0, 32)
      : []
    dispatch({
      type: 'derived',
      projectId,
      revision: expectedRevision,
      records,
      ...(usage ? { usage } : {}),
      recoveryDiagnostics
    })
  }, [execute])

  const loadPreviewHistory = useCallback(async (projectId: string): Promise<void> => {
    const content = await execute('preview.list', { projectId })
    const history = previewHistoryFrom(content.history)
    if (history) dispatch({ type: 'preview-history', projectId, value: history })
    const comparison = previewComparisonFrom(content.comparison)
    if (comparison) dispatch({ type: 'preview-comparison', projectId, value: comparison })
  }, [execute])

  const loadMediaIntelligence = useCallback(async (
    projectId: string,
    expectedRevision: number,
    preferredAssetId = stateRef.current.project?.id === projectId
      ? stateRef.current.selectedAssetId
      : undefined
  ): Promise<void> => {
    const [capabilityContent, listContent] = await Promise.all([
      execute('analysis.capabilities', { projectId, expectedRevision }),
      execute('analysis.list', { projectId, expectedRevision })
    ])
    const capabilities = audioAnalysisCapabilitiesFrom(capabilityContent.capabilities)
    const denoiseMetadataCapability = denoiseMetadataCapabilityFrom(capabilityContent.denoiseMetadata)
    const visualProvisioning = visualProvisioningFrom(capabilityContent.visual)
    const speakerAdapters = speakerAdaptersFrom(capabilityContent.speakerAdapters)
    const speakerIdentities = speakerIdentitiesFrom(capabilityContent.speakerIdentities)
    const records = Array.isArray(listContent.records)
      ? listContent.records
        .map(audioAnalysisRecordFrom)
        .filter((value): value is AudioAnalysisRecordProjection => value !== undefined)
      : []
    const operations = Array.isArray(listContent.operations)
      ? listContent.operations
        .map(mediaIntelligenceProgressFrom)
        .filter((value): value is MediaIntelligenceProgressProjection => value !== undefined)
      : []
    const currentEvidenceRecord = records.find((record) =>
      record.id === stateRef.current.mediaIntelligenceEvidence?.recordId &&
      record.currentGrant !== false
    )
    const cachedSpeaker = [...records].reverse().find((record) =>
      record.kind === 'speaker-diarization' &&
      record.currentGrant !== false &&
      (preferredAssetId === undefined || record.assetId === preferredAssetId)
    )
    const cachedVad = [...records].reverse().find((record) =>
      record.kind === 'vad' &&
      record.currentGrant !== false &&
      (preferredAssetId === undefined || record.assetId === preferredAssetId)
    )
    const cachedDenoise = [...records].reverse().find((record) =>
      record.kind === 'denoise-metadata' &&
      record.currentGrant !== false &&
      (preferredAssetId === undefined || record.assetId === preferredAssetId)
    )
    const cachedEvidenceRecord = currentEvidenceRecord ?? cachedSpeaker ?? cachedVad ?? cachedDenoise
    let evidence: MediaIntelligenceEvidenceProjection | undefined
    if (cachedEvidenceRecord) {
      const evidenceContent = await execute('analysis.evidence', {
        projectId,
        expectedRevision,
        analysisId: cachedEvidenceRecord.id,
        offset: 0,
        limit: 200
      }).catch(() => undefined)
      evidence = mediaIntelligenceEvidenceFrom(evidenceContent?.evidence)
    }
    dispatch({
      type: 'audio-analysis-state',
      projectId,
      revision: expectedRevision,
      ...(capabilities ? { capabilities } : {}),
      ...(denoiseMetadataCapability ? { denoiseMetadataCapability } : {}),
      ...(visualProvisioning ? { visualProvisioning } : {}),
      speakerAdapters,
      speakerIdentities,
      records,
      operations,
      ...(evidence ? { evidence } : {})
    })
  }, [execute])

  const loadGeneration = useCallback(async (projectId: string): Promise<void> => {
    const [catalogContent, listContent] = await Promise.all([
      execute('generation.catalog'),
      execute('generation.list', { projectId })
    ])
    const catalog = generationCatalogFrom(catalogContent.catalog)
    if (!catalog) throw new Error(copy('invalidHostResponse'))
    const records = Array.isArray(listContent.records)
      ? listContent.records
        .map(generationRecordFrom)
        .filter((value): value is GenerationRecordProjection => value !== undefined)
      : []
    const recoveryDiagnostics = Array.isArray(listContent.recoveryDiagnostics)
      ? listContent.recoveryDiagnostics
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.slice(0, 512))
        .slice(0, 32)
      : []
    const value: GenerationStateProjection = {
      catalog,
      outcome: catalogContent.outcome === 'available' ? 'available' : 'unavailable',
      ...(typeof catalogContent.message === 'string'
        ? { unavailableMessage: catalogContent.message.slice(0, 512) }
        : {}),
      records,
      recoveryDiagnostics
    }
    dispatch({ type: 'generation-state', projectId, value })
  }, [copy, execute])

  return { loadDerived, loadPreviewHistory, loadMediaIntelligence, loadGeneration }
}
