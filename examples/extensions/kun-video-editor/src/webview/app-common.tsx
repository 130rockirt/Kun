import type { GeneratedArtifact, JobSnapshot, MediaCapabilityFeature } from '@kun/extension-api'
import { replaceAsciiControlCharacters } from '../text-safety.js'
import type { PropsWithChildren, ReactNode } from 'react'
import type { EditorController } from './controller.js'
import { formatMessage, type Messages } from './i18n.js'
import {
  VIEW_LIMITS,
  type AssetProjection,
  type EditorState,
  type ItemProjection,
  type ProjectProjection,
  type RenderTicket,
  type RevisionProjection,
  type SpeakerAttributionProjection,
  type TimelineOperation,
  type TrackProjection
} from './model.js'
import { linkedProjectItemIds } from './spatial-timeline.js'
import { themeStyle } from './app-presentation.js'

export type ProjectPackageResultSummary = {
  entryCount: number
  archiveBytes: number
  sha256: string
  displayName: string
}

export function projectPackageResultSummary(job: JobSnapshot): ProjectPackageResultSummary | undefined {
  const data = recordValue(job.result?.data)
  if (!data || data.schemaVersion !== 1 || data.format !== 'zip') return undefined
  const generatedMedia = recordValue(data.generatedMedia)
  if (
    !Number.isSafeInteger(data.entryCount) || Number(data.entryCount) < 1 ||
    !Number.isSafeInteger(data.archiveBytes) || Number(data.archiveBytes) < 1 ||
    typeof data.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(data.sha256) ||
    typeof generatedMedia?.displayName !== 'string'
  ) return undefined
  return {
    entryCount: Number(data.entryCount),
    archiveBytes: Number(data.archiveBytes),
    sha256: data.sha256,
    displayName: safeHostDisplayName(generatedMedia.displayName)
  }
}

export function JobRow({ job, controller, messages }: { job: JobSnapshot; controller: EditorController; messages: Messages }): React.JSX.Element {
  const terminal = ['completed', 'failed', 'cancelled', 'interrupted'].includes(job.state)
  const progress = job.progress?.percentage ?? (job.progress?.completed !== undefined && job.progress.total ? job.progress.completed / job.progress.total * 100 : undefined)
  return (
    <li className={`job job-${job.state}`}>
      <div><strong>{jobKindLabel(messages, job.kind)}</strong><small>{job.id} · {formatMessage(messages.attempt, { attempt: job.executionAttempt })}</small></div>
      <span className="job-state">{jobStateLabel(messages, job.state)}</span>
      <progress max={100} value={progress ?? (job.state === 'completed' ? 100 : undefined)} aria-label={formatMessage(messages.progressLabel, { label: jobKindLabel(messages, job.kind), value: Math.round(progress ?? 0) })} />
      <p>{jobDetailLabel(messages, job)}</p>
      {!terminal && <button type="button" className="danger-button" disabled={controller.state.busy} onClick={() => void controller.cancelJob(job.id)}>{messages.cancelJob}</button>}
    </li>
  )
}

export function ResultPreviewWorkbench({ controller, messages }: { controller: EditorController; messages: Messages }): React.JSX.Element {
  const preview = controller.state.resultPreview!
  const source = preview.result
  const url = controller.state.activeMediaUrl
  const isImage = source.mimeType.startsWith('image/')
  const isAudio = source.mimeType.startsWith('audio/')
  return <div
    className="editor-app result-preview-app"
    data-theme={controller.state.theme?.kind ?? 'dark'}
    data-reduced-motion={controller.state.theme?.reducedMotion ? 'true' : 'false'}
    dir={controller.state.locale?.direction ?? 'ltr'}
    lang={controller.state.locale?.language ?? 'en'}
    style={themeStyle(controller.state.theme)}
  >
    <header className="project-bar">
      <div className="brand-block"><span className="brand-mark" aria-hidden="true">K</span><div><strong>{messages.preview}</strong><small>{source.name ?? source.mimeType}</small></div></div>
    </header>
    <main className="result-preview-main">
      {!url ? <EmptyState>{source.availability === 'unavailable' ? messages.artifactUnavailable : messages.loadingEditor}</EmptyState>
        : isImage ? <img src={url} alt={source.name ?? messages.generatedProofFrame} onError={() => void controller.refreshActiveLease()} />
          : isAudio ? <audio src={url} controls onError={() => void controller.refreshActiveLease()} aria-label={source.name ?? messages.audioPreview} />
            : <video src={url} controls playsInline onError={() => void controller.refreshActiveLease()} aria-label={source.name ?? messages.videoPreview} />}
      <p className="subtle">{messages.technicallyValidated}</p>
    </main>
  </div>
}

