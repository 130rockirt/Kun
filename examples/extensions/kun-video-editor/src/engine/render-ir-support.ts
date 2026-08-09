import { createHash } from 'node:crypto'
import { engineError } from './errors.js'
import {
  activeSequence,
  type BlendMode,
  type Sequence,
  type Caption,
  type MediaAsset,
  type Rational,
  type TimelineItem,
  type VideoProject
} from './schema.js'
/*
 * Keep all Render IR contracts in this module rather than widening the durable
 * project schema with backend-specific state. The compiler consumes the
 * active sequence through the schema-owned accessor.
 */
import type {
  EffectInstance,
  KeyframeTrack
} from './schema.js'
import { containsNullOrLineBreak } from '../text-safety.js'
import {
  RENDER_IR_LIMITS,
  type CanonicalRenderIr,
  type RenderBackendCapabilities,
  type RenderFrameRange,
  type RenderIrMediaLayer,
  type RenderIrSource,
  type RenderIrTextLayer,
  type RenderSourceReference,
  type UnsupportedRenderNode
} from './render-ir-model.js'

export type SequenceProjection = Pick<Sequence, 'id' | 'tracks' | 'items' | 'captions'>

export type ExtendedTimelineItem = TimelineItem & {
  effects?: EffectInstance[]
  keyframes?: KeyframeTrack[]
}

export function defaultFfmpegCapabilities(): RenderBackendCapabilities {
  return {
    id: 'ffmpeg',
    version: 'negotiated',
    codecs: ['aac', 'ffv1', 'h264', 'h265', 'png', 'prores'],
    filters: [
      'audio-fade', 'audio-mix', 'color-source', 'concat', 'crop',
      'drawtext', 'fade', 'opacity', 'overlay', 'pad', 'rotate', 'scale'
    ],
    effects: [],
    colorSpaces: ['bt709'],
    fonts: ['sans-serif'],
    maxSources: RENDER_IR_LIMITS.sources,
    maxLayers: RENDER_IR_LIMITS.layers,
    maxTextLayers: RENDER_IR_LIMITS.textLayers,
    hardwareAcceleration: 'optional'
  }
}

export function activeSequenceProjection(project: VideoProject): SequenceProjection {
  return activeSequence(project)
}

export function sequenceDurationFrames(sequence: SequenceProjection): number {
  return Math.max(
    0,
    ...sequence.items.map((item) => item.timelineStartFrame + item.durationFrames),
    ...sequence.captions.map((caption) => caption.endFrame)
  )
}

export function renderSource(asset: MediaAsset): RenderIrSource {
  const reference = asset.mediaHandleId
    ? { kind: 'media-handle' as const, reference: asset.mediaHandleId }
    : asset.workspaceRelativePath
      ? { kind: 'workspace-file' as const, reference: asset.workspaceRelativePath }
      : undefined
  if (!reference) throw engineError('render_unsupported', `Asset ${asset.id} has no durable media reference`)
  return {
    id: asset.id,
    assetId: asset.id,
    reference,
    durationUs: asset.durationUs,
    container: asset.container,
    ...(asset.video ? {
      video: {
        ...structuredClone(asset.video),
        rotation: asset.video.rotation ?? 0
      }
    } : {}),
    ...(asset.audio ? { audio: structuredClone(asset.audio) } : {}),
    ...(asset.still ? {
      still: {
        ...structuredClone(asset.still),
        loop: asset.still.loop ?? false
      }
    } : {})
  }
}

