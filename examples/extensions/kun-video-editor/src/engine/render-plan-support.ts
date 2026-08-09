import { engineError } from './errors.js'
import type {
  FfmpegRenderStep,
  PlannedArtifact,
  RenderInputReference,
  RenderKind,
  TextRenderStep
} from './render-plan.js'
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

export function isFinalVideoKind(kind: RenderKind): kind is 'h264-mp4' | 'h265-mp4' | 'prores-mov' | 'ffv1-mkv' {
  return kind === 'h264-mp4' || kind === 'h265-mp4' || kind === 'prores-mov' || kind === 'ffv1-mkv'
}

export function videoArtifactName(projectId: string, revision: number, kind: RenderKind): string {
  if (kind === 'preview') return `${projectId}-revision-${revision}-preview.mp4`
  const extension = kind === 'prores-mov' ? 'mov' : kind === 'ffv1-mkv' ? 'mkv' : 'mp4'
  return `${projectId}-revision-${revision}.${extension}`
}

export function videoArtifactMime(kind: RenderKind): string {
  return kind === 'prores-mov'
    ? 'video/quicktime'
    : kind === 'ffv1-mkv'
      ? 'video/x-matroska'
      : 'video/mp4'
}

export function prepareCompositionInputs(
  ir: CanonicalRenderIr,
  includeAudioOnlyItems: boolean
): {
    inputs: Record<string, RenderInputReference>
    args: string[]
    items: Array<{ layer: RenderIrMediaLayer; source: RenderIrSource; inputIndex: number }>
  } {
  const inputs: Record<string, RenderInputReference> = {}
  const args = ['-nostdin']
  const items: Array<{ layer: RenderIrMediaLayer; source: RenderIrSource; inputIndex: number }> = []
  for (const layer of ir.layers) {
    if (layer.source.kind !== 'asset') {
      throw engineError('render_unsupported', `Nested sequence layer ${layer.id} requires a composed proxy backend`)
    }
    const sourceId = layer.source.sourceId
    const source = ir.sources.find(({ id }) => id === sourceId)
    if (!source) throw engineError('invalid_project', `Missing Render IR source ${sourceId}`)
    if (!includeAudioOnlyItems && !hasVisualSource(source)) continue
    // Media placeholders are part of the public broker request and therefore
    // have their own bounded identifier budget. Timeline ids grow after
    // repeated transcript cuts (`-part-N`), so never derive a binding key from
    // the user/project-controlled id.
    const inputName = `clip-${items.length}`
    inputs[inputName] = structuredClone(source.reference)
    if (source.still?.animated === false) {
      args.push('-loop', '1', '-framerate', `${ir.fps.numerator}/${ir.fps.denominator}`)
    } else if (source.still?.animated === true && source.still.loop) {
      args.push('-stream_loop', '-1')
    }
    args.push(
      '-ss', microsecondsToSecondsArgument(layer.sourceMap.startUs),
      '-t', microsecondsToSecondsArgument(layer.sourceMap.endUs - layer.sourceMap.startUs),
      '-i', placeholder('input', inputName)
    )
    items.push({ layer, source, inputIndex: items.length })
  }
  return { inputs, args, items }
}

