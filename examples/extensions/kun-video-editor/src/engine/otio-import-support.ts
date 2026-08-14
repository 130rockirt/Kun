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
  OTIO_ADAPTER_ID,
  OTIO_ADAPTER_VERSION,
  type OtioInterchangeImport,
  type OtioTimecodeMapping
} from './otio-interchange.js'
import { addMapping } from './otio-export-support.js'
import {
  addLoss,
  invalid,
  lossCollector,
  lossManifest,
  metadataLoss,
  optionalRecord,
  record,
  stringValue,
  type LossCollector
} from './otio-validation-support.js'

export function importPortableOtio(
  document: Record<string, unknown>,
  documentDigest: string
): OtioInterchangeImport {
  const timelines = arrayValue(document.children, 'OTIO collection children')
    .map((value, index) => record(value, `OTIO timeline ${index}`))
  if (timelines.length === 0 || timelines.some(({ OTIO_SCHEMA }) => OTIO_SCHEMA !== 'Timeline.1')) {
    invalid('Portable OTIO import requires at least one Timeline.1 child')
  }
  const fps = portableFrameRate(timelines[0]!)
  const assets = new Map<string, VideoProject['assets'][number]>()
  const loss = lossCollector()
  addLoss(loss, metadataLoss(
    'portable-import-default-canvas', 'canvas', 'canvas',
    'OTIO does not define a project canvas; import uses a 1920x1080 BT.709-compatible default.'
  ))
  addLoss(loss, metadataLoss(
    'portable-import-no-kun-snapshot', 'project-metadata', 'project',
    'This OTIO document has no Kun round-trip snapshot; only the bounded portable timeline subset is imported.'
  ))
  const sequences = timelines.map((timeline, sequenceIndex) =>
    portableSequence(timeline, sequenceIndex, fps, assets, loss))
  const projectId = `otio-${documentDigest.slice(0, 24)}`
  const active = sequences[0]!
  const timestamp = '1970-01-01T00:00:00.000Z'
  const project: VideoProject = {
    schemaVersion: 2,
    id: projectId,
    name: safeOtioName(document.name, 'Imported OTIO project'),
    createdAt: timestamp,
    updatedAt: timestamp,
    fps,
    canvas: {
      preset: '16:9', width: 1_920, height: 1_080, fit: 'fit', background: '#000000'
    },
    assets: [...assets.values()].sort((left, right) => left.id.localeCompare(right.id)),
    tracks: structuredClone(active.tracks),
    items: structuredClone(active.items),
    captions: structuredClone(active.captions),
    sequences,
    activeSequenceId: active.id,
    linkGroups: [],
    selection: {
      generation: 0,
      revision: 0,
      sequenceId: active.id,
      playheadFrame: 0,
      selectedAssetIds: [],
      selectedItemIds: [],
      selectedCaptionIds: [],
      selectedWordIds: []
    },
    transcripts: [],
    derivedReferences: [],
    currentRevision: 0,
    eventGeneration: 0,
    revisions: [{
      revision: 0,
      parentRevision: null,
      author: 'system',
      sourceOperation: 'interchange.otio.import',
      timestamp,
      summary: 'Imported bounded portable OTIO timeline',
      operations: [],
      inverseOperations: []
    }],
    undoStack: [],
    redoStack: [],
    agentUndoStack: [],
    recovery: {
      mode: 'healthy',
      unreadableManifestKinds: [],
      interruptedJobIds: [],
      notes: ['Media references require Host-authorized relink after OTIO import.']
    }
  }
  const validated = validateProjectRoundTrip(project)
  const mappings: OtioTimecodeMapping[] = []
  for (const sequence of validated.sequences) {
    for (const item of sequence.items) {
      addMapping(
        mappings, fps, sequence.id, item.id,
        item.timelineStartFrame, item.timelineStartFrame + item.durationFrames
      )
    }
    for (const caption of sequence.captions) {
      addMapping(mappings, fps, sequence.id, caption.id, caption.startFrame, caption.endFrame)
    }
  }
  return {
    adapterId: OTIO_ADAPTER_ID,
    adapterVersion: OTIO_ADAPTER_VERSION,
    project: validated,
    sourceDocumentDigest: documentDigest,
    fidelity: 'portable-otio',
    mediaRelinkRequired: validated.assets.map(({ id }) => id).sort(),
    timecodeMappings: mappings,
    lossManifest: lossManifest(loss, false)
  }
}

