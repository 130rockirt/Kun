import {
  useEffect,
  useRef,
  useState,
  type CSSProperties
} from 'react'
import type { EditorController } from './controller.js'
import { formatMessage, type Messages } from './i18n.js'
import { SpatialTimeline, linkedMoveOperations, linkedTrimOperations } from './spatial-timeline.js'
import {
  VIEW_LIMITS,
  frameToSeconds,
  projectFrameFromSourceTime,
  type CaptionProjection,
  type ItemProjection,
  type ProjectProjection,
  type TimelineOperation,
  type TimelineSource
} from './model.js'
import {
  EmptyState,
  Panel,
  agentStateLabel,
  compatibleTracks,
  deleteTimelineItem,
  formatTime,
  formatTimestamp,
  projectChangeReasonLabel,
  revisionAuthorLabel,
  revisionSummaryLabel,
  speakerAttributionLabel,
  splitAtPlayhead,
  trackDisplayName
} from './app-common.js'
import { WorkbenchIcon } from './app-shell.js'

export function MediaPlayer(props: {
  url?: string
  kind?: string
  title?: string
  project: ProjectProjection
  timelineSource?: TimelineSource
  caption?: CaptionProjection
  playheadFrame: number
  playing: boolean
  onSeek(frame: number): void
  onPlaybackChange(playing: boolean): void
  onResourceError(): void
  messages: Messages
}): React.JSX.Element {
  const mediaRef = useRef<HTMLMediaElement | null>(null)
  const seconds = props.timelineSource
    ? props.timelineSource.sourceTimeUs / 1_000_000
    : frameToSeconds(props.project, props.playheadFrame)
  useEffect(() => {
    const media = mediaRef.current
    if (media && Math.abs(media.currentTime - seconds) > 0.2) media.currentTime = seconds
  }, [props.url, seconds])
  useEffect(() => {
    const media = mediaRef.current
    if (!media) return
    media.playbackRate = props.timelineSource?.playbackRate ?? 1
    if (props.playing) void media.play().catch(() => props.onPlaybackChange(false))
    else media.pause()
  }, [props.playing, props.timelineSource?.playbackRate, props.url])
  const bind = (element: HTMLMediaElement | null): void => { mediaRef.current = element }
  const update = (): void => {
    const media = mediaRef.current
    if (!media) return
    props.onSeek(props.timelineSource
      ? projectFrameFromSourceTime(props.project, props.timelineSource, media.currentTime)
      : Math.round(media.currentTime * props.project.fps.numerator / props.project.fps.denominator))
  }
  if (!props.url) {
    return <div className={`player-stage aspect-${props.project.canvas.preset.replace(':', '-')}`}><EmptyState>{props.messages.selectMediaPreview}</EmptyState></div>
  }
  if (props.kind === 'image') {
    return <div className={`player-stage aspect-${props.project.canvas.preset.replace(':', '-')}`}><img src={props.url} alt={props.title ? `${props.messages.proofFrame}: ${props.title}` : props.messages.generatedProofFrame} onError={props.onResourceError} /></div>
  }
  if (props.kind === 'audio') {
    return <div className="player-stage audio-stage"><div className="audio-visual" aria-hidden="true">{props.messages.audioAbbreviation}</div><audio ref={bind} src={props.url} controls onTimeUpdate={update} onPlay={() => props.onPlaybackChange(true)} onPause={() => props.onPlaybackChange(false)} onError={props.onResourceError} aria-label={props.title ?? props.messages.audioPreview} />{props.caption && <CaptionOverlay caption={props.caption} />}</div>
  }
  const videoStyle: CSSProperties = props.timelineSource ? {
    objectFit: props.project.canvas.fit === 'crop' ? 'cover' : 'contain',
    opacity: props.timelineSource.item.opacity,
    transform: `translate(${props.timelineSource.item.transform.x}px, ${props.timelineSource.item.transform.y}px) scale(${props.timelineSource.item.transform.scaleX}, ${props.timelineSource.item.transform.scaleY}) rotate(${props.timelineSource.item.transform.rotation}deg)`
  } : {}
  return <div className={`player-stage aspect-${props.project.canvas.preset.replace(':', '-')}`} style={{ background: props.project.canvas.background }}><video ref={bind} src={props.url} style={videoStyle} controls playsInline onTimeUpdate={update} onPlay={() => props.onPlaybackChange(true)} onPause={() => props.onPlaybackChange(false)} onError={props.onResourceError} aria-label={props.title ?? props.messages.videoPreview} />{props.caption && <CaptionOverlay caption={props.caption} />}</div>
}