export function audioStep(ir: CanonicalRenderIr, outputHandleId: string): FfmpegRenderStep {
  const inputs: Record<string, RenderInputReference> = {}
  const args = ['-nostdin']
  const audioFilters: string[] = []
  let inputIndex = 0
  for (const layer of ir.layers) {
    if (layer.source.kind !== 'asset') {
      throw engineError('render_unsupported', `Nested sequence layer ${layer.id} requires a composed proxy backend`)
    }
    const sourceId = layer.source.sourceId
    const source = ir.sources.find(({ id }) => id === sourceId)
    if (!source) throw engineError('invalid_project', `Missing Render IR source ${sourceId}`)
    if (!source.audio || !layer.audio.enabled) continue
    const name = `clip-${inputIndex}`
    inputs[name] = structuredClone(source.reference)
    args.push(
      '-ss', microsecondsToSecondsArgument(layer.sourceMap.startUs),
      '-t', microsecondsToSecondsArgument(layer.sourceMap.endUs - layer.sourceMap.startUs),
      '-i', placeholder('input', name)
    )
    const delay = Math.floor(framesToMicroseconds(layer.timeline.startFrame, ir.fps) / 1000)
    audioFilters.push(
      `[${inputIndex}:a]asetpts=(PTS-STARTPTS)/${layer.sourceMap.speed.numerator}*${layer.sourceMap.speed.denominator},` +
      `${audioFadeFilters(layer, ir.fps)}adelay=${delay}:all=1,volume=${layer.audio.volume.toFixed(4)}[a${inputIndex}]`
    )
    inputIndex += 1
  }
  if (audioFilters.length === 0) {
    throw engineError('render_unsupported', 'Audio output requires a probed audio stream')
  }
  const labels = audioFilters.map((_filter, index) => `[a${index}]`).join('')
  const graph = `${audioFilters.join(';')};${labels}amix=inputs=${audioFilters.length}:normalize=0[aout]`
  args.push(
    '-filter_complex', graph,
    '-map', '[aout]',
    '-vn',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-f', 'mp4',
    placeholder('output', 'audio')
  )
  return {
    kind: 'ffmpeg',
    id: 'audio-aac',
    inputs,
    outputs: { audio: outputHandleId },
    args
  }
}

export function compositionGraph(
  ir: CanonicalRenderIr,
  items: Array<{ layer: RenderIrMediaLayer; source: RenderIrSource; inputIndex: number }>,
  burnedCaptions: boolean,
  includeAudio: boolean,
  advancedEffects?: AdvancedEffectExecutionPlan
): { graph: string; videoOutput: string; audioOutput?: string } {
  if (canUseSequentialConcat(items, burnedCaptions, includeAudio)) {
    return sequentialCompositionGraph(ir, items, includeAudio)
  }

  // The color source duration option accepts a decimal duration, but FFmpeg 8
  // no longer accepts the rational frame expression used by timeline filters.
  const duration = microsecondsToSecondsArgument(
    framesToMicroseconds(ir.range.endFrame, ir.fps)
  )
  const filters = [
    `color=c=${ir.canvas.background}:s=${ir.canvas.width}x${ir.canvas.height}:r=${ir.fps.numerator}/${ir.fps.denominator}:d=${duration}[base]`
  ]
  let videoLabel = 'base'
  const audioLabels: string[] = []
  for (const { layer, source, inputIndex } of items) {
    const start = frameToSecondsArgument(layer.timeline.startFrame, ir.fps)
    const end = frameToSecondsArgument(layer.timeline.endFrame, ir.fps)
    if (hasVisualSource(source)) {
      const prepared = `vprep${inputIndex}`
      const next = `vcomp${inputIndex}`
      const advancedFilter = advancedEffects?.layers.find(({ layerId }) => layerId === layer.id)?.filterChain
      filters.push(
        `[${inputIndex}:v]setpts=(PTS-STARTPTS)/${layer.sourceMap.speed.numerator}*${layer.sourceMap.speed.denominator},` +
        `${geometryFilter(ir, layer)},${advancedFilter ? `${advancedFilter},` : ''}${visualFadeFilters(layer)}format=rgba,` +
        `colorchannelmixer=aa=${layer.visual.opacity.toFixed(4)},setpts=PTS+${start}/TB[${prepared}]`
      )
      const x = `(W-w)/2+${layer.visual.transform.x.toFixed(3)}`
      const y = `(H-h)/2+${layer.visual.transform.y.toFixed(3)}`
      filters.push(
        `[${videoLabel}][${prepared}]overlay=x='${x}':y='${y}':eof_action=pass:enable='between(t,${start},${end})'[${next}]`
      )
      videoLabel = next
    }
    if (includeAudio && source.audio && layer.audio.enabled) {
      const delay = Math.floor(framesToMicroseconds(layer.timeline.startFrame, ir.fps) / 1000)
      const audioLabel = `a${inputIndex}`
      filters.push(
        `[${inputIndex}:a]asetpts=(PTS-STARTPTS)/${layer.sourceMap.speed.numerator}*${layer.sourceMap.speed.denominator},` +
        `${audioFadeFilters(layer, ir.fps)}adelay=${delay}:all=1,volume=${layer.audio.volume.toFixed(4)}[${audioLabel}]`
      )
      audioLabels.push(audioLabel)
    }
  }
  if (burnedCaptions) {
    for (const [index, caption] of ir.textLayers.entries()) {
      const next = `captioned${index}`
      const fontSize = Math.round(caption.style.fontSize)
      const fontColor = safeCaptionColor(caption.style.color, 'FFFFFF')
      const boxColor = safeCaptionColor(caption.style.background, '000000')
      const y = caption.placement === 'top'
        ? 'h/12'
        : caption.placement === 'center'
          ? '(h-text_h)/2'
          : 'h-text_h-h/12'
      const start = frameToSecondsArgument(caption.timeline.startFrame, ir.fps)
      const end = frameToSecondsArgument(caption.timeline.endFrame, ir.fps)
      filters.push(
        `[${videoLabel}]drawtext=text=${escapeDrawtextText(caption.text)}` +
        `:font=${escapeDrawtextText(caption.style.fontFamily)}` +
        `:expansion=none:fontcolor=0x${fontColor}:fontsize=${fontSize}` +
        `:box=1:boxcolor=0x${boxColor}@0.65:boxborderw=12` +
        `:x=(w-text_w)/2:y=${y}:enable='between(t,${start},${end})'[${next}]`
      )
      videoLabel = next
    }
  }
  let audioOutput: string | undefined
  if (audioLabels.length > 0) {
    filters.push(`${audioLabels.map((label) => `[${label}]`).join('')}amix=inputs=${audioLabels.length}:normalize=0[aout]`)
    audioOutput = '[aout]'
  }
  const graph = filters.join(';')
  assertBoundedFilterGraph(graph)
  return { graph, videoOutput: `[${videoLabel}]`, audioOutput }
}

