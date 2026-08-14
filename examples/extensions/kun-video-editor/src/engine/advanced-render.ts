import { createHash } from 'node:crypto'
import { engineError } from './errors.js'
import {
  EFFECT_CATALOG,
  addPerformanceIssues,
  audioArgs,
  audioEncoderFor,
  decimal,
  digest,
  exactNumericParameters,
  extensionFor,
  formatCandidates,
  invalid,
  mimeFor,
  muxerFor,
  normalizedStrings,
  portableCandidates,
  pushIssue,
  rationalValue,
  renderIssue,
  renderPerformance,
  selectEncoder,
  validateCapabilities,
  validateExportSettings,
  videoEncoderArgs
} from './advanced-render-support.js'
import {
  renderIrDigest,
  validateRenderIr,
  type CanonicalRenderIr,
  type RenderIrEffect
} from './render-ir.js'
import type { Rational } from './schema.js'
import { containsNullOrLineBreak } from '../text-safety.js'

export const ADVANCED_RENDER_LIMITS = Object.freeze({
  capabilityEntries: 256,
  gpuDevices: 8,
  effectNodes: 128,
  issues: 64,
  width: 16_384,
  height: 16_384,
  fps: 240,
  audioChannels: 16,
  canonicalBytes: 256 * 1024
})

export type RenderAccelerationPreference = 'cpu' | 'prefer-gpu' | 'require-gpu'
export type AdvancedExportFormat = 'h264-mp4' | 'h265-mp4' | 'prores-mov'
export type NegotiatedExportFormat = AdvancedExportFormat | 'ffv1-mkv'
export type AdvancedExportQuality = 'draft' | 'balanced' | 'high' | 'master'
export type AdvancedAudioCodec = 'aac' | 'pcm-s24' | 'flac'

export type RenderPerformanceLimits = {
  maxWidth: number
  maxHeight: number
  maxPixelsPerFrame: number
  maxFps: number
  maxDurationFrames: number
  maxEffectNodes: number
  maxMegapixelFrames: number
}

export type GpuRenderDeviceCapabilities = {
  id: string
  api: 'metal' | 'cuda' | 'opencl' | 'qsv' | 'vaapi'
  filters: string[]
  encoders: string[]
  maxPixelsPerFrame: number
  maxFps: number
}

export type AdvancedRenderCapabilities = {
  id: string
  version: string
  encoders: string[]
  muxers: string[]
  filters: string[]
  effects: string[]
  colorSpaces: string[]
  gpuDevices: GpuRenderDeviceCapabilities[]
  limits: RenderPerformanceLimits
}

export type AdvancedRenderIssue = {
  nodeId: string
  capability: string
  message: string
  guidance: string
}

export type AdvancedEffectStep = {
  effectId: string
  effectType: string
  filter: string
  complexity: number
}

export type AdvancedEffectLayerPlan = {
  layerId: string
  engine: 'cpu' | 'gpu'
  deviceId?: string
  filters: AdvancedEffectStep[]
  filterChain: string
}

export type AdvancedEffectExecutionPlan = {
  supported: boolean
  target: 'preview' | 'export'
  projectId: string
  sequenceId: string
  revision: number
  renderIrDigest: string
  capabilitiesDigest: string
  renderSemanticsDigest: string
  acceleration: {
    requested: RenderAccelerationPreference
    selected: 'cpu' | 'gpu'
    deviceId?: string
    fellBackToCpu: boolean
  }
  performance: {
    width: number
    height: number
    fps: number
    durationFrames: number
    effectNodes: number
    megapixelFrames: number
    weightedMegapixelFrames: number
  }
  layers: AdvancedEffectLayerPlan[]
  warnings: AdvancedRenderIssue[]
  issues: AdvancedRenderIssue[]
}

export type AdvancedExportSettings = {
  format: AdvancedExportFormat
  width: number
  height: number
  frameRate: Rational
  quality: AdvancedExportQuality
  acceleration: RenderAccelerationPreference
  allowPortableEquivalent?: boolean
  audio?: {
    codec: AdvancedAudioCodec
    sampleRate: 44_100 | 48_000 | 96_000
    channels: number
    bitrateKbps?: number
  }
}

