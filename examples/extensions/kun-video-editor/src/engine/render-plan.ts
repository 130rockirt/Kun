import { engineError } from './errors.js'
export { escapeDrawtextText } from './render-plan-support.js'
import {
  assertBoundedFilterGraph,
  audioStep,
  compositionGraph,
  hasVisualSource,
  isFinalVideoKind,
  placeholder,
  prepareCompositionInputs,
  subtitleArtifact,
  subtitleStep,
  validateOpaqueReference,
  videoArtifactMime,
  videoArtifactName
} from './render-plan-support.js'
import type { VideoProject } from './schema.js'
import { generateSubtitles, type SubtitleFormat } from './subtitles.js'
import {
  assertRenderIrSupported,
  compileRenderIr,
  defaultFfmpegCapabilities,
  negotiateRenderIr,
  renderIrDigest,
  resolveInteractivePlayback,
  type CanonicalRenderIr,
  type InteractivePlaybackDecision,
  type RenderBackendCapabilities,
  type RenderCapabilityReport,
  type RenderIrMediaLayer,
  type RenderIrSource
} from './render-ir.js'
import {
  frameToSecondsArgument,
  framesToMicroseconds,
  microsecondsToSecondsArgument
} from './time.js'
import { assertValidTimeline, projectDurationFrames } from './timeline.js'
import { flattenNestedRenderIr } from './nested-render.js'
import type {
  AdvancedEffectExecutionPlan,
  AdvancedExportPlan
} from './advanced-render.js'

export type RenderKind =
  | 'proof-frame'
  | 'preview'
  | 'h264-mp4'
  | 'h265-mp4'
  | 'prores-mov'
  | 'ffv1-mkv'
  | 'audio-aac'
  | 'subtitles'
export type CaptionMode = 'none' | 'burned' | 'sidecar' | 'both'

export type RenderRequest = {
  kind: RenderKind
  expectedRevision: number
  outputHandleId: string
  proofFrame?: number
  startFrame?: number
  endFrame?: number
  captionMode?: CaptionMode
  subtitleFormat?: SubtitleFormat
  subtitleOutputHandleId?: string
  backendCapabilities?: RenderBackendCapabilities
  advancedEffects?: AdvancedEffectExecutionPlan
  advancedExport?: AdvancedExportPlan
}

export type RenderInputReference = {
  kind: 'media-handle' | 'workspace-file' | 'generated-text'
  reference: string
}

export type FfmpegRenderStep = {
  kind: 'ffmpeg'
  id: string
  inputs: Record<string, RenderInputReference>
  outputs: Record<string, string>
  args: string[]
}

export type TextRenderStep = {
  kind: 'write-text'
  id: string
  output: string
  mime: 'application/x-subrip' | 'text/vtt'
  content: string
}

export type RenderStep = FfmpegRenderStep | TextRenderStep

export type PlannedArtifact = {
  output: string
  name: string
  mime: string
  kind: 'image' | 'video' | 'audio' | 'subtitle'
}

export type RenderPlan = {
  schemaVersion: 1
  projectId: string
  sequenceId: string
  revision: number
  renderKind: RenderKind
  canvas: VideoProject['canvas']
  fps: VideoProject['fps']
  durationFrames: number
  renderIr: CanonicalRenderIr
  renderIrDigest: string
  backendCapabilitiesDigest: string
  capabilityReport: RenderCapabilityReport
  playback: InteractivePlaybackDecision
  verification: {
    technicalValidation: 'pending'
    visualInspection: 'not-performed'
  }
  steps: RenderStep[]
  artifacts: PlannedArtifact[]
}

