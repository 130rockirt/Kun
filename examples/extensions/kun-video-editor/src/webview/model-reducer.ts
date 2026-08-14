import type { JobEvent, JobSnapshot } from '@kun/extension-api'
import type {
  DerivedMediaRecordProjection,
  GenerationRecordProjection,
  MediaIntelligenceProgressProjection,
  PreviewHistoryProjection
} from './model-intelligence.js'
import { VIEW_LIMITS, type ProjectProjection } from './model-project.js'
import type { EditorAction, EditorState } from './model-state.js'

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'initialized': {
      const restored = action.persisted
      return {
        ...state,
        initialized: true,
        connection: 'online',
        ...(restored?.selectedItemId ? { selectedItemId: restored.selectedItemId } : {}),
        playheadFrame: restored?.playheadFrame ?? state.playheadFrame,
        activeWorkspace: restored?.activeWorkspace ?? state.activeWorkspace,
        renderTickets: restored?.renderTickets.slice(-VIEW_LIMITS.jobs) ?? state.renderTickets,
        projectPackageTickets: restored?.projectPackageTickets.slice(-VIEW_LIMITS.jobs) ?? state.projectPackageTickets,
        otioExportTickets: restored?.otioExportTickets.slice(-VIEW_LIMITS.jobs) ?? state.otioExportTickets,
        transcriptWindowStart: restored?.transcriptWindowStart ?? state.transcriptWindowStart
      }
    }
    case 'busy': return { ...state, busy: action.value }
    case 'connection': return { ...state, connection: action.value }
    case 'reconnect': return { ...state, connection: 'reconnecting', reconnectToken: state.reconnectToken + 1 }
    case 'theme': return { ...state, theme: action.value }
    case 'locale': return { ...state, locale: action.value }
    case 'media-capabilities': return { ...state, mediaCapabilities: action.value }
    case 'result-preview': return { ...state, resultPreview: action.value }
    case 'projects': return { ...state, projects: dedupeById(action.value).slice(0, VIEW_LIMITS.projects) }
    case 'project': {
      const project = boundProject(action.value)
      const switchingProject = state.project !== undefined && state.project.id !== project.id
      const revisionChanged = state.project?.id === project.id &&
        state.project.currentRevision !== project.currentRevision
      const hydrateSelection = switchingProject || state.project === undefined
      const mediaLibrary = state.mediaLibrary?.projectId === project.id &&
        state.mediaLibrary.revision === project.currentRevision
        ? state.mediaLibrary
        : undefined
      const selectedItemId = hydrateSelection
        ? project.selection.selectedItemIds.find((id) => project.items.some((item) => item.id === id))
        : state.selectedItemId && project.items.some(({ id }) => id === state.selectedItemId)
          ? state.selectedItemId
          : undefined
      const projectTicketIds = new Set(
        [
          ...state.renderTickets.filter(({ projectId }) => projectId === project.id),
          ...state.projectPackageTickets.filter(({ projectId }) => projectId === project.id),
          ...state.otioExportTickets.filter(({ projectId }) => projectId === project.id)
        ].map(({ jobId }) => jobId)
      )
      return {
        ...state,
        project,
        selectedItemId,
        selectedCaptionId: hydrateSelection
          ? project.selection.selectedCaptionIds.find((id) => project.captions.some((caption) => caption.id === id))
          : state.selectedCaptionId && project.captions.some(({ id }) => id === state.selectedCaptionId)
            ? state.selectedCaptionId
            : undefined,
        selectedAssetId: hydrateSelection
          ? project.selection.selectedAssetIds[0] ?? project.assets[0]?.id
          : state.selectedAssetId ?? project.assets[0]?.id,
        mediaLibrary,
        playheadFrame: hydrateSelection
          ? Math.min(project.selection.playheadFrame, Math.max(0, project.durationFrames))
          : Math.min(state.playheadFrame, Math.max(0, project.durationFrames)),
        ...(switchingProject ? {
          playing: false,
          media: {},
          leases: {},
          activeMediaHandleId: undefined,
          activeMediaUrl: undefined,
          revokedHandles: [],
          script: undefined,
          agentRun: undefined,
          agentEvents: [],
          jobs: state.jobs.filter(({ id }) => projectTicketIds.has(id)),
          derivedRecords: [],
          derivedUsage: undefined,
          derivedRecoveryDiagnostics: [],
          previewHistory: { schemaVersion: 1, generation: 0, entries: [] },
          previewComparison: undefined,
          audioAnalysisCapabilities: undefined,
          denoiseMetadataCapability: undefined,
          audioAnalysisRecords: [],
          visualProvisioning: undefined,
          visualMomentPage: undefined,
          speakerAdapters: [],
          speakerIdentities: [],
          speakerAttributionPlan: undefined,
          mediaIntelligenceOperations: [],
          mediaIntelligenceEvidence: undefined,
          audioSyncPreview: undefined,
          generation: { ...state.generation, records: [], recoveryDiagnostics: [] },
          jobEvents: Object.fromEntries(
            Object.entries(state.jobEvents).filter(([jobId]) => projectTicketIds.has(jobId))
          ),
          timelineWindowStart: 0,
          transcriptWindowStart: 0
        } : {}),
        ...(revisionChanged ? {
          audioSyncPreview: undefined,
          speakerAttributionPlan: undefined,
          visualMomentPage: undefined
        } : {}),
        conflict: undefined
      }
    }
    case 'media-library': {
      if (
        state.project?.id !== action.value.projectId ||
        state.project.currentRevision !== action.value.revision
      ) return state
      return {
        ...state,
        mediaLibrary: {
          ...action.value,
          assets: dedupeById(action.value.assets).slice(0, VIEW_LIMITS.assets)
        }
      }
    }
    case 'selection-synced': {
      if (
        state.project?.id !== action.projectId ||
        state.project.currentRevision !== action.revision ||
        action.generation < state.project.selection.generation ||
        action.eventGeneration < state.project.eventGeneration
      ) return state
      return {
        ...state,
        project: {
          ...state.project,
          eventGeneration: action.eventGeneration,
          selection: action.selection
        }
      }
    }
    case 'clear-project': return {
      ...state,
      project: undefined,
      mediaLibrary: undefined,
      selectedItemId: undefined,
      selectedCaptionId: undefined,
      selectedAssetId: undefined,
      playing: false,
      media: {},
      leases: {},
      activeMediaHandleId: undefined,
      activeMediaUrl: undefined,
      revokedHandles: [],
      script: undefined,
      playheadFrame: 0,
      agentRun: undefined,
      agentEvents: [],
      jobs: [],
      derivedRecords: [],
      derivedUsage: undefined,
      derivedRecoveryDiagnostics: [],
      previewHistory: { schemaVersion: 1, generation: 0, entries: [] },
      previewComparison: undefined,
      audioAnalysisCapabilities: undefined,
      denoiseMetadataCapability: undefined,
      audioAnalysisRecords: [],
      visualProvisioning: undefined,
      visualMomentPage: undefined,
      speakerAdapters: [],
      speakerIdentities: [],
      speakerAttributionPlan: undefined,
      mediaIntelligenceOperations: [],
      mediaIntelligenceEvidence: undefined,
      audioSyncPreview: undefined,
      generation: { ...state.generation, records: [], recoveryDiagnostics: [] },
      jobEvents: {},
      timelineWindowStart: 0,
      transcriptWindowStart: 0,
      conflict: undefined
    }
    case 'selection': return {
      ...state,
      ...(Object.prototype.hasOwnProperty.call(action, 'itemId') ? { selectedItemId: action.itemId } : {}),
      ...(Object.prototype.hasOwnProperty.call(action, 'captionId') ? { selectedCaptionId: action.captionId } : {}),
      ...(Object.prototype.hasOwnProperty.call(action, 'assetId') ? { selectedAssetId: action.assetId } : {})
    }
    case 'seek': return {
      ...state,
      playheadFrame: Math.max(0, Math.min(Math.round(action.frame), state.project?.durationFrames ?? Number.MAX_SAFE_INTEGER))
    }
    case 'playing': return { ...state, playing: action.value }
    case 'media': {
      const media = { ...state.media }
      for (const item of action.value.slice(0, VIEW_LIMITS.assets)) media[item.handleId] = item
      return { ...state, media: boundRecord(media, VIEW_LIMITS.assets) }
    }
    case 'lease': return {
      ...state,
      leases: boundRecord({ ...state.leases, [action.value.handleId]: action.value }, VIEW_LIMITS.mediaLeases),
      revokedHandles: state.revokedHandles.filter((id) => id !== action.value.handleId)
    }
    case 'lease-release': return {
      ...state,
      leases: omitKey(state.leases, action.handleId),
      ...(state.activeMediaHandleId === action.handleId
        ? { activeMediaHandleId: undefined, activeMediaUrl: undefined, playing: false }
        : {})
    }
    case 'active-media': return { ...state, activeMediaHandleId: action.handleId, activeMediaUrl: action.url }
    case 'media-revoked': return {
      ...state,
      revokedHandles: [...new Set([...state.revokedHandles, action.handleId])].slice(-VIEW_LIMITS.assets),
      leases: omitKey(state.leases, action.handleId),
      ...(state.activeMediaHandleId === action.handleId
        ? { activeMediaHandleId: undefined, activeMediaUrl: undefined, playing: false }
        : {})
    }
    case 'script': return {
      ...state,
      script: { revision: action.revision, digest: action.digest, markdown: action.markdown, dirty: false }
    }
    case 'script-edit': return state.script
      ? { ...state, script: { ...state.script, markdown: action.markdown.slice(0, 262_144), dirty: true } }
      : state
    case 'agent-run': return { ...state, agentRun: action.value }
    case 'agent-event': return {
      ...state,
      agentEvents: mergeSequenced(state.agentEvents, action.value, VIEW_LIMITS.agentEvents)
    }
    case 'jobs': return { ...state, jobs: mergeJobSnapshots(state.jobs, action.value) }
    case 'job-event': {
      const jobEvents = {
        ...state.jobEvents,
        [action.value.jobId]: mergeSequenced(
          state.jobEvents[action.value.jobId] ?? [],
          action.value,
          VIEW_LIMITS.agentEvents
        )
      }
      const current = state.jobs.find(({ id }) => id === action.value.jobId)
      const jobs = current
        ? state.jobs.map((job) => job.id === action.value.jobId ? snapshotFromEvent(job, action.value) : job)
        : state.jobs
      return { ...state, jobs: boundJobs(jobs), jobEvents: boundRecord(jobEvents, VIEW_LIMITS.jobs) }
    }
    case 'active-workspace': return { ...state, activeWorkspace: action.value }
    case 'render-ticket': return {
      ...state,
      renderTickets: dedupeByKey([...state.renderTickets, action.value], 'jobId').slice(-VIEW_LIMITS.jobs)
    }
    case 'project-package-ticket': return {
      ...state,
      projectPackageTickets: dedupeByKey(
        [...state.projectPackageTickets, action.value],
        'jobId'
      ).slice(-VIEW_LIMITS.jobs)
    }
    case 'otio-export-ticket': return {
      ...state,
      otioExportTickets: dedupeByKey(
        [...state.otioExportTickets, action.value],
        'jobId'
      ).slice(-VIEW_LIMITS.jobs)
    }
    case 'otio-import-preview': return { ...state, otioImportPreview: action.value }
    case 'derived': {
      if (
        state.project?.id !== action.projectId ||
        state.project.currentRevision !== action.revision
      ) return state
      const incomingIds = new Set(action.records.map(({ id }) => id))
      return {
        ...state,
        derivedRecords: mergeDerivedRecords(state.derivedRecords, action.records)
          .filter(({ id }) => incomingIds.has(id))
          .filter(({ projectId }) => projectId === undefined || projectId === action.projectId)
          .slice(0, VIEW_LIMITS.derivedRecords),
        ...(action.usage ? { derivedUsage: action.usage } : {}),
        derivedRecoveryDiagnostics: action.recoveryDiagnostics?.slice(0, 32) ?? state.derivedRecoveryDiagnostics
      }
    }
    case 'derived-record': {
      if (state.project?.id !== action.value.projectId) return state
      return {
        ...state,
        derivedRecords: mergeDerivedRecords(state.derivedRecords, [action.value])
          .slice(0, VIEW_LIMITS.derivedRecords)
      }
    }
    case 'preview-history': {
      if (state.project?.id !== action.projectId) return state
      return {
        ...state,
        previewHistory: boundPreviewHistory(action.value),
        ...(state.previewComparison && (
          !action.value.entries.some(({ id }) => id === state.previewComparison?.leftEntryId) ||
          !action.value.entries.some(({ id }) => id === state.previewComparison?.rightEntryId)
        ) ? { previewComparison: undefined } : {})
      }
    }
    case 'preview-comparison': return state.project?.id === action.projectId
      ? { ...state, previewComparison: action.value }
      : state
    case 'audio-analysis-state': {
      if (
        state.project?.id !== action.projectId ||
        state.project.currentRevision !== action.revision
      ) return state
      return {
        ...state,
        ...(action.capabilities ? { audioAnalysisCapabilities: action.capabilities } : {}),
        ...(action.denoiseMetadataCapability ? { denoiseMetadataCapability: action.denoiseMetadataCapability } : {}),
        ...(action.visualProvisioning ? { visualProvisioning: action.visualProvisioning } : {}),
        ...(action.visualMomentPage ? { visualMomentPage: action.visualMomentPage } : {}),
        ...(action.clearVisualMomentPage ? { visualMomentPage: undefined } : {}),
        ...(action.records ? { audioAnalysisRecords: action.records.slice(0, 512) } : {}),
        ...(action.operations ? {
          mediaIntelligenceOperations: mergeAnalysisProgress(
            state.mediaIntelligenceOperations,
            action.operations
          )
        } : {}),
        ...(action.evidence ? { mediaIntelligenceEvidence: action.evidence } : {}),
        ...(action.speakerAdapters ? { speakerAdapters: action.speakerAdapters.slice(0, 16) } : {}),
        ...(action.speakerIdentities ? { speakerIdentities: action.speakerIdentities.slice(0, 256) } : {}),
        ...(action.speakerAttributionPlan ? { speakerAttributionPlan: action.speakerAttributionPlan } : {}),
        ...(action.clearSpeakerAttributionPlan ? { speakerAttributionPlan: undefined } : {}),
        ...(action.syncPreview ? { audioSyncPreview: action.syncPreview } : {}),
        ...(action.clearSyncPreview ? { audioSyncPreview: undefined } : {})
      }
    }
    case 'media-intelligence-progress': {
      if (
        state.project?.id !== action.value.projectId ||
        state.project.currentRevision !== action.value.projectRevision
      ) return state
      return {
        ...state,
        mediaIntelligenceOperations: mergeAnalysisProgress(
          state.mediaIntelligenceOperations,
          [action.value]
        )
      }
    }
    case 'generation-state': {
      if (action.projectId && action.projectId !== state.project?.id) return state
      return {
        ...state,
        generation: {
          ...action.value,
          records: mergeGenerationRecords([], action.value.records)
            .slice(0, VIEW_LIMITS.generationRecords),
          recoveryDiagnostics: action.value.recoveryDiagnostics.slice(0, 32)
        }
      }
    }
    case 'generation-record': {
      if (action.value.projectId !== state.project?.id) return state
      return {
        ...state,
        generation: {
          ...state.generation,
          records: mergeGenerationRecords(state.generation.records, [action.value])
            .slice(0, VIEW_LIMITS.generationRecords)
        }
      }
    }
    case 'notice': return {
      ...state,
      notices: dedupeByKey([...state.notices, action.value], 'id').slice(-VIEW_LIMITS.notices)
    }
    case 'project-change': {
      const previous = state.lastProjectChange
      if (
        previous?.projectId === action.value.projectId &&
        previous.generation !== undefined &&
        action.value.generation !== undefined &&
        action.value.generation < previous.generation
      ) return state
      return { ...state, lastProjectChange: action.value }
    }
    case 'dismiss-notice': return { ...state, notices: state.notices.filter(({ id }) => id !== action.id) }
    case 'conflict': return {
      ...state,
      conflict: { expectedRevision: action.expectedRevision, currentRevision: action.currentRevision }
    }
    case 'clear-conflict': return { ...state, conflict: undefined }
    case 'transcript-window': return { ...state, transcriptWindowStart: Math.max(0, action.start) }
    case 'timeline-window': return { ...state, timelineWindowStart: Math.max(0, action.start) }
  }
}

