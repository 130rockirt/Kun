import { createHash } from 'node:crypto'
import { engineError } from './errors.js'
import {
  VideoProjectSchema,
  validateProjectRoundTrip,
  type Caption,
  type EffectInstance,
  type KeyframeTrack,
  type Rational,
  type Sequence,
  type TimelineItem,
  type Track,
  type VideoProject
} from './schema.js'
import { framesToMicroseconds, microsecondsToFrames, rescaleFrames } from './time.js'
import { containsNullOrLineBreak, replaceNullOrLineBreaks } from '../text-safety.js'
import {
  OTIO_LIMITS,
  type OtioTimecodeMapping
} from './otio-interchange.js'
import {
  addLoss,
  invalid,
  metadataLoss,
  optionalRecord,
  record,
  type LossCollector
} from './otio-validation-support.js'

export function otioTimeline(
  project: VideoProject,
  sequence: Sequence,
  loss: LossCollector,
  mappings: OtioTimecodeMapping[]
): Record<string, unknown> {
  const tracks = sequence.tracks
    .slice()
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map((track) => otioTrack(project, sequence, track, loss, mappings))
  return {
    OTIO_SCHEMA: 'Timeline.1',
    name: sequence.name,
    global_start_time: rationalTime(0, project.fps),
    metadata: {
      kun: {
        id: sequence.id,
        viewState: structuredClone(sequence.viewState),
        frameRate: structuredClone(project.fps)
      }
    },
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      name: `${sequence.name} tracks`,
      metadata: { kun: { id: `${sequence.id}.tracks` } },
      children: tracks,
      effects: [],
      markers: []
    }
  }
}

export function otioTrack(
  project: VideoProject,
  sequence: Sequence,
  track: Track,
  loss: LossCollector,
  mappings: OtioTimecodeMapping[]
): Record<string, unknown> {
  const timelineEntries = track.kind === 'caption'
    ? sequence.captions
        .filter(({ trackId }) => trackId === track.id)
        .map((caption) => ({
          startFrame: caption.startFrame,
          endFrame: caption.endFrame,
          id: caption.id,
          value: otioCaption(project, sequence, caption, loss, mappings)
        }))
    : sequence.items
        .filter(({ trackId }) => trackId === track.id)
        .map((item) => ({
          startFrame: item.timelineStartFrame,
          endFrame: item.timelineStartFrame + item.durationFrames,
          id: item.id,
          value: otioClip(project, sequence, item, loss, mappings)
        }))
  timelineEntries.sort((left, right) => left.startFrame - right.startFrame || left.id.localeCompare(right.id))
  const children: Record<string, unknown>[] = []
  let cursor = 0
  for (const entry of timelineEntries) {
    if (entry.startFrame > cursor) children.push(otioGap(entry.startFrame - cursor, project.fps, track.id, cursor))
    if (entry.startFrame < cursor) {
      addLoss(loss, metadataLoss(
        'overlap-custom-metadata', 'track-overlap', entry.id,
        `Overlapping timing on track ${track.id} is exact in Kun metadata but sequential OTIO Track semantics may flatten it.`
      ))
    }
    children.push(entry.value)
    cursor = Math.max(cursor, entry.endFrame)
  }
  return {
    OTIO_SCHEMA: 'Track.1',
    name: track.name,
    kind: track.kind === 'audio' ? 'Audio' : 'Video',
    metadata: {
      kun: {
        id: track.id,
        kind: track.kind,
        order: track.order,
        overlap: track.overlap,
        muted: track.muted ?? false,
        locked: track.locked ?? false
      }
    },
    children,
    effects: [],
    markers: []
  }
}