export function portableSequence(
  timeline: Record<string, unknown>,
  sequenceIndex: number,
  fps: Rational,
  assets: Map<string, VideoProject['assets'][number]>,
  loss: LossCollector
): Sequence {
  const timelineMetadata = optionalRecord(optionalRecord(timeline.metadata)?.kun)
  const sequenceId = optionalOtioId(timelineMetadata?.id) ?? `sequence-${sequenceIndex + 1}`
  const stack = record(timeline.tracks, `OTIO timeline ${sequenceIndex} tracks`)
  if (stack.OTIO_SCHEMA !== 'Stack.1') invalid(`OTIO timeline ${sequenceIndex} tracks must be Stack.1`)
  const tracks: Track[] = []
  const items: TimelineItem[] = []
  const captions: Caption[] = []
  for (const [trackIndex, rawTrack] of arrayValue(stack.children, 'OTIO stack children').entries()) {
    const trackNode = record(rawTrack, `OTIO track ${trackIndex}`)
    if (trackNode.OTIO_SCHEMA !== 'Track.1') invalid(`OTIO track ${trackIndex} must be Track.1`)
    const metadata = optionalRecord(optionalRecord(trackNode.metadata)?.kun)
    const declaredKind = metadata?.kind
    const kind: Track['kind'] = declaredKind === 'caption'
      ? 'caption'
      : trackNode.kind === 'Audio'
        ? 'audio'
        : 'video'
    const trackId = optionalOtioId(metadata?.id) ?? `${sequenceId}.track-${trackIndex + 1}`
    tracks.push({
      id: trackId,
      name: safeOtioName(trackNode.name, kind === 'audio' ? 'Audio' : kind === 'caption' ? 'Captions' : 'Video'),
      kind,
      order: trackIndex,
      overlap: kind === 'audio' ? 'mix' : 'reject',
      ...(metadata?.muted === true ? { muted: true } : {}),
      ...(metadata?.locked === true ? { locked: true } : {})
    })
    let cursor = 0
    for (const [childIndex, rawChild] of arrayValue(trackNode.children, `OTIO track ${trackIndex} children`).entries()) {
      const child = record(rawChild, `OTIO track ${trackIndex} child ${childIndex}`)
      const durationFrames = otioRangeDuration(child.source_range, fps)
      if (child.OTIO_SCHEMA === 'Gap.1') {
        cursor += durationFrames
        continue
      }
      if (child.OTIO_SCHEMA !== 'Clip.2') invalid('Portable OTIO tracks support only Clip.2 and Gap.1 children')
      const childMetadata = optionalRecord(optionalRecord(child.metadata)?.kun)
      const timelineStartFrame = nonNegativeOtioInteger(childMetadata?.timelineStartFrame) ?? cursor
      const stableId = optionalOtioId(childMetadata?.id) ?? `${trackId}.clip-${childIndex + 1}`
      if (kind === 'caption' && optionalRecord(childMetadata?.caption)) {
        const captionValue = structuredClone(childMetadata!.caption) as Caption
        captionValue.id = stableId
        captionValue.trackId = trackId
        captionValue.startFrame = timelineStartFrame
        captionValue.endFrame = timelineStartFrame + durationFrames
        captions.push(captionValue)
      } else {
        items.push(portableClip(
          child, childMetadata, stableId, trackId, timelineStartFrame,
          durationFrames, kind, fps, assets, loss
        ))
      }
      cursor = Math.max(cursor, timelineStartFrame + durationFrames)
    }
  }
  if (tracks.length === 0) invalid(`Portable OTIO sequence ${sequenceId} has no tracks`)
  return {
    id: sequenceId,
    name: safeOtioName(timeline.name, `Sequence ${sequenceIndex + 1}`),
    tracks,
    items,
    captions,
    viewState: { zoom: 1, scrollFrame: 0, open: sequenceIndex === 0 }
  }
}

