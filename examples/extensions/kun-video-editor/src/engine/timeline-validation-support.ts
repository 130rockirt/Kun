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
import {
  CANVAS_PRESETS,
  type AssetTimeRange,
  type TimelineValidationIssue
} from './timeline.js'
import { validateItemReferences } from './timeline-operation-support.js'

export function validateTrackOverlap(
  project: VideoProject,
  track: Track,
  issues: TimelineValidationIssue[]
): void {
  if (track.overlap === 'mix') return
  const ordered = project.items.filter(({ trackId }) => trackId === track.id).sort(compareItems)
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!
    const current = ordered[index]!
    if (previous.timelineStartFrame + previous.durationFrames > current.timelineStartFrame) {
      issues.push({
        path: `tracks.${track.id}`,
        code: 'overlap',
        message: `Items ${previous.id} and ${current.id} overlap on track ${track.id}`
      })
    }
  }
}

export function validateSequenceReferences(
  project: VideoProject,
  issues: TimelineValidationIssue[]
): void {
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]))
  const sequences = new Map(project.sequences.map((sequence) => [sequence.id, sequence]))
  const allItems = new Map<string, { sequenceId: string; item: TimelineItem }>()
  const allTracks = new Map<string, string>()
  const allCaptions = new Map<string, string>()
  for (const [sequenceIndex, sequence] of project.sequences.entries()) {
    unique(sequence.tracks, `sequences[${sequenceIndex}].tracks`, issues)
    unique(sequence.items, `sequences[${sequenceIndex}].items`, issues)
    unique(sequence.captions, `sequences[${sequenceIndex}].captions`, issues)
    const tracks = new Map(sequence.tracks.map((track) => [track.id, track]))
    for (const track of sequence.tracks) {
      const owner = allTracks.get(track.id)
      if (owner) {
        issues.push(refIssue(
          `sequences[${sequenceIndex}].tracks`,
          `Track identity ${track.id} is already used by sequence ${owner}`
        ))
      } else allTracks.set(track.id, sequence.id)
    }
    for (const [itemIndex, item] of sequence.items.entries()) {
      const existing = allItems.get(item.id)
      if (existing) {
        issues.push(refIssue(
          `sequences[${sequenceIndex}].items[${itemIndex}].id`,
          `Item identity ${item.id} is already used by sequence ${existing.sequenceId}`
        ))
      } else {
        allItems.set(item.id, { sequenceId: sequence.id, item })
      }
      validateItemReferences(project, item, itemIndex, assets, tracks, issues)
      if (item.nestedSequenceId !== undefined && !sequences.has(item.nestedSequenceId)) {
        issues.push(refIssue(
          `sequences[${sequenceIndex}].items[${itemIndex}].nestedSequenceId`,
          `Missing nested sequence ${item.nestedSequenceId}`
        ))
      } else if (item.nestedSequenceId !== undefined) {
        const nested = sequences.get(item.nestedSequenceId)!
        const nestedDuration = sequenceDurationFramesForValidation(nested)
        const nestedDurationUs = framesToMicroseconds(nestedDuration, project.fps)
        if (item.sourceEndUs > nestedDurationUs) {
          issues.push(rangeIssue(
            `sequences[${sequenceIndex}].items[${itemIndex}]`,
            `Nested item exceeds sequence ${nested.id} duration`
          ))
        }
      }
    }
    for (const [captionIndex, caption] of sequence.captions.entries()) {
      const owner = allCaptions.get(caption.id)
      if (owner) {
        issues.push(refIssue(
          `sequences[${sequenceIndex}].captions[${captionIndex}].id`,
          `Caption identity ${caption.id} is already used by sequence ${owner}`
        ))
      } else allCaptions.set(caption.id, sequence.id)
      if (tracks.get(caption.trackId)?.kind !== 'caption') {
        issues.push(refIssue(
          `sequences[${sequenceIndex}].captions[${captionIndex}].trackId`,
          'Caption must reference a caption track in its sequence'
        ))
      }
    }
  }

  for (const [groupIndex, group] of project.linkGroups.entries()) {
    const members = new Set(group.itemIds)
    if (members.size !== group.itemIds.length) {
      issues.push(refIssue(`linkGroups[${groupIndex}].itemIds`, 'Link groups cannot contain duplicate items'))
    }
    let ownerSequenceId: string | undefined
    for (const itemId of group.itemIds) {
      const entry = allItems.get(itemId)
      if (!entry) {
        issues.push(refIssue(`linkGroups[${groupIndex}].itemIds`, `Missing linked item ${itemId}`))
      } else if (entry.item.linkGroupId !== group.id) {
        issues.push(refIssue(
          `linkGroups[${groupIndex}].itemIds`,
          `Linked item ${itemId} does not reference group ${group.id}`
        ))
      } else if (ownerSequenceId !== undefined && entry.sequenceId !== ownerSequenceId) {
        issues.push(refIssue(
          `linkGroups[${groupIndex}].itemIds`,
          `Link group ${group.id} cannot cross sequence boundaries`
        ))
      } else {
        ownerSequenceId = entry.sequenceId
      }
    }
  }
  for (const { item } of allItems.values()) {
    if (item.linkGroupId && !project.linkGroups.some(({ id }) => id === item.linkGroupId)) {
      issues.push(refIssue('items.linkGroupId', `Missing link group ${item.linkGroupId}`))
    }
  }
  validateNoSequenceCycles(project, sequences, issues)
}