export type AdvancedExportCapabilityEvidence = {
  requestedFormat: AdvancedExportFormat
  selectedFormat?: NegotiatedExportFormat
  selectedEncoder?: string
  selectedMuxer?: string
  encoderCandidates: string[]
  advertisedEncoders: string[]
  advertisedMuxers: string[]
  gpuDeviceId?: string
  portableEquivalent: boolean
}

export type AdvancedExportPlan = {
  supported: boolean
  projectId: string
  sequenceId: string
  revision: number
  renderIrDigest: string
  capabilitiesDigest: string
  settingsDigest: string
  requested: AdvancedExportSettings
  selected?: {
    format: NegotiatedExportFormat
    encoder: string
    muxer: string
    extension: 'mp4' | 'mov' | 'mkv'
    mime: 'video/mp4' | 'video/quicktime' | 'video/x-matroska'
    hardwareAccelerated: boolean
    gpuDeviceId?: string
    videoFilterSuffix: string[]
    videoArgs: string[]
    audioArgs: string[]
    muxerArgs: string[]
  }
  capabilityEvidence: AdvancedExportCapabilityEvidence
  warnings: AdvancedRenderIssue[]
  issues: AdvancedRenderIssue[]
}

export function baselineAdvancedFfmpegCapabilities(): AdvancedRenderCapabilities {
  return {
    id: 'ffmpeg',
    version: 'negotiated',
    encoders: ['aac', 'ffv1', 'flac', 'libx264', 'libx265', 'pcm_s24le', 'prores_ks'],
    muxers: ['matroska', 'mov', 'mp4'],
    filters: ['avgblur_opencl', 'boxblur', 'colorbalance', 'eq', 'unsharp', 'unsharp_opencl', 'vignette'],
    effects: Object.keys(EFFECT_CATALOG).sort(),
    colorSpaces: ['bt709'],
    gpuDevices: [],
    limits: {
      maxWidth: 8_192,
      maxHeight: 8_192,
      maxPixelsPerFrame: 33_554_432,
      maxFps: 120,
      maxDurationFrames: 2_592_000,
      maxEffectNodes: ADVANCED_RENDER_LIMITS.effectNodes,
      maxMegapixelFrames: 20_000_000
    }
  }
}

export function advancedRenderCapabilitiesDigest(capabilities: AdvancedRenderCapabilities): string {
  validateCapabilities(capabilities)
  return digest({
    ...capabilities,
    encoders: normalizedStrings(capabilities.encoders),
    muxers: normalizedStrings(capabilities.muxers),
    filters: normalizedStrings(capabilities.filters),
    effects: normalizedStrings(capabilities.effects),
    colorSpaces: normalizedStrings(capabilities.colorSpaces),
    gpuDevices: [...capabilities.gpuDevices]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((device) => ({
        ...device,
        filters: normalizedStrings(device.filters),
        encoders: normalizedStrings(device.encoders)
      }))
  })
}