export function otioClip(
  project: VideoProject,
  sequence: Sequence,
  item: TimelineItem,
  loss: LossCollector,
  mappings: OtioTimecodeMapping[]
): Record<string, unknown> {
  const asset = project.assets.find(({ id }) => id === item.assetId)
  if (!asset && !item.nestedSequenceId) invalid(`Timeline item ${item.id} refers to a missing asset`)
  const sourceStartFrame = microsecondsToFrames(item.sourceStartUs, project.fps, 'nearest')
  const sourceDurationFrames = Math.max(
    1,
    microsecondsToFrames(item.sourceEndUs - item.sourceStartUs, project.fps, 'nearest')
  )
  const effects = otioEffects(item.effects ?? [], item.keyframes ?? [], item, loss)
  if (item.nestedSequenceId) {
    addLoss(loss, metadataLoss(
      'nested-sequence-reference-custom-metadata', 'nested-sequence', item.id,
      `Nested sequence ${item.nestedSequenceId} is preserved by stable ID in Kun metadata; OTIO consumers may flatten it.`
    ))
  }
  if (!identityVisual(item)) {
    addLoss(loss, metadataLoss(
      'visual-transform-custom-metadata', 'visual-transform', item.id,
      'Transform, crop, opacity, and fades are preserved in Kun metadata rather than portable OTIO fields.'
    ))
  }
  if (item.keyframes?.length) {
    addLoss(loss, metadataLoss(
      'keyframes-custom-metadata', 'keyframes', item.id,
      'Keyframe interpolation and property paths are preserved in Kun metadata.'
    ))
  }
  if (item.effects?.length) {
    addLoss(loss, metadataLoss(
      'effect-parameters-custom-metadata', 'effects', item.id,
      'Effect identities are emitted as OTIO Effect objects; parameters remain Kun metadata.'
    ))
  }
  addMapping(mappings, project.fps, sequence.id, item.id, item.timelineStartFrame, item.timelineStartFrame + item.durationFrames)
  return {
    OTIO_SCHEMA: 'Clip.2',
    name: item.nestedSequenceId
      ? project.sequences.find(({ id }) => id === item.nestedSequenceId)?.name ?? item.nestedSequenceId
      : asset!.name,
    source_range: timeRange(sourceStartFrame, sourceDurationFrames, project.fps),
    media_reference: item.nestedSequenceId
      ? {
          OTIO_SCHEMA: 'MissingReference.1',
          name: `Nested sequence ${item.nestedSequenceId}`,
          metadata: { kun: { nestedSequenceId: item.nestedSequenceId } },
          available_range: null
        }
      : {
          OTIO_SCHEMA: 'ExternalReference.1',
          name: asset!.name,
          target_url: `kun-media://${encodeURIComponent(asset!.id)}`,
          available_range: timeRange(
            0,
            Math.max(1, microsecondsToFrames(asset!.durationUs, project.fps, 'nearest')),
            project.fps
          ),
          metadata: { kun: { assetId: asset!.id } }
        },
    effects,
    markers: [],
    metadata: {
      kun: {
        id: item.id,
        sequenceId: sequence.id,
        assetId: item.assetId,
        timelineStartFrame: item.timelineStartFrame,
        durationFrames: item.durationFrames,
        sourceStartUs: item.sourceStartUs,
        sourceEndUs: item.sourceEndUs,
        speed: structuredClone(item.speed),
        transform: structuredClone(item.transform),
        opacity: item.opacity,
        fadeInFrames: item.fadeInFrames,
        fadeOutFrames: item.fadeOutFrames,
        ...(item.crop ? { crop: structuredClone(item.crop) } : {}),
        ...(item.volume === undefined ? {} : { volume: item.volume }),
        ...(item.linkGroupId ? { linkGroupId: item.linkGroupId } : {}),
        ...(item.nestedSequenceId ? { nestedSequenceId: item.nestedSequenceId } : {}),
        effects: structuredClone(item.effects ?? []),
        keyframes: structuredClone(item.keyframes ?? []),
        startTimecode: frameTimecode(item.timelineStartFrame, project.fps),
        endTimecode: frameTimecode(item.timelineStartFrame + item.durationFrames, project.fps)
      }
    }
  }
}