export function MediaCapabilityStatus({ state, messages }: { state: EditorState; messages: Messages }): React.JSX.Element {
  const ready = Boolean(
    state.mediaCapabilities?.ffmpeg.available &&
    state.mediaCapabilities.ffprobe.available &&
    hasMediaFeature(state, 'libx264-encoder') &&
    hasMediaFeature(state, 'aac-encoder')
  )
  return <span
    className={ready ? 'connection connection-online' : 'connection connection-offline'}
    title={ready ? messages.mediaCapabilitiesReady : messages.mediaCapabilitiesLimited}
  >FFmpeg</span>
}

export function Panel(props: PropsWithChildren<{ title: string; actions?: ReactNode; className?: string }>): React.JSX.Element {
  return <section className={`panel ${props.className ?? ''}`}><header className="panel-header"><h2>{props.title}</h2>{props.actions && <div className="panel-actions">{props.actions}</div>}</header><div className="panel-body">{props.children}</div></section>
}

export function hasMediaFeature(state: EditorState, feature: MediaCapabilityFeature): boolean {
  return state.mediaCapabilities?.ffmpeg.features.includes(feature) ?? false
}

export function canImportMedia(state: EditorState): boolean {
  return state.mediaCapabilities?.ffprobe.available !== false
}

export function canRender(
  state: EditorState,
  kind: RenderTicket['renderKind'],
  captionMode: 'none' | 'burned' | 'sidecar' | 'both'
): boolean {
  if ((kind === 'subtitles' || captionMode !== 'none') && !state.project?.captions.length) return false
  if (!state.mediaCapabilities?.ffprobe.available) return false
  if (kind !== 'subtitles' && !state.mediaCapabilities.ffmpeg.available) return false
  if ((kind === 'preview' || kind === 'h264-mp4') && !hasMediaFeature(state, 'libx264-encoder')) return false
  if ((kind === 'audio-aac' || kind === 'h264-mp4') && !hasMediaFeature(state, 'aac-encoder')) return false
  if ((captionMode === 'burned' || captionMode === 'both') && !hasMediaFeature(state, 'drawtext-filter')) return false
  return true
}

export function EmptyState({ children }: PropsWithChildren): React.JSX.Element { return <div className="empty-state"><span aria-hidden="true">--</span><p>{children}</p></div> }
export function StatusNotice({ severity, children }: PropsWithChildren<{ severity: 'info' | 'warning' | 'error' }>): React.JSX.Element { return <div className={`status-notice status-${severity}`} role={severity === 'error' ? 'alert' : 'status'}>{children}</div> }
export function Spinner(): React.JSX.Element { return <span className="spinner" aria-hidden="true" /> }

export function visibleProjectAssets(state: EditorState): AssetProjection[] {
  const project = state.project
  const mediaLibrary = state.mediaLibrary
  const page = project && mediaLibrary?.projectId === project.id &&
    mediaLibrary.revision === project.currentRevision
    ? mediaLibrary.assets
    : []
  return [...new Map([...(project?.assets ?? []), ...page].map((asset) => [asset.id, asset])).values()]
}