function boundProject(project: ProjectProjection): ProjectProjection {
  let segments = VIEW_LIMITS.transcriptSegments
  return {
    ...project,
    assets: dedupeById(project.assets).slice(0, VIEW_LIMITS.assets),
    sequences: dedupeById(project.sequences).slice(0, VIEW_LIMITS.sequences),
    mediaFolders: dedupeById(project.mediaFolders).slice(0, VIEW_LIMITS.mediaFolders),
    linkGroups: dedupeById(project.linkGroups).slice(0, VIEW_LIMITS.items),
    tracks: dedupeById(project.tracks).slice(0, VIEW_LIMITS.tracks),
    items: dedupeById(project.items).slice(0, VIEW_LIMITS.items),
    captions: dedupeById(project.captions).slice(0, VIEW_LIMITS.captions),
    transcripts: dedupeById(project.transcripts).slice(0, VIEW_LIMITS.transcripts).map((transcript) => {
      const allowed = Math.max(0, segments)
      const items = transcript.segments.slice(0, allowed)
      segments -= items.length
      return { ...transcript, segments: items, truncated: transcript.truncated || transcript.segments.length > items.length }
    }),
    revisions: project.revisions.slice(-VIEW_LIMITS.revisions)
  }
}

function boundPreviewHistory(history: PreviewHistoryProjection): PreviewHistoryProjection {
  const entries = dedupeById(history.entries).slice(-VIEW_LIMITS.previewHistory)
  const ids = new Set(entries.map(({ id }) => id))
  return {
    schemaVersion: 1,
    generation: Math.max(0, Math.floor(history.generation)),
    ...(history.activeEntryId && ids.has(history.activeEntryId)
      ? { activeEntryId: history.activeEntryId }
      : {}),
    entries
  }
}

