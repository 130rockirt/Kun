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
export function useProjectMediaActions(context: EditorActionContext) {
  const { client, dispatch, stateRef, ownedLeaseIds, derivedLeaseCache, derivedLeaseRequests, pendingOtioImportHandle, activeProjectResolutionGeneration, projectLoadGeneration, mediaLibraryLoadGeneration, openMediaHandleRef, copy, pushNotice, execute, releaseAllLeases, loadDerived, loadPreviewHistory, loadMediaIntelligence, loadGeneration, loadProject, loadMediaLibraryPage, loadProjects, loadProjectPackageSnapshot, loadOtioExportSnapshot, refreshJobs, withBusy } = context
  const createProject = useCallback(async (
    name: string,
    preset: CanvasPreset,
    fps: { numerator: number; denominator: number } = { numerator: 30, denominator: 1 }
  ): Promise<void> => {
    await withBusy(async () => {
      const normalized = name.trim().slice(0, 160)
      if (!normalized) throw new Error(copy('projectNameRequired'))
      const idBase = normalized.toLowerCase().replace(/[^a-z0-9._~-]+/gu, '-').replace(/^-|-$/gu, '') || 'video'
      const projectId = `${idBase.slice(0, 96)}-${Date.now().toString(36)}`
      const content = await execute('project.create', {
        projectId,
        name: normalized,
        canvasPreset: preset,
        fps
      })
      const created = projectFrom(content, copy('invalidProjectProjection'))
      await loadProject(created.id)
      await loadProjects()
    })
  }, [copy, execute, loadProject, loadProjects, withBusy])

  const openProject = useCallback(async (projectId: string): Promise<void> => {
    await withBusy(async () => {
      await execute('project.select', { projectId })
      await loadProject(projectId)
    })
  }, [execute, loadProject, withBusy])

  const refreshGeneration = useCallback(async (): Promise<void> => {
    const project = requiredProject(stateRef.current, copy('openProjectFirst'))
    await loadGeneration(project.id)
  }, [copy, loadGeneration])

  const requestGeneration = useCallback(async (request: GenerationPanelRequest): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      if (request.projectId !== project.id || request.projectRevision !== project.currentRevision) {
        throw new Error(copy('projectChanged'))
      }
      const content = await execute('generation.request', request as unknown as JsonObject)
      if (content.outcome === 'confirmation-required') {
        throw new Error(typeof content.message === 'string'
          ? content.message.slice(0, 512)
          : copy('editorOperationFailed'))
      }
      if (content.outcome === 'unavailable') {
        pushNotice({
          id: 'generation-unavailable',
          severity: 'warning',
          message: typeof content.message === 'string'
            ? content.message.slice(0, 512)
            : copy('editorOperationFailed')
        })
      }
      await loadGeneration(project.id)
    })
  }, [copy, execute, loadGeneration, pushNotice, withBusy])

  const retryGeneration = useCallback(async (
    recordId: string,
    consent: GenerationConsent
  ): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      const content = await execute('generation.retry', {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        recordId,
        consent: consent as unknown as JsonObject
      })
      if (content.outcome === 'confirmation-required' || content.outcome === 'unavailable') {
        pushNotice({
          id: `generation-retry-${recordId}`,
          severity: 'warning',
          message: typeof content.message === 'string'
            ? content.message.slice(0, 512)
            : copy('editorOperationFailed')
        })
      }
      await loadGeneration(project.id)
    })
  }, [copy, execute, loadGeneration, pushNotice, withBusy])

  const cancelGeneration = useCallback(async (recordId: string): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      await execute('generation.cancel', { projectId: project.id, recordId })
      await loadGeneration(project.id)
    })
  }, [copy, execute, loadGeneration, withBusy])

  const insertGeneratedVariant = useCallback(async (
    recordId: string,
    outputId: string
  ): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      const content = await execute('generation.insert', {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        recordId,
        outputId,
        addToTimeline: true,
        timelineStartFrame: project.selection.playheadFrame,
        stillDurationFrames: 150
      })
      if (!['inserted', 'already-in-project'].includes(String(content.outcome))) {
        throw new Error(copy('invalidHostResponse'))
      }
      await loadProject(project.id)
      await loadProjects()
    })
  }, [copy, execute, loadProject, loadProjects, withBusy])

  const importMedia = useCallback(async (
    options: { folderId?: string; addToTimeline?: boolean } = {}
  ): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      if (stateRef.current.mediaCapabilities?.ffprobe.available === false) {
        pushNotice({
          id: 'ffprobe-unavailable',
          severity: 'warning',
          message: copy('ffprobeUnavailable'),
          messageKey: 'ffprobeUnavailable'
        })
        return
      }
      const selection = await client.media.pickFiles({
        multiple: true,
        maxFiles: 32,
        filters: [{
          name: copy('chooseMedia'),
          extensions: [
            'mp4', 'mov', 'mkv', 'webm', 'm4a', 'mp3', 'wav',
            'png', 'jpg', 'jpeg', 'webp', 'gif', 'apng'
          ],
          mimeTypes: ['video/*', 'audio/*', 'image/*']
        }]
      })
      if (selection.outcome === 'cancelled') return
      try {
        const content = await execute('media.import-batch', {
          projectId: project.id,
          expectedRevision: project.currentRevision,
          items: selection.files.map((file) => ({
            mediaHandleId: file.handleId,
            ...(visualAssetKind(file.displayName, file.kind) ? {
              assetKind: visualAssetKind(file.displayName, file.kind),
              stillDurationFrames: 150
            } : {})
          })),
          addToTimeline: options.addToTimeline ?? true,
          ...(options.folderId ? { folderId: options.folderId } : {})
        })
        if (content.outcome === 'unavailable') {
          const messageKey: MessageKey = content.code === 'FFPROBE_UNAVAILABLE'
            ? 'ffprobeUnavailable'
            : 'mediaCapabilitiesUnavailable'
          pushNotice({
            id: 'media-import-unavailable',
            severity: 'warning',
            message: copy(messageKey),
            messageKey
          })
          await Promise.all(selection.files.map(({ handleId }) =>
            client.media.release({ resource: 'handle', handleId }).catch(() => undefined)
          ))
          await loadProject(project.id)
          await loadProjects()
          return
        }
        const currentRevision = safeInteger(content.currentRevision)
        if (
          content.outcome !== 'imported-batch' ||
          safeInteger(content.importedCount) !== selection.files.length ||
          currentRevision !== project.currentRevision + 1
        ) {
          throw new Error(copy('invalidHostResponse'))
        }
        dispatch({ type: 'media', value: selection.files })
      } catch (error) {
        const authoritative = await loadProject(project.id).catch(() => undefined)
        // A lost response may hide a successful atomic commit. Only revoke the
        // picker grants when the authoritative revision proves no commit won;
        // otherwise preserving the grants is safer than taking bound media offline.
        let releasable = authoritative?.currentRevision === project.currentRevision
          ? selection.files
          : []
        if (authoritative && authoritative.currentRevision > project.currentRevision) {
          try {
            const retainedHandles = new Set<string>()
            let offset = 0
            for (let pageIndex = 0; pageIndex < 6; pageIndex += 1) {
              const pageContent = await execute('media.list', {
                projectId: project.id,
                expectedRevision: authoritative.currentRevision,
                offset,
                limit: 100
              })
              const page = mediaLibraryPageFrom(pageContent, {
                projectId: project.id,
                revision: authoritative.currentRevision,
                query: ''
              }, copy('invalidHostResponse'))
              for (const asset of page.assets) {
                if (asset.mediaHandleId) retainedHandles.add(asset.mediaHandleId)
              }
              if (page.hiddenAfter === 0) {
                releasable = selection.files.filter(({ handleId }) => !retainedHandles.has(handleId))
                break
              }
              if (page.assets.length === 0) throw new Error(copy('invalidHostResponse'))
              offset += page.assets.length
            }
          } catch {
            // Keep ambiguous picker grants alive rather than revoke media that
            // may have committed on the lost-response path.
            releasable = []
          }
        }
        await Promise.all(releasable.map(({ handleId }) =>
          client.media.release({ resource: 'handle', handleId }).catch(() => undefined)
        ))
        throw error
      }
      await loadProject(project.id)
      await loadProjects()
    })
  }, [client, copy, execute, loadProject, loadProjects, pushNotice, withBusy])

  const importTranscript = useCallback(async (): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      const assetId = stateRef.current.selectedAssetId
      if (!assetId || !assetFromState(stateRef.current, assetId)) {
        throw new Error(copy('selectAssetForTranscript'))
      }
      const selection = await client.media.pickFiles({
        multiple: false,
        maxFiles: 1,
        filters: [{
          name: copy('chooseTranscript'),
          extensions: ['srt', 'vtt', 'json'],
          mimeTypes: ['application/x-subrip', 'text/vtt', 'application/json', 'text/plain']
        }]
      })
      if (selection.outcome === 'cancelled') return
      const file = selection.files[0]!
      try {
        const text = await client.media.readText({ handleId: file.handleId, maxBytes: 512 * 1024 })
        const format = transcriptFormat(
          text.displayName,
          text.mimeType,
          copy('unsupportedTranscriptFormat')
        )
        const content = await execute('transcript.import', {
          projectId: project.id,
          expectedRevision: project.currentRevision,
          assetId,
          transcriptId: `transcript-${Date.now().toString(36)}`,
          mode: 'import',
          format,
          source: text.content
        })
        const values = { count: transcriptSegmentCount(content) }
        pushNotice({
          id: 'transcript-imported',
          severity: 'info',
          message: formatMessage(copy('transcriptImported'), values),
          messageKey: 'transcriptImported',
          messageValues: values
        })
        await loadProject(project.id)
        await loadProjects()
      } finally {
        await client.media.release({ resource: 'handle', handleId: file.handleId }).catch(() => undefined)
      }
    })
  }, [client, copy, execute, loadProject, loadProjects, pushNotice, withBusy])

  const checkLocalTranscriber = useCallback(async (): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      const assetId = stateRef.current.selectedAssetId
      if (!assetId) throw new Error(copy('selectAssetForTranscript'))
      const content = await execute('transcript.import', {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        assetId,
        transcriptId: `transcript-check-${Date.now().toString(36)}`,
        mode: 'local-asr'
      })
      pushNotice({
        id: 'local-transcriber-status',
        severity: content.outcome === 'unavailable' ? 'warning' : 'info',
        message: content.outcome === 'unavailable'
          ? copy('localTranscriberUnavailable')
          : copy('localTranscriberAvailable'),
        messageKey: content.outcome === 'unavailable'
          ? 'localTranscriberUnavailable'
          : 'localTranscriberAvailable'
      })
    })
  }, [copy, execute, pushNotice, withBusy])

  const generateCaptions = useCallback(async (): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      const selectedAssetId = stateRef.current.selectedAssetId
      const transcripts = selectedAssetId
        ? project.transcripts.filter(({ assetId }) => assetId === selectedAssetId)
        : project.transcripts
      const captionTrack = project.tracks.find(({ kind }) => kind === 'caption')
      if (!captionTrack || transcripts.length === 0) throw new Error(copy('transcriptRequiredForCaptions'))
      const content = await execute('caption.generate', {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        trackId: captionTrack.id,
        ...(selectedAssetId ? { assetId: selectedAssetId } : {}),
        idPrefix: `caption-auto-${Date.now().toString(36)}`,
        placement: 'bottom',
        style: { fontSize: 42, color: '#FFFFFF', background: '#000000', maxWidthRatio: 0.84 },
        animation: { kind: 'none' }
      })
      const values = { count: safeInteger(content.generatedCount) ?? 0 }
      pushNotice({
        id: 'captions-generated',
        severity: 'info',
        message: formatMessage(copy('generatedCaptions'), values),
        messageKey: 'generatedCaptions',
        messageValues: values
      })
      await loadProject(project.id)
      await loadProjects()
    })
  }, [copy, execute, loadProject, loadProjects, pushNotice, withBusy])

  const openMediaHandle = useCallback(async (handleId: string): Promise<void> => {
    const existing = stateRef.current.leases[handleId]
    if (existing && Date.parse(existing.expiresAt) - Date.now() > 30_000) {
      dispatch({ type: 'active-media', handleId, url: existing.url })
      return
    }
    try {
      const previous = stateRef.current.activeMediaHandleId
      if (previous && previous !== handleId) {
        const lease = stateRef.current.leases[previous]
        if (lease) {
          ownedLeaseIds.current.delete(lease.leaseId)
          await client.media.release({ resource: 'lease', leaseId: lease.leaseId }).catch(() => undefined)
        }
      }
      const lease = await client.media.openViewResource({ handleId })
      ownedLeaseIds.current.add(lease.leaseId)
      dispatch({ type: 'lease', value: lease })
      dispatch({ type: 'active-media', handleId, url: lease.url })
    } catch (error) {
      if (isRevokedMediaError(error)) dispatch({ type: 'media-revoked', handleId })
      throw error
    }
  }, [client])
  openMediaHandleRef.current = openMediaHandle

  const openAsset = useCallback(async (assetId: string): Promise<void> => {
    const project = requiredProject(stateRef.current, copy('openProjectFirst'))
    const asset = assetFromState(stateRef.current, assetId)
    if (!asset?.mediaHandleId) {
      pushNotice({
        id: 'asset-unavailable',
        severity: 'warning',
        message: copy('assetUnavailable'),
        messageKey: 'assetUnavailable'
      })
      return
    }
    dispatch({ type: 'selection', assetId })
    await withBusy(() => openMediaHandle(asset.mediaHandleId!))
  }, [copy, openMediaHandle, pushNotice, withBusy])

  const openPassiveMediaHandle = useCallback(async (handleId: string): Promise<string> => {
    const existing = derivedLeaseCache.current.get(handleId) ?? stateRef.current.leases[handleId]
    if (existing && Date.parse(existing.expiresAt) - Date.now() > 30_000) return existing.url
    if (existing) {
      derivedLeaseCache.current.delete(handleId)
      ownedLeaseIds.current.delete(existing.leaseId)
      await client.media.release({ resource: 'lease', leaseId: existing.leaseId }).catch(() => undefined)
      dispatch({ type: 'lease-release', handleId })
    }
    let request = derivedLeaseRequests.current.get(handleId)
    if (!request) {
      request = client.media.openViewResource({ handleId })
      derivedLeaseRequests.current.set(handleId, request)
    }
    let lease: MediaResourceLease
    try {
      lease = await request
    } finally {
      if (derivedLeaseRequests.current.get(handleId) === request) derivedLeaseRequests.current.delete(handleId)
    }
    derivedLeaseCache.current.set(handleId, lease)
    ownedLeaseIds.current.add(lease.leaseId)
    dispatch({ type: 'lease', value: lease })
    return lease.url
  }, [client])

  const openDerivedResource = useCallback(async (recordId: string): Promise<string | undefined> => {
    const record = stateRef.current.derivedRecords.find(({ id }) => id === recordId)
    const handleId = record?.artifactHandleId
    if (!handleId) return undefined
    return await openPassiveMediaHandle(handleId)
  }, [openPassiveMediaHandle])

  const refreshActiveLease = useCallback(async (): Promise<void> => {
    const handleId = stateRef.current.activeMediaHandleId
    if (!handleId) return
    const lease = stateRef.current.leases[handleId]
    if (lease) {
      ownedLeaseIds.current.delete(lease.leaseId)
      await client.media.release({ resource: 'lease', leaseId: lease.leaseId }).catch(() => undefined)
    }
    dispatch({ type: 'lease-release', handleId })
    await withBusy(() => openMediaHandle(handleId))
  }, [client, openMediaHandle, withBusy])

  const recoverMedia = useCallback(async (requestedAssetId?: string): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      const assetId = requestedAssetId ?? stateRef.current.selectedAssetId
      const asset = assetFromState(stateRef.current, assetId)
      if (!asset) throw new Error(copy('assetUnavailable'))
      const selection = await client.media.pickFiles({
        multiple: false,
        maxFiles: 1,
        filters: [{
          name: copy('chooseReplacementMedia'),
          extensions: asset.kind === 'video'
            ? ['mp4', 'mov', 'mkv', 'webm']
            : asset.kind === 'audio'
              ? ['m4a', 'mp3', 'wav']
              : ['png', 'jpg', 'jpeg', 'webp', 'gif', 'apng'],
          mimeTypes: [asset.kind === 'animation' ? 'image/*' : `${asset.kind}/*`]
        }]
      })
      if (selection.outcome === 'cancelled') return
      const replacement = selection.files[0]!
      dispatch({ type: 'media', value: [replacement] })
      try {
        await releaseAllLeases()
        await execute('media.reauthorize', {
          projectId: project.id,
          expectedRevision: project.currentRevision,
          assetId: asset.id,
          mediaHandleId: replacement.handleId
        })
      } catch (error) {
        await client.media.release({
          resource: 'handle',
          handleId: replacement.handleId
        }).catch(() => undefined)
        throw error
      }
      const values = { name: asset.name }
      pushNotice({
        id: `asset-reauthorized-${asset.id}`,
        severity: 'info',
        message: formatMessage(copy('mediaReauthorized'), values),
        messageKey: 'mediaReauthorized',
        messageValues: values
      })
      await loadProject(project.id)
    })
  }, [client, copy, execute, loadProject, pushNotice, releaseAllLeases, withBusy])

  const refreshDerived = useCallback(async (): Promise<void> => {
    const project = requiredProject(stateRef.current, copy('openProjectFirst'))
    await loadDerived(project.id)
  }, [copy, loadDerived])

  return { createProject, openProject, refreshGeneration, requestGeneration, retryGeneration, cancelGeneration, insertGeneratedVariant, importMedia, importTranscript, checkLocalTranscriber, generateCaptions, openMediaHandle, openAsset, openPassiveMediaHandle, openDerivedResource, refreshActiveLease, recoverMedia, refreshDerived }
}