export function CaptionOverlay({ caption }: { caption: CaptionProjection }): React.JSX.Element {
  return <div
    className={`caption-overlay caption-${caption.placement}`}
    style={{
      color: caption.style?.color,
      background: caption.style?.background,
      fontSize: caption.style?.fontSize
    }}
  >{caption.text}</div>
}

export function PlayerControls({ controller, project, messages }: { controller: EditorController; project: ProjectProjection; messages: Messages }): React.JSX.Element {
  return (
    <div className="transport" aria-label={messages.playerControls}>
      <button type="button" className="transport-icon" aria-label="-5s" title="-5s" onClick={() => controller.seek(Math.max(0, controller.state.playheadFrame - Math.round(project.fps.numerator / project.fps.denominator * 5)))}><WorkbenchIcon name="back" /></button>
      <button type="button" className="primary-transport transport-icon" aria-label={controller.state.playing ? messages.pause : messages.play} aria-pressed={controller.state.playing} onClick={controller.togglePlaying}><WorkbenchIcon name={controller.state.playing ? 'pause' : 'play'} /><span className="sr-only">{controller.state.playing ? messages.pause : messages.play}</span></button>
      <button type="button" className="transport-icon" aria-label="+5s" title="+5s" onClick={() => controller.seek(Math.min(project.durationFrames, controller.state.playheadFrame + Math.round(project.fps.numerator / project.fps.denominator * 5)))}><WorkbenchIcon name="forward" /></button>
      <label className="scrubber"><span>{messages.timelinePosition}</span><input type="range" min={0} max={Math.max(1, project.durationFrames)} value={controller.state.playheadFrame} onChange={(event) => controller.seek(Number(event.target.value))} /></label>
      <output>{formatTime(frameToSeconds(project, controller.state.playheadFrame))} / {formatTime(frameToSeconds(project, project.durationFrames))}</output>
    </div>
  )
}

export function TimelinePanel({ controller, messages }: { controller: EditorController; messages: Messages }): React.JSX.Element {
  const project = controller.state.project!
  return (
    <Panel title={messages.timeline} className="timeline-panel">
      <SpatialTimeline controller={controller} messages={messages} />
      <EditToolbar controller={controller} project={project} messages={messages} />
    </Panel>
  )
}

export function EditToolbar({ controller, project, messages }: { controller: EditorController; project: ProjectProjection; messages: Messages }): React.JSX.Element {
  const item = project.items.find(({ id }) => id === controller.state.selectedItemId)
  const [trimStart, setTrimStart] = useState(0)
  const [trimEnd, setTrimEnd] = useState(0)
  const [trackId, setTrackId] = useState('')
  const [beforeItemId, setBeforeItemId] = useState('')
  useEffect(() => {
    if (!item) return
    setTrimStart(item.timelineStartFrame)
    setTrimEnd(item.timelineStartFrame + item.durationFrames)
    setTrackId(item.trackId)
  }, [item])
  return (
    <div className="edit-toolbar" aria-label={messages.manualTimelineEditing}>
      <div className="selection-quick-summary" data-empty={item ? 'false' : 'true'}>
        <span className="selection-quick-icon"><WorkbenchIcon name="clips" /></span>
        <span><strong>{item?.id ?? messages.timeline}</strong><small>{item ? `${item.durationFrames}f · ${trackDisplayName(messages, project.tracks.find(({ id }) => id === item.trackId) ?? project.tracks[0]!)}` : messages.noSelection}</small></span>
      </div>
      <div className="selection-quick-actions">
        <button type="button" aria-label={messages.splitAtPlayhead} onClick={() => item && void splitAtPlayhead(controller, project, item, messages)} disabled={!item}><WorkbenchIcon name="split" /><span>{messages.splitAtPlayhead}</span></button>
        <button type="button" className="danger-button" aria-label={messages.deleteItem} onClick={() => item && window.confirm(messages.deleteItemConfirm) && void deleteTimelineItem(controller, project, item, messages)} disabled={!item}><WorkbenchIcon name="delete" /><span>{messages.deleteItem}</span></button>
        <button type="button" aria-label={messages.workspaceProperties} onClick={() => controller.setActiveWorkspace('properties')} disabled={!item}><WorkbenchIcon name="properties" /><span>{messages.workspaceProperties}</span></button>
      </div>
      <details className="precision-edit">
        <summary>{messages.manualTimelineEditing}</summary>
        <div className="precision-edit-grid">
          <label><span>{messages.trimIn} ({messages.frames})</span><input type="number" min={item?.timelineStartFrame ?? 0} max={trimEnd - 1} value={trimStart} onChange={(event) => setTrimStart(Number(event.target.value))} disabled={!item} /></label>
          <label><span>{messages.trimOut} ({messages.frames})</span><input type="number" min={trimStart + 1} max={item ? item.timelineStartFrame + item.durationFrames : 1} value={trimEnd} onChange={(event) => setTrimEnd(Number(event.target.value))} disabled={!item} /></label>
          <button type="button" disabled={!item} onClick={() => item && applyToolbarTrim(controller, project, item, trimStart, trimEnd, messages)}>{messages.applyTrim}</button>
          <label><span>{messages.track}</span><select value={trackId} onChange={(event) => setTrackId(event.target.value)} disabled={!item}>{compatibleTracks(project.tracks, item).map((track) => <option key={track.id} value={track.id}>{trackDisplayName(messages, track)}</option>)}</select></label>
          <button type="button" disabled={!item || !trackId} onClick={() => item && applyToolbarMove(controller, project, item, trackId, messages)}>{messages.moveTrack}</button>
          <label><span>{messages.placeBefore}</span><select value={beforeItemId} onChange={(event) => setBeforeItemId(event.target.value)} disabled={!item}><option value="">{messages.endOfTrack}</option>{project.items.filter((candidate) => candidate.trackId === item?.trackId && candidate.id !== item?.id).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.id}</option>)}</select></label>
          <button type="button" disabled={!item} onClick={() => item && void controller.applyOperations([{ type: 'reorder-item', itemId: item.id, ...(beforeItemId ? { beforeItemId } : {}) }], formatMessage(messages.reorderSummary, { id: item.id }))}>{messages.reorder}</button>
        </div>
      </details>
    </div>
  )
}

