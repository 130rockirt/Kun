import { engineError } from './errors.js'
import {
  MAX_PROJECT_HISTORY,
  TimelineOperationSchema,
  VideoProjectSchema,
  syncActiveSequenceProjection,
  type CanvasFit,
  type CanvasPreset,
  type MediaAsset,
  type Rational,
  type TimelineItem,
  type TimelineOperation,
  type Track,
  type VideoProject
} from './schema.js'
import { framesToMicroseconds, microsecondsToFrames, normalizeRational } from './time.js'
import {
  retimeKeyframeTrack,
  splitKeyframeTrack,
  trimKeyframeTrack,
  type KeyframeEditNote
} from './keyframes.js'
import { validateKeyframeProperty } from './effects.js'
import {
  assertSequenceDeleteSafe,
  createEmptySequenceSnapshot,
  duplicateSequenceSnapshot,
  propagateNestedSequenceDuration,
  sequenceDurationFrames,
  sequenceSnapshot
} from './sequences.js'
import {
  applyMulticamTransactionPreview,
  compileMulticamPlanTransaction,
  planMulticamAngleSwitch,
  planMulticamLayout,
  planMulticamMerge,
  validateMulticamGroup,
  type MulticamGroup,
  type MulticamPlan
} from './multicam.js'
import { applyOne } from './timeline-operation-apply.js'
import {
  compareItems,
  normalizeAssetRanges,
  projectDurationFramesWithoutCaptions,
  rangeIssue,
  refIssue,
  sortProjectCollections,
  subtractSourceRanges,
  unique,
  validateDerivedReferences,
  validateNoSequenceCycles,
  validateSelectionReferences,
  validateSequenceReferences,
  validateTrackOverlap
} from './timeline-validation-support.js'
import { validateItemReferences } from './timeline-operation-support.js'

export type TimelineValidationIssue = {
  path: string
  code: string
  message: string
}

export type ApplyOperationsResult = {
  project: VideoProject
  inverseOperations: TimelineOperation[]
  changedIds: string[]
  notes: TimelineOperationNote[]
}

export type TimelineOperationNote = {
  code: string
  messageKey: string
  severity: 'info' | 'warning'
  values?: Record<string, string | number>
}

export type AssetTimeRange = {
  assetId: string
  startUs: number
  endUs: number
  reason?: 'filler' | 'silence' | 'selection'
}

export const CANVAS_PRESETS: Readonly<Record<CanvasPreset, { width: number; height: number }>> = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 }
}

export function projectDurationFrames(project: VideoProject): number {
  const itemEnd = project.items.reduce(
    (maximum, item) => Math.max(maximum, item.timelineStartFrame + item.durationFrames),
    0
  )
  const captionEnd = project.captions.reduce(
    (maximum, caption) => Math.max(maximum, caption.endFrame),
    0
  )
  return Math.max(itemEnd, captionEnd)
}