export function validateNoSequenceCycles(
  project: VideoProject,
  sequences: ReadonlyMap<string, VideoProject['sequences'][number]>,
  issues: TimelineValidationIssue[]
): void {
  const maximumDepth = 8
  const visiting = new Set<string>()
  const memo = new Map<string, number>()
  const depthFrom = (sequenceId: string): number | undefined => {
    if (visiting.has(sequenceId)) return undefined
    const retained = memo.get(sequenceId)
    if (retained !== undefined) return retained
    visiting.add(sequenceId)
    const sequence = sequences.get(sequenceId)
    let depth = 0
    for (const item of sequence?.items ?? []) {
      if (!item.nestedSequenceId) continue
      const childDepth = depthFrom(item.nestedSequenceId)
      if (childDepth === undefined) return undefined
      depth = Math.max(depth, 1 + childDepth)
    }
    visiting.delete(sequenceId)
    memo.set(sequenceId, depth)
    return depth
  }
  for (const sequence of project.sequences) {
    const depth = depthFrom(sequence.id)
    if (depth === undefined) {
      issues.push(refIssue(`sequences.${sequence.id}`, 'Nested sequence graph contains a cycle'))
      return
    }
    if (depth > maximumDepth) {
      issues.push(rangeIssue(`sequences.${sequence.id}`, `Nested sequence depth exceeds ${maximumDepth}`))
      return
    }
  }
}

export function sequenceDurationFramesForValidation(sequence: VideoProject['sequences'][number]): number {
  return Math.max(
    0,
    ...sequence.items.map((item) => item.timelineStartFrame + item.durationFrames),
    ...sequence.captions.map((caption) => caption.endFrame)
  )
}

export function validateSelectionReferences(
  project: VideoProject,
  issues: TimelineValidationIssue[]
): void {
  const sequence = project.sequences.find(({ id }) => id === project.selection.sequenceId)
  if (!sequence) return
  const references: Array<[readonly string[], Set<string>, string]> = [
    [project.selection.selectedAssetIds, new Set(project.assets.map(({ id }) => id)), 'selectedAssetIds'],
    [project.selection.selectedItemIds, new Set(sequence.items.map(({ id }) => id)), 'selectedItemIds'],
    [project.selection.selectedCaptionIds, new Set(sequence.captions.map(({ id }) => id)), 'selectedCaptionIds'],
    [
      project.selection.selectedWordIds,
      new Set(project.transcripts.flatMap((transcript) =>
        transcript.segments.flatMap((segment) => (segment.words ?? []).map(({ id }) => id))
      )),
      'selectedWordIds'
    ]
  ]
  for (const [ids, valid, key] of references) {
    for (const id of ids) {
      if (!valid.has(id)) issues.push(refIssue(`selection.${key}`, `Missing selected identity ${id}`))
    }
  }
  if (project.selection.revision > project.currentRevision) {
    issues.push(rangeIssue('selection.revision', 'Selection cannot target a future project revision'))
  }
}

export function validateDerivedReferences(
  project: VideoProject,
  issues: TimelineValidationIssue[]
): void {
  const assetIds = new Set(project.assets.map(({ id }) => id))
  const derivedIds = new Set(project.derivedReferences.map(({ id }) => id))
  for (const [index, reference] of project.derivedReferences.entries()) {
    if (reference.sourceAssetId && !assetIds.has(reference.sourceAssetId)) {
      issues.push(refIssue(`derivedReferences[${index}].sourceAssetId`, `Missing asset ${reference.sourceAssetId}`))
    }
    for (const dependencyId of reference.dependencyIds) {
      if (!derivedIds.has(dependencyId)) {
        issues.push(refIssue(`derivedReferences[${index}].dependencyIds`, `Missing derived dependency ${dependencyId}`))
      }
    }
  }
}

