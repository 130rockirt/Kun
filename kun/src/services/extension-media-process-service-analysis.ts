import { createHash } from 'node:crypto'
import { access, realpath, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { constants } from 'node:fs'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { terminateSpawnTree } from '../adapters/tool/builtin-tool-utils.js'
import type { ExtensionPrincipal } from './extension-agent-service.js'
import {
  ExtensionMediaHandleService,
  type ResolvedMediaHandle
} from './extension-media-handle-service.js'
import { BEAT_MAX_BPM, BEAT_MIN_BPM, BEAT_PCM_SAMPLE_RATE, BEAT_WINDOW_MICROS, type ExtensionBeatGridAnalysis, ExtensionMediaProcessError, type ExtensionSilenceAnalysis, SYNC_FEATURE_SAMPLE_RATE, VISUAL_FEATURE_DIMENSIONS, VISUAL_FRAME_HEIGHT, VISUAL_FRAME_WIDTH } from './extension-media-process-service-contracts.js'
import { boundedInteger } from './extension-media-process-service-probe-normalization.js'

/**
 * Deterministic, interpretable 24-dimensional RGB/luma/edge descriptor. This
 * is a measured pixel feature vector, not a synthetic semantic embedding.
 */
export function visualFeaturesFromRgb24(
  rgb: Buffer,
  width = VISUAL_FRAME_WIDTH,
  height = VISUAL_FRAME_HEIGHT
): number[] {
  if (
    !Number.isSafeInteger(width) || width < 2 || width > 512 ||
    !Number.isSafeInteger(height) || height < 2 || height > 512 ||
    rgb.byteLength !== width * height * 3
  ) {
    throw new ExtensionMediaProcessError(
      'invalid_analysis_output',
      'Decoded visual frame dimensions are invalid'
    )
  }
  const pixels = width * height
  const luma = new Float64Array(pixels)
  const histogram = [0, 0, 0, 0, 0]
  let red = 0
  let green = 0
  let blue = 0
  let saturation = 0
  let lumaTotal = 0
  let lumaSquares = 0
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const offset = pixel * 3
    const r = rgb[offset]! / 255
    const g = rgb[offset + 1]! / 255
    const b = rgb[offset + 2]! / 255
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    red += r
    green += g
    blue += b
    saturation += Math.max(r, g, b) - Math.min(r, g, b)
    lumaTotal += y
    lumaSquares += y * y
    luma[pixel] = y
    histogram[Math.min(4, Math.floor(y * 5))]! += 1
  }
  const meanRed = red / pixels
  const meanGreen = green / pixels
  const meanBlue = blue / pixels
  const brightness = lumaTotal / pixels
  const contrast = Math.min(1, Math.sqrt(Math.max(0, lumaSquares / pixels - brightness * brightness)) * 2)
  const meanSaturation = saturation / pixels
  let horizontalDifference = 0
  let horizontalCount = 0
  let verticalDifference = 0
  let verticalCount = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      if (x > 0) {
        verticalDifference += Math.abs(luma[index]! - luma[index - 1]!)
        verticalCount += 1
      }
      if (y > 0) {
        horizontalDifference += Math.abs(luma[index]! - luma[index - width]!)
        horizontalCount += 1
      }
    }
  }
  const horizontalEdge = Math.min(1, horizontalDifference / Math.max(1, horizontalCount) * 3)
  const verticalEdge = Math.min(1, verticalDifference / Math.max(1, verticalCount) * 3)
  const edgeDensity = Math.min(1, (horizontalEdge + verticalEdge) / 2)
  const warmth = clamp01((meanRed - meanBlue + 1) / 2)
  const coolness = clamp01((meanBlue - meanRed + 1) / 2)
  const vector = [
    meanRed,
    meanGreen,
    meanBlue,
    brightness,
    1 - brightness,
    meanSaturation,
    1 - meanSaturation,
    contrast,
    1 - contrast,
    edgeDensity,
    1 - edgeDensity,
    warmth,
    coolness,
    clamp01(meanRed - Math.max(meanGreen, meanBlue) + 0.5),
    clamp01(meanGreen - Math.max(meanRed, meanBlue) + 0.5),
    clamp01(meanBlue - Math.max(meanRed, meanGreen) + 0.5),
    histogram[0]! / pixels,
    histogram[1]! / pixels,
    histogram[2]! / pixels,
    histogram[3]! / pixels,
    histogram[4]! / pixels,
    horizontalEdge,
    verticalEdge,
    0.25
  ]
  const magnitude = Math.sqrt(vector.reduce((total, value) => total + value * value, 0))
  if (!Number.isFinite(magnitude) || magnitude <= Number.EPSILON || vector.length !== VISUAL_FEATURE_DIMENSIONS) {
    throw new ExtensionMediaProcessError(
      'invalid_analysis_output',
      'Decoded visual frame did not produce valid measured features'
    )
  }
  return vector.map((value) => Number((value / magnitude).toFixed(8)))
}

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