export function negotiateAdvancedEffects(
  ir: CanonicalRenderIr,
  capabilities: AdvancedRenderCapabilities,
  request: {
    target: 'preview' | 'export'
    acceleration: RenderAccelerationPreference
  }
): AdvancedEffectExecutionPlan {
  validateRenderIr(ir)
  validateCapabilities(capabilities)
  if (!['preview', 'export'].includes(request.target)) invalid('Advanced effect target is invalid')
  if (!['cpu', 'prefer-gpu', 'require-gpu'].includes(request.acceleration)) {
    invalid('Advanced effect acceleration preference is invalid')
  }
  const issues: AdvancedRenderIssue[] = []
  const warnings: AdvancedRenderIssue[] = []
  const enabled = ir.layers.flatMap((layer) => layer.effects
    .filter((effect) => effect.enabled)
    .map((effect) => ({ layerId: layer.id, effect })))
  const metrics = renderPerformance(ir, enabled.map(({ effect }) => effect))
  addPerformanceIssues(ir, capabilities.limits, metrics, issues)
  if (!capabilities.colorSpaces.includes(ir.canvas.colorSpace)) {
    pushIssue(issues, renderIssue(
      'canvas', `color-space:${ir.canvas.colorSpace}`,
      `Backend ${capabilities.id} does not advertise ${ir.canvas.colorSpace} output.`,
      'Select a color-managed backend or explicitly convert the project before export.'
    ))
  }
  const cpuAvailable = enabled.every(({ effect }) => {
    const catalog = EFFECT_CATALOG[effect.type]
    return Boolean(catalog && capabilities.effects.includes(effect.type) && capabilities.filters.includes(catalog.cpuFilter))
  })
  const gpuDevice = request.acceleration === 'cpu'
    ? undefined
    : capabilities.gpuDevices.find((device) =>
      metrics.width * metrics.height <= device.maxPixelsPerFrame &&
      metrics.fps <= device.maxFps &&
      enabled.every(({ effect }) => {
        const catalog = EFFECT_CATALOG[effect.type]
        return Boolean(
          catalog?.gpuFilter &&
          capabilities.effects.includes(effect.type) &&
          device.filters.includes(catalog.gpuFilter)
        )
      }))
  if (request.acceleration === 'require-gpu' && !gpuDevice && enabled.length > 0) {
    pushIssue(issues, renderIssue(
      'backend', 'acceleration:gpu',
      'No single advertised GPU device can execute every enabled effect within its performance limits.',
      'Use prefer-gpu to allow the deterministic CPU fallback, simplify effects, or select another device.'
    ))
  }
  if (!cpuAvailable && !gpuDevice) {
    for (const { layerId, effect } of enabled) {
      const catalog = EFFECT_CATALOG[effect.type]
      if (!catalog) {
        pushIssue(issues, renderIssue(
          effect.id, `effect:${effect.type}`,
          `Effect ${effect.type} on ${layerId} is outside the bounded advanced-effect catalog.`,
          'Disable the effect, bake it to a proxy, or install an adapter that explicitly implements it.'
        ))
      } else if (!capabilities.effects.includes(effect.type)) {
        pushIssue(issues, renderIssue(
          effect.id, `effect:${effect.type}`,
          `Backend ${capabilities.id} does not advertise effect ${effect.type}.`,
          'Select a backend advertising the effect or disable it.'
        ))
      } else if (!capabilities.filters.includes(catalog.cpuFilter)) {
        pushIssue(issues, renderIssue(
          effect.id, `filter:${catalog.cpuFilter}`,
          `The CPU fallback for ${effect.type} requires ${catalog.cpuFilter}.`,
          `Install an FFmpeg build with ${catalog.cpuFilter} or use a compatible GPU device.`
        ))
      }
    }
  }
  const selectedGpu = Boolean(gpuDevice && request.acceleration !== 'cpu' && issues.length === 0)
  const fellBackToCpu = request.acceleration === 'prefer-gpu' && enabled.length > 0 && !selectedGpu
  if (fellBackToCpu && cpuAvailable) {
    warnings.push(renderIssue(
      'backend', 'fallback:cpu',
      'The requested GPU path cannot execute the complete effect chain; the entire chain will use the deterministic CPU fallback.',
      'This is expected and preserves preview/export semantics; choose a capable GPU backend to accelerate it.'
    ))
  }
  const layers: AdvancedEffectLayerPlan[] = []
  for (const layer of ir.layers) {
    const effects = layer.effects.filter((effect) => effect.enabled)
    if (effects.length === 0) continue
    const steps: AdvancedEffectStep[] = []
    for (const effect of effects) {
      const catalog = EFFECT_CATALOG[effect.type]
      if (!catalog) continue
      const filter = selectedGpu ? catalog.gpuFilter : catalog.cpuFilter
      if (!filter) continue
      try {
        steps.push({
          effectId: effect.id,
          effectType: effect.type,
          filter: catalog.compile(effect.parameters, filter),
          complexity: catalog.complexity
        })
      } catch (error) {
        pushIssue(issues, renderIssue(
          effect.id, `effect-parameters:${effect.type}`,
          error instanceof Error ? error.message : `Invalid parameters for ${effect.type}.`,
          'Use only the documented bounded parameters for this effect.'
        ))
      }
    }
    const filters = steps.map(({ filter }) => filter)
    layers.push({
      layerId: layer.id,
      engine: selectedGpu ? 'gpu' : 'cpu',
      ...(selectedGpu && gpuDevice ? { deviceId: gpuDevice.id } : {}),
      filters: steps,
      filterChain: selectedGpu
        ? ['format=rgba', 'hwupload', ...filters, 'hwdownload', 'format=yuv420p'].join(',')
        : filters.join(',')
    })
  }
  const capabilitiesDigest = advancedRenderCapabilitiesDigest(capabilities)
  const semantics = {
    irDigest: renderIrDigest(ir),
    capabilitiesDigest,
    acceleration: selectedGpu ? { engine: 'gpu', deviceId: gpuDevice!.id } : { engine: 'cpu' },
    layers
  }
  return {
    supported: issues.length === 0,
    target: request.target,
    projectId: ir.projectId,
    sequenceId: ir.sequenceId,
    revision: ir.revision,
    renderIrDigest: renderIrDigest(ir),
    capabilitiesDigest,
    renderSemanticsDigest: digest(semantics),
    acceleration: {
      requested: request.acceleration,
      selected: selectedGpu ? 'gpu' : 'cpu',
      ...(selectedGpu && gpuDevice ? { deviceId: gpuDevice.id } : {}),
      fellBackToCpu
    },
    performance: metrics,
    layers,
    warnings,
    issues
  }
}