export function renderLayer(
  project: VideoProject,
  item: ExtendedTimelineItem,
  trackOrder: number,
  itemOrder: number,
  sourceIds: ReadonlySet<string>
): RenderIrMediaLayer {
  const nestedSequenceId = item.nestedSequenceId
  if (nestedSequenceId && !project.sequences.some(({ id }) => id === nestedSequenceId)) {
    throw engineError('invalid_project', `Timeline item ${item.id} refers to missing sequence ${nestedSequenceId}`)
  }
  if (!nestedSequenceId && !sourceIds.has(item.assetId)) {
    throw engineError('invalid_project', `Timeline item ${item.id} refers to missing asset ${item.assetId}`)
  }
  const crop = item.crop ?? { left: 0, top: 0, right: 0, bottom: 0 }
  const effects = (item.effects ?? []).map((effect) => ({
    id: effect.id,
    type: effect.type,
    enabled: effect.enabled,
    parameters: Object.fromEntries(Object.entries(effect.parameters).sort(([left], [right]) => left.localeCompare(right)))
  }))
  const keyframes = (item.keyframes ?? []).map((track) => ({
    id: track.id,
    property: track.property,
    interpolation: track.interpolation,
    points: [...track.points].sort((left, right) => left.frame - right.frame || left.id.localeCompare(right.id))
  }))
  return {
    id: item.id,
    kind: 'media',
    trackId: item.trackId,
    trackOrder,
    itemOrder,
    source: nestedSequenceId
      ? { kind: 'sequence', sequenceId: nestedSequenceId }
      : { kind: 'asset', sourceId: item.assetId },
    timeline: itemRange(item),
    sourceMap: {
      startUs: item.sourceStartUs,
      endUs: item.sourceEndUs,
      speed: structuredClone(item.speed)
    },
    visual: {
      fit: project.canvas.fit,
      transform: structuredClone(item.transform),
      crop: structuredClone(crop),
      opacity: item.visible === false ? 0 : item.opacity,
      fadeInFrames: item.fadeInFrames,
      fadeOutFrames: item.fadeOutFrames,
      blendMode: item.blendMode ?? 'normal'
    },
    audio: {
      enabled: !(project.tracks.find(({ id }) => id === item.trackId)?.muted ?? false) && item.muted !== true,
      volume: item.volume ?? 1,
      fadeInFrames: item.fadeInFrames,
      fadeOutFrames: item.fadeOutFrames
    },
    effects,
    keyframes
  }
}

export function renderTextLayer(project: VideoProject, caption: Caption, trackOrder: number): RenderIrTextLayer {
  const words = (caption.words ?? []).map((word) => structuredClone(word))
  if (words.length > RENDER_IR_LIMITS.wordsPerTextLayer) {
    throw engineError('render_unsupported', `Text layer ${caption.id} exceeds the ${RENDER_IR_LIMITS.wordsPerTextLayer} word limit`)
  }
  return {
    id: caption.id,
    kind: 'text',
    trackId: caption.trackId,
    trackOrder,
    timeline: { startFrame: caption.startFrame, endFrame: caption.endFrame },
    text: caption.text,
    placement: caption.placement,
    style: {
      fontFamily: caption.style?.fontFamily ?? 'sans-serif',
      fontSize: caption.style?.fontSize ?? Math.max(18, Math.min(96, Math.round(project.canvas.height / 24))),
      color: caption.style?.color ?? '#FFFFFF',
      background: caption.style?.background ?? '#000000',
      ...(caption.style?.fontWeight === undefined ? {} : { fontWeight: caption.style.fontWeight }),
      ...(caption.style?.maxWidthRatio === undefined ? {} : { maxWidthRatio: caption.style.maxWidthRatio })
    },
    words,
    animation: {
      kind: caption.animation?.kind ?? 'none',
      durationFrames: caption.animation?.durationFrames ?? 0
    }
  }
}

export function itemRange(item: TimelineItem): RenderFrameRange {
  return {
    startFrame: item.timelineStartFrame,
    endFrame: item.timelineStartFrame + item.durationFrames
  }
}

export function intersects(left: RenderFrameRange, right: RenderFrameRange): boolean {
  return left.startFrame < right.endFrame && right.startFrame < left.endFrame
}

export function validateFrameRange(range: RenderFrameRange, maximum?: number): void {
  nonNegativeInteger(range.startFrame, 'range.startFrame')
  positiveInteger(range.endFrame, 'range.endFrame')
  if (range.endFrame <= range.startFrame) invalid('Render range must be non-empty')
  if (maximum !== undefined && range.endFrame > maximum) invalid('Render range exceeds the composed sequence')
}

export function validateReference(reference: RenderSourceReference): void {
  if (reference.kind !== 'media-handle' && reference.kind !== 'workspace-file') invalid('Unsupported source reference kind')
  boundedString(reference.reference, 'source reference', 512)
  if (containsNullOrLineBreak(reference.reference)) invalid('Source reference contains control characters')
}

export function validateBackendCapabilities(capabilities: RenderBackendCapabilities): void {
  boundedString(capabilities.id, 'backend id', 128)
  boundedString(capabilities.version, 'backend version', 128)
  for (const [name, values] of Object.entries({
    codecs: capabilities.codecs,
    filters: capabilities.filters,
    effects: capabilities.effects,
    colorSpaces: capabilities.colorSpaces,
    fonts: capabilities.fonts
  })) {
    if (!Array.isArray(values) || values.length > 512) invalid(`Backend ${name} catalog is invalid`)
    values.forEach((value) => boundedString(value, `backend ${name}`, 128))
  }
  positiveInteger(capabilities.maxSources, 'backend maxSources')
  positiveInteger(capabilities.maxLayers, 'backend maxLayers')
  positiveInteger(capabilities.maxTextLayers, 'backend maxTextLayers')
  if (!['none', 'optional', 'required'].includes(capabilities.hardwareAcceleration)) {
    invalid('Backend hardwareAcceleration declaration is invalid')
  }
}