export function applyToolbarTrim(
  controller: EditorController,
  project: ProjectProjection,
  item: ItemProjection,
  startFrame: number,
  endFrame: number,
  messages: Messages
): void {
  const operations = linkedTrimOperations(project, item, startFrame, endFrame)
  if (operations.length === 0) return
  void controller.applyOperations(
    operations,
    formatMessage(operations.length > 1 ? messages.trimLinkedSummary : messages.trimSummary, { id: item.id })
  )
}

export function applyToolbarMove(
  controller: EditorController,
  project: ProjectProjection,
  item: ItemProjection,
  trackId: string,
  messages: Messages
): void {
  const operations = linkedMoveOperations(project, item, item.timelineStartFrame, trackId)
  if (operations.length === 0) return
  void controller.applyOperations(
    operations,
    formatMessage(operations.length > 1 ? messages.moveLinkedSummary : messages.moveSummary, { id: item.id })
  )
}

const KEYFRAME_PROPERTIES = [
  'transform.x', 'transform.y', 'transform.scaleX', 'transform.scaleY', 'transform.rotation',
  'crop.left', 'crop.top', 'crop.right', 'crop.bottom', 'opacity', 'volume'
] as const

const EFFECT_CATALOG = [
  { type: 'color.basic', label: (messages: Messages) => messages.effectColorBasic, parameters: {
    brightness: { defaultValue: 0, min: -1, max: 1, step: 0.01 },
    contrast: { defaultValue: 1, min: 0, max: 2, step: 0.01 },
    saturation: { defaultValue: 1, min: 0, max: 3, step: 0.01 },
    gamma: { defaultValue: 1, min: 0.1, max: 10, step: 0.05 }
  } },
  { type: 'color.temperature', label: (messages: Messages) => messages.effectColorTemperature, parameters: {
    temperature: { defaultValue: 0, min: -1, max: 1, step: 0.01 },
    tint: { defaultValue: 0, min: -1, max: 1, step: 0.01 }
  } },
  { type: 'blur', label: (messages: Messages) => messages.effectBlur, parameters: {
    radius: { defaultValue: 2, min: 0, max: 100, step: 1 }
  } },
  { type: 'sharpen', label: (messages: Messages) => messages.effectSharpen, parameters: {
    amount: { defaultValue: 1, min: 0, max: 5, step: 0.05 }
  } },
  { type: 'vignette', label: (messages: Messages) => messages.effectVignette, parameters: {
    intensity: { defaultValue: 0.35, min: 0, max: 1, step: 0.01 }
  } }
] as const