export function validateTimeline(project: VideoProject): TimelineValidationIssue[] {
  const issues: TimelineValidationIssue[] = []
  try {
    project = syncActiveSequenceProjection(project)
    VideoProjectSchema.parse(project)
  } catch (error) {
    issues.push({
      path: 'project',
      code: 'schema',
      message: error instanceof Error ? error.message : String(error)
    })
    return issues
  }

  unique(project.assets, 'assets', issues)
  unique(project.tracks, 'tracks', issues)
  unique(project.items, 'items', issues)
  unique(project.captions, 'captions', issues)
  unique(project.transcripts, 'transcripts', issues)
  unique(project.sequences, 'sequences', issues)
  unique(project.linkGroups, 'linkGroups', issues)
  unique(project.derivedReferences, 'derivedReferences', issues)
  unique(project.multicamGroups ?? [], 'multicamGroups', issues)

  const assets = new Map(project.assets.map((asset) => [asset.id, asset]))
  const tracks = new Map(project.tracks.map((track) => [track.id, track]))
  const transcriptIds = new Set(project.transcripts.map(({ id }) => id))

  project.assets.forEach((asset, index) => {
    for (const transcriptId of asset.transcriptIds) {
      if (!transcriptIds.has(transcriptId)) {
        issues.push(refIssue(`assets[${index}].transcriptIds`, `Missing transcript ${transcriptId}`))
      }
    }
    if (asset.kind === 'video' && asset.video === undefined) {
      issues.push(refIssue(`assets[${index}].video`, 'Video assets require probed video metadata'))
    }
  })

  project.transcripts.forEach((transcript, index) => {
    const asset = assets.get(transcript.assetId)
    if (!asset) {
      issues.push(refIssue(`transcripts[${index}].assetId`, `Missing asset ${transcript.assetId}`))
      return
    }
    let previousEnd = -1
    transcript.segments.forEach((segment, segmentIndex) => {
      if (segment.endUs > asset.durationUs) {
        issues.push(rangeIssue(
          `transcripts[${index}].segments[${segmentIndex}]`,
          'Transcript segment exceeds the source asset duration'
        ))
      }
      if (segment.startUs < previousEnd) {
        issues.push(rangeIssue(
          `transcripts[${index}].segments[${segmentIndex}]`,
          'Transcript segments must be ordered and non-overlapping'
        ))
      }
      previousEnd = segment.endUs
      for (const word of segment.words ?? []) {
        if (word.startUs < segment.startUs || word.endUs > segment.endUs || word.endUs <= word.startUs) {
          issues.push(rangeIssue(
            `transcripts[${index}].segments[${segmentIndex}].words`,
            'Transcript word timing must remain within its segment'
          ))
        }
      }
    })
  })

  project.items.forEach((item, index) => validateItemReferences(
    project,
    item,
    index,
    assets,
    tracks,
    issues
  ))

  project.captions.forEach((caption, index) => {
    const track = tracks.get(caption.trackId)
    if (!track || track.kind !== 'caption') {
      issues.push(refIssue(`captions[${index}].trackId`, 'Caption must reference a caption track'))
    }
    if (caption.endFrame > projectDurationFramesWithoutCaptions(project)) {
      issues.push(rangeIssue(`captions[${index}]`, 'Caption exceeds the composed media duration'))
    }
  })

  for (const track of project.tracks) validateTrackOverlap(project, track, issues)

  validateSequenceReferences(project, issues)
  validateSelectionReferences(project, issues)
  validateDerivedReferences(project, issues)

  const revisions = new Set(project.revisions.map(({ revision }) => revision))
  if (!revisions.has(project.currentRevision)) {
    issues.push(refIssue('currentRevision', 'The current revision has no metadata record'))
  }
  if (project.revisions.at(-1)?.revision !== project.currentRevision) {
    issues.push(rangeIssue('revisions', 'Revision metadata must end at the current revision'))
  }
  if (project.revisions.length > MAX_PROJECT_HISTORY + 1) {
    issues.push(rangeIssue('revisions', 'Revision metadata exceeds the bounded history window'))
  }
  if (project.eventGeneration < project.currentRevision) {
    issues.push(rangeIssue('eventGeneration', 'Event generation cannot trail the project revision'))
  }
  const revisionsByNumber = new Map(project.revisions.map((revision) => [revision.revision, revision]))
  for (const [index, entry] of project.agentUndoStack.entries()) {
    const revision = revisionsByNumber.get(entry.revision)
    if (
      !revision ||
      revision.author !== 'agent' ||
      revision.actorId !== entry.actorId ||
      revision.transactionId !== entry.transactionId
    ) {
      issues.push(refIssue(
        `agentUndoStack[${index}]`,
        `Agent undo entry does not identify its retained Agent transaction`
      ))
    }
  }
  return issues
}

export function assertValidTimeline(project: VideoProject): void {
  const issues = validateTimeline(project)
  if (issues.length > 0) {
    throw engineError('invalid_project', issues[0]!.message, { issues })
  }
}