export function otioCaption(
  project: VideoProject,
  sequence: Sequence,
  caption: Caption,
  loss: LossCollector,
  mappings: OtioTimecodeMapping[]
): Record<string, unknown> {
  addLoss(loss, metadataLoss(
    'caption-custom-metadata', 'caption', caption.id,
    'Editable caption text, word timing, style, and animation are preserved in Kun metadata.'
  ))
  addMapping(mappings, project.fps, sequence.id, caption.id, caption.startFrame, caption.endFrame)
  return {
    OTIO_SCHEMA: 'Clip.2',
    name: caption.text,
    source_range: timeRange(0, caption.endFrame - caption.startFrame, project.fps),
    media_reference: {
      OTIO_SCHEMA: 'MissingReference.1',
      name: 'Kun caption',
      metadata: { kun: { kind: 'caption' } },
      available_range: null
    },
    effects: [],
    markers: [],
    metadata: {
      kun: {
        id: caption.id,
        sequenceId: sequence.id,
        kind: 'caption',
        timelineStartFrame: caption.startFrame,
        durationFrames: caption.endFrame - caption.startFrame,
        caption: structuredClone(caption),
        startTimecode: frameTimecode(caption.startFrame, project.fps),
        endTimecode: frameTimecode(caption.endFrame, project.fps)
      }
    }
  }
}

export function otioEffects(
  effects: readonly EffectInstance[],
  keyframes: readonly KeyframeTrack[],
  item: TimelineItem,
  loss: LossCollector
): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = effects.map((effect) => ({
    OTIO_SCHEMA: 'Effect.1',
    name: effect.type,
    effect_name: effect.type,
    metadata: { kun: structuredClone(effect) }
  }))
  if (item.speed.numerator !== item.speed.denominator) {
    result.unshift({
      OTIO_SCHEMA: 'LinearTimeWarp.1',
      name: 'Kun speed',
      effect_name: 'LinearTimeWarp',
      time_scalar: item.speed.numerator / item.speed.denominator,
      metadata: { kun: { speed: structuredClone(item.speed) } }
    })
  }
  if (keyframes.length > 0 && effects.length === 0) {
    addLoss(loss, metadataLoss(
      'keyframes-without-effect-custom-metadata', 'keyframes', item.id,
      'Property keyframes without an OTIO Effect are retained only in clip-level Kun metadata.'
    ))
  }
  return result
}

export function otioGap(durationFrames: number, fps: Rational, trackId: string, startFrame: number): Record<string, unknown> {
  return {
    OTIO_SCHEMA: 'Gap.1',
    name: 'Gap',
    source_range: timeRange(0, durationFrames, fps),
    effects: [],
    markers: [],
    metadata: { kun: { id: `${trackId}.gap.${startFrame}`, startFrame, durationFrames } }
  }
}

export function timeRange(startFrame: number, durationFrames: number, fps: Rational): Record<string, unknown> {
  return {
    OTIO_SCHEMA: 'TimeRange.1',
    start_time: rationalTime(startFrame, fps),
    duration: rationalTime(durationFrames, fps)
  }
}

export function rationalTime(frame: number, fps: Rational): Record<string, unknown> {
  return {
    OTIO_SCHEMA: 'RationalTime.1',
    value: frame,
    rate: fps.numerator / fps.denominator,
    metadata: { kun: { frame, frameRate: structuredClone(fps) } }
  }
}

export function frameTimecode(frame: number, fps: Rational): string {
  if (!Number.isSafeInteger(frame) || frame < 0) invalid('Timecode frame must be a non-negative integer')
  const nominalRate = Math.max(1, Math.round(fps.numerator / fps.denominator))
  const frames = frame % nominalRate
  const totalSeconds = Math.floor(frame / nominalRate)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3_600)
  return [hours, minutes, seconds, frames].map((value) => String(value).padStart(2, '0')).join(':')
}

