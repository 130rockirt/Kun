import { createHash } from 'node:crypto'
import { engineError } from './errors.js'
import {
  ADVANCED_RENDER_LIMITS,
  type AdvancedAudioCodec,
  type AdvancedEffectExecutionPlan,
  type AdvancedExportFormat,
  type AdvancedExportQuality,
  type AdvancedExportSettings,
  type AdvancedRenderCapabilities,
  type AdvancedRenderIssue,
  type GpuRenderDeviceCapabilities,
  type NegotiatedExportFormat,
  type RenderAccelerationPreference,
  type RenderPerformanceLimits
} from './advanced-render.js'
import {
  renderIrDigest,
  validateRenderIr,
  type CanonicalRenderIr,
  type RenderIrEffect
} from './render-ir.js'
import type { Rational } from './schema.js'
import { containsNullOrLineBreak } from '../text-safety.js'

type EffectCatalogEntry = {
  cpuFilter: string
  gpuFilter?: string
  complexity: number
  compile(parameters: Readonly<Record<string, number | string | boolean>>, filter: string): string
}

export const EFFECT_CATALOG: Readonly<Record<string, EffectCatalogEntry>> = Object.freeze({
  'color.basic': {
    cpuFilter: 'eq',
    complexity: 1.25,
    compile(parameters, filter) {
      const values = exactNumericParameters(parameters, {
        brightness: [-1, 1, 0],
        contrast: [0, 2, 1],
        saturation: [0, 3, 1],
        gamma: [0.1, 10, 1]
      })
      return `${filter}=brightness=${decimal(values.brightness!)}:contrast=${decimal(values.contrast!)}:` +
        `saturation=${decimal(values.saturation!)}:gamma=${decimal(values.gamma!)}`
    }
  },
  'color.temperature': {
    cpuFilter: 'colorbalance',
    complexity: 1.5,
    compile(parameters, filter) {
      const values = exactNumericParameters(parameters, {
        temperature: [-1, 1, 0],
        tint: [-1, 1, 0]
      })
      const temperature = values.temperature!
      const tint = values.tint!
      return `${filter}=rs=${decimal(temperature)}:bs=${decimal(-temperature)}:` +
        `gm=${decimal(tint)}`
    }
  },
  blur: {
    cpuFilter: 'boxblur',
    gpuFilter: 'avgblur_opencl',
    complexity: 2.5,
    compile(parameters, filter) {
      const values = exactNumericParameters(parameters, { radius: [0, 100, 2] })
      const radius = Math.max(1, Math.round(values.radius!))
      return filter === 'avgblur_opencl'
        ? `${filter}=sizeX=${radius}:sizeY=${radius}`
        : `${filter}=luma_radius=${radius}:luma_power=1:chroma_radius=${radius}:chroma_power=1`
    }
  },
  sharpen: {
    cpuFilter: 'unsharp',
    gpuFilter: 'unsharp_opencl',
    complexity: 2,
    compile(parameters, filter) {
      const values = exactNumericParameters(parameters, { amount: [0, 5, 1] })
      return filter === 'unsharp_opencl'
        ? `${filter}=luma_msize_x=5:luma_msize_y=5:luma_amount=${decimal(values.amount!)}`
        : `${filter}=5:5:${decimal(values.amount!)}:5:5:0`
    }
  },
  vignette: {
    cpuFilter: 'vignette',
    complexity: 1.75,
    compile(parameters, filter) {
      const values = exactNumericParameters(parameters, { intensity: [0, 1, 0.35] })
      const angle = Math.PI / 2 - values.intensity! * Math.PI / 3
      return `${filter}=angle=${angle.toFixed(6)}`
    }
  }
})

type EncoderCandidate = {
  encoder: string
  hardwareApi?: GpuRenderDeviceCapabilities['api']
}

export function formatCandidates(
  format: AdvancedExportFormat,
  acceleration: RenderAccelerationPreference
): EncoderCandidate[] {
  const gpu = format === 'h264-mp4'
    ? [
        { encoder: 'h264_videotoolbox', hardwareApi: 'metal' as const },
        { encoder: 'h264_nvenc', hardwareApi: 'cuda' as const },
        { encoder: 'h264_qsv', hardwareApi: 'qsv' as const },
        { encoder: 'h264_vaapi', hardwareApi: 'vaapi' as const }
      ]
    : format === 'h265-mp4'
      ? [
          { encoder: 'hevc_videotoolbox', hardwareApi: 'metal' as const },
          { encoder: 'hevc_nvenc', hardwareApi: 'cuda' as const },
          { encoder: 'hevc_qsv', hardwareApi: 'qsv' as const },
          { encoder: 'hevc_vaapi', hardwareApi: 'vaapi' as const }
        ]
      : [{ encoder: 'prores_videotoolbox', hardwareApi: 'metal' as const }]
  const cpu = format === 'h264-mp4'
    ? [{ encoder: 'libx264' }]
    : format === 'h265-mp4'
      ? [{ encoder: 'libx265' }]
      : [{ encoder: 'prores_ks' }]
  return acceleration === 'cpu' ? cpu : acceleration === 'require-gpu' ? gpu : [...gpu, ...cpu]
}