function boundJobs(jobs: JobSnapshot[]): JobSnapshot[] {
  return dedupeById(jobs)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, VIEW_LIMITS.jobs)
}

function mergeJobSnapshots(current: readonly JobSnapshot[], incoming: JobSnapshot[]): JobSnapshot[] {
  const currentById = new Map(current.map((snapshot) => [snapshot.id, snapshot]))
  return boundJobs(incoming.map((snapshot) => {
    const previous = currentById.get(snapshot.id)
    if (!previous) return snapshot
    const previousTerminal = isTerminalJobState(previous.state)
    const incomingTerminal = isTerminalJobState(snapshot.state)
    if (previousTerminal !== incomingTerminal) return previousTerminal ? previous : snapshot
    return snapshot.updatedAt >= previous.updatedAt ? snapshot : previous
  }))
}

function mergeDerivedRecords(
  current: readonly DerivedMediaRecordProjection[],
  incoming: readonly DerivedMediaRecordProjection[]
): DerivedMediaRecordProjection[] {
  const records = new Map(current.map((record) => [record.id, record]))
  for (const record of incoming) {
    const previous = records.get(record.id)
    if (
      !previous ||
      record.generation > previous.generation ||
      (record.generation === previous.generation && record.statusGeneration >= previous.statusGeneration)
    ) records.set(record.id, record)
  }
  return [...records.values()].sort((left, right) =>
    right.generation - left.generation || right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)
  )
}

