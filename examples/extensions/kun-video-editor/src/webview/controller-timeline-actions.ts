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
export function useTimelineActions(context: EditorMediaActionContext) {
  const { client, dispatch, stateRef, ownedLeaseIds, derivedLeaseCache, derivedLeaseRequests, pendingOtioImportHandle, activeProjectResolutionGeneration, projectLoadGeneration, mediaLibraryLoadGeneration, openMediaHandleRef, copy, pushNotice, execute, releaseAllLeases, loadDerived, loadPreviewHistory, loadMediaIntelligence, loadGeneration, loadProject, loadMediaLibraryPage, loadProjects, loadProjectPackageSnapshot, loadOtioExportSnapshot, refreshJobs, withBusy, openAsset, openMediaHandle, openPassiveMediaHandle } = context
  const applyOperations = useCallback(async (operations: TimelineOperation[], summary: string): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      await execute('project.update', {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        operations: operations as unknown as JsonValue,
        summary: summary.slice(0, 512)
      })
      await loadProject(project.id)
      await loadProjects()
    })
  }, [copy, execute, loadProject, loadProjects, withBusy])

  const createSequence = useCallback(async (name: string, activate = true): Promise<void> => {
    const normalized = boundedName(name, copy('sequenceNameRequired'))
    await applyOperations([{
      type: 'create-sequence',
      sequenceId: localId('sequence', normalized),
      name: normalized,
      activate
    }], formatMessage(copy('sequenceCreateSummary'), { name: normalized }))
  }, [applyOperations, copy])

  const duplicateSequence = useCallback(async (
    sequenceId: string,
    name: string,
    activate = true
  ): Promise<void> => {
    const normalized = boundedName(name, copy('sequenceNameRequired'))
    await applyOperations([{
      type: 'duplicate-sequence',
      sourceSequenceId: sequenceId,
      sequenceId: localId('sequence-copy', normalized),
      name: normalized,
      activate
    }], formatMessage(copy('sequenceDuplicateSummary'), { name: normalized }))
  }, [applyOperations, copy])

  const renameSequence = useCallback(async (sequenceId: string, name: string): Promise<void> => {
    const normalized = boundedName(name, copy('sequenceNameRequired'))
    await applyOperations(
      [{ type: 'rename-sequence', sequenceId, name: normalized }],
      formatMessage(copy('sequenceRenameSummary'), { name: normalized })
    )
  }, [applyOperations, copy])

  const selectSequence = useCallback(async (sequenceId: string): Promise<void> => {
    const project = requiredProject(stateRef.current, copy('openProjectFirst'))
    const sequence = project.sequences.find(({ id }) => id === sequenceId)
    if (!sequence) throw new Error(copy('sequenceUnavailable'))
    await applyOperations([
      ...(sequence.viewState.open ? [] : [{ type: 'open-sequence' as const, sequenceId }]),
      { type: 'select-sequence', sequenceId }
    ], formatMessage(copy('sequenceSelectSummary'), { name: sequence.name }))
  }, [applyOperations, copy])

  const closeSequence = useCallback(async (sequenceId: string): Promise<void> => {
    const project = requiredProject(stateRef.current, copy('openProjectFirst'))
    const sequence = project.sequences.find(({ id }) => id === sequenceId)
    if (!sequence) throw new Error(copy('sequenceUnavailable'))
    const isActive = project.activeSequenceId === sequenceId
    const fallback = project.sequences.find((candidate) => candidate.id !== sequenceId && candidate.viewState.open) ??
      project.sequences.find((candidate) => candidate.id !== sequenceId)
    if (isActive && !fallback) throw new Error(copy('sequenceCloseFinal'))
    await applyOperations([
      ...(isActive && fallback && !fallback.viewState.open
        ? [{ type: 'open-sequence' as const, sequenceId: fallback.id }]
        : []),
      {
        type: 'close-sequence',
        sequenceId,
        ...(isActive && fallback ? { fallbackSequenceId: fallback.id } : {})
      }
    ], formatMessage(copy('sequenceCloseSummary'), { name: sequence.name }))
  }, [applyOperations, copy])

  const deleteSequence = useCallback(async (sequenceId: string): Promise<void> => {
    const project = requiredProject(stateRef.current, copy('openProjectFirst'))
    const sequence = project.sequences.find(({ id }) => id === sequenceId)
    if (!sequence) throw new Error(copy('sequenceUnavailable'))
    await applyOperations(
      [{ type: 'delete-sequence', sequenceId }],
      formatMessage(copy('sequenceDeleteSummary'), { name: sequence.name })
    )
  }, [applyOperations, copy])

  const setSequenceView = useCallback(async (
    sequenceId: string,
    zoom: number,
    scrollFrame: number
  ): Promise<void> => {
    await applyOperations(
      [{ type: 'set-sequence-view', sequenceId, zoom, scrollFrame }],
      copy('sequenceViewSummary')
    )
  }, [applyOperations, copy])

  const decomposeNested = useCallback(async (itemId: string): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      await execute('sequence.decompose', {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        itemId
      })
      await loadProject(project.id)
      await loadProjects()
    })
  }, [copy, execute, loadProject, loadProjects, withBusy])

  const createMediaFolder = useCallback(async (name: string, parentId?: string): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      const normalized = boundedName(name, copy('folderNameRequired'))
      await execute('media.folder.create', {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        folderId: localId('folder', normalized),
        name: normalized,
        ...(parentId ? { parentId } : {})
      })
      await loadProject(project.id)
    })
  }, [copy, execute, loadProject, withBusy])

  const updateMediaFolder = useCallback(async (
    folderId: string,
    patch: { name?: string; parentId?: string | null }
  ): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      await execute('media.folder.update', {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        folderId,
        ...(patch.name === undefined ? {} : { name: boundedName(patch.name, copy('folderNameRequired')) }),
        ...(patch.parentId === undefined ? {} : { parentId: patch.parentId })
      })
      await loadProject(project.id)
    })
  }, [copy, execute, loadProject, withBusy])

  const deleteMediaFolder = useCallback(async (
    folderId: string,
    moveContentsToFolderId?: string
  ): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      await execute('media.folder.delete', {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        folderId,
        ...(moveContentsToFolderId ? { moveContentsToFolderId } : {})
      })
      await loadProject(project.id)
    })
  }, [copy, execute, loadProject, withBusy])

  const organizeMedia = useCallback(async (assetIds: string[], folderId?: string): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      if (assetIds.length < 1 || assetIds.length > 64) throw new Error(copy('mediaSelectionRequired'))
      await execute('media.organize', {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        assetIds: [...new Set(assetIds)].slice(0, 64),
        folderId: folderId ?? null
      })
      await loadProject(project.id)
    })
  }, [copy, execute, loadProject, withBusy])

  const refreshPreviewHistory = useCallback(async (): Promise<void> => {
    const project = requiredProject(stateRef.current, copy('openProjectFirst'))
    await loadPreviewHistory(project.id)
  }, [copy, loadPreviewHistory])

  const addPreview = useCallback(async (
    source: PreviewSourceProjection,
    label: string
  ): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      const content = await execute('preview.add', {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        entryId: localId('preview', label),
        label: boundedName(label, copy('previewLabelRequired')),
        source: source as unknown as JsonValue
      })
      dispatchPreviewResult(project.id, content, dispatch)
    })
  }, [copy, execute, withBusy])

  const selectPreview = useCallback(async (entryId: string): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      const content = await execute('preview.select', {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        entryId
      })
      dispatchPreviewResult(project.id, content, dispatch)
      const entry = previewEntryFrom(content.entry) ??
        stateRef.current.previewHistory.entries.find(({ id }) => id === entryId)
      if (!entry) return
      const source = entry.source
      if (source.kind === 'asset' || source.kind === 'generated') {
        await openAsset(source.assetId)
      } else if (source.artifactId) {
        const artifact = artifactsForJobs(stateRef.current.jobs)
          .find(({ artifactId }) => artifactId === source.artifactId)
        if (artifact && artifactUsesPlayer(artifact)) await openMediaHandle(artifact.mediaHandleId)
      }
    })
  }, [copy, execute, openAsset, openMediaHandle, withBusy])

  const openPreviewResource = useCallback(async (entryId: string): Promise<PreviewResource | undefined> => {
    const state = stateRef.current
    const project = requiredProject(state, copy('openProjectFirst'))
    const entry = state.previewHistory.entries.find(({ id }) => id === entryId)
    if (!entry) return undefined
    const source = entry.source
    if (source.kind === 'asset' || source.kind === 'generated') {
      const asset = assetFromState(stateRef.current, source.assetId)
      if (!asset?.mediaHandleId) return undefined
      const mediaKind = asset.kind === 'audio'
        ? 'audio'
        : asset.kind === 'image'
          ? 'image'
          : 'video'
      return {
        entryId,
        title: entry.label,
        url: await openPassiveMediaHandle(asset.mediaHandleId),
        mediaKind
      }
    }
    if (!source.artifactId) return undefined
    const artifact = artifactsForJobs(state.jobs)
      .find(({ artifactId }) => artifactId === source.artifactId)
    if (!artifact || !artifactUsesPlayer(artifact)) return undefined
    return {
      entryId,
      title: entry.label,
      url: await openPassiveMediaHandle(artifact.mediaHandleId),
      mediaKind: artifact.mediaKind as PreviewResource['mediaKind']
    }
  }, [copy, openPassiveMediaHandle])

  const comparePreviews = useCallback(async (
    leftEntryId: string,
    rightEntryId: string,
    mode: 'wipe' | 'side-by-side'
  ): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      const content = await execute('preview.compare', {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        leftEntryId,
        rightEntryId,
        mode
      })
      dispatchPreviewResult(project.id, content, dispatch)
    })
  }, [copy, execute, withBusy])

  const replaceSelectedFromPreview = useCallback(async (entryId: string): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      const itemId = stateRef.current.selectedItemId
      if (!itemId) throw new Error(copy('selectClipForReplacement'))
      const content = await execute('preview.replace', {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        itemId,
        entryId
      })
      dispatchPreviewResult(project.id, content, dispatch)
      await loadProject(project.id)
      await loadProjects()
    })
  }, [copy, execute, loadProject, loadProjects, withBusy])

  const attachSelection = useCallback(async (previewEntryIds: string[] = []): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      if (previewEntryIds.length > 64) throw new Error(copy('selectionAttachmentTooLarge'))
      const content = await execute('context.attach-selection', {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        previewEntryIds: [...new Set(previewEntryIds)]
      })
      const attachment = asRecord(content.attachment, copy('invalidHostResponse'))
      const revision = safeInteger(attachment.revision)
      const generation = safeInteger(attachment.selectionGeneration)
      if (revision === undefined || generation === undefined) {
        throw new Error(copy('invalidHostResponse'))
      }
      await client.ui.attachComposerContext({
        schemaVersion: 1,
        id: 'video-selection',
        title: formatMessage(copy('selectionContextTitle'), { project: project.name }),
        summary: formatMessage(copy('selectionContextSummary'), {
          revision,
          items: Array.isArray(attachment.selectedItemIds) ? attachment.selectedItemIds.length : 0,
          previews: Array.isArray(attachment.previewEntryIds) ? attachment.previewEntryIds.length : 0
        }),
        reference: attachment as JsonObject,
        revision,
        generation
      })
      pushNotice({
        id: 'selection-attached',
        severity: 'info',
        message: copy('selectionAttached'),
        messageKey: 'selectionAttached'
      })
    })
  }, [client, copy, execute, pushNotice, withBusy])

  const history = useCallback(async (action: 'project.undo' | 'project.redo'): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      await execute(action, { projectId: project.id, expectedRevision: project.currentRevision })
      await loadProject(project.id)
      await loadProjects()
    })
  }, [copy, execute, loadProject, loadProjects, withBusy])

  const undo = useCallback(() => history('project.undo'), [history])
  const redo = useCallback(() => history('project.redo'), [history])

  const readScript = useCallback(async (): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      const content = await execute('script.read', { projectId: project.id, expectedRevision: project.currentRevision })
      const markdown = typeof content.timelineMarkdown === 'string' ? content.timelineMarkdown : ''
      const digest = typeof content.digest === 'string' ? content.digest : ''
      dispatch({ type: 'script', revision: safeInteger(content.currentRevision) ?? project.currentRevision, digest, markdown })
    })
  }, [copy, execute, withBusy])

  const editScript = useCallback((markdown: string) => dispatch({ type: 'script-edit', markdown }), [])

  const applyScript = useCallback(async (
    ranges: Array<{ assetId: string; startUs: number; endUs: number; reason?: 'filler' | 'silence' | 'selection' }>
  ): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      let script = stateRef.current.script
      if (!script) {
        const content = await execute('script.read', {
          projectId: project.id,
          expectedRevision: project.currentRevision
        })
        script = {
          revision: safeInteger(content.currentRevision) ?? project.currentRevision,
          digest: typeof content.digest === 'string' ? content.digest : '',
          markdown: typeof content.timelineMarkdown === 'string' ? content.timelineMarkdown : '',
          dirty: false
        }
        dispatch({
          type: 'script',
          revision: script.revision,
          digest: script.digest,
          markdown: script.markdown
        })
      }
      if (ranges.length === 0 || ranges.length > 2_000) throw new Error(copy('rangesRequired'))
      await execute('script.apply', {
        projectId: project.id,
        expectedRevision: project.currentRevision,
        timelineMarkdown: script.markdown,
        ranges: ranges as unknown as JsonValue,
        summary: copy('scriptApplySummary')
      })
      const updated = await loadProject(project.id)
      const content = await execute('script.read', {
        projectId: updated.id,
        expectedRevision: updated.currentRevision
      })
      dispatch({
        type: 'script',
        revision: safeInteger(content.currentRevision) ?? updated.currentRevision,
        digest: typeof content.digest === 'string' ? content.digest : '',
        markdown: typeof content.timelineMarkdown === 'string' ? content.timelineMarkdown : ''
      })
    })
  }, [copy, execute, loadProject, withBusy])

  const startAgent = useCallback(async (prompt: string): Promise<void> => {
    await withBusy(async () => {
      const project = requiredProject(stateRef.current, copy('openProjectFirst'))
      const input = prompt.trim()
      if (!input) throw new Error(copy('agentGoalRequired'))
      const created = await client.agent.createRun({
        input,
        profileId: 'video-editor',
        visibility: 'private',
        metadata: { projectId: project.id, expectedRevision: project.currentRevision },
        budget: { maxTokens: 32_768, maxElapsedMs: 1_800_000, maxModelRequests: 48, maxToolInvocations: 96, maxEvents: 4_000 }
      })
      dispatch({ type: 'agent-run', value: created.run })
    })
  }, [client, copy, withBusy])

  const steerAgent = useCallback(async (prompt: string): Promise<void> => {
    await withBusy(async () => {
      const run = stateRef.current.agentRun
      if (!run) throw new Error(copy('noAgentRun'))
      const input = prompt.trim()
      if (!input) throw new Error(copy('guidanceEmpty'))
      const result = await client.agent.steer({ runId: run.id, input })
      dispatch({ type: 'agent-run', value: result.run })
    })
  }, [client, copy, withBusy])

  const cancelAgent = useCallback(async (): Promise<void> => {
    const run = stateRef.current.agentRun
    if (!run) return
    await withBusy(async () => {
      const result = await client.agent.cancel({ runId: run.id, reason: copy('agentCanceledByUser') })
      dispatch({ type: 'agent-run', value: result.run })
    })
  }, [client, copy, withBusy])

  return { applyOperations, createSequence, duplicateSequence, renameSequence, selectSequence, closeSequence, deleteSequence, setSequenceView, decomposeNested, createMediaFolder, updateMediaFolder, deleteMediaFolder, organizeMedia, refreshPreviewHistory, addPreview, selectPreview, openPreviewResource, comparePreviews, replaceSelectedFromPreview, attachSelection, history, undo, redo, readScript, editScript, applyScript, startAgent, steerAgent, cancelAgent }
}