export function EffectRow(props: {
  item: ItemProjection
  effect: NonNullable<ItemProjection['effects']>[number]
  controller: EditorController
  messages: Messages
}): React.JSX.Element {
  const { item, effect, controller, messages } = props
  const [parameters, setParameters] = useState(effect.parameters)
  useEffect(() => setParameters(effect.parameters), [effect.parameters])
  const definition = EFFECT_CATALOG.find(({ type }) => type === effect.type)
  const update = (next: Partial<typeof effect> = {}): void => {
    void controller.applyOperations([{
      type: 'set-item-effects',
      itemId: item.id,
      effects: (item.effects ?? []).map((candidate) => candidate.id === effect.id
        ? { ...candidate, ...next, parameters }
        : candidate)
    }], formatMessage(messages.effectUpdatedSummary, { effect: effect.type, id: item.id }))
  }
  const remove = (): void => {
    const keyframes = (item.keyframes ?? []).filter(({ property }) => !property.startsWith(`effect.${effect.id}.`))
    void controller.applyOperations([
      { type: 'set-item-keyframes', itemId: item.id, keyframes },
      { type: 'set-item-effects', itemId: item.id, effects: (item.effects ?? []).filter(({ id }) => id !== effect.id) }
    ], formatMessage(messages.effectRemovedSummary, { effect: effect.type, id: item.id }))
  }
  return <article className="effect-row">
    <header><label><input type="checkbox" checked={effect.enabled} onChange={(event) => update({ enabled: event.target.checked })} />{definition?.label(messages) ?? effect.type}</label><button type="button" onClick={remove}>{messages.remove}</button></header>
    <div className="effect-parameters">{Object.entries(parameters).map(([key, value]) => {
      const parameter = definition?.parameters[key as keyof typeof definition.parameters] as { min: number; max: number; step: number } | undefined
      return typeof value === 'number'
        ? <label key={key}><span>{key}</span><input type="number" min={parameter?.min} max={parameter?.max} step={parameter?.step ?? 0.01} value={value} onChange={(event) => setParameters((current) => ({ ...current, [key]: Number(event.target.value) }))} onBlur={() => update()} /></label>
        : null
    })}</div>
  </article>
}

export function decimalRational(value: number): { numerator: number; denominator: number } {
  const denominator = 1_000
  const numerator = Math.max(1, Math.round(value * denominator))
  const divisor = greatestCommonDivisor(numerator, denominator)
  return { numerator: numerator / divisor, denominator: denominator / divisor }
}

export function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(left)
  let b = Math.abs(right)
  while (b > 0) [a, b] = [b, a % b]
  return a || 1
}