export function normalizeCapabilities(capabilities: RenderBackendCapabilities): RenderBackendCapabilities {
  const sorted = (values: string[]): string[] => [...new Set(values)].sort()
  return {
    ...capabilities,
    codecs: sorted(capabilities.codecs),
    filters: sorted(capabilities.filters),
    effects: sorted(capabilities.effects),
    colorSpaces: sorted(capabilities.colorSpaces),
    fonts: sorted(capabilities.fonts)
  }
}

export function issue(
  nodeId: string,
  nodeType: UnsupportedRenderNode['nodeType'],
  capability: string,
  message: string,
  guidance: string
): UnsupportedRenderNode {
  return { nodeId, nodeType, capability, message, guidance }
}

export function layerIssue(layerId: string, capability: string, label: string): UnsupportedRenderNode {
  return issue(
    layerId,
    'layer',
    capability,
    `Layer ${layerId} requires ${label}, which the selected backend does not advertise.`,
    `Remove ${label}, bake the layer to a proxy, or select a compatible backend.`
  )
}

export function identityTransform(transform: TimelineItem['transform']): boolean {
  return transform.x === 0 && transform.y === 0 && transform.scaleX === 1 &&
    transform.scaleY === 1 && transform.rotation === 0
}

export function sameRational(left: Rational, right: Rational): boolean {
  return left.numerator * right.denominator === right.numerator * left.denominator
}

export function requiresOverlayFilter(ir: CanonicalRenderIr): boolean {
  if ((ir.textPolicy === 'burned' || ir.textPolicy === 'both') && ir.textLayers.length > 0) return true
  const visualLayers = ir.layers.filter((layer) => {
    if (layer.source.kind === 'sequence') return true
    const sourceId = layer.source.sourceId
    const source = ir.sources.find(({ id }) => id === sourceId)
    return source?.video !== undefined || source?.still !== undefined
  })
  if (visualLayers.length === 0) return false
  const trackId = visualLayers[0]!.trackId
  let cursor = ir.range.startFrame
  for (const layer of visualLayers) {
    if (
      layer.trackId !== trackId ||
      layer.timeline.startFrame !== cursor ||
      !identityTransform(layer.visual.transform) ||
      Object.values(layer.visual.crop).some((value) => value !== 0) ||
      layer.visual.opacity !== 1 ||
      layer.visual.blendMode !== 'normal' ||
      layer.visual.fadeInFrames !== 0 ||
      layer.visual.fadeOutFrames !== 0 ||
      layer.effects.some(({ enabled }) => enabled) ||
      layer.keyframes.length > 0
    ) return true
    cursor = layer.timeline.endFrame
  }
  return cursor !== ir.range.endFrame
}

export function assertCanonicalOrder(ir: CanonicalRenderIr): void {
  assertOrdered(ir.sources, (left, right) => left.id.localeCompare(right.id), 'sources')
  assertOrdered(ir.layers, (left, right) =>
    left.trackOrder - right.trackOrder ||
    left.trackId.localeCompare(right.trackId) ||
    left.timeline.startFrame - right.timeline.startFrame ||
    left.id.localeCompare(right.id), 'layers')
  assertOrdered(ir.textLayers, (left, right) =>
    left.trackOrder - right.trackOrder ||
    left.timeline.startFrame - right.timeline.startFrame ||
    left.id.localeCompare(right.id), 'textLayers')
}

export function assertOrdered<T>(values: readonly T[], compare: (left: T, right: T) => number, label: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (compare(values[index - 1]!, values[index]!) > 0) invalid(`Render IR ${label} are not in canonical order`)
  }
}

export function validateColor(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^#[0-9A-Fa-f]{6}$/u.test(value)) invalid(`${label} must be a six-digit hexadecimal color`)
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

export function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]))
  }
  return value
}

export function boundedId(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,191}$/u.test(value) ||
    value === '.' || value === '..'
  ) {
    invalid(`${label} must be a bounded identifier`)
  }
}

export function boundedString(value: unknown, label: string, maximum: number): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || value.includes('\0')) {
    invalid(`${label} must be a bounded string`)
  }
}

export function nonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalid(`${label} must be a non-negative integer`)
}

export function positiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) invalid(`${label} must be a positive integer`)
}

export function finiteBetween(value: unknown, minimum: number, maximum: number, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    invalid(`${label} must be between ${minimum} and ${maximum}`)
  }
}

export function finite(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`${label} must be finite`)
}

export function invalid(message: string): never {
  throw engineError('render_unsupported', message)
}