export function addMapping(
  mappings: OtioTimecodeMapping[],
  fps: Rational,
  sequenceId: string,
  id: string,
  startFrame: number,
  endFrame: number
): void {
  if (mappings.length >= OTIO_LIMITS.timecodeMappings) invalid('OTIO timecode mapping limit exceeded')
  mappings.push({
    id,
    sequenceId,
    startFrame,
    endFrame,
    startTimecode: frameTimecode(startFrame, fps),
    endTimecode: frameTimecode(endFrame, fps),
    frameRate: structuredClone(fps)
  })
}

export function collectTimecodeMappings(document: Record<string, unknown>, fps: Rational): OtioTimecodeMapping[] {
  const mappings: OtioTimecodeMapping[] = []
  visit(document, (node) => {
    const metadata = optionalRecord(node.metadata)
    const kun = optionalRecord(metadata?.kun)
    if (
      typeof kun?.id !== 'string' ||
      typeof kun.sequenceId !== 'string' ||
      !Number.isSafeInteger(kun.timelineStartFrame) ||
      !Number.isSafeInteger(kun.durationFrames)
    ) return
    addMapping(
      mappings,
      fps,
      kun.sequenceId,
      kun.id,
      Number(kun.timelineStartFrame),
      Number(kun.timelineStartFrame) + Number(kun.durationFrames)
    )
  })
  return mappings.sort((left, right) =>
    left.sequenceId.localeCompare(right.sequenceId) ||
    left.startFrame - right.startFrame ||
    left.id.localeCompare(right.id))
}

export function sanitizeProject(project: VideoProject): VideoProject {
  const copy = structuredClone(project)
  copy.assets = copy.assets.map((asset) => {
    const sanitized = { ...asset }
    delete sanitized.workspaceRelativePath
    // Schema v2 requires a durable reference. This value is a namespaced,
    // non-reusable offline placeholder, never the source grant or a path.
    sanitized.mediaHandleId = `otio_offline_${asset.id}`
    sanitized.availability = 'offline'
    sanitized.recovery = { reason: 'missing' }
    return sanitized
  })
  return validateProjectRoundTrip(copy)
}

export function identityVisual(item: TimelineItem): boolean {
  return item.transform.x === 0 && item.transform.y === 0 &&
    item.transform.scaleX === 1 && item.transform.scaleY === 1 &&
    item.transform.rotation === 0 && item.opacity === 1 &&
    item.fadeInFrames === 0 && item.fadeOutFrames === 0 &&
    !item.crop
}

export function validateKunMediaReferences(document: Record<string, unknown>): void {
  visit(document, (node) => {
    if (node.OTIO_SCHEMA !== 'ExternalReference.1') return
    if (typeof node.target_url !== 'string' || !/^kun-media:\/\/[A-Za-z0-9._~%-]+$/u.test(node.target_url)) {
      invalid('OTIO external references must use bounded kun-media URLs')
    }
  })
}

export function visit(value: unknown, callback: (node: Record<string, unknown>) => void): void {
  const stack: unknown[] = [value]
  let count = 0
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current || typeof current !== 'object') continue
    count += 1
    if (count > OTIO_LIMITS.objectNodes) invalid('OTIO object-node limit exceeded')
    if (Array.isArray(current)) {
      stack.push(...current)
      continue
    }
    const node = current as Record<string, unknown>
    callback(node)
    stack.push(...Object.values(node))
  }
}

export function parseDocument(value: unknown): Record<string, unknown> {
  const parsed = value instanceof Uint8Array || typeof value === 'string'
    ? JSON.parse(Buffer.from(value).toString('utf8')) as unknown
    : value
  const document = record(parsed, 'OTIO document')
  if (document.OTIO_SCHEMA !== 'SerializableCollection.1') invalid('OTIO root must be SerializableCollection.1')
  if (!Array.isArray(document.children)) invalid('OTIO collection children must be an array')
  return document
}