function mergeAnalysisProgress(
  current: readonly MediaIntelligenceProgressProjection[],
  incoming: readonly MediaIntelligenceProgressProjection[]
): MediaIntelligenceProgressProjection[] {
  const values = new Map(current.map((progress) => [progress.operationId, progress]))
  for (const progress of incoming) {
    const previous = values.get(progress.operationId)
    if (!previous || progress.generation >= previous.generation) values.set(progress.operationId, progress)
  }
  return [...values.values()]
    .sort((left, right) => right.generation - left.generation || left.operationId.localeCompare(right.operationId))
    .slice(0, 100)
}

function mergeGenerationRecords(
  current: readonly GenerationRecordProjection[],
  incoming: readonly GenerationRecordProjection[]
): GenerationRecordProjection[] {
  const values = new Map(current.map((record) => [record.id, record]))
  for (const record of incoming) {
    const previous = values.get(record.id)
    if (!previous || record.generation >= previous.generation) values.set(record.id, record)
  }
  return [...values.values()].sort((left, right) =>
    right.generation - left.generation || right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)
  )
}

function isTerminalJobState(state: JobSnapshot['state']): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled' || state === 'interrupted'
}

function snapshotFromEvent(snapshot: JobSnapshot, event: JobEvent): JobSnapshot {
  return {
    ...snapshot,
    state: event.state,
    updatedAt: event.timestamp,
    executionAttempt: event.executionAttempt,
    latestCursor: event.cursor,
    ...(event.progress ? { progress: event.progress } : {}),
    ...(event.result ? { result: event.result } : {}),
    ...(event.error ? { error: event.error } : {}),
    ...(['completed', 'failed', 'cancelled', 'interrupted'].includes(event.state)
      ? { terminalAt: event.timestamp }
      : {})
  }
}

function mergeSequenced<T extends { sequence: number }>(current: T[], next: T, limit: number): T[] {
  const bySequence = new Map(current.map((value) => [value.sequence, value]))
  bySequence.set(next.sequence, next)
  return [...bySequence.values()]
    .sort((left, right) => left.sequence - right.sequence)
    .slice(-limit)
}

function dedupeById<T extends { id: string }>(items: readonly T[]): T[] {
  return dedupeByKey(items, 'id')
}

function dedupeByKey<T, K extends keyof T>(items: readonly T[], key: K): T[] {
  const values = new Map<T[K], T>()
  for (const item of items) values.set(item[key], item)
  return [...values.values()]
}

function boundRecord<T>(record: Record<string, T>, limit: number): Record<string, T> {
  return Object.fromEntries(Object.entries(record).slice(-limit))
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([candidate]) => candidate !== key))
}