export function parseSilenceIntervals(
  diagnostics: string,
  durationMicros: number,
  minimumSilenceMicros: number,
  maxIntervals: number
): {
  intervals: ExtensionSilenceAnalysis['intervals']
  truncated: boolean
} {
  let openStartMicros: number | undefined
  let truncated = false
  const intervals: ExtensionSilenceAnalysis['intervals'] = []
  const append = (startMicros: number, endMicros: number): void => {
    const start = Math.max(0, Math.min(durationMicros, startMicros))
    const end = Math.max(start, Math.min(durationMicros, endMicros))
    if (end - start < minimumSilenceMicros) return
    if (intervals.length >= maxIntervals) {
      truncated = true
      return
    }
    intervals.push({
      startMicros: start,
      endMicros: end,
      confidence: 1,
      confidenceSemantics: 'threshold-classification'
    })
  }
  for (const line of diagnostics.split(/\r?\n/u)) {
    const start = /silence_start:\s*(-?\d+(?:\.\d+)?)/u.exec(line)
    if (start) {
      const seconds = Number(start[1])
      if (Number.isFinite(seconds)) openStartMicros = Math.round(seconds * 1_000_000)
      continue
    }
    const end = /silence_end:\s*(-?\d+(?:\.\d+)?)/u.exec(line)
    if (end && openStartMicros !== undefined) {
      const seconds = Number(end[1])
      if (Number.isFinite(seconds)) append(openStartMicros, Math.round(seconds * 1_000_000))
      openStartMicros = undefined
    }
  }
  if (openStartMicros !== undefined) append(openStartMicros, durationMicros)
  return { intervals, truncated }
}

export function syncPcmByteLimit(durationMicros: number): number {
  return Math.min(
    2 * 1024 * 1024,
    Math.max(4_096, Math.ceil(durationMicros * SYNC_FEATURE_SAMPLE_RATE * 2 / 1_000_000) + 4_096)
  )
}

export function beatPcmByteLimit(durationMicros: number): number {
  return Math.min(
    2 * 1024 * 1024,
    Math.max(4_096, Math.ceil(durationMicros * BEAT_PCM_SAMPLE_RATE * 2 / 1_000_000) + 4_096)
  )
}

export type DetectedBeatGrid = Omit<ExtensionBeatGridAnalysis, 'source'>

