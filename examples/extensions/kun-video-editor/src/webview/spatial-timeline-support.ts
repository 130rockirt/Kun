import type {
  CSSProperties,
  PointerEvent as ReactPointerEvent
} from 'react'
import {
  TIMELINE_GEOMETRY_LIMITS,
  createTimelineViewport,
  frameToTimelineX,
  timelineXToFrame,
  type TimelineItemRect,
  type TimelineRange
} from '../engine/timeline-geometry.js'
import type {
  TimelineSnapResult,
  TimelineSnapState
} from '../engine/timeline-snap.js'
import {
  compileTimelineEditPlanOperations,
  planLinkedMove,
  planLinkedTrim,
  planRippleDelete
} from '../engine/timeline-edit-planners.js'
import type { LinkGroup, TimelineItem } from '../engine/schema.js'
import type { EditorController } from './controller.js'
import { formatMessage, type Messages } from './i18n.js'
import type {
  ItemProjection,
  ProjectProjection,
  TimelineOperation,
  TrackProjection
} from './model.js'

export const LANE_HEIGHT = 58
export const MIN_TIMELINE_WIDTH = 160
export const DEFAULT_TIMELINE_WIDTH = 640
export const SNAP_THRESHOLD_PIXELS = 8

export type GestureRegion = 'body' | 'trim-start' | 'trim-end'

export type ItemGesture = {
  pointerId: number
  itemId: string
  region: GestureRegion
  clientX: number
  originalStart: number
  originalEnd: number
  targetTrackId: string
  snap?: TimelineSnapState
}

export type ItemPreview = {
  itemId: string
  startFrame: number
  endFrame: number
  trackId: string
  snap?: TimelineSnapResult
}

export type RangeGesture = {
  pointerId: number
  anchorFrame: number
  targetTrackId: string
}

export type RipplePreview = {
  targetTrackId: string
  plan: ReturnType<typeof planRippleDelete>
  operations: TimelineOperation[]
}

export type ItemPropertiesPatch = Omit<
  Extract<TimelineOperation, { type: 'update-item-properties' }>,
  'type' | 'itemId'
>


export async function commitLinkedMove(
  controller: EditorController,
  project: ProjectProjection,
  item: ItemProjection,
  preview: ItemPreview,
  messages: Messages
): Promise<void> {
  const operations = linkedMoveOperations(project, item, preview.startFrame, preview.trackId)
  if (operations.length === 0) return
  await controller.applyOperations(
    operations,
    formatMessage(operations.length > 1 ? messages.moveLinkedSummary : messages.moveSummary, { id: item.id })
  )
}

export function linkedMoveOperations(
  project: ProjectProjection,
  item: ItemProjection,
  timelineStartFrame: number,
  trackId = item.trackId
): TimelineOperation[] {
  const deltaFrames = timelineStartFrame - item.timelineStartFrame
  if (deltaFrames === 0 && trackId === item.trackId) return []
  const items = project.items.map(toEngineItem)
  const plan = planLinkedMove({
    items,
    linkGroups: projectedLinkGroups(project.linkGroups),
    tracks: project.tracks,
    itemId: item.id,
    deltaFrames,
    targetTrackId: trackId
  })
  return compileTimelineEditPlanOperations(items, plan) as TimelineOperation[]
}

export async function commitLinkedTrim(
  controller: EditorController,
  project: ProjectProjection,
  item: ItemProjection,
  preview: ItemPreview,
  messages: Messages
): Promise<void> {
  const operations = linkedTrimOperations(project, item, preview.startFrame, preview.endFrame)
  if (operations.length === 0) return
  await controller.applyOperations(
    operations,
    formatMessage(operations.length > 1 ? messages.trimLinkedSummary : messages.trimSummary, { id: item.id })
  )
}

export function linkedTrimOperations(
  project: ProjectProjection,
  item: ItemProjection,
  startFrame: number,
  endFrame: number
): TimelineOperation[] {
  if (startFrame === item.timelineStartFrame && endFrame === item.timelineStartFrame + item.durationFrames) return []
  const items = project.items.map(toEngineItem)
  const plan = planLinkedTrim({
    items,
    linkGroups: projectedLinkGroups(project.linkGroups),
    tracks: project.tracks,
    itemId: item.id,
    startFrame,
    endFrame
  })
  return compileTimelineEditPlanOperations(items, plan) as TimelineOperation[]
}

function projectedLinkGroups(groups: ProjectProjection['linkGroups']): LinkGroup[] {
  return groups.map(({ id, kind, itemIds, locked }) => ({ id, kind, itemIds: [...itemIds], locked }))
}

export function linkedProjectItemIds(project: ProjectProjection, itemId: string): string[] {
  const result = new Set([itemId])
  let changed = true
  while (changed) {
    changed = false
    for (const group of project.linkGroups) {
      if (!group.locked || !group.itemIds.some((id) => result.has(id))) continue
      for (const id of group.itemIds) {
        if (!project.items.some((item) => item.id === id) || result.has(id)) continue
        result.add(id)
        changed = true
      }
    }
  }
  return [...result].sort()
}

