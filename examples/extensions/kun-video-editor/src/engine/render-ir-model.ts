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

export const RENDER_IR_SCHEMA_VERSION = 1 as const

export const RENDER_IR_LIMITS = Object.freeze({
  sources: 100,
  layers: 500,
  textLayers: 500,
  effectsPerLayer: 16,
  keyframeTracksPerLayer: 32,
  keyframesPerTrack: 256,
  wordsPerTextLayer: 512,
  unsupportedNodes: 64,
  canonicalBytes: 512 * 1024
})

export type RenderFrameRange = {
  startFrame: number
  endFrame: number
}

export type RenderSourceReference = {
  kind: 'media-handle' | 'workspace-file'
  reference: string
}

export type RenderIrSource = {
  id: string
  assetId: string
  reference: RenderSourceReference
  durationUs: number
  container: string
  video?: {
    codec: string
    width: number
    height: number
    frameRate: Rational
    rotation: 0 | 90 | 180 | 270
  }
  audio?: {
    codec: string
    sampleRate: number
    channels: number
  }
  still?: {
    width: number
    height: number
    format: string
    animated: boolean
    frameRate?: Rational
    loop: boolean
  }
}

export type RenderIrEffect = {
  id: string
  type: string
  enabled: boolean
  parameters: Record<string, number | string | boolean>
}

export type RenderIrKeyframeTrack = {
  id: string
  property: string
  interpolation: 'hold' | 'linear' | 'ease'
  points: Array<{ id: string; frame: number; value: number }>
}

export type RenderIrMediaLayer = {
  id: string
  kind: 'media'
  trackId: string
  trackOrder: number
  itemOrder: number
  source: { kind: 'asset'; sourceId: string } | { kind: 'sequence'; sequenceId: string }
  timeline: RenderFrameRange
  sourceMap: {
    startUs: number
    endUs: number
    speed: Rational
  }
  visual: {
    fit: VideoProject['canvas']['fit']
    transform: TimelineItem['transform']
    crop: { left: number; top: number; right: number; bottom: number }
    opacity: number
    fadeInFrames: number
    fadeOutFrames: number
    blendMode: BlendMode
  }
  audio: {
    enabled: boolean
    volume: number
    fadeInFrames: number
    fadeOutFrames: number
  }
  effects: RenderIrEffect[]
  keyframes: RenderIrKeyframeTrack[]
}

export type RenderIrTextLayer = {
  id: string
  kind: 'text'
  trackId: string
  trackOrder: number
  timeline: RenderFrameRange
  text: string
  placement: Caption['placement']
  style: {
    fontFamily: string
    fontSize: number
    color: string
    background: string
    fontWeight?: number
    maxWidthRatio?: number
  }
  words: Array<{
    id: string
    text: string
    startFrame: number
    endFrame: number
    sourceWordId?: string
  }>
  animation: {
    kind: 'none' | 'word-highlight' | 'fade'
    durationFrames: number
  }
}

export type CanonicalRenderIr = {
  schemaVersion: typeof RENDER_IR_SCHEMA_VERSION
  projectId: string
  sequenceId: string
  revision: number
  fps: Rational
  range: RenderFrameRange
  canvas: {
    width: number
    height: number
    background: string
    colorSpace: 'bt709'
    colorRange: 'tv'
    pixelAspectRatio: Rational
  }
  textPolicy: 'none' | 'burned' | 'sidecar' | 'both'
  sources: RenderIrSource[]
  layers: RenderIrMediaLayer[]
  textLayers: RenderIrTextLayer[]
  audioMix: {
    normalize: false
    sampleRate: number
    channels: number
  }
}

export type RenderIrCompileOptions = {
  range?: RenderFrameRange
  textPolicy?: CanonicalRenderIr['textPolicy']
}

export type RenderTarget =
  | 'proof-frame'
  | 'preview'
  | 'h264-mp4'
  | 'h265-mp4'
  | 'prores-mov'
  | 'ffv1-mkv'
  | 'audio-aac'
  | 'subtitles'

export type RenderBackendCapabilities = {
  id: string
  version: string
  codecs: string[]
  filters: string[]
  effects: string[]
  colorSpaces: string[]
  fonts: string[]
  maxSources: number
  maxLayers: number
  maxTextLayers: number
  hardwareAcceleration: 'none' | 'optional' | 'required'
}

export type UnsupportedRenderNode = {
  nodeId: string
  nodeType: 'backend' | 'canvas' | 'source' | 'layer' | 'text' | 'effect' | 'limit'
  capability: string
  message: string
  guidance: string
}

export type RenderCapabilityReport = {
  supported: boolean
  target: RenderTarget
  backendId: string
  backendVersion: string
  capabilitiesDigest: string
  hardwareAcceleration: RenderBackendCapabilities['hardwareAcceleration']
  unsupported: UnsupportedRenderNode[]
}

export type InteractivePlaybackDecision = {
  mode: 'source-fast-path' | 'composed-proof'
  irDigest: string
  projectId: string
  sequenceId: string
  revision: number
  sourceId?: string
  layerId?: string
  reasons: string[]
}