export function generateRenderPlan(project: VideoProject, request: RenderRequest): RenderPlan {
  assertValidTimeline(project)
  if (request.expectedRevision !== project.currentRevision) {
    throw engineError('revision_conflict', 'Render request is based on a stale project revision', {
      expectedRevision: request.expectedRevision,
      currentRevision: project.currentRevision
    })
  }
  validateOpaqueReference(request.outputHandleId, 'outputHandleId')
  const durationFrames = projectDurationFrames(project)
  if (durationFrames <= 0) {
    throw engineError(
      'render_unsupported',
      request.kind === 'subtitles'
        ? 'Subtitle export requires at least one timed caption'
        : 'A media render requires at least one timeline item'
    )
  }
  const captionMode = request.captionMode ?? 'none'
  const proofFrame = request.kind === 'proof-frame' ? request.proofFrame ?? 0 : undefined
  if (
    proofFrame !== undefined &&
    (!Number.isSafeInteger(proofFrame) || proofFrame < 0 || proofFrame >= durationFrames)
  ) {
    throw engineError('render_unsupported', 'Proof frame must be inside the composed timeline')
  }
  const hasStartFrame = request.startFrame !== undefined
  const hasEndFrame = request.endFrame !== undefined
  if (hasStartFrame !== hasEndFrame) {
    throw engineError('render_unsupported', 'A render range requires both startFrame and endFrame')
  }
  if (proofFrame !== undefined && hasStartFrame) {
    throw engineError('render_unsupported', 'A proof-frame render cannot also request a render range')
  }
  const requestedRange = hasStartFrame
    ? { startFrame: request.startFrame!, endFrame: request.endFrame! }
    : undefined
  if (
    requestedRange &&
    (!Number.isSafeInteger(requestedRange.startFrame) ||
      !Number.isSafeInteger(requestedRange.endFrame) ||
      requestedRange.startFrame < 0 ||
      requestedRange.endFrame <= requestedRange.startFrame ||
      requestedRange.endFrame > durationFrames)
  ) {
    throw engineError('render_unsupported', 'Render range must be inside the composed timeline')
  }
  const renderIr = flattenNestedRenderIr(project, compileRenderIr(project, {
    textPolicy: request.kind === 'subtitles' ? 'sidecar' : captionMode,
    ...(proofFrame === undefined
      ? requestedRange ? { range: requestedRange } : {}
      : { range: { startFrame: proofFrame, endFrame: proofFrame + 1 } })
  }))
  const backendCapabilities = constrainToFfmpegCompiler(
    request.backendCapabilities ?? defaultFfmpegCapabilities(),
    request.advancedEffects !== undefined
  )
  const capabilityReport = negotiateRenderIr(renderIr, backendCapabilities, request.kind)
  assertRenderIrSupported(capabilityReport)
  validateAdvancedPlans(renderIr, request)
  const playback = resolveInteractivePlayback(renderIr)
  const plan: RenderPlan = {
    schemaVersion: 1,
    projectId: project.id,
    sequenceId: renderIr.sequenceId,
    revision: project.currentRevision,
    renderKind: request.kind,
    canvas: structuredClone(project.canvas),
    fps: structuredClone(project.fps),
    durationFrames: renderIr.range.endFrame - renderIr.range.startFrame,
    renderIr,
    renderIrDigest: renderIrDigest(renderIr),
    backendCapabilitiesDigest: capabilityReport.capabilitiesDigest,
    capabilityReport,
    playback,
    verification: {
      technicalValidation: 'pending',
      visualInspection: 'not-performed'
    },
    steps: [],
    artifacts: []
  }

  if (request.kind === 'subtitles') {
    const format = request.subtitleFormat ?? 'srt'
    plan.steps.push(subtitleStep(renderIr, request.outputHandleId, format, 'subtitles'))
    plan.artifacts.push(subtitleArtifact(request.outputHandleId, format))
    return plan
  }

  const sidecarRequested = captionMode === 'sidecar' || captionMode === 'both'
  const burnedRequested = captionMode === 'burned' || captionMode === 'both'
  const subtitleFormat = request.subtitleFormat ?? 'srt'
  if (sidecarRequested && !isFinalVideoKind(request.kind)) {
    throw engineError('render_unsupported', 'Sidecar captions are supported only for a final video export')
  }
  if (burnedRequested && request.kind === 'audio-aac') {
    throw engineError('render_unsupported', 'Burned captions require a video render')
  }
  if (burnedRequested) {
    if (project.captions.length === 0) {
      throw engineError('render_unsupported', 'Burned captions were requested but the project has no captions')
    }
  }
  if (sidecarRequested) {
    if (project.captions.length === 0) {
      throw engineError('render_unsupported', 'Sidecar captions were requested but the project has no captions')
    }
    if (!request.subtitleOutputHandleId) {
      throw engineError('render_unsupported', 'Sidecar captions require an output handle')
    }
    validateOpaqueReference(request.subtitleOutputHandleId, 'subtitleOutputHandleId')
    plan.steps.push(subtitleStep(renderIr, request.subtitleOutputHandleId, subtitleFormat, 'sidecar-captions'))
    plan.artifacts.push(subtitleArtifact(request.subtitleOutputHandleId, subtitleFormat))
  }

  if (request.kind === 'proof-frame') {
    plan.steps.push(proofFrameStep(renderIr, request, burnedRequested))
    plan.artifacts.push({
      output: request.outputHandleId,
      name: `${project.id}-revision-${project.currentRevision}-proof.png`,
      mime: 'image/png',
      kind: 'image'
    })
    return plan
  }

  if (request.kind === 'audio-aac') {
    plan.steps.push(audioStep(renderIr, request.outputHandleId))
    plan.artifacts.push({
      output: request.outputHandleId,
      name: `${project.id}-revision-${project.currentRevision}.m4a`,
      mime: 'audio/mp4',
      kind: 'audio'
    })
    return plan
  }

  plan.steps.push(videoStep(renderIr, request, burnedRequested))
  plan.artifacts.push({
    output: request.outputHandleId,
    name: videoArtifactName(project.id, project.currentRevision, request.kind),
    mime: videoArtifactMime(request.kind),
    kind: 'video'
  })
  return plan
}