export function InspectorPanel(props: { controller: EditorController; item?: ItemProjection; caption?: CaptionProjection; messages: Messages }): React.JSX.Element {
  const { controller, item, caption, messages } = props
  const project = controller.state.project!
  const [x, setX] = useState(0)
  const [y, setY] = useState(0)
  const [scale, setScale] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [opacity, setOpacity] = useState(1)
  const [crop, setCrop] = useState({ left: 0, top: 0, right: 0, bottom: 0 })
  const [blendMode, setBlendMode] = useState<NonNullable<ItemProjection['blendMode']>>('normal')
  const [speed, setSpeed] = useState(1)
  const [volume, setVolume] = useState(1)
  const [fadeInFrames, setFadeInFrames] = useState(0)
  const [fadeOutFrames, setFadeOutFrames] = useState(0)
  const [muted, setMuted] = useState(false)
  const [effectType, setEffectType] = useState<string>(EFFECT_CATALOG[0]!.type)
  const [keyframeProperty, setKeyframeProperty] = useState('opacity')
  const [keyframeValue, setKeyframeValue] = useState(1)
  const [keyframeInterpolation, setKeyframeInterpolation] = useState<'hold' | 'linear' | 'ease'>('linear')
  useEffect(() => {
    if (!item) return
    setX(item.transform.x)
    setY(item.transform.y)
    setScale(item.transform.scaleX)
    setRotation(item.transform.rotation)
    setOpacity(item.opacity)
    setCrop(item.crop ?? { left: 0, top: 0, right: 0, bottom: 0 })
    setBlendMode(item.blendMode ?? 'normal')
    setSpeed(item.speed.numerator / item.speed.denominator)
    setVolume(item.volume ?? 1)
    setFadeInFrames(item.fadeInFrames)
    setFadeOutFrames(item.fadeOutFrames)
    setMuted(item.muted ?? false)
  }, [item])
  const selectedAsset = item ? project.assets.find(({ id }) => id === item.assetId) : undefined
  const applyComposition = (): void => {
    if (!item || crop.left + crop.right >= 1 || crop.top + crop.bottom >= 1 || speed <= 0) return
    const operations: TimelineOperation[] = [
      { type: 'update-transform', itemId: item.id, transform: { x, y, scaleX: scale, scaleY: scale, rotation } },
      { type: 'update-item-composition', itemId: item.id, crop, opacity, blendMode }
    ]
    if (Math.abs(speed - item.speed.numerator / item.speed.denominator) > 0.000001) {
      operations.push({ type: 'retime-item', itemId: item.id, speed: decimalRational(speed) })
    }
    void controller.applyOperations(operations, formatMessage(messages.compositionSummary, { id: item.id }))
  }
  const addEffect = (): void => {
    if (!item) return
    const definition = EFFECT_CATALOG.find(({ type }) => type === effectType)
    if (!definition) return
    const effect = {
      id: `${effectType.replace(/[^a-z0-9]+/giu, '-')}-${Date.now().toString(36)}`.slice(0, 128),
      type: definition.type,
      enabled: true,
      parameters: Object.fromEntries(Object.entries(definition.parameters).map(([key, value]) => [key, value.defaultValue]))
    }
    void controller.applyOperations(
      [{ type: 'set-item-effects', itemId: item.id, effects: [...(item.effects ?? []), effect] }],
      formatMessage(messages.effectAddedSummary, { effect: definition.label(messages), id: item.id })
    )
  }
  const applyAudio = (): void => {
    if (!item) return
    void controller.applyOperations([{
      type: 'update-item-properties',
      itemId: item.id,
      volume,
      fadeInFrames: Math.max(0, Math.round(fadeInFrames)),
      fadeOutFrames: Math.max(0, Math.round(fadeOutFrames)),
      muted
    }], formatMessage(messages.audioPropertiesSummary, { id: item.id }))
  }
  const upsertKeyframe = (): void => {
    if (!item || !Number.isFinite(keyframeValue)) return
    const localFrame = Math.max(0, Math.min(item.durationFrames, controller.state.playheadFrame - item.timelineStartFrame))
    const tracks = structuredClone(item.keyframes ?? [])
    let track = tracks.find(({ property }) => property === keyframeProperty)
    if (!track) {
      track = {
        id: `keyframes-${keyframeProperty.replace(/[^a-z0-9]+/giu, '-')}`.slice(0, 128),
        property: keyframeProperty,
        interpolation: keyframeInterpolation,
        points: []
      }
      tracks.push(track)
    }
    track.interpolation = keyframeInterpolation
    track.points = [
      ...track.points.filter(({ frame }) => frame !== localFrame),
      { id: `${track.id}-${localFrame}`.slice(0, 128), frame: localFrame, value: keyframeValue }
    ].sort((left, right) => left.frame - right.frame)
    void controller.applyOperations(
      [{ type: 'set-item-keyframes', itemId: item.id, keyframes: tracks }],
      formatMessage(messages.keyframeSummary, { property: keyframeProperty, frame: localFrame })
    )
  }
  return (
    <Panel title={messages.inspector}>
      {!item && !caption ? <EmptyState>{messages.noSelection}</EmptyState> : item ? (
        <div className="inspector-stack">
          <section className="selected-item-hero">
            <span className={`selected-item-thumb media-kind-${selectedAsset?.kind ?? 'video'}`} aria-hidden="true"><WorkbenchIcon name="clips" /></span>
            <span className="selected-item-copy"><small>{messages.selectedClip}</small><strong>{selectedAsset?.name ?? item.id}</strong><span>{formatTime(frameToSeconds(project, item.durationFrames))} · {item.trackId}</span></span>
            <button type="button" className="quiet-button" onClick={() => controller.seek(item.timelineStartFrame)}>{messages.locateOnTimeline}</button>
          </section>
          {item.nestedSequenceId && <div className="nested-sequence-actions wide-field"><strong>{messages.nestedSequence}</strong><span>{item.nestedSequenceId}</span><div className="button-row"><button type="button" onClick={() => void controller.selectSequence(item.nestedSequenceId!)}>{messages.openNestedSequence}</button><button type="button" onClick={() => window.confirm(messages.decomposeNestedConfirm) && void controller.decomposeNested(item.id)}>{messages.decomposeNestedSequence}</button></div></div>}
          <details className="inspector-section" open><summary>{messages.propertiesTransform}<span aria-hidden="true">⌄</span></summary><div className="field-grid inspector-grid">
            <label><span>X</span><input type="number" value={x} onChange={(event) => setX(Number(event.target.value))} /></label>
            <label><span>Y</span><input type="number" value={y} onChange={(event) => setY(Number(event.target.value))} /></label>
            <label><span>{messages.scale}</span><input type="number" min="0.01" max="10" step="0.05" value={scale} onChange={(event) => setScale(Number(event.target.value))} /></label>
            <label><span>{messages.rotation}</span><input type="number" step="1" value={rotation} onChange={(event) => setRotation(Number(event.target.value))} /></label>
            <label><span>{messages.speed}</span><input type="number" min="0.05" max="16" step="0.05" value={speed} onChange={(event) => setSpeed(Number(event.target.value))} /></label>
            <details className="inspector-crop-fields"><summary>{messages.crop}</summary><div className="field-grid">{(['left', 'top', 'right', 'bottom'] as const).map((edge) => <label key={edge}><span>{messages[`crop${edge[0]!.toUpperCase()}${edge.slice(1)}` as keyof Messages]}</span><input type="number" min="0" max="0.95" step="0.01" value={crop[edge]} onChange={(event) => setCrop((current) => ({ ...current, [edge]: Number(event.target.value) }))} /></label>)}</div></details>
          </div></details>
          <details className="inspector-section" open><summary>{messages.propertiesAppearance}<span aria-hidden="true">⌄</span></summary><div className="field-grid inspector-grid">
            <label className="property-slider wide-field"><span>{messages.opacity}</span><span><input type="range" min="0" max="1" step="0.01" value={opacity} onChange={(event) => setOpacity(Number(event.target.value))} /><output>{Math.round(opacity * 100)}%</output></span></label>
            <label><span>{messages.blendMode}</span><select value={blendMode} onChange={(event) => setBlendMode(event.target.value as typeof blendMode)}><option value="normal">{messages.blendNormal}</option><option value="multiply">{messages.blendMultiply}</option><option value="screen">{messages.blendScreen}</option><option value="overlay">{messages.blendOverlay}</option></select></label>
            <button type="button" className="primary-action" onClick={applyComposition}>{messages.applyComposition}</button>
          </div></details>
          <details className="inspector-section"><summary>{messages.propertiesAudio}<span aria-hidden="true">⌄</span></summary><div className="field-grid inspector-grid">
            <label className="property-slider wide-field"><span>{messages.volume}</span><span><input type="range" min="0" max="2" step="0.01" value={volume} onChange={(event) => setVolume(Number(event.target.value))} /><output>{Math.round(volume * 100)}%</output></span></label>
            <label><span>{messages.fadeIn}</span><input type="number" min="0" max={item.durationFrames} value={fadeInFrames} onChange={(event) => setFadeInFrames(Number(event.target.value))} /></label>
            <label><span>{messages.fadeOut}</span><input type="number" min="0" max={item.durationFrames} value={fadeOutFrames} onChange={(event) => setFadeOutFrames(Number(event.target.value))} /></label>
            <label className="checkbox-field wide-field"><input type="checkbox" checked={muted} onChange={(event) => setMuted(event.target.checked)} /><span>{messages.muted}</span></label>
            <button type="button" className="primary-action" onClick={applyAudio}>{messages.applyAudioProperties}</button>
          </div></details>
          <details className="inspector-section"><summary>{messages.effects}<span aria-hidden="true">⌄</span></summary><fieldset className="effect-editor"><legend className="sr-only">{messages.effects}</legend><div className="button-row"><select aria-label={messages.effectCatalog} value={effectType} onChange={(event) => setEffectType(event.target.value)}>{EFFECT_CATALOG.map((effect) => <option key={effect.type} value={effect.type}>{effect.label(messages)}</option>)}</select><button type="button" onClick={addEffect}>{messages.addEffect}</button></div>{(item.effects ?? []).map((effect) => <EffectRow key={effect.id} item={item} effect={effect} controller={controller} messages={messages} />)}</fieldset></details>
          <details className="inspector-section"><summary>{messages.propertiesAnimation}<span aria-hidden="true">⌄</span></summary><fieldset className="keyframe-editor"><legend className="sr-only">{messages.keyframes}</legend><label><span>{messages.keyframeProperty}</span><select value={keyframeProperty} onChange={(event) => setKeyframeProperty(event.target.value)}>{KEYFRAME_PROPERTIES.map((property) => <option key={property} value={property}>{property}</option>)}{(item.effects ?? []).flatMap((effect) => Object.entries(effect.parameters).filter(([, value]) => typeof value === 'number').map(([parameter]) => <option key={`${effect.id}.${parameter}`} value={`effect.${effect.id}.${parameter}`}>{effect.type} · {parameter}</option>))}</select></label><label><span>{messages.value}</span><input type="number" step="0.01" value={keyframeValue} onChange={(event) => setKeyframeValue(Number(event.target.value))} /></label><label><span>{messages.interpolation}</span><select value={keyframeInterpolation} onChange={(event) => setKeyframeInterpolation(event.target.value as typeof keyframeInterpolation)}><option value="hold">{messages.interpolationHold}</option><option value="linear">{messages.interpolationLinear}</option><option value="ease">{messages.interpolationEase}</option></select></label><button type="button" onClick={upsertKeyframe}>{messages.setKeyframeAtPlayhead}</button><ul>{(item.keyframes ?? []).map((track) => <li key={track.id}><span>{track.property} · {track.points.length}</span><button type="button" onClick={() => void controller.applyOperations([{ type: 'set-item-keyframes', itemId: item.id, keyframes: (item.keyframes ?? []).filter(({ id }) => id !== track.id) }], formatMessage(messages.removeKeyframeTrackSummary, { property: track.property }))}>{messages.remove}</button></li>)}</ul></fieldset></details>
        </div>
      ) : <p>{messages.captionSelected}: <strong>{caption?.id}</strong>. {messages.captions}</p>}
      <details className="inspector-section canvas-section"><summary>{messages.canvasAndFit}<span aria-hidden="true">⌄</span></summary><fieldset className="aspect-controls"><legend className="sr-only">{messages.canvasAndFit}</legend>{(['16:9', '9:16', '1:1'] as const).map((preset) => <button type="button" key={preset} aria-pressed={project.canvas.preset === preset} onClick={() => void controller.applyOperations([{ type: 'set-canvas', preset, fit: project.canvas.fit }], formatMessage(messages.canvasSummary, { preset }))}>{preset}</button>)}<label><span>{messages.fitPolicy}</span><select value={project.canvas.fit} onChange={(event) => void controller.applyOperations([{ type: 'set-canvas', preset: project.canvas.preset, fit: event.target.value as 'fit' | 'crop' | 'pad' }], messages.fitSummary)}><option value="fit">{messages.fit}</option><option value="crop">{messages.crop}</option><option value="pad">{messages.pad}</option></select></label></fieldset></details>
      <p className="boundary-note">{messages.canvasBoundary}</p>
    </Panel>
  )
}