/**
 * Ordinary transcript edits produce many adjacent cuts on one track. Building
 * those as overlays repeats the base canvas and timing expression for every
 * clip and crosses the public 8 KiB per-argument limit at roughly 25 cuts.
 * A concat graph is both semantically simpler and substantially smaller.
 */
export function sequentialCompositionGraph(
  ir: CanonicalRenderIr,
  items: Array<{ layer: RenderIrMediaLayer; source: RenderIrSource; inputIndex: number }>,
  includeAudio: boolean
): { graph: string; videoOutput: string; audioOutput?: string } {
  const hasAudio = includeAudio && items.every(({ source, layer }) =>
    source.audio !== undefined && layer.audio.enabled)
  const filters: string[] = []
  const concatInputs: string[] = []

  for (const { layer, inputIndex } of items) {
    const videoLabel = `v${inputIndex}`
    filters.push(
      `[${inputIndex}:v]setpts=(PTS-STARTPTS)/${layer.sourceMap.speed.numerator}*${layer.sourceMap.speed.denominator},` +
      `${sequentialGeometryFilter(ir, layer.visual.fit)},settb=AVTB[${videoLabel}]`
    )
    concatInputs.push(`[${videoLabel}]`)
    if (hasAudio) {
      const audioLabel = `a${inputIndex}`
      filters.push(
        `[${inputIndex}:a]asetpts=(PTS-STARTPTS)/${layer.sourceMap.speed.numerator}*${layer.sourceMap.speed.denominator},` +
        `aresample=async=1:first_pts=0[${audioLabel}]`
      )
      concatInputs.push(`[${audioLabel}]`)
    }
  }

  filters.push(
    `${concatInputs.join('')}concat=n=${items.length}:v=1:a=${hasAudio ? 1 : 0}` +
    (hasAudio ? '[vout][aout]' : '[vout]')
  )
  const graph = filters.join(';')
  assertBoundedFilterGraph(graph)
  return {
    graph,
    videoOutput: '[vout]',
    ...(hasAudio ? { audioOutput: '[aout]' } : {})
  }
}

