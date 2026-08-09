import {
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import {
  createTimelineViewport,
  frameToTimelineX,
  type TimelineItemRect,
  type TimelineRange
} from '../engine/timeline-geometry.js'
import type { EditorController } from './controller.js'
import { formatMessage, type Messages } from './i18n.js'
import type {
  DerivedMediaRecordProjection,
  ItemProjection,
  ProjectProjection,
  TimelineOperation,
  TrackProjection
} from './model.js'
import {
  rectStyle,
  waveHeight,
  type GestureRegion,
  type ItemPropertiesPatch
} from './spatial-timeline-support.js'

export function TrackHeader(props: {
  track: TrackProjection
  messages: Messages
  onUpdate(patch: { muted?: boolean; locked?: boolean; syncLocked?: boolean }): void
}): React.JSX.Element {
  const { track, messages } = props
  const kind = track.kind === 'video'
    ? messages.trackKindVideo
    : track.kind === 'audio'
      ? messages.trackKindAudio
      : messages.trackKindCaption
  const name = ({
    'video-1': messages.defaultVideoTrack1,
    'video-2': messages.defaultVideoTrack2,
    'audio-1': messages.defaultAudioTrack1,
    'captions-1': messages.defaultCaptionTrack
  } as Record<string, string>)[track.id] ?? track.name
  return <div className="timeline-spatial-header">
    <strong>{name}</strong>
    <small>{kind}</small>
    <span className="timeline-track-badges">
      {track.syncLocked && <span>{messages.syncLocked}</span>}
      {track.muted && <span>{messages.muted}</span>}
      {track.visible === false && <span>{messages.hidden}</span>}
      {track.locked && <span>{messages.locked}</span>}
    </span>
    <span className="timeline-track-controls">
      <button
        type="button"
        aria-label={track.muted ? messages.trackUnmute : messages.trackMute}
        aria-pressed={track.muted ?? false}
        onClick={() => props.onUpdate({ muted: !(track.muted ?? false) })}
      >M</button>
      <button
        type="button"
        aria-label={track.syncLocked ? messages.disableSyncLock : messages.enableSyncLock}
        aria-pressed={track.syncLocked ?? false}
        onClick={() => props.onUpdate({ syncLocked: !(track.syncLocked ?? false) })}
      >S</button>
      <button
        type="button"
        aria-label={track.locked ? messages.unlockTrack : messages.lockTrack}
        aria-pressed={track.locked ?? false}
        onClick={() => props.onUpdate({ locked: !(track.locked ?? false) })}
      >L</button>
    </span>
  </div>
}

export function ClipProperties(props: {
  controller: EditorController
  item: ItemProjection
  messages: Messages
}): React.JSX.Element {
  const { controller, item, messages } = props
  const [volume, setVolume] = useState(item.volume ?? 1)
  const [fadeInFrames, setFadeInFrames] = useState(item.fadeInFrames)
  const [fadeOutFrames, setFadeOutFrames] = useState(item.fadeOutFrames)
  useEffect(() => {
    setVolume(item.volume ?? 1)
    setFadeInFrames(item.fadeInFrames)
    setFadeOutFrames(item.fadeOutFrames)
  }, [item.fadeInFrames, item.fadeOutFrames, item.id, item.volume])
  const update = (patch: ItemPropertiesPatch): void => {
    void controller.applyOperations(
      [{ type: 'update-item-properties', itemId: item.id, ...patch }],
      formatMessage(messages.itemPropertiesSummary, { id: item.id })
    )
  }
  const locked = item.locked ?? false
  return <fieldset className="timeline-clip-properties">
    <legend>{messages.clipProperties}</legend>
    <span className="timeline-clip-state-buttons">
      <button type="button" disabled={locked} aria-pressed={item.muted ?? false} onClick={() => update({ muted: !(item.muted ?? false) })}>
        {item.muted ? messages.unmuteClip : messages.muteClip}
      </button>
      <button type="button" disabled={locked} aria-pressed={item.visible === false} onClick={() => update({ visible: item.visible === false })}>
        {item.visible === false ? messages.showClip : messages.hideClip}
      </button>
      <button type="button" aria-pressed={locked} onClick={() => update({ locked: !locked })}>
        {locked ? messages.unlockClip : messages.lockClip}
      </button>
    </span>
    <label><span>{messages.volume}</span><input type="number" min={0} max={4} step={0.05} value={volume} disabled={locked} onChange={(event) => setVolume(Number(event.target.value))} /></label>
    <label><span>{messages.fadeIn} ({messages.frames})</span><input type="number" min={0} max={Math.max(0, item.durationFrames - fadeOutFrames)} value={fadeInFrames} disabled={locked} onChange={(event) => setFadeInFrames(Number(event.target.value))} /></label>
    <label><span>{messages.fadeOut} ({messages.frames})</span><input type="number" min={0} max={Math.max(0, item.durationFrames - fadeInFrames)} value={fadeOutFrames} disabled={locked} onChange={(event) => setFadeOutFrames(Number(event.target.value))} /></label>
    <button
      type="button"
      disabled={locked || fadeInFrames + fadeOutFrames > item.durationFrames}
      onClick={() => update({ volume, fadeInFrames, fadeOutFrames })}
    >{messages.applyAudioProperties}</button>
  </fieldset>
}

export function TimelineClip(props: {
  item: ItemProjection
  rect: TimelineItemRect
  project: ProjectProjection
  controller: EditorController
  selected: boolean
  messages: Messages
  onBegin(event: ReactPointerEvent<HTMLElement>, item: ItemProjection, region: GestureRegion): void
  onMove(event: ReactPointerEvent<HTMLElement>): void
  onEnd(event: ReactPointerEvent<HTMLElement>): void
  onKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, item: ItemProjection): void
  onOpen(): void
  waveformRecord?: DerivedMediaRecordProjection
}): React.JSX.Element {
  const asset = props.project.assets.find(({ id }) => id === props.item.assetId)
  const name = asset?.name ?? props.item.assetId
  const end = props.item.timelineStartFrame + props.item.durationFrames
  return (
    <div
      className={props.selected ? 'timeline-clip selected' : 'timeline-clip'}
      data-item-id={props.item.id}
      data-linked={props.item.linkGroupId ? 'true' : 'false'}
      data-muted={props.item.muted ? 'true' : 'false'}
      data-visible={props.item.visible === false ? 'false' : 'true'}
      style={rectStyle(props.rect)}
    >
      <button
        type="button"
        className="timeline-clip-body"
        aria-pressed={props.selected}
        aria-label={formatMessage(props.messages.timelineItemLabel, {
          name,
          start: props.item.timelineStartFrame,
          end
        })}
        onClick={() => {
          props.controller.selectItem(props.item.id)
          props.controller.seek(props.item.timelineStartFrame)
        }}
        onPointerDown={(event) => props.onBegin(event, props.item, 'body')}
        onPointerMove={props.onMove}
        onPointerUp={props.onEnd}
        onPointerCancel={props.onEnd}
        onDoubleClick={props.onOpen}
        onKeyDown={(event) => props.onKeyDown(event, props.item)}
      >
        <strong>{name}</strong>
        <small>{props.item.timelineStartFrame}–{end}f</small>
        {asset?.kind === 'audio' && <Waveform
          record={props.waveformRecord}
          controller={props.controller}
          messages={props.messages}
          itemId={props.item.id}
        />}
        <span className="timeline-clip-badges">
          {props.item.linkGroupId && <span>{props.messages.linkedGroup}</span>}
          {props.item.muted && <span>{props.messages.muted}</span>}
          {props.item.visible === false && <span>{props.messages.hidden}</span>}
          {props.item.locked && <span>{props.messages.locked}</span>}
        </span>
      </button>
      <button
        type="button"
        className="timeline-trim-handle trim-start"
        aria-label={formatMessage(props.messages.trimStartHandle, { name })}
        onPointerDown={(event) => props.onBegin(event, props.item, 'trim-start')}
        onPointerMove={props.onMove}
        onPointerUp={props.onEnd}
        onPointerCancel={props.onEnd}
      />
      <button
        type="button"
        className="timeline-trim-handle trim-end"
        aria-label={formatMessage(props.messages.trimEndHandle, { name })}
        onPointerDown={(event) => props.onBegin(event, props.item, 'trim-end')}
        onPointerMove={props.onMove}
        onPointerUp={props.onEnd}
        onPointerCancel={props.onEnd}
      />
    </div>
  )
}

