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
import type {
  TimelineOperationNote,
  TimelineValidationIssue
} from './timeline.js'
import {
  duplicate,
  itemIndex,
  missing,
  rangeIssue,
  refIssue,
  sourceDeltaUs
} from './timeline-validation-support.js'

export function multicamGroup(project: VideoProject, groupId: string): MulticamGroup {
  const group = (project.multicamGroups ?? []).find(({ id }) => id === groupId)
  if (!group) missing(groupId)
  return structuredClone(group!)
}

export function applyMulticamPlan(
  project: VideoProject,
  group: MulticamGroup,
  plan: Readonly<MulticamPlan>,
  changedIds: Set<string>,
  notes: TimelineOperationNote[]
): TimelineOperation[] {
  if (plan.outcome !== 'ready' || plan.refusal) {
    throw engineError('invalid_operation', plan.refusal?.message ?? 'Multicam plan was refused', {
      groupId: group.id,
      planId: plan.id,
      refusal: plan.refusal,
      requestedRange: plan.requestedRange,
      uncoveredRanges: plan.uncoveredRanges,
      limitingMemberIds: plan.limitingMemberIds
    })
  }
  const transaction = compileMulticamPlanTransaction({
    projectId: project.id,
    expectedRevision: project.currentRevision,
    group,
    plan: plan as MulticamPlan
  })
  const applied = applyMulticamTransactionPreview({
    projectId: project.id,
    sequenceId: group.sequenceId,
    currentRevision: project.currentRevision,
    group,
    transaction
  })
  const groups = project.multicamGroups ?? (project.multicamGroups = [])
  const index = groups.findIndex(({ id }) => id === group.id)
  if (index < 0) missing(group.id)
  groups[index] = structuredClone(applied.group) as MulticamGroup
  changedIds.add(group.id)
  for (const id of [
    ...transaction.receiptEvidence.createdFragmentIds,
    ...transaction.receiptEvidence.changedFragmentIds,
    ...transaction.receiptEvidence.removedFragmentIds
  ]) changedIds.add(id)
  notes.push({
    code: `multicam_${plan.kind.replaceAll('-', '_')}`,
    messageKey: 'video.receipt.multicamProgramChanged',
    severity: plan.uncoveredRanges.length > 0 ? 'warning' : 'info',
    values: {
      planId: plan.id,
      groupId: group.id,
      requestedStartFrame: plan.requestedRange.startFrame,
      requestedEndFrame: plan.requestedRange.endFrame,
      appliedRangeCount: plan.appliedRanges.length,
      uncoveredRangeCount: plan.uncoveredRanges.length,
      limitingAngles: transaction.receiptEvidence.limitingAngles
        .map(({ angleLabel }) => angleLabel)
        .join(', ') || 'none'
    }
  })
  return [{ type: 'set-multicam-group', group: structuredClone(group) }]
}

export function assertItemEditable(project: VideoProject, itemId: string): void {
  const item = project.items[itemIndex(project, itemId)]!
  const track = project.tracks.find(({ id }) => id === item.trackId)
  if (item.locked) throw engineError('invalid_operation', `Timeline item is locked: ${item.id}`)
  if (track?.locked) throw engineError('invalid_operation', `Timeline track is locked: ${track.id}`)
}

export function appendKeyframePolicyNotes(
  target: TimelineOperationNote[],
  itemId: string,
  operation: 'split' | 'trim' | 'retime',
  notes: readonly KeyframeEditNote[]
): void {
  const counts = new Map<KeyframeEditNote['code'], number>()
  for (const note of notes) counts.set(note.code, (counts.get(note.code) ?? 0) + note.count)
  for (const [policy, count] of [...counts].sort(([left], [right]) => left.localeCompare(right))) {
    target.push({
      code: `keyframe_${policy}`,
      messageKey: 'video.receipt.keyframePolicy',
      severity: policy.startsWith('dropped-') || policy === 'deduplicated' ? 'warning' : 'info',
      values: { itemId, operation, policy, count }
    })
  }
}

export function addSequenceSnapshot(
  project: VideoProject,
  sequence: VideoProject['sequences'][number],
  linkGroups: VideoProject['linkGroups']
): void {
  if (project.sequences.some(({ id }) => id === sequence.id)) duplicate(sequence.id)
  const existingGroupIds = new Set(project.linkGroups.map(({ id }) => id))
  for (const group of linkGroups) {
    if (existingGroupIds.has(group.id)) duplicate(group.id)
    existingGroupIds.add(group.id)
  }
  project.sequences.push(structuredClone(sequence))
  project.linkGroups.push(...structuredClone(linkGroups))
}