export function normalizeAssetRanges(project: VideoProject, ranges: readonly AssetTimeRange[]): AssetTimeRange[] {
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]))
  const sorted = ranges.map((range) => {
    const asset = assets.get(range.assetId)
    if (
      !asset ||
      !Number.isSafeInteger(range.startUs) ||
      !Number.isSafeInteger(range.endUs) ||
      range.startUs < 0 ||
      range.endUs <= range.startUs ||
      range.endUs > asset.durationUs
    ) {
      throw engineError('invalid_operation', 'Transcript edit contains an invalid timed asset range')
    }
    return { ...range }
  }).sort((left, right) =>
    left.assetId.localeCompare(right.assetId) || left.startUs - right.startUs || left.endUs - right.endUs
  )
  const merged: AssetTimeRange[] = []
  for (const range of sorted) {
    const previous = merged.at(-1)
    if (previous && previous.assetId === range.assetId && range.startUs <= previous.endUs) {
      previous.endUs = Math.max(previous.endUs, range.endUs)
      previous.reason = previous.reason === range.reason ? previous.reason : 'selection'
    } else {
      merged.push(range)
    }
  }
  return merged
}

export function subtractSourceRanges(
  item: TimelineItem,
  ranges: readonly AssetTimeRange[],
  fps: Rational
): TimelineItem[] {
  let sourceCursor = item.sourceStartUs
  const keptSource: Array<{ startUs: number; endUs: number }> = []
  for (const range of ranges) {
    const startUs = Math.max(item.sourceStartUs, range.startUs)
    const endUs = Math.min(item.sourceEndUs, range.endUs)
    if (startUs > sourceCursor) keptSource.push({ startUs: sourceCursor, endUs: startUs })
    sourceCursor = Math.max(sourceCursor, endUs)
  }
  if (sourceCursor < item.sourceEndUs) keptSource.push({ startUs: sourceCursor, endUs: item.sourceEndUs })
  return keptSource.flatMap(({ startUs, endUs }) => {
    const durationFrames = sourceUsToTimelineFrames(endUs - startUs, item.speed, fps)
    return durationFrames <= 0 ? [] : [{
      ...item,
      sourceStartUs: startUs,
      sourceEndUs: endUs,
      durationFrames,
      fadeInFrames: 0,
      fadeOutFrames: 0
    }]
  })
}

export function sourceDeltaUs(frames: number, speed: Rational, fps: Rational): number {
  const normalized = normalizeRational(speed)
  const timelineUs = BigInt(framesToMicroseconds(frames, fps))
  return Number(
    (timelineUs * BigInt(normalized.numerator) + BigInt(normalized.denominator) / 2n) /
    BigInt(normalized.denominator)
  )
}

export function sourceUsToTimelineFrames(sourceUs: number, speed: Rational, fps: Rational): number {
  const normalized = normalizeRational(speed)
  const timelineUs = Number(
    (BigInt(sourceUs) * BigInt(normalized.denominator) + BigInt(normalized.numerator) / 2n) /
    BigInt(normalized.numerator)
  )
  return microsecondsToFrames(timelineUs, fps)
}

export function unique(
  values: ReadonlyArray<{ id: string }>,
  collection: string,
  issues: TimelineValidationIssue[]
): void {
  const seen = new Set<string>()
  values.forEach(({ id }, index) => {
    if (seen.has(id)) issues.push(refIssue(`${collection}[${index}].id`, `Duplicate identity ${id}`))
    seen.add(id)
  })
}

export function sortProjectCollections(project: VideoProject): void {
  sortSequenceCollections(project)
  for (const sequence of project.sequences) sortSequenceCollections(sequence)
  project.multicamGroups?.sort((left, right) => left.id.localeCompare(right.id))
  project.transcripts.forEach((transcript) => {
    transcript.segments.sort((left, right) => left.startUs - right.startUs || left.id.localeCompare(right.id))
  })
}

export function sortSequenceCollections(sequence: Pick<VideoProject, 'tracks' | 'items' | 'captions'>): void {
  sequence.tracks.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
  sequence.items.sort(compareItems)
  sequence.captions.sort((left, right) => left.startFrame - right.startFrame || left.id.localeCompare(right.id))
}

export function compareItems(left: TimelineItem, right: TimelineItem): number {
  return left.timelineStartFrame - right.timelineStartFrame || left.id.localeCompare(right.id)
}

export function projectDurationFramesWithoutCaptions(project: VideoProject): number {
  return project.items.reduce(
    (maximum, item) => Math.max(maximum, item.timelineStartFrame + item.durationFrames),
    0
  )
}

export function itemIndex(project: VideoProject, id: string): number {
  const index = project.items.findIndex((item) => item.id === id)
  if (index < 0) missing(id)
  return index
}

export function duplicate(id: string): never {
  throw engineError('invalid_operation', `Identity already exists: ${id}`)
}

export function missing(id: string): never {
  throw engineError('invalid_operation', `Identity does not exist: ${id}`)
}

export function refIssue(path: string, message: string): TimelineValidationIssue {
  return { path, code: 'invalid_reference', message }
}

export function rangeIssue(path: string, message: string): TimelineValidationIssue {
  return { path, code: 'invalid_range', message }
}

export function canvasForPreset(preset: CanvasPreset, fit: CanvasFit = 'fit'): VideoProject['canvas'] {
  return { preset, fit, ...CANVAS_PRESETS[preset], background: '#000000' }
}