function constrainToFfmpegCompiler(
  observed: RenderBackendCapabilities,
  advancedEffectsPlanned: boolean
): RenderBackendCapabilities {
  const implemented: RenderBackendCapabilities = {
    ...defaultFfmpegCapabilities(),
    effects: advancedEffectsPlanned
      ? ['blur', 'color.basic', 'color.temperature', 'sharpen', 'vignette']
      : []
  }
  const intersection = (available: readonly string[], supported: readonly string[]): string[] =>
    supported.filter((entry) => available.includes(entry))
  const fonts = observed.fonts.includes('*')
    ? [...implemented.fonts]
    : intersection(observed.fonts, implemented.fonts)
  return {
    ...observed,
    codecs: intersection(observed.codecs, implemented.codecs),
    filters: intersection(observed.filters, implemented.filters),
    effects: intersection(observed.effects, implemented.effects),
    colorSpaces: intersection(observed.colorSpaces, implemented.colorSpaces),
    fonts,
    maxSources: Math.min(observed.maxSources, implemented.maxSources),
    maxLayers: Math.min(observed.maxLayers, implemented.maxLayers),
    maxTextLayers: Math.min(observed.maxTextLayers, implemented.maxTextLayers)
  }
}

function proofFrameStep(
  ir: CanonicalRenderIr,
  request: RenderRequest,
  burnedCaptions: boolean
): FfmpegRenderStep {
  const frame = request.proofFrame ?? 0
  if (!Number.isSafeInteger(frame) || frame < ir.range.startFrame || frame >= ir.range.endFrame) {
    throw engineError('render_unsupported', 'Proof frame must be inside the composed timeline')
  }
  const prepared = prepareCompositionInputs(ir, false)
  if (prepared.items.length === 0) {
    throw engineError('render_unsupported', 'Proof output requires a probed video stream')
  }
  const composition = compositionGraph(ir, prepared.items, burnedCaptions, false, request.advancedEffects)
  const proofOutput = 'proof-frame-output'
  const graph = `${composition.graph};${composition.videoOutput}` +
    `trim=start_frame=${frame}:end_frame=${frame + 1},setpts=PTS-STARTPTS[${proofOutput}]`
  assertBoundedFilterGraph(graph)
  return {
    kind: 'ffmpeg',
    id: 'proof-frame',
    inputs: prepared.inputs,
    outputs: { proof: request.outputHandleId },
    args: [
      ...prepared.args,
      '-filter_complex', graph,
      '-map', `[${proofOutput}]`,
      '-frames:v', '1',
      '-f', 'image2',
      placeholder('output', 'proof')
    ]
  }
}

