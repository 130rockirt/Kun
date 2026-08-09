import type { GeneratedArtifact, JobSnapshot } from '@kun/extension-api'
import {
  VIEW_LIMITS,
  type AssetProjection,
  type CaptionProjection,
  type ItemProjection,
  type ProjectProjection,
  type RenderTicket,
  type TranscriptSegmentProjection
} from './model-project.js'
import type { EditorState, PersistedEditorState } from './model-state.js'

export function toPersistedState(state: EditorState): PersistedEditorState {
  return {
    schemaVersion: 1,
    ...(state.selectedItemId ? { selectedItemId: state.selectedItemId } : {}),
    playheadFrame: state.playheadFrame,
    ...(state.agentRun ? { activeRunId: state.agentRun.id } : {}),
    activeWorkspace: state.activeWorkspace,
    renderTickets: state.renderTickets.slice(-VIEW_LIMITS.jobs),
    projectPackageTickets: state.projectPackageTickets.slice(-VIEW_LIMITS.jobs),
    otioExportTickets: state.otioExportTickets.slice(-VIEW_LIMITS.jobs),
    transcriptWindowStart: state.transcriptWindowStart
  }
}

export function proofIsStale(ticket: RenderTicket, project?: ProjectProjection): boolean {
  return Boolean(project && ticket.projectId === project.id && ticket.pinnedRevision !== project.currentRevision)
}

export function transcriptFrame(
  project: Pick<ProjectProjection, 'fps'>,
  segment: Pick<TranscriptSegmentProjection, 'startUs'>
): number {
  return Math.max(0, Math.round(
    segment.startUs * project.fps.numerator / project.fps.denominator / 1_000_000
  ))
}

export function frameToSeconds(project: Pick<ProjectProjection, 'fps'>, frame: number): number {
  return frame * project.fps.denominator / project.fps.numerator
}

export function activeTranscriptSegment(
  project: ProjectProjection,
  assetId: string | undefined,
  frame: number
): TranscriptSegmentProjection | undefined {
  if (!assetId) return undefined
  const item = project.items.find((candidate) =>
    candidate.assetId === assetId &&
    candidate.timelineStartFrame <= frame &&
    frame < candidate.timelineStartFrame + candidate.durationFrames
  )
  if (!item) return undefined
  const timelineDeltaFrames = frame - item.timelineStartFrame
  const sourceUs = item.sourceStartUs + Math.round(
    timelineDeltaFrames * 1_000_000 * project.fps.denominator * item.speed.numerator /
    (project.fps.numerator * item.speed.denominator)
  )
  return project.transcripts
    .find((transcript) => transcript.assetId === assetId)
    ?.segments.find((segment) => segment.startUs <= sourceUs && sourceUs < segment.endUs)
}

export type TimelineSource = {
  item: ItemProjection
  asset: AssetProjection
  sourceTimeUs: number
  playbackRate: number
}

export function timelineSourceAtFrame(
  project: ProjectProjection,
  frame: number
): TimelineSource | undefined {
  const trackOrder = new Map(project.tracks.map((track) => [track.id, track.order]))
  const item = project.items
    .filter((candidate) =>
      candidate.timelineStartFrame <= frame &&
      frame < candidate.timelineStartFrame + candidate.durationFrames
    )
    .sort((left, right) =>
      (trackOrder.get(left.trackId) ?? Number.MAX_SAFE_INTEGER) -
        (trackOrder.get(right.trackId) ?? Number.MAX_SAFE_INTEGER) ||
      left.id.localeCompare(right.id)
    )
    .find((candidate) => project.assets.some(({ id, kind }) => id === candidate.assetId && kind === 'video')) ??
    project.items
      .filter((candidate) =>
        candidate.timelineStartFrame <= frame &&
        frame < candidate.timelineStartFrame + candidate.durationFrames
      )
      .sort((left, right) =>
        (trackOrder.get(left.trackId) ?? Number.MAX_SAFE_INTEGER) -
          (trackOrder.get(right.trackId) ?? Number.MAX_SAFE_INTEGER) ||
        left.id.localeCompare(right.id)
      )[0]
  if (!item) return undefined
  const asset = project.assets.find(({ id }) => id === item.assetId)
  if (!asset) return undefined
  const timelineDeltaFrames = frame - item.timelineStartFrame
  const sourceTimeUs = Math.min(item.sourceEndUs, Math.max(item.sourceStartUs,
    item.sourceStartUs + Math.round(
      timelineDeltaFrames * 1_000_000 * project.fps.denominator * item.speed.numerator /
      (project.fps.numerator * item.speed.denominator)
    )
  ))
  return {
    item,
    asset,
    sourceTimeUs,
    playbackRate: item.speed.numerator / item.speed.denominator
  }
}

export function projectFrameFromSourceTime(
  project: Pick<ProjectProjection, 'fps'>,
  source: Pick<TimelineSource, 'item'>,
  sourceSeconds: number
): number {
  const sourceDeltaUs = Math.max(0, sourceSeconds * 1_000_000 - source.item.sourceStartUs)
  const timelineFrames = sourceDeltaUs * project.fps.numerator * source.item.speed.denominator /
    (1_000_000 * project.fps.denominator * source.item.speed.numerator)
  return source.item.timelineStartFrame + Math.round(timelineFrames)
}

export function activeCaptionAtFrame(
  project: ProjectProjection,
  frame: number
): CaptionProjection | undefined {
  return project.captions.find(({ startFrame, endFrame }) => startFrame <= frame && frame < endFrame)
}

export function generatedArtifacts(snapshot: JobSnapshot): GeneratedArtifact[] {
  return snapshot.result?.generatedArtifacts.slice(0, 64) ?? []
}