export function VirtualControls(props: { start: number; total: number; onChange(start: number): void; messages: Messages }): React.JSX.Element | null {
  if (props.total <= VIEW_LIMITS.virtualWindow) return null
  return <div className="virtual-controls" aria-label={props.messages.virtualList}><button type="button" onClick={() => props.onChange(Math.max(0, props.start - VIEW_LIMITS.virtualWindow))} disabled={props.start === 0}>{props.messages.previous}</button><span>{props.start + 1}–{Math.min(props.total, props.start + VIEW_LIMITS.virtualWindow)} / {props.total}</span><button type="button" onClick={() => props.onChange(Math.min(props.total - 1, props.start + VIEW_LIMITS.virtualWindow))} disabled={props.start + VIEW_LIMITS.virtualWindow >= props.total}>{props.messages.next}</button></div>
}

export async function splitAtPlayhead(controller: EditorController, project: ProjectProjection, item: ItemProjection, messages: Messages): Promise<void> {
  const frame = controller.state.playheadFrame
  if (frame <= item.timelineStartFrame || frame >= item.timelineStartFrame + item.durationFrames) return
  await controller.applyOperations(
    [{ type: 'split-item', itemId: item.id, atFrame: frame }],
    formatMessage(messages.splitSummary, { id: item.id, frame })
  )
}

export async function deleteTimelineItem(
  controller: EditorController,
  project: ProjectProjection,
  item: ItemProjection,
  messages: Messages
): Promise<void> {
  const itemIds = linkedProjectItemIds(project, item.id)
  const itemIdSet = new Set(itemIds)
  const linkedGroupIds = project.linkGroups
    .filter((group) => group.locked && group.itemIds.some((itemId) => itemIdSet.has(itemId)))
    .map(({ id }) => id)
  const operations: TimelineOperation[] = [
    ...linkedGroupIds.map((linkGroupId) => ({ type: 'delete-link-group' as const, linkGroupId })),
    ...itemIds.map((itemId) => ({ type: 'delete-item' as const, itemId }))
  ]
  if (operations.length > 200) return
  await controller.applyOperations(operations, formatMessage(messages.deleteSummary, { id: item.id }))
}

export function connectionLabel(messages: Messages, state: EditorController['state']['connection']): string {
  if (state === 'online') return messages.connected
  if (state === 'offline') return messages.offline
  if (state === 'reconnecting') return messages.reconnecting
  return messages.connecting
}

export function revisionAuthorLabel(messages: Messages, author: string): string {
  if (author === 'agent') return messages.revisionAuthorAgent
  if (author === 'system') return messages.revisionAuthorSystem
  if (author === 'manual' || author === 'user') return messages.revisionAuthorManual
  return author
}

export function revisionSummaryLabel(messages: Messages, revision: RevisionProjection): string {
  const labels: Readonly<Record<string, string>> = {
    'project.create': messages.revisionProjectCreated,
    'video-probe': messages.revisionMediaImported,
    'media.reauthorize': messages.revisionMediaReauthorized,
    'video-transcribe': messages.revisionTranscriptImported,
    'video-apply-script': messages.revisionScriptApplied,
    'video-update-timeline': messages.revisionTimelineUpdated,
    'history.undo': messages.revisionUndo,
    'history.redo': messages.revisionRedo
  }
  return labels[revision.sourceOperation] ?? revision.summary
}

export function agentStateLabel(messages: Messages, state: string): string {
  const labels: Record<string, string> = {
    queued: messages.agentStateQueued,
    running: messages.agentStateRunning,
    'waiting-approval': messages.agentStateWaitingApproval,
    'waiting-user-input': messages.agentStateWaitingInput,
    completed: messages.agentStateCompleted,
    failed: messages.agentStateFailed,
    cancelled: messages.agentStateCancelled,
    'budget-exhausted': messages.agentStateBudgetExhausted
  }
  return labels[state] ?? state
}