export function activateSequence(project: VideoProject, sequenceId: string, changedIds: Set<string>): void {
  const current = project.sequences.find(({ id }) => id === project.activeSequenceId)
  const target = project.sequences.find(({ id }) => id === sequenceId)
  if (!current || !target) missing(sequenceId)
  if (!target.viewState.open) {
    throw engineError('invalid_operation', `Sequence must be open before selection: ${sequenceId}`)
  }
  current.tracks = structuredClone(project.tracks)
  current.items = structuredClone(project.items)
  current.captions = structuredClone(project.captions)
  project.activeSequenceId = target.id
  project.tracks = structuredClone(target.tracks)
  project.items = structuredClone(target.items)
  project.captions = structuredClone(target.captions)
  project.selection = {
    ...project.selection,
    generation: project.selection.generation + 1,
    sequenceId: target.id,
    playheadFrame: 0,
    selectedItemIds: [],
    selectedCaptionIds: [],
    selectedWordIds: [],
    range: undefined
  }
  changedIds.add(current.id)
  changedIds.add(target.id)
}

export function validateItemReferences(
  project: VideoProject,
  item: TimelineItem,
  index: number,
  assets: ReadonlyMap<string, MediaAsset>,
  tracks: ReadonlyMap<string, Track>,
  issues: TimelineValidationIssue[]
): void {
  const asset = item.nestedSequenceId ? undefined : assets.get(item.assetId)
  const track = tracks.get(item.trackId)
  if (!item.nestedSequenceId && !asset) {
    issues.push(refIssue(`items[${index}].assetId`, `Missing asset ${item.assetId}`))
  }
  if (!track) issues.push(refIssue(`items[${index}].trackId`, `Missing track ${item.trackId}`))
  if (track?.kind === 'caption') {
    issues.push(refIssue(`items[${index}].trackId`, 'Media items cannot be placed on caption tracks'))
  }
  if (
    track?.kind === 'video' && !item.nestedSequenceId &&
    asset?.kind !== 'video' && asset?.kind !== 'image' && asset?.kind !== 'animation'
  ) {
    issues.push(refIssue(`items[${index}]`, 'Only visual media can be placed on a video track'))
  }
  if (item.nestedSequenceId && track?.kind !== 'video') {
    issues.push(refIssue(`items[${index}]`, 'Nested sequences must be placed on a video track'))
  }
  if (track?.kind === 'audio' && !item.nestedSequenceId && asset?.audio === undefined) {
    issues.push(refIssue(`items[${index}]`, 'Audio tracks require a source with audio'))
  }
  if (!item.nestedSequenceId && item.sourceEndUs > (asset?.durationUs ?? 0)) {
    issues.push(rangeIssue(`items[${index}]`, 'Item source range exceeds the asset duration'))
  }
  if (item.fadeInFrames + item.fadeOutFrames > item.durationFrames) {
    issues.push(rangeIssue(`items[${index}]`, 'Item fades exceed its duration'))
  }
  const keyframeProperties = new Set<string>()
  for (const keyframes of item.keyframes ?? []) {
    if (keyframeProperties.has(keyframes.property)) {
      issues.push(rangeIssue(`items[${index}].keyframes`, `Duplicate keyframe property ${keyframes.property}`))
    }
    keyframeProperties.add(keyframes.property)
    if (keyframes.points.some(({ frame }) => frame > item.durationFrames)) {
      issues.push(rangeIssue(`items[${index}].keyframes`, `Keyframe track ${keyframes.id} exceeds item duration`))
    }
    try {
      validateKeyframeProperty(item, keyframes)
    } catch (error) {
      issues.push(rangeIssue(
        `items[${index}].keyframes`,
        error instanceof Error ? error.message : `Invalid keyframe property ${keyframes.property}`
      ))
    }
  }
  const expected = sourceDeltaUs(item.durationFrames, item.speed, project.fps)
  const actual = item.sourceEndUs - item.sourceStartUs
  const tolerance = Math.max(1, framesToMicroseconds(1, project.fps))
  if (Math.abs(expected - actual) > tolerance) {
    issues.push(rangeIssue(`items[${index}]`, 'Item source and timeline durations do not agree'))
  }
}