export function negotiateAdvancedExport(
  ir: CanonicalRenderIr,
  settings: AdvancedExportSettings,
  capabilities: AdvancedRenderCapabilities
): AdvancedExportPlan {
  validateRenderIr(ir)
  validateCapabilities(capabilities)
  validateExportSettings(settings)
  const issues: AdvancedRenderIssue[] = []
  const warnings: AdvancedRenderIssue[] = []
  const fps = rationalValue(settings.frameRate)
  const outputMetrics = {
    width: settings.width,
    height: settings.height,
    fps,
    durationFrames: ir.range.endFrame - ir.range.startFrame,
    effectNodes: ir.layers.reduce((total, layer) => total + layer.effects.filter(({ enabled }) => enabled).length, 0),
    megapixelFrames: settings.width * settings.height / 1_000_000 * (ir.range.endFrame - ir.range.startFrame),
    weightedMegapixelFrames: 0
  }
  outputMetrics.weightedMegapixelFrames = outputMetrics.megapixelFrames * Math.max(1, outputMetrics.effectNodes)
  addPerformanceIssues(ir, capabilities.limits, outputMetrics, issues)
  const requestedCandidates = formatCandidates(settings.format, settings.acceleration)
  let candidates = requestedCandidates
  let portableEquivalent = false
  let selectedFormat: NegotiatedExportFormat = settings.format
  const deviceWorkload = { pixelsPerFrame: settings.width * settings.height, fps }
  let selected = selectEncoder(candidates, capabilities, settings.acceleration, deviceWorkload)
  if (!selected && settings.allowPortableEquivalent) {
    const fallback = portableCandidates(settings.format, settings.acceleration)
    selected = selectEncoder(fallback.candidates, capabilities, settings.acceleration, deviceWorkload)
    if (selected) {
      selectedFormat = fallback.format
      candidates = fallback.candidates
      portableEquivalent = true
      warnings.push(renderIssue(
        'export', `fallback:${selectedFormat}`,
        `${settings.format} is unavailable; ${selectedFormat} was selected as an explicit portable equivalent.`,
        'Review the selected codec/container before starting the export.'
      ))
    }
  }
  if (!selected) {
    pushIssue(issues, renderIssue(
      'export', `codec:${settings.format}`,
      `No advertised encoder satisfies ${settings.format} with acceleration policy ${settings.acceleration}.`,
      settings.allowPortableEquivalent
        ? 'Install a supported encoder or select another backend.'
        : 'Install a supported encoder or explicitly allow a portable equivalent.'
    ))
  }
  if (selected && settings.acceleration === 'prefer-gpu' && !selected.device) {
    warnings.push(renderIssue(
      'export', 'fallback:cpu-encoder',
      `No compatible hardware encoder is available; ${selected.encoder} will encode on the CPU.`,
      'The output settings remain unchanged; select a compatible GPU backend for acceleration.'
    ))
  }
  const muxer = muxerFor(selectedFormat)
  if (!capabilities.muxers.includes(muxer)) {
    pushIssue(issues, renderIssue(
      'export', `muxer:${muxer}`,
      `Backend ${capabilities.id} does not advertise the ${muxer} muxer.`,
      'Install a backend with the required muxer or choose a compatible output format.'
    ))
  }
  const audioEncoder = settings.audio ? audioEncoderFor(settings.audio.codec) : undefined
  if (audioEncoder && !capabilities.encoders.includes(audioEncoder)) {
    pushIssue(issues, renderIssue(
      'audio', `codec:${audioEncoder}`,
      `Backend ${capabilities.id} does not advertise audio encoder ${audioEncoder}.`,
      'Choose an available audio codec or install a backend with the requested encoder.'
    ))
  }
  if (settings.audio && muxer === 'mp4' && settings.audio.codec !== 'aac') {
    pushIssue(issues, renderIssue(
      'audio', `container-audio:${muxer}/${settings.audio.codec}`,
      `Audio codec ${settings.audio.codec} is not allowed by the bounded MP4 profile.`,
      'Use AAC for MP4, or select ProRes MOV / FFV1 MKV for lossless audio.'
    ))
  }
  const capabilitiesDigest = advancedRenderCapabilitiesDigest(capabilities)
  const settingsDigest = digest(settings)
  const evidence: AdvancedExportCapabilityEvidence = {
    requestedFormat: settings.format,
    ...(selected ? {
      selectedFormat,
      selectedEncoder: selected.encoder,
      selectedMuxer: muxer,
      ...(selected.device ? { gpuDeviceId: selected.device.id } : {})
    } : {}),
    encoderCandidates: candidates.map(({ encoder }) => encoder),
    advertisedEncoders: normalizedStrings(capabilities.encoders),
    advertisedMuxers: normalizedStrings(capabilities.muxers),
    portableEquivalent
  }
  return {
    supported: issues.length === 0,
    projectId: ir.projectId,
    sequenceId: ir.sequenceId,
    revision: ir.revision,
    renderIrDigest: renderIrDigest(ir),
    capabilitiesDigest,
    settingsDigest,
    requested: structuredClone(settings),
    ...(selected && issues.length === 0 ? {
      selected: {
        format: selectedFormat,
        encoder: selected.encoder,
        muxer,
        extension: extensionFor(selectedFormat),
        mime: mimeFor(selectedFormat),
        hardwareAccelerated: Boolean(selected.device),
        ...(selected.device ? { gpuDeviceId: selected.device.id } : {}),
        videoFilterSuffix: [
          `scale=${settings.width}:${settings.height}:flags=lanczos`,
          `fps=${settings.frameRate.numerator}/${settings.frameRate.denominator}`
        ],
        videoArgs: videoEncoderArgs(selected.encoder, selectedFormat, settings.quality),
        audioArgs: settings.audio ? audioArgs(settings.audio) : ['-an'],
        muxerArgs: muxer === 'mp4'
          ? ['-movflags', '+faststart', '-f', 'mp4']
          : ['-f', muxer]
      }
    } : {}),
    capabilityEvidence: evidence,
    warnings,
    issues
  }
}

export function assertAdvancedRenderSupported(
  plan: AdvancedEffectExecutionPlan | AdvancedExportPlan
): void {
  if (plan.supported) return
  throw engineError(
    'render_unsupported',
    `Advanced render negotiation failed: ${plan.issues.map(({ nodeId, capability }) => `${nodeId} (${capability})`).join(', ')}`,
    { issues: plan.issues }
  )
}