function videoStep(
  ir: CanonicalRenderIr,
  request: RenderRequest,
  burnedCaptions: boolean
): FfmpegRenderStep {
  const prepared = prepareCompositionInputs(ir, true)
  if (!prepared.items.some(({ source }) => hasVisualSource(source))) {
    throw engineError('render_unsupported', 'Video output requires a probed video stream')
  }
  const { graph, videoOutput, audioOutput } = compositionGraph(
    ir,
    prepared.items,
    burnedCaptions,
    true,
    request.advancedEffects
  )
  const selected = request.advancedExport?.selected
  const outputFilters = selected?.videoFilterSuffix ?? []
  const processedVideoOutput = outputFilters.length > 0 ? '[advanced-export-video]' : videoOutput
  const outputGraph = outputFilters.length > 0
    ? `${graph};${videoOutput}${outputFilters.join(',')}[advanced-export-video]`
    : graph
  assertBoundedFilterGraph(outputGraph)
  prepared.args.push('-filter_complex', outputGraph, '-map', processedVideoOutput)
  if (audioOutput) prepared.args.push('-map', audioOutput)
  else prepared.args.push('-an')
  if (selected) {
    prepared.args.push(...selected.videoArgs)
    if (audioOutput) prepared.args.push(...selected.audioArgs)
    prepared.args.push(...selected.muxerArgs, placeholder('output', 'video'))
  } else {
    if (request.kind !== 'preview' && request.kind !== 'h264-mp4') {
      throw engineError('render_unsupported', `${request.kind} requires an advanced export negotiation plan`)
    }
    prepared.args.push(
      '-c:v', 'libx264',
      '-preset', request.kind === 'preview' ? 'veryfast' : 'medium',
      '-crf', request.kind === 'preview' ? '28' : '20',
      '-pix_fmt', 'yuv420p'
    )
    if (audioOutput) prepared.args.push('-c:a', 'aac', '-b:a', request.kind === 'preview' ? '128k' : '192k')
    prepared.args.push('-movflags', '+faststart', '-f', 'mp4', placeholder('output', 'video'))
  }
  return {
    kind: 'ffmpeg',
    id: request.kind,
    inputs: prepared.inputs,
    outputs: { video: request.outputHandleId },
    args: prepared.args
  }
}

function validateAdvancedPlans(ir: CanonicalRenderIr, request: RenderRequest): void {
  const rendersVisual = request.kind === 'proof-frame' || request.kind === 'preview' || isFinalVideoKind(request.kind)
  const enabledEffects = rendersVisual ? ir.layers
    .flatMap((layer) => layer.effects.filter(({ enabled }) => enabled)) : []
  const enabledEffectIds = enabledEffects.map(({ id }) => id).sort()
  const plannedEffectIds = request.advancedEffects?.layers
    .flatMap((layer) => layer.filters.map(({ effectId }) => effectId))
    .sort() ?? []
  if (enabledEffectIds.length > 0 && !request.advancedEffects) {
    throw engineError(
      'render_unsupported',
      'Enabled effects require an explicit negotiated execution plan',
      {
        unsupported: enabledEffects.map((effect) => ({
          nodeId: effect.id,
          nodeType: 'effect',
          capability: `effect:${effect.type}`,
          message: `Effect ${effect.type} has no pinned execution plan.`,
          guidance: 'Negotiate the effect against the current backend before starting this render.'
        }))
      }
    )
  }
  if (request.advancedEffects) {
    const expectedTarget = request.kind === 'proof-frame' || request.kind === 'preview'
      ? 'preview'
      : 'export'
    if (
      !request.advancedEffects.supported ||
      request.advancedEffects.projectId !== ir.projectId ||
      request.advancedEffects.sequenceId !== ir.sequenceId ||
      request.advancedEffects.revision !== ir.revision ||
      request.advancedEffects.renderIrDigest !== renderIrDigest(ir) ||
      request.advancedEffects.target !== expectedTarget ||
      request.advancedEffects.acceleration.selected !== 'cpu' ||
      JSON.stringify(plannedEffectIds) !== JSON.stringify(enabledEffectIds)
    ) {
      throw engineError(
        'render_unsupported',
        'Advanced effect plan does not exactly match the pinned Render IR or the bounded CPU executor'
      )
    }
  }
  if (request.advancedExport) {
    if (
      !isFinalVideoKind(request.kind) ||
      !request.advancedExport.supported ||
      !request.advancedExport.selected ||
      request.advancedExport.projectId !== ir.projectId ||
      request.advancedExport.sequenceId !== ir.sequenceId ||
      request.advancedExport.revision !== ir.revision ||
      request.advancedExport.renderIrDigest !== renderIrDigest(ir) ||
      request.advancedExport.selected.format !== request.kind
    ) {
      throw engineError('render_unsupported', 'Advanced export plan does not match the pinned Render IR and selected format')
    }
  } else if (request.kind === 'h265-mp4' || request.kind === 'prores-mov' || request.kind === 'ffv1-mkv') {
    throw engineError('render_unsupported', `${request.kind} requires an explicit negotiated export plan`)
  }
}