export function portableCandidates(
  format: AdvancedExportFormat,
  acceleration: RenderAccelerationPreference
): { format: NegotiatedExportFormat; candidates: EncoderCandidate[] } {
  if (format === 'prores-mov') return { format: 'ffv1-mkv', candidates: [{ encoder: 'ffv1' }] }
  if (format === 'h265-mp4') return { format: 'h264-mp4', candidates: formatCandidates('h264-mp4', acceleration) }
  return { format: 'ffv1-mkv', candidates: [{ encoder: 'ffv1' }] }
}

export function selectEncoder(
  candidates: readonly EncoderCandidate[],
  capabilities: AdvancedRenderCapabilities,
  acceleration: RenderAccelerationPreference,
  workload: { pixelsPerFrame: number; fps: number }
): { encoder: string; device?: GpuRenderDeviceCapabilities } | undefined {
  for (const candidate of candidates) {
    if (!capabilities.encoders.includes(candidate.encoder)) continue
    if (!candidate.hardwareApi) {
      if (acceleration === 'require-gpu') continue
      return { encoder: candidate.encoder }
    }
    const device = capabilities.gpuDevices.find((entry) =>
      entry.api === candidate.hardwareApi &&
      entry.encoders.includes(candidate.encoder) &&
      workload.pixelsPerFrame <= entry.maxPixelsPerFrame &&
      workload.fps <= entry.maxFps)
    if (device) return { encoder: candidate.encoder, device }
  }
  return undefined
}

export function videoEncoderArgs(
  encoder: string,
  format: NegotiatedExportFormat,
  quality: AdvancedExportQuality
): string[] {
  if (encoder === 'libx264' || encoder === 'libx265') {
    const crf = quality === 'draft' ? 30 : quality === 'balanced' ? 24 : quality === 'high' ? 19 : 14
    const preset = quality === 'draft' ? 'fast' : quality === 'master' ? 'slow' : 'medium'
    return [
      '-c:v', encoder,
      '-preset', preset,
      '-crf', String(crf),
      '-pix_fmt', 'yuv420p',
      ...(encoder === 'libx265' ? ['-tag:v', 'hvc1'] : [])
    ]
  }
  if (encoder === 'prores_ks' || encoder === 'prores_videotoolbox') {
    const profile = quality === 'draft' ? '0' : quality === 'balanced' ? '1' : quality === 'high' ? '2' : '3'
    return ['-c:v', encoder, '-profile:v', profile, '-pix_fmt', 'yuv422p10le']
  }
  if (encoder === 'ffv1') return ['-c:v', 'ffv1', '-level', '3', '-coder', '1', '-context', '1', '-pix_fmt', 'yuv422p10le']
  const qualityValue = quality === 'draft' ? '45' : quality === 'balanced' ? '60' : quality === 'high' ? '75' : '90'
  const base = ['-c:v', encoder, '-q:v', qualityValue, '-pix_fmt', 'yuv420p']
  return format === 'h265-mp4' ? [...base, '-tag:v', 'hvc1'] : base
}

export function audioArgs(audio: NonNullable<AdvancedExportSettings['audio']>): string[] {
  const encoder = audioEncoderFor(audio.codec)
  return [
    '-c:a', encoder,
    '-ar', String(audio.sampleRate),
    '-ac', String(audio.channels),
    ...(audio.codec === 'aac' ? ['-b:a', `${audio.bitrateKbps ?? 192}k`] : [])
  ]
}

export function audioEncoderFor(codec: AdvancedAudioCodec): string {
  return codec === 'pcm-s24' ? 'pcm_s24le' : codec
}

export function muxerFor(format: NegotiatedExportFormat): 'mp4' | 'mov' | 'matroska' {
  return format === 'prores-mov' ? 'mov' : format === 'ffv1-mkv' ? 'matroska' : 'mp4'
}

export function extensionFor(format: NegotiatedExportFormat): 'mp4' | 'mov' | 'mkv' {
  return format === 'prores-mov' ? 'mov' : format === 'ffv1-mkv' ? 'mkv' : 'mp4'
}