export function CaptionPanel({ controller, messages }: { controller: EditorController; messages: Messages }): React.JSX.Element {
  const project = controller.state.project!
  const selected = project.captions.find(({ id }) => id === controller.state.selectedCaptionId)
  const [text, setText] = useState('')
  const [start, setStart] = useState(0)
  const [end, setEnd] = useState(30)
  const [placement, setPlacement] = useState<'top' | 'center' | 'bottom'>('bottom')
  const [animation, setAnimation] = useState<'none' | 'word-highlight' | 'fade'>('none')
  const [animationDuration, setAnimationDuration] = useState(0)
  useEffect(() => {
    if (!selected) return
    setText(selected.text)
    setStart(selected.startFrame)
    setEnd(selected.endFrame)
    setPlacement(selected.placement)
    setAnimation(selected.animation?.kind ?? 'none')
    setAnimationDuration(selected.animation?.durationFrames ?? 0)
  }, [selected])
  const save = (): void => {
    const captionTrack = project.tracks.find(({ kind }) => kind === 'caption')
    if (!captionTrack || !text.trim() || end <= start) return
    const captionAnimation = {
      kind: animation,
      ...(animation !== 'none' ? { durationFrames: Math.max(0, Math.round(animationDuration)) } : {})
    }
    const operation: TimelineOperation = selected
      ? { type: 'update-caption', captionId: selected.id, patch: { text: text.trim(), startFrame: start, endFrame: end, placement, animation: captionAnimation } }
      : { type: 'add-caption', caption: { id: `caption-${Date.now().toString(36)}`, trackId: captionTrack.id, startFrame: start, endFrame: end, text: text.trim(), placement, animation: captionAnimation } }
    void controller.applyOperations(
      [operation],
      selected ? formatMessage(messages.updateCaptionSummary, { id: selected.id }) : messages.addCaptionSummary
    )
  }
  return (
    <Panel title={messages.captions}>
      <div className="caption-layout">
        <ul className="caption-list">{project.captions.slice(0, VIEW_LIMITS.virtualWindow).map((caption) => <li key={caption.id}><button type="button" aria-pressed={selected?.id === caption.id} onClick={() => controller.selectCaption(caption.id)}><span className="caption-copy"><span>{caption.text}</span>{caption.speakerAttribution && <small className={`speaker-attribution ${caption.speakerAttribution.status}`}>{speakerAttributionLabel(messages, caption.speakerAttribution)}</small>}</span><small>{caption.startFrame}–{caption.endFrame}f</small></button></li>)}</ul>
        <div className="field-grid">
          <label className="wide-field"><span>{messages.captionText}</span><textarea rows={3} value={text} maxLength={4096} onChange={(event) => setText(event.target.value)} /></label>
          <label><span>{messages.startFrame}</span><input type="number" min={0} value={start} onChange={(event) => setStart(Number(event.target.value))} /></label>
          <label><span>{messages.endFrame}</span><input type="number" min={start + 1} max={Math.max(start + 1, project.durationFrames)} value={end} onChange={(event) => setEnd(Number(event.target.value))} /></label>
          <label><span>{messages.placement}</span><select value={placement} onChange={(event) => setPlacement(event.target.value as typeof placement)}><option value="top">{messages.top}</option><option value="center">{messages.center}</option><option value="bottom">{messages.bottom}</option></select></label>
          <label><span>{messages.captionAnimation}</span><select value={animation} onChange={(event) => setAnimation(event.target.value as typeof animation)}><option value="none">{messages.captionAnimationNone}</option><option value="word-highlight">{messages.captionAnimationWordHighlight}</option><option value="fade">{messages.captionAnimationFade}</option></select></label>
          <label><span>{messages.animationDurationFrames}</span><input type="number" min={0} max={Math.max(0, end - start)} value={animationDuration} disabled={animation === 'none'} onChange={(event) => setAnimationDuration(Number(event.target.value))} /></label>
          <button type="button" onClick={save}>{selected ? messages.updateCaption : messages.addCaption}</button>
          {selected && <button type="button" className="danger-button" onClick={() => window.confirm(messages.deleteCaptionConfirm) && void controller.applyOperations([{ type: 'delete-caption', captionId: selected.id }], formatMessage(messages.deleteCaptionSummary, { id: selected.id }))}>{messages.deleteCaption}</button>}
        </div>
      </div>
    </Panel>
  )
}