export function toEngineItem(item: ItemProjection): TimelineItem {
  return {
    id: item.id,
    assetId: item.assetId,
    trackId: item.trackId,
    timelineStartFrame: item.timelineStartFrame,
    durationFrames: item.durationFrames,
    sourceStartUs: item.sourceStartUs,
    sourceEndUs: item.sourceEndUs,
    speed: item.speed,
    transform: item.transform,
    opacity: item.opacity,
    fadeInFrames: item.fadeInFrames,
    fadeOutFrames: item.fadeOutFrames,
    ...(item.linkGroupId ? { linkGroupId: item.linkGroupId } : {}),
    ...(item.nestedSequenceId ? { nestedSequenceId: item.nestedSequenceId } : {}),
    ...(item.volume !== undefined ? { volume: item.volume } : {}),
    ...(item.muted !== undefined ? { muted: item.muted } : {}),
    ...(item.visible !== undefined ? { visible: item.visible } : {}),
    ...(item.locked !== undefined ? { locked: item.locked } : {}),
    ...(item.crop ? { crop: structuredClone(item.crop) } : {}),
    ...(item.effects ? { effects: structuredClone(item.effects) } : {}),
    ...(item.keyframes ? { keyframes: structuredClone(item.keyframes) } : {})
  }
}

export function previewRect(
  viewport: ReturnType<typeof createTimelineViewport>,
  rect: TimelineItemRect,
  preview: ItemPreview
): TimelineItemRect {
  return {
    ...rect,
    trackId: preview.trackId,
    startFrame: preview.startFrame,
    endFrame: preview.endFrame,
    left: frameToTimelineX(viewport, preview.startFrame),
    width: Math.max(1, (preview.endFrame - preview.startFrame) * viewport.pixelsPerFrame)
  }
}

export function rectStyle(rect: TimelineItemRect): CSSProperties {
  return { left: rect.left, width: rect.width }
}

export function trackFor(project: ProjectProjection, trackId: string): TrackProjection | undefined {
  return project.tracks.find(({ id }) => id === trackId)
}

export function compatibleDropTrack(
  project: ProjectProjection,
  item: ItemProjection,
  clientX: number,
  clientY: number
): string | undefined {
  if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') return undefined
  const element = document.elementFromPoint(clientX, clientY)
  const lane = element?.closest<HTMLElement>('[data-timeline-track-id]')
  const trackId = lane?.dataset.timelineTrackId
  const target = trackId ? trackFor(project, trackId) : undefined
  const asset = project.assets.find(({ id }) => id === item.assetId)
  if (!target || target.locked || target.kind === 'caption') return undefined
  if (asset?.kind === 'audio' && target.kind !== 'audio') return undefined
  if (asset?.kind === 'video' && target.kind !== 'video') return undefined
  return target.id
}

export function eventFrame(
  event: ReactPointerEvent<HTMLElement>,
  viewport: ReturnType<typeof createTimelineViewport>
): number {
  const rect = event.currentTarget.getBoundingClientRect()
  return Math.min(viewport.durationFrames, Math.max(0, timelineXToFrame(viewport, event.clientX - rect.left, 'round')))
}

export function isTimelineControl(target: EventTarget): boolean {
  return typeof Element !== 'undefined' && target instanceof Element &&
    Boolean(target.closest('button, input, .timeline-clip, .timeline-caption'))
}

export function initialPixelsPerFrame(durationFrames: number): number {
  return Math.min(8, Math.max(0.08, DEFAULT_TIMELINE_WIDTH / Math.max(120, durationFrames)))
}

export function boundedSequenceZoom(value: number): number {
  return Math.min(1_000, Math.max(0.01, Number.isFinite(value) ? value : 1))
}

export function sequencePixelsPerFrame(zoom: number, durationFrames: number): number {
  return Math.min(
    TIMELINE_GEOMETRY_LIMITS.maxPixelsPerFrame,
    Math.max(
      TIMELINE_GEOMETRY_LIMITS.minPixelsPerFrame,
      initialPixelsPerFrame(durationFrames) * boundedSequenceZoom(zoom)
    )
  )
}

export function timelineTicks(range: TimelineRange, count: number): number[] {
  const span = Math.max(1, range.endFrame - range.startFrame)
  const result: number[] = []
  for (let index = 0; index <= count; index += 1) {
    result.push(Math.round(range.startFrame + span * index / count))
  }
  return [...new Set(result)]
}

export function formatTimelineFrame(project: ProjectProjection, frame: number): string {
  const seconds = frame * project.fps.denominator / project.fps.numerator
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.floor(seconds % 60)
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
}

export function waveHeight(id: string, index: number): number {
  let hash = index * 17 + 31
  for (const character of id) hash = (hash * 33 + character.charCodeAt(0)) % 97
  return 28 + hash % 68
}