export function jobStateLabel(messages: Messages, state: JobSnapshot['state']): string {
  if (state === 'queued') return messages.jobStateQueued
  if (state === 'running') return messages.jobStateRunning
  if (state === 'completed') return messages.jobStateCompleted
  if (state === 'failed') return messages.jobStateFailed
  if (state === 'cancelled') return messages.jobStateCancelled
  return messages.jobStateInterrupted
}

export function jobKindLabel(messages: Messages, kind: string): string {
  if (kind === 'media.ffmpeg') return messages.jobKindRender
  if (kind === 'media.ffprobe') return messages.jobKindProbe
  if (kind === 'media.archive') return messages.jobKindProjectPackage
  if (kind.includes('transcri')) return messages.jobKindTranscribe
  return kind
}

export function jobDetailLabel(messages: Messages, job: JobSnapshot): string {
  if (job.state === 'completed') return messages.jobCompletedDetail
  if (job.state === 'failed') {
    return job.error?.code
      ? formatMessage(messages.jobFailedDetail, { code: job.error.code })
      : messages.jobFailedWithoutCode
  }
  if (job.state === 'cancelled') return messages.jobCancelledDetail
  if (job.state === 'interrupted') return messages.jobInterruptedDetail
  if (job.progress?.phase === 'encoding' || job.progress?.phase === 'encode') return messages.jobProgressEncoding
  if (job.progress?.phase === 'finalizing') return messages.jobProgressFinalizing
  if (job.progress) return messages.jobProgressRunning
  return messages.waitingProgress
}

export function transcriptTagLabel(messages: Messages, tag: string): string {
  if (tag === 'filler') return messages.transcriptTagFiller
  if (tag === 'silence') return messages.transcriptTagSilence
  return tag
}

export function speakerAttributionLabel(messages: Messages, attribution: SpeakerAttributionProjection): string {
  if (attribution.status === 'identified' && attribution.speakerLabel) return attribution.speakerLabel
  if (attribution.status === 'overlap') return messages.speakerStatusOverlap
  if (attribution.status === 'unknown') return messages.speakerStatusUnknown
  return messages.speakerStatusUncertain
}

export function projectChangeReasonLabel(messages: Messages, reason: string): string {
  const labels: Record<string, string> = {
    'project-created': messages.projectChangeCreated,
    'active-project-changed': messages.projectChangeActive,
    'asset-imported': messages.projectChangeAssetImported,
    'asset-reauthorized': messages.projectChangeAssetReauthorized,
    'transcript-imported': messages.projectChangeTranscriptImported,
    'speaker-attribution-applied': messages.projectChangeSpeakerAttribution,
    'script-applied': messages.projectChangeScriptApplied,
    'timeline-updated': messages.projectChangeTimelineUpdated,
    'project-undo': messages.projectChangeUndone,
    'project-redo': messages.projectChangeRedone
  }
  return labels[reason] ?? messages.projectChanged
}

export function trackKindLabel(messages: Messages, kind: TrackProjection['kind']): string {
  if (kind === 'video') return messages.trackKindVideo
  if (kind === 'audio') return messages.trackKindAudio
  return messages.trackKindCaption
}

export function trackDisplayName(messages: Messages, track: TrackProjection): string {
  const labels: Readonly<Record<string, string>> = {
    'video-1': messages.defaultVideoTrack1,
    'video-2': messages.defaultVideoTrack2,
    'audio-1': messages.defaultAudioTrack1,
    'captions-1': messages.defaultCaptionTrack
  }
  return labels[track.id] ?? track.name
}

export function mediaKindLabel(messages: Messages, kind: GeneratedArtifact['mediaKind']): string {
  if (kind === 'video') return messages.mediaKindVideo
  if (kind === 'audio') return messages.mediaKindAudio
  if (kind === 'image') return messages.mediaKindImage
  return messages.mediaKindSubtitle
}