export function mimeFor(format: NegotiatedExportFormat): 'video/mp4' | 'video/quicktime' | 'video/x-matroska' {
  return format === 'prores-mov'
    ? 'video/quicktime'
    : format === 'ffv1-mkv'
      ? 'video/x-matroska'
      : 'video/mp4'
}

export function renderPerformance(
  ir: CanonicalRenderIr,
  effects: readonly RenderIrEffect[]
): AdvancedEffectExecutionPlan['performance'] {
  const width = ir.canvas.width
  const height = ir.canvas.height
  const fps = rationalValue(ir.fps)
  const durationFrames = ir.range.endFrame - ir.range.startFrame
  const megapixelFrames = width * height / 1_000_000 * durationFrames
  const complexity = effects.reduce((total, effect) => total + (EFFECT_CATALOG[effect.type]?.complexity ?? 4), 1)
  return {
    width,
    height,
    fps,
    durationFrames,
    effectNodes: effects.length,
    megapixelFrames,
    weightedMegapixelFrames: megapixelFrames * complexity
  }
}

export function addPerformanceIssues(
  ir: CanonicalRenderIr,
  limits: RenderPerformanceLimits,
  metrics: AdvancedEffectExecutionPlan['performance'],
  issues: AdvancedRenderIssue[]
): void {
  const checks: Array<[boolean, string, string, string]> = [
    [metrics.width <= limits.maxWidth, 'limit:width', `Output width ${metrics.width} exceeds ${limits.maxWidth}.`, 'Reduce output width or use a backend with a larger frame limit.'],
    [metrics.height <= limits.maxHeight, 'limit:height', `Output height ${metrics.height} exceeds ${limits.maxHeight}.`, 'Reduce output height or use a backend with a larger frame limit.'],
    [metrics.width * metrics.height <= limits.maxPixelsPerFrame, 'limit:pixels', 'Output pixels per frame exceed the backend limit.', 'Reduce resolution or use a higher-capacity backend.'],
    [metrics.fps <= limits.maxFps, 'limit:fps', `Output frame rate ${metrics.fps} exceeds ${limits.maxFps}.`, 'Reduce frame rate or use a backend with a higher frame-rate limit.'],
    [metrics.durationFrames <= limits.maxDurationFrames, 'limit:duration', 'Render duration exceeds the backend frame limit.', 'Split the render range or use a backend with a larger duration limit.'],
    [metrics.effectNodes <= limits.maxEffectNodes, 'limit:effects', 'Enabled effect count exceeds the backend limit.', 'Disable or bake effects before rendering.'],
    [metrics.weightedMegapixelFrames <= limits.maxMegapixelFrames, 'limit:workload', 'Estimated render workload exceeds the bounded performance budget.', 'Lower resolution, duration, or effect complexity, then retry.']
  ]
  for (const [passes, capability, message, guidance] of checks) {
    if (!passes) pushIssue(issues, renderIssue(ir.sequenceId, capability, message, guidance))
  }
}

export function validateCapabilities(capabilities: AdvancedRenderCapabilities): void {
  boundedString(capabilities.id, 'capabilities.id', 128)
  boundedString(capabilities.version, 'capabilities.version', 128)
  for (const [label, values] of Object.entries({
    encoders: capabilities.encoders,
    muxers: capabilities.muxers,
    filters: capabilities.filters,
    effects: capabilities.effects,
    colorSpaces: capabilities.colorSpaces
  })) {
    if (!Array.isArray(values) || values.length > ADVANCED_RENDER_LIMITS.capabilityEntries) {
      invalid(`capabilities.${label} exceeds its bound`)
    }
    values.forEach((value) => boundedString(value, `capabilities.${label}`, 128))
  }
  if (capabilities.gpuDevices.length > ADVANCED_RENDER_LIMITS.gpuDevices) invalid('GPU device catalog exceeds its bound')
  for (const device of capabilities.gpuDevices) {
    boundedString(device.id, 'gpuDevice.id', 128)
    if (!['metal', 'cuda', 'opencl', 'qsv', 'vaapi'].includes(device.api)) invalid('GPU device API is invalid')
    device.filters.forEach((value) => boundedString(value, 'gpuDevice.filters', 128))
    device.encoders.forEach((value) => boundedString(value, 'gpuDevice.encoders', 128))
    positiveInteger(device.maxPixelsPerFrame, 'gpuDevice.maxPixelsPerFrame')
    positiveNumber(device.maxFps, 'gpuDevice.maxFps')
  }
  const limits = capabilities.limits
  positiveInteger(limits.maxWidth, 'limits.maxWidth')
  positiveInteger(limits.maxHeight, 'limits.maxHeight')
  positiveInteger(limits.maxPixelsPerFrame, 'limits.maxPixelsPerFrame')
  positiveNumber(limits.maxFps, 'limits.maxFps')
  positiveInteger(limits.maxDurationFrames, 'limits.maxDurationFrames')
  positiveInteger(limits.maxEffectNodes, 'limits.maxEffectNodes')
  positiveNumber(limits.maxMegapixelFrames, 'limits.maxMegapixelFrames')
}