export function canUseSequentialConcat(
  items: Array<{ layer: RenderIrMediaLayer; source: RenderIrSource; inputIndex: number }>,
  burnedCaptions: boolean,
  includeAudio: boolean
): boolean {
  if (burnedCaptions || items.length === 0) return false
  const firstTrackId = items[0]!.layer.trackId
  const audioPresence = items[0]!.source.audio !== undefined && items[0]!.layer.audio.enabled
  let cursor = 0
  for (const { layer, source } of items) {
    if (
      !hasVisualSource(source) ||
      layer.trackId !== firstTrackId ||
      layer.timeline.startFrame !== cursor ||
      layer.visual.transform.x !== 0 ||
      layer.visual.transform.y !== 0 ||
      layer.visual.transform.scaleX !== 1 ||
      layer.visual.transform.scaleY !== 1 ||
      layer.visual.transform.rotation !== 0 ||
      Object.values(layer.visual.crop).some((value) => value !== 0) ||
      layer.visual.opacity !== 1 ||
      layer.visual.fadeInFrames !== 0 ||
      layer.visual.fadeOutFrames !== 0 ||
      layer.effects.some(({ enabled }) => enabled) ||
      layer.keyframes.length > 0 ||
      (includeAudio && (source.audio !== undefined && layer.audio.enabled) !== audioPresence)
    ) {
      return false
    }
    cursor += layer.timeline.endFrame - layer.timeline.startFrame
  }
  return true
}

export function hasVisualSource(source: RenderIrSource): boolean {
  return source.video !== undefined || source.still !== undefined
}

export function assertBoundedFilterGraph(graph: string): void {
  if (graph.length <= 8_000) return
  throw engineError(
    'render_unsupported',
    'The composed filter graph exceeds the bounded FFmpeg request size; shorten captions or timeline complexity'
  )
}

export function escapeDrawtextText(value: string): string {
  const normalized = value
    .replace(/\r\n?/gu, '\n')
    .split('')
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code === 9 || code === 10 || (code >= 32 && code !== 127)
    })
    .join('')
    .replace(/\n/gu, ' ')
    .trim()
  if (!normalized) throw engineError('render_unsupported', 'A burned caption cannot be empty')
  // FFmpeg applies one escaping layer to the drawtext option and a second to
  // the enclosing filtergraph. This is an argv element, so there is no shell
  // escaping layer. Keep expansion=none so percent sequences stay literal.
  return [...normalized].map(escapeDrawtextCharacter).join('')
}

/** Apply drawtext-option escaping before filtergraph escaping for one input character. */
export function escapeDrawtextCharacter(character: string): string {
  const optionEscaped = requiresDrawtextOptionEscape(character) ? `\\${character}` : character
  return [...optionEscaped]
    .map((part) => requiresFiltergraphEscape(part) ? `\\${part}` : part)
    .join('')
}

export function requiresDrawtextOptionEscape(character: string): boolean {
  return character === '\\' || character === "'" || character === ':'
}

export function requiresFiltergraphEscape(character: string): boolean {
  return character === '\\' || character === "'" || character === '[' ||
    character === ']' || character === ',' || character === ';'
}

export function safeCaptionColor(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback
  const match = /^#?([0-9A-Fa-f]{6})$/u.exec(value)
  if (!match) {
    throw engineError('render_unsupported', 'Burned caption colors must use six-digit hexadecimal values')
  }
  return match[1]!.toUpperCase()
}

export function geometryFilter(ir: CanonicalRenderIr, layer: RenderIrMediaLayer): string {
  const crop = layer.visual.crop
  const sourceCrop = Object.values(crop).some((value) => value !== 0)
    ? `crop=iw*${(1 - crop.left - crop.right).toFixed(6)}:` +
      `ih*${(1 - crop.top - crop.bottom).toFixed(6)}:` +
      `iw*${crop.left.toFixed(6)}:ih*${crop.top.toFixed(6)},`
    : ''
  const baseGeometry = layer.visual.fit === 'crop'
    ? `scale=${ir.canvas.width}:${ir.canvas.height}:force_original_aspect_ratio=increase,` +
      `crop=${ir.canvas.width}:${ir.canvas.height},setsar=1`
    : layer.visual.fit === 'pad'
      ? sequentialGeometryFilter(ir, layer.visual.fit)
      : `scale=${ir.canvas.width}:${ir.canvas.height}:force_original_aspect_ratio=decrease,setsar=1`
  // Apply item transforms only after the source has been fitted to the canvas.
  // Scaling the target first made crop mode request (for example) a 640x360
  // crop from a 320x180 image whenever the item scale was 0.5.
  const transformed = layer.visual.transform.scaleX === 1 && layer.visual.transform.scaleY === 1
    ? baseGeometry
    : `${baseGeometry},scale=iw*${layer.visual.transform.scaleX.toFixed(6)}:` +
      `ih*${layer.visual.transform.scaleY.toFixed(6)}`
  const rotation = layer.visual.transform.rotation === 0
    ? ''
    : `,rotate=${(layer.visual.transform.rotation * Math.PI / 180).toFixed(8)}:c=none`
  return `${sourceCrop}${transformed}${rotation}`
}