/** Pure deterministic detector used by the Host boundary and fixture tests. */
export function detectBeatGridFromPcm(pcm: Buffer, maxMarkers: number): DetectedBeatGrid {
  const boundedMarkers = boundedInteger(maxMarkers, 2_000, 1, 4_096)
  const sampleCount = Math.floor(pcm.byteLength / 2)
  const samplesPerWindow = Math.max(
    1,
    Math.round(BEAT_PCM_SAMPLE_RATE * BEAT_WINDOW_MICROS / 1_000_000)
  )
  const windowCount = Math.floor(sampleCount / samplesPerWindow)
  const analyzedDurationMicros = Math.floor(sampleCount * 1_000_000 / BEAT_PCM_SAMPLE_RATE)
  if (windowCount < 40) {
    return { markers: [], analyzedDurationMicros, truncated: false }
  }

  const energy: number[] = []
  for (let window = 0; window < windowCount; window += 1) {
    let sumSquares = 0
    const start = window * samplesPerWindow
    for (let sample = start; sample < start + samplesPerWindow; sample += 1) {
      const normalized = pcm.readInt16LE(sample * 2) / 32_768
      sumSquares += normalized * normalized
    }
    energy.push(Math.sqrt(sumSquares / samplesPerWindow))
  }
  const positiveFlux = energy.map((value, index) =>
    index === 0 ? 0 : Math.max(0, value - energy[index - 1]!))
  const onset = positiveFlux.map((value, index) => {
    const start = Math.max(0, index - 8)
    const end = Math.min(positiveFlux.length, index + 9)
    let local = 0
    for (let candidate = start; candidate < end; candidate += 1) local += positiveFlux[candidate]!
    const baseline = local / Math.max(1, end - start)
    return Math.max(0, value - baseline * 1.15)
  })
  const maximumOnset = onset.reduce((maximum, value) => Math.max(maximum, value), 0)
  if (maximumOnset <= 1e-6) {
    return { markers: [], analyzedDurationMicros, truncated: false }
  }
  const normalized = onset.map((value) => value / maximumOnset)
  const energeticOnsets = normalized.filter((value) => value >= 0.35).length
  if (energeticOnsets < 4) {
    return { markers: [], analyzedDurationMicros, truncated: false }
  }

  const minimumLag = Math.max(2, Math.floor(60_000_000 / (BEAT_MAX_BPM * BEAT_WINDOW_MICROS)))
  const maximumLag = Math.min(
    normalized.length - 1,
    Math.ceil(60_000_000 / (BEAT_MIN_BPM * BEAT_WINDOW_MICROS))
  )
  let bestLag = 0
  let bestScore = 0
  let bestTempoDistance = Number.POSITIVE_INFINITY
  for (let lag = minimumLag; lag <= maximumLag; lag += 1) {
    let numerator = 0
    let leftEnergy = 0
    let rightEnergy = 0
    for (let index = lag; index < normalized.length; index += 1) {
      const left = normalized[index]!
      const right = normalized[index - lag]!
      numerator += left * right
      leftEnergy += left * left
      rightEnergy += right * right
    }
    const score = leftEnergy <= Number.EPSILON || rightEnergy <= Number.EPSILON
      ? 0
      : numerator / Math.sqrt(leftEnergy * rightEnergy)
    const bpm = 60_000_000 / (lag * BEAT_WINDOW_MICROS)
    const tempoDistance = Math.abs(bpm - 120)
    if (score > bestScore + 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && tempoDistance < bestTempoDistance)) {
      bestLag = lag
      bestScore = score
      bestTempoDistance = tempoDistance
    }
  }
  if (bestLag === 0 || bestScore < 0.2) {
    return { markers: [], analyzedDurationMicros, truncated: false }
  }

  let bestPhase = 0
  let bestPhaseScore = -1
  for (let phase = 0; phase < bestLag; phase += 1) {
    let score = 0
    let count = 0
    for (let index = phase; index < normalized.length; index += bestLag) {
      score += normalized[index]!
      count += 1
    }
    const average = score / Math.max(1, count)
    if (average > bestPhaseScore) {
      bestPhase = phase
      bestPhaseScore = average
    }
  }

  const beatFrames: number[] = []
  const strengths: number[] = []
  let lastFrame = -1
  for (let expected = bestPhase; expected < normalized.length; expected += bestLag) {
    let selected = expected
    for (let candidate = Math.max(0, expected - 2); candidate <= Math.min(normalized.length - 1, expected + 2); candidate += 1) {
      if (normalized[candidate]! > normalized[selected]!) selected = candidate
    }
    if (selected <= lastFrame || normalized[selected]! < 0.12) continue
    beatFrames.push(selected)
    strengths.push(normalized[selected]!)
    lastFrame = selected
  }
  if (beatFrames.length < 4) {
    return { markers: [], analyzedDurationMicros, truncated: false }
  }

  const meter = inferDownbeatMeter(strengths)
  const tempoBpm = Number((60_000_000 / (bestLag * BEAT_WINDOW_MICROS)).toFixed(6))
  const rawMarkers: DetectedBeatGrid['markers'] = beatFrames.map((frame, index) => {
    const strength = Number(Math.max(0, Math.min(1, strengths[index]!)).toFixed(6))
    const rhythmicConfidence = 0.55 + Math.min(0.35, bestScore * 0.35)
    const confidence = Number(Math.min(1, rhythmicConfidence + strength * 0.1).toFixed(6))
    const downbeat = meter !== undefined && index % meter.length === meter.phase
    return {
      timeMicros: Math.min(
        analyzedDurationMicros,
        Math.max(0, frame * BEAT_WINDOW_MICROS + Math.floor(BEAT_WINDOW_MICROS / 2))
      ),
      kind: downbeat ? 'downbeat' : 'beat',
      confidence: downbeat
        ? Number(Math.min(1, confidence * (0.9 + meter.contrast * 0.1)).toFixed(6))
        : confidence,
      strength
    }
  })
  return {
    tempoBpm,
    markers: rawMarkers.slice(0, boundedMarkers),
    analyzedDurationMicros,
    truncated: rawMarkers.length > boundedMarkers
  }
}