export function validateExportSettings(settings: AdvancedExportSettings): void {
  if (!['h264-mp4', 'h265-mp4', 'prores-mov'].includes(settings.format)) invalid('Export format is invalid')
  positiveInteger(settings.width, 'export.width')
  positiveInteger(settings.height, 'export.height')
  if (settings.width > ADVANCED_RENDER_LIMITS.width || settings.height > ADVANCED_RENDER_LIMITS.height) {
    invalid('Export resolution exceeds the absolute safety limit')
  }
  if ((settings.format === 'h264-mp4' || settings.format === 'h265-mp4') && (settings.width % 2 || settings.height % 2)) {
    invalid('4:2:0 MP4 output requires even width and height')
  }
  positiveInteger(settings.frameRate.numerator, 'export.frameRate.numerator')
  positiveInteger(settings.frameRate.denominator, 'export.frameRate.denominator')
  if (rationalValue(settings.frameRate) > ADVANCED_RENDER_LIMITS.fps) invalid('Export frame rate exceeds the absolute safety limit')
  if (!['draft', 'balanced', 'high', 'master'].includes(settings.quality)) invalid('Export quality is invalid')
  if (!['cpu', 'prefer-gpu', 'require-gpu'].includes(settings.acceleration)) invalid('Export acceleration is invalid')
  if (settings.audio) {
    if (!['aac', 'pcm-s24', 'flac'].includes(settings.audio.codec)) invalid('Export audio codec is invalid')
    if (![44_100, 48_000, 96_000].includes(settings.audio.sampleRate)) invalid('Export audio sample rate is invalid')
    positiveInteger(settings.audio.channels, 'export.audio.channels')
    if (settings.audio.channels > ADVANCED_RENDER_LIMITS.audioChannels) invalid('Export audio channels exceed the limit')
    if (settings.audio.bitrateKbps !== undefined) {
      if (!Number.isSafeInteger(settings.audio.bitrateKbps) || settings.audio.bitrateKbps < 32 || settings.audio.bitrateKbps > 1_536) {
        invalid('Export audio bitrate must be between 32 and 1536 kbps')
      }
    }
  }
}

export function exactNumericParameters(
  parameters: Readonly<Record<string, number | string | boolean>>,
  definitions: Readonly<Record<string, readonly [minimum: number, maximum: number, fallback: number]>>
): Record<string, number> {
  const unknown = Object.keys(parameters).filter((key) => !(key in definitions))
  if (unknown.length > 0) throw new Error(`Unsupported effect parameter(s): ${unknown.sort().join(', ')}`)
  const result: Record<string, number> = {}
  for (const [key, [minimum, maximum, fallback]] of Object.entries(definitions)) {
    const value = parameters[key] ?? fallback
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
      throw new Error(`${key} must be a finite number between ${minimum} and ${maximum}`)
    }
    result[key] = value
  }
  return result
}

export function rationalValue(value: Rational): number {
  return value.numerator / value.denominator
}

export function decimal(value: number): string {
  const normalized = Math.abs(value) < 0.0000005 ? 0 : value
  return normalized.toFixed(6)
}

export function renderIssue(
  nodeId: string,
  capability: string,
  message: string,
  guidance: string
): AdvancedRenderIssue {
  return { nodeId, capability, message, guidance }
}

export function pushIssue(target: AdvancedRenderIssue[], value: AdvancedRenderIssue): void {
  if (target.length < ADVANCED_RENDER_LIMITS.issues) target.push(value)
}

export function normalizedStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

export function digest(value: unknown): string {
  const canonical = JSON.stringify(sortJson(value))
  if (Buffer.byteLength(canonical, 'utf8') > ADVANCED_RENDER_LIMITS.canonicalBytes) {
    invalid('Advanced render canonical evidence exceeds its byte limit')
  }
  return createHash('sha256').update(canonical).digest('hex')
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

export function boundedString(value: unknown, label: string, maximum: number): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || containsNullOrLineBreak(value)) {
    invalid(`${label} must be a bounded string`)
  }
}

export function positiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) invalid(`${label} must be a positive integer`)
}

export function positiveNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) invalid(`${label} must be positive`)
}

export function invalid(message: string): never {
  throw engineError('render_unsupported', message)
}