export function portableClip(
  clip: Record<string, unknown>,
  metadata: Record<string, unknown> | undefined,
  itemId: string,
  trackId: string,
  timelineStartFrame: number,
  durationFrames: number,
  trackKind: Track['kind'],
  fps: Rational,
  assets: Map<string, VideoProject['assets'][number]>,
  loss: LossCollector
): TimelineItem {
  const reference = record(clip.media_reference, `OTIO clip ${itemId} media_reference`)
  if (reference.OTIO_SCHEMA !== 'ExternalReference.1') {
    invalid(`Portable OTIO clip ${itemId} requires an ExternalReference.1`)
  }
  const target = stringValue(reference.target_url, `OTIO clip ${itemId} target_url`, 512)
  const assetId = decodeURIComponent(target.slice('kun-media://'.length))
  if (!optionalOtioId(assetId)) invalid(`OTIO clip ${itemId} media ID is invalid`)
  const sourceRange = record(clip.source_range, `OTIO clip ${itemId} source_range`)
  const sourceStartFrame = otioRationalFrame(sourceRange.start_time, fps)
  const sourceDurationFrames = Math.max(1, otioRationalFrame(sourceRange.duration, fps))
  const sourceStartUs = framesToMicroseconds(sourceStartFrame, fps)
  const sourceEndUs = framesToMicroseconds(sourceStartFrame + sourceDurationFrames, fps)
  const availableDuration = reference.available_range
    ? Math.max(1, otioRangeDuration(reference.available_range, fps))
    : sourceStartFrame + sourceDurationFrames
  const durationUs = framesToMicroseconds(availableDuration, fps)
  const existing = assets.get(assetId)
  if (existing) existing.durationUs = Math.max(existing.durationUs, durationUs)
  else {
    assets.set(assetId, {
      id: assetId,
      name: safeOtioName(reference.name ?? clip.name, assetId),
      kind: trackKind === 'audio' ? 'audio' : 'video',
      mediaHandleId: `otio_offline_${assetId}`,
      durationUs,
      container: 'unknown',
      transcriptIds: [],
      availability: 'offline',
      recovery: { reason: 'missing' }
    })
    addLoss(loss, metadataLoss(
      'portable-media-relink-required', 'media-reference', assetId,
      `Media ${assetId} remains offline until the Host authorizes a relink.`
    ))
  }
  const effects = portableEffects(clip.effects, itemId, loss)
  const speed = portableSpeed(clip.effects)
  return {
    id: itemId,
    assetId,
    trackId,
    timelineStartFrame,
    durationFrames,
    sourceStartUs,
    sourceEndUs,
    speed,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    opacity: 1,
    fadeInFrames: 0,
    fadeOutFrames: 0,
    ...(effects.length > 0 ? { effects } : {}),
    ...(Array.isArray(metadata?.keyframes) ? { keyframes: structuredClone(metadata.keyframes) as KeyframeTrack[] } : {})
  }
}