export function applyTimelineOperations(
  source: VideoProject,
  operations: readonly TimelineOperation[]
): ApplyOperationsResult {
  assertValidTimeline(source)
  const previousSequenceDurations = new Map(
    source.sequences.map((sequence) => [sequence.id, sequenceDurationFrames(sequence)])
  )
  const project = structuredClone(source)
  const inverseOperations: TimelineOperation[] = []
  const changedIds = new Set<string>()
  const notes: TimelineOperationNote[] = []

  for (const unchecked of operations) {
    const operation = TimelineOperationSchema.parse(unchecked)
    const inverses = applyOne(project, operation, changedIds, notes)
    inverseOperations.unshift(...inverses)
  }
  sortProjectCollections(project)
  let synchronized = syncActiveSequenceProjection(project)
  const durationChangedSequenceIds = synchronized.sequences
    .filter((sequence) => {
      const previous = previousSequenceDurations.get(sequence.id)
      return previous !== undefined && previous !== sequenceDurationFrames(sequence)
    })
    .map(({ id }) => id)
    .sort()
  const propagatedItemIds = new Set<string>()
  const propagatedSequenceIds = new Set<string>()
  for (const sequenceId of durationChangedSequenceIds) {
    const previousDuration = previousSequenceDurations.get(sequenceId)
    if (previousDuration === undefined) continue
    const propagated = propagateNestedSequenceDuration(synchronized, sequenceId, previousDuration)
    synchronized = propagated.project
    propagated.changedItemIds.forEach((id) => {
      propagatedItemIds.add(id)
      changedIds.add(id)
    })
    propagated.changedSequenceIds.forEach((id) => {
      propagatedSequenceIds.add(id)
      changedIds.add(id)
    })
  }
  if (propagatedItemIds.size > 0) {
    notes.push({
      code: 'nested-duration-propagated',
      messageKey: 'video.receipt.nestedDurationPropagated',
      severity: 'info',
      values: {
        itemCount: propagatedItemIds.size,
        sequenceCount: propagatedSequenceIds.size
      }
    })
  }
  assertValidTimeline(synchronized)
  return { project: synchronized, inverseOperations, changedIds: [...changedIds].sort(), notes }
}

export function removeAssetTimeRanges(
  source: VideoProject,
  ranges: readonly AssetTimeRange[]
): { project: VideoProject; removed: AssetTimeRange[]; changedIds: string[] } {
  assertValidTimeline(source)
  const normalized = normalizeAssetRanges(source, ranges)
  const project = structuredClone(source)
  const changedIds = new Set<string>()

  for (const track of project.tracks) {
    const original = project.items
      .filter((item) => item.trackId === track.id)
      .sort(compareItems)
    if (original.length === 0) continue
    let removedBefore = 0
    const replacement: TimelineItem[] = []
    for (const item of original) {
      const cuts = normalized.filter((range) =>
        range.assetId === item.assetId &&
        range.startUs < item.sourceEndUs &&
        range.endUs > item.sourceStartUs
      )
      if (cuts.length === 0) {
        replacement.push({ ...item, timelineStartFrame: item.timelineStartFrame - removedBefore })
        continue
      }
      changedIds.add(item.id)
      const kept = subtractSourceRanges(item, cuts, project.fps)
      const originalEnd = item.timelineStartFrame + item.durationFrames
      let cursor = item.timelineStartFrame - removedBefore
      kept.forEach((part, index) => {
        const next = {
          ...part,
          id: kept.length === 1 ? item.id : `${item.id}-part-${index + 1}`,
          timelineStartFrame: cursor
        }
        replacement.push(next)
        changedIds.add(next.id)
        cursor += next.durationFrames
      })
      const removedFromItem = item.durationFrames - kept.reduce((sum, part) => sum + part.durationFrames, 0)
      removedBefore += removedFromItem
      // Preserve pre-existing gaps while rippling only the frames deleted by this edit.
      const expectedCursor = originalEnd - removedBefore
      if (cursor > expectedCursor) {
        throw engineError('invalid_operation', 'Transcript range conversion expanded a timeline item')
      }
    }
    project.items = [
      ...project.items.filter((item) => item.trackId !== track.id),
      ...replacement
    ]
  }

  sortProjectCollections(project)
  const synchronized = syncActiveSequenceProjection(project)
  assertValidTimeline(synchronized)
  return { project: synchronized, removed: normalized, changedIds: [...changedIds].sort() }
}


export { canvasForPreset } from './timeline-validation-support.js'