function Waveform(props: {
  record?: DerivedMediaRecordProjection
  controller: EditorController
  messages: Messages
  itemId: string
}): React.JSX.Element {
  const [resourceUrl, setResourceUrl] = useState<string | undefined>(undefined)
  useEffect(() => {
    let active = true
    setResourceUrl(undefined)
    if (!props.record?.artifactHandleId || !props.controller.openDerivedResource) return () => { active = false }
    void props.controller.openDerivedResource(props.record.id)
      .then((url) => { if (active) setResourceUrl(url) })
      .catch(() => { if (active) setResourceUrl(undefined) })
    return () => { active = false }
  }, [props.controller, props.record?.artifactHandleId, props.record?.id])
  const state = props.record?.status ?? 'pending'
  const label = state === 'ready'
    ? props.messages.waveformReady
    : state === 'partial'
      ? props.messages.waveformPartial
      : props.messages.waveformPending
  return <span className="timeline-waveform" data-state={state} aria-label={label}>
    {resourceUrl
      ? <img src={resourceUrl} alt="" draggable={false} />
      : Array.from({ length: 14 }, (_, index) => <i key={index} style={{ height: `${waveHeight(props.itemId, index)}%` }} />)}
  </span>
}

export function TimelineOverlays(props: {
  viewport: ReturnType<typeof createTimelineViewport>
  playheadX: number
  snapGuideX?: number
  selectedRange?: TimelineRange
}): React.JSX.Element {
  return <>
    {props.selectedRange && props.selectedRange.endFrame > props.selectedRange.startFrame && <span
      className="timeline-range-selection"
      style={{
        left: frameToTimelineX(props.viewport, props.selectedRange.startFrame),
        width: Math.max(1, (props.selectedRange.endFrame - props.selectedRange.startFrame) * props.viewport.pixelsPerFrame)
      }}
    />}
    {props.playheadX >= 0 && props.playheadX <= props.viewport.widthPixels && <span className="timeline-playhead" style={{ left: props.playheadX }} />}
    {props.snapGuideX !== undefined && props.snapGuideX >= 0 && props.snapGuideX <= props.viewport.widthPixels && <span className="timeline-snap-guide" style={{ left: props.snapGuideX }} />}
  </>
}