export function RevisionPanel({ controller, messages }: { controller: EditorController; messages: Messages }): React.JSX.Element {
  const project = controller.state.project!
  return (
    <Panel title={messages.revisions} actions={<span className="revision-badge">{messages.current} r{project.currentRevision}</span>}>
      <ol className="revision-list" reversed>{[...project.revisions].reverse().map((revision) => <li key={revision.revision} className={revision.revision === project.currentRevision ? 'current' : ''}><strong>r{revision.revision}</strong><span>{revisionSummaryLabel(messages, revision)}</span><small>{revisionAuthorLabel(messages, revision.author)} · {formatTimestamp(revision.timestamp, controller.state.locale?.language)}</small></li>)}</ol>
    </Panel>
  )
}

export function AgentSyncPanel({ controller, messages }: { controller: EditorController; messages: Messages }): React.JSX.Element {
  const { project, lastProjectChange, agentRun } = controller.state
  return (
    <Panel title={messages.agent} actions={<span className="revision-badge">r{project?.currentRevision ?? 0}</span>}>
      <div className="agent-sync-callout">
        <strong>{messages.mainAgent}</strong>
        <p>{messages.mainAgentHelp}</p>
      </div>
      <dl className="agent-sync-grid">
        <div><dt>{messages.activeProject}</dt><dd>{project?.name ?? messages.noProject}</dd></div>
        <div><dt>{messages.activeRevision}</dt><dd>{project ? `r${project.currentRevision}` : '—'}</dd></div>
        <div><dt>{messages.agentTool}</dt><dd><code>{messages.agentToolActive}</code></dd></div>
      </dl>
      <div className="agent-sync-status" role="status" aria-live="polite">
        <span className="agent-sync-dot" aria-hidden="true" />
        <span>{lastProjectChange && lastProjectChange.projectId === project?.id
          ? `${messages.lastSync}: ${projectChangeReasonLabel(messages, lastProjectChange.reason)} · r${lastProjectChange.revision}`
          : messages.agentReady}</span>
      </div>
      {agentRun ? <p className="subtle">{messages.legacyRun}: {agentStateLabel(messages, agentRun.state)}</p> : null}
      <p className="boundary-note">{messages.unsupported}</p>
    </Panel>
  )
}