export function sequentialGeometryFilter(
  ir: CanonicalRenderIr,
  fit: RenderIrMediaLayer['visual']['fit']
): string {
  if (fit === 'crop') {
    return `scale=${ir.canvas.width}:${ir.canvas.height}:force_original_aspect_ratio=increase,` +
      `crop=${ir.canvas.width}:${ir.canvas.height},setsar=1`
  }
  return `scale=${ir.canvas.width}:${ir.canvas.height}:force_original_aspect_ratio=decrease,` +
    `pad=${ir.canvas.width}:${ir.canvas.height}:(ow-iw)/2:(oh-ih)/2:${ir.canvas.background},` +
    'setsar=1'
}

export function visualFadeFilters(layer: RenderIrMediaLayer): string {
  const duration = layer.timeline.endFrame - layer.timeline.startFrame
  const filters: string[] = []
  if (layer.visual.fadeInFrames > 0) {
    filters.push(`fade=t=in:start_frame=0:nb_frames=${layer.visual.fadeInFrames}:alpha=1`)
  }
  if (layer.visual.fadeOutFrames > 0) {
    filters.push(
      `fade=t=out:start_frame=${Math.max(0, duration - layer.visual.fadeOutFrames)}` +
      `:nb_frames=${layer.visual.fadeOutFrames}:alpha=1`
    )
  }
  return filters.length > 0 ? `${filters.join(',')},` : ''
}

export function audioFadeFilters(layer: RenderIrMediaLayer, fps: CanonicalRenderIr['fps']): string {
  const filters: string[] = []
  if (layer.audio.fadeInFrames > 0) {
    filters.push(`afade=t=in:st=0:d=${frameToSecondsArgument(layer.audio.fadeInFrames, fps)}`)
  }
  if (layer.audio.fadeOutFrames > 0) {
    const durationFrames = layer.timeline.endFrame - layer.timeline.startFrame
    filters.push(
      `afade=t=out:st=${frameToSecondsArgument(Math.max(0, durationFrames - layer.audio.fadeOutFrames), fps)}` +
      `:d=${frameToSecondsArgument(layer.audio.fadeOutFrames, fps)}`
    )
  }
  return filters.length > 0 ? `${filters.join(',')},` : ''
}

export function subtitleStep(
  ir: CanonicalRenderIr,
  output: string,
  format: SubtitleFormat,
  id: string
): TextRenderStep {
  return {
    kind: 'write-text',
    id,
    output,
    mime: format === 'srt' ? 'application/x-subrip' : 'text/vtt',
    content: generateSubtitles(ir.textLayers.map((text) => ({
      id: text.id,
      trackId: text.trackId,
      startFrame: text.timeline.startFrame,
      endFrame: text.timeline.endFrame,
      text: text.text,
      placement: text.placement,
      style: structuredClone(text.style),
      words: structuredClone(text.words),
      animation: structuredClone(text.animation)
    })), ir.fps, format)
  }
}

export function subtitleArtifact(output: string, format: SubtitleFormat): PlannedArtifact {
  return {
    output,
    name: `captions.${format}`,
    mime: format === 'srt' ? 'application/x-subrip' : 'text/vtt',
    kind: 'subtitle'
  }
}

export function placeholder(kind: 'input' | 'output', name: string): string {
  return `{{${kind}:${name}}}`
}

export function validateOpaqueReference(value: string, label: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    value.includes('\0') ||
    value.includes('\r') ||
    value.includes('\n')
  ) {
    throw engineError('render_unsupported', `${label} must be a bounded opaque reference`)
  }
}