export function inferDownbeatMeter(strengths: readonly number[]): {
  length: 3 | 4
  phase: number
  contrast: number
} | undefined {
  let best: { length: 3 | 4; phase: number; contrast: number } | undefined
  for (const length of [3, 4] as const) {
    if (strengths.length < length * 3) continue
    for (let phase = 0; phase < length; phase += 1) {
      const accented = strengths.filter((_value, index) => index % length === phase)
      const remainder = strengths.filter((_value, index) => index % length !== phase)
      const accentedMean = mean(accented)
      const remainderMean = mean(remainder)
      const contrast = (accentedMean - remainderMean) / Math.max(accentedMean, 1e-9)
      if (contrast >= 0.18 && (!best || contrast > best.contrast)) {
        best = { length, phase, contrast }
      }
    }
  }
  return best
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length
}

export function pcmEnergyFeatures(
  pcm: Buffer,
  samplePeriodMicros: number,
  maxFeaturePoints: number
): { features: number[]; analyzedDurationMicros: number } {
  const sampleCount = Math.floor(pcm.byteLength / 2)
  const pointCount = Math.min(
    maxFeaturePoints,
    Math.floor(sampleCount * 1_000_000 / (SYNC_FEATURE_SAMPLE_RATE * samplePeriodMicros))
  )
  const energy: number[] = []
  for (let point = 0; point < pointCount; point += 1) {
    const start = Math.round(
      point * samplePeriodMicros * SYNC_FEATURE_SAMPLE_RATE / 1_000_000
    )
    const end = Math.min(
      sampleCount,
      Math.round((point + 1) * samplePeriodMicros * SYNC_FEATURE_SAMPLE_RATE / 1_000_000)
    )
    if (end <= start) break
    let sumSquares = 0
    for (let sample = start; sample < end; sample += 1) {
      const normalized = pcm.readInt16LE(sample * 2) / 32_768
      sumSquares += normalized * normalized
    }
    energy.push(Math.sqrt(sumSquares / (end - start)))
  }
  if (energy.length === 0) return { features: [], analyzedDurationMicros: 0 }
  const mean = energy.reduce((total, value) => total + value, 0) / energy.length
  const centered = energy.map((value) => value - mean)
  const scale = centered.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0)
  const features = centered.map((value) =>
    scale <= Number.EPSILON ? 0 : Number((value / scale).toFixed(8))
  )
  return {
    features,
    analyzedDurationMicros: features.length * samplePeriodMicros
  }
}