export function portableEffects(value: unknown, itemId: string, loss: LossCollector): EffectInstance[] {
  if (value === undefined) return []
  const effects: EffectInstance[] = []
  for (const [index, raw] of arrayValue(value, `OTIO clip ${itemId} effects`).entries()) {
    const effect = record(raw, `OTIO clip ${itemId} effect ${index}`)
    if (effect.OTIO_SCHEMA === 'LinearTimeWarp.1') continue
    if (effect.OTIO_SCHEMA !== 'Effect.1') {
      addLoss(loss, metadataLoss(
        'portable-effect-unsupported', 'effects', `${itemId}.effect-${index + 1}`,
        `Unsupported OTIO effect schema ${String(effect.OTIO_SCHEMA)} was omitted.`
      ))
      continue
    }
    const kun = optionalRecord(optionalRecord(effect.metadata)?.kun)
    const full = kun && typeof kun.type === 'string' && optionalRecord(kun.parameters)
      ? kun as unknown as EffectInstance
      : undefined
    effects.push(full ? structuredClone(full) : {
      id: optionalOtioId(kun?.id) ?? `${itemId}.effect-${index + 1}`,
      type: safeOtioName(effect.effect_name ?? effect.name, 'otio.effect'),
      enabled: true,
      parameters: {}
    })
    addLoss(loss, metadataLoss(
      'portable-effect-parameters', 'effects', effects.at(-1)!.id,
      'Portable OTIO effect parameters may require manual review after import.'
    ))
  }
  return effects
}

export function portableSpeed(value: unknown): Rational {
  if (!Array.isArray(value)) return { numerator: 1, denominator: 1 }
  const warp = value
    .map((entry) => optionalRecord(entry))
    .find((entry) => entry?.OTIO_SCHEMA === 'LinearTimeWarp.1')
  if (!warp || typeof warp.time_scalar !== 'number' || !Number.isFinite(warp.time_scalar) || warp.time_scalar <= 0) {
    return { numerator: 1, denominator: 1 }
  }
  const denominator = 1_000_000
  const numerator = Math.max(1, Math.round(warp.time_scalar * denominator))
  const divisor = gcd(numerator, denominator)
  return { numerator: numerator / divisor, denominator: denominator / divisor }
}

export function portableFrameRate(timeline: Record<string, unknown>): Rational {
  const global = optionalRecord(timeline.global_start_time)
  if (global && typeof global.rate === 'number') return rateRational(global.rate)
  return { numerator: 30, denominator: 1 }
}

export function rateRational(rate: number): Rational {
  if (!Number.isFinite(rate) || rate <= 0 || rate > 240) invalid('OTIO frame rate is invalid')
  const common: Array<[number, Rational]> = [
    [23.976, { numerator: 24_000, denominator: 1_001 }],
    [29.97, { numerator: 30_000, denominator: 1_001 }],
    [59.94, { numerator: 60_000, denominator: 1_001 }]
  ]
  const matched = common.find(([candidate]) => Math.abs(candidate - rate) < 0.001)
  if (matched) return matched[1]
  if (Number.isInteger(rate)) return { numerator: rate, denominator: 1 }
  const denominator = 1_000_000
  const numerator = Math.round(rate * denominator)
  const divisor = gcd(numerator, denominator)
  return { numerator: numerator / divisor, denominator: denominator / divisor }
}

export function otioRangeDuration(value: unknown, fps: Rational): number {
  return Math.max(1, otioRationalFrame(record(value, 'OTIO time range').duration, fps))
}

export function otioRationalFrame(value: unknown, targetFps: Rational): number {
  const time = record(value, 'OTIO RationalTime')
  if (time.OTIO_SCHEMA !== 'RationalTime.1') invalid('OTIO time value must be RationalTime.1')
  if (typeof time.value !== 'number' || !Number.isSafeInteger(time.value) || time.value < 0) {
    invalid('OTIO RationalTime value must be a non-negative integer frame')
  }
  if (typeof time.rate !== 'number') invalid('OTIO RationalTime rate is missing')
  return rescaleFrames(time.value, rateRational(time.rate), targetFps, 'nearest')
}

export function optionalOtioId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._~-]{0,191}$/u.test(value)
    ? value
    : undefined
}

export function nonNegativeOtioInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined
}

export function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array`)
  return value
}

export function safeOtioName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const safe = replaceNullOrLineBreaks(value, ' ').trim().slice(0, 255)
  return safe || fallback
}

export function gcd(left: number, right: number): number {
  let a = left
  let b = right
  while (b !== 0) {
    const remainder = a % b
    a = b
    b = remainder
  }
  return a
}