export function previewSourceLabel(messages: Messages, kind: 'asset' | 'timeline' | 'generated'): string {
  if (kind === 'asset') return messages.previewSourceAsset
  if (kind === 'generated') return messages.previewSourceGenerated
  return messages.previewSourceTimeline
}

export function assetKindAbbreviation(messages: Messages, kind: ProjectProjection['assets'][number]['kind']): string {
  if (kind === 'video') return messages.videoAbbreviation
  if (kind === 'audio') return messages.audioAbbreviation
  if (kind === 'image') return messages.imageAbbreviation
  return messages.animationAbbreviation
}

export function compatibleTracks(tracks: TrackProjection[], item?: ItemProjection): TrackProjection[] {
  if (!item) return []
  const current = tracks.find(({ id }) => id === item.trackId)
  return tracks.filter(({ kind }) => kind === current?.kind && kind !== 'caption')
}

export function segmentTimelineFrame(project: ProjectProjection, assetId: string, startUs: number): number {
  const item = [...project.items].sort((a, b) => a.timelineStartFrame - b.timelineStartFrame).find((candidate) =>
    candidate.assetId === assetId && candidate.sourceStartUs <= startUs && startUs < candidate.sourceEndUs
  )
  if (!item) return Math.max(0, Math.round(startUs * project.fps.numerator / project.fps.denominator / 1_000_000))
  const sourceDelta = startUs - item.sourceStartUs
  const frameDelta = sourceDelta * project.fps.numerator * item.speed.denominator /
    (1_000_000 * project.fps.denominator * item.speed.numerator)
  return item.timelineStartFrame + Math.round(frameDelta)
}

export function ticketForArtifact(tickets: RenderTicket[], artifact: GeneratedArtifact): RenderTicket | undefined {
  return artifact.provenance.jobId ? tickets.find(({ jobId }) => jobId === artifact.provenance.jobId) : undefined
}

export function artifactMatchesPlayback(
  artifact: GeneratedArtifact,
  project: ProjectProjection,
  playheadFrame: number
): boolean {
  const metadata = artifact.provenance.metadata
  if (!metadata || Array.isArray(metadata)) return false
  const digest = metadata.renderIrDigest
  const capabilitiesDigest = metadata.backendCapabilitiesDigest
  if (
    artifact.availability !== 'available' ||
    metadata.projectId !== project.id ||
    metadata.sequenceId !== project.playback.sequenceId ||
    metadata.pinnedRevision !== project.currentRevision ||
    typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest) ||
    typeof capabilitiesDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(capabilitiesDigest)
  ) return false
  if (artifact.mediaKind === 'image' && metadata.renderKind === 'proof-frame') {
    return metadata.proofFrame === playheadFrame
  }
  if (
    artifact.mediaKind !== 'video' ||
    (metadata.renderKind !== 'preview' && metadata.renderKind !== 'h264-mp4') ||
    digest !== project.playback.irDigest
  ) return false
  const range = metadata.renderRange
  return Boolean(
    range && typeof range === 'object' && !Array.isArray(range) &&
    range.startFrame === 0 && range.endFrame === project.durationFrames
  )
}

export function durationBand(duration: number, total: number): string {
  const share = total > 0 ? duration / total : 0
  return share > 0.5 ? 'xl' : share > 0.25 ? 'lg' : share > 0.1 ? 'md' : 'sm'
}

export function formatTime(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const minutes = Math.floor(safe / 60)
  const remaining = Math.floor(safe % 60)
  return `${minutes.toString().padStart(2, '0')}:${remaining.toString().padStart(2, '0')}`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function formatTimestamp(value: string, locale?: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale)
}

export function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function safeHostDisplayName(value: string): string {
  const leaf = value.normalize('NFKC').replace(/\\/gu, '/').split('/').at(-1)?.trim() ?? ''
  return replaceAsciiControlCharacters(leaf, '').slice(0, 256) || 'project-package.zip'
}
