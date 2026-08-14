import { engineError } from './errors.js'
import type { TimelineEditPlan } from './timeline-edit-planners.js'
import type { ProjectService, CommitMetadata } from './project-service.js'
import type {
  LinkGroup,
  TimelineItem,
  TimelineOperation,
  Track,
  UpdateItemPropertiesOperation
} from './schema.js'

export function linkedClosure(itemId: string, groups: readonly LinkGroup[]): Set<string> {
  const result = new Set([itemId])
  let changed = true
  while (changed) {
    changed = false
    for (const group of groups) {
      if (!group.locked || !group.itemIds.some((id) => result.has(id))) continue
      for (const id of group.itemIds) {
        if (result.has(id)) continue
        result.add(id)
        changed = true
      }
    }
  }
  return result
}

export function uniqueItems(items: readonly TimelineItem[], label: string): Map<string, TimelineItem> {
  const result = new Map<string, TimelineItem>()
  for (const item of items) {
    if (result.has(item.id)) invalid(`${label} contains duplicate item ${item.id}`)
    result.set(item.id, item)
  }
  return result
}

export function sameItem(left: TimelineItem, right: TimelineItem): boolean {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right))
}

export function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalValue(entry)]))
}

export function sameItemExceptPlacement(left: TimelineItem, right: TimelineItem): boolean {
  return sameItem(
    { ...left, trackId: '', timelineStartFrame: 0 },
    { ...right, trackId: '', timelineStartFrame: 0 }
  )
}

export function isContainedTimelineRange(original: TimelineItem, next: TimelineItem): boolean {
  return original.trackId === next.trackId &&
    next.timelineStartFrame >= original.timelineStartFrame &&
    next.timelineStartFrame + next.durationFrames <= original.timelineStartFrame + original.durationFrames
}

export function changedItemProperties(
  original: TimelineItem,
  next: TimelineItem
): Omit<UpdateItemPropertiesOperation, 'type' | 'itemId'> | undefined {
  const comparableOriginal = withoutItemProperties(original)
  const comparableNext = withoutItemProperties(next)
  if (!sameItem(comparableOriginal, comparableNext)) return undefined
  const patch: Omit<UpdateItemPropertiesOperation, 'type' | 'itemId'> = {}
  if ((original.volume ?? 1) !== (next.volume ?? 1)) patch.volume = next.volume ?? 1
  if (original.fadeInFrames !== next.fadeInFrames) patch.fadeInFrames = next.fadeInFrames
  if (original.fadeOutFrames !== next.fadeOutFrames) patch.fadeOutFrames = next.fadeOutFrames
  if ((original.muted ?? false) !== (next.muted ?? false)) patch.muted = next.muted ?? false
  if ((original.visible ?? true) !== (next.visible ?? true)) patch.visible = next.visible ?? true
  if ((original.locked ?? false) !== (next.locked ?? false)) patch.locked = next.locked ?? false
  return Object.keys(patch).length > 0 ? patch : undefined
}

export function withoutItemProperties(item: TimelineItem): TimelineItem {
  const result = structuredClone(item)
  result.volume = 1
  result.fadeInFrames = 0
  result.fadeOutFrames = 0
  result.muted = false
  result.visible = true
  result.locked = false
  return result
}

export function validatePropertiesPatch(
  patch: Omit<UpdateItemPropertiesOperation, 'type' | 'itemId'>
): void {
  if (Object.keys(patch).length === 0) invalid('Clip properties patch cannot be empty')
  if (patch.volume !== undefined && (!Number.isFinite(patch.volume) || patch.volume < 0 || patch.volume > 4)) {
    invalid('Clip volume must be between 0 and 4')
  }
  for (const [label, value] of [
    ['fadeInFrames', patch.fadeInFrames],
    ['fadeOutFrames', patch.fadeOutFrames]
  ] as const) {
    if (value !== undefined) frame(value, label)
  }
  for (const [label, value] of [
    ['muted', patch.muted],
    ['visible', patch.visible],
    ['locked', patch.locked]
  ] as const) {
    if (value !== undefined && typeof value !== 'boolean') invalid(`${label} must be boolean`)
  }
}

export function finalizePlan(plan: TimelineEditPlan): TimelineEditPlan {
  plan.items.sort((left, right) =>
    left.trackId.localeCompare(right.trackId) || left.timelineStartFrame - right.timelineStartFrame ||
    left.id.localeCompare(right.id)
  )
  plan.removedIds = uniqueSorted(plan.removedIds)
  plan.createdIds = uniqueSorted(plan.createdIds)
  plan.changedIds = uniqueSorted(plan.changedIds)
  plan.shifts.sort((left, right) =>
    left.trackId.localeCompare(right.trackId) || left.fromFrame - right.fromFrame
  )
  return plan
}

export function fragmentId(originId: string, fragment: 'left' | 'right'): string {
  const suffix = fragment === 'left' ? '~l' : '~r'
  return `${originId.slice(0, Math.max(1, 128 - suffix.length))}${suffix}`
}

export function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

export function editRange(startFrame: number, endFrame: number): { startFrame: number; endFrame: number } {
  const start = frame(startFrame, 'startFrame')
  const end = frame(endFrame, 'endFrame')
  if (end <= start) invalid('Timeline edit range must be non-empty and half-open')
  return { startFrame: start, endFrame: end }
}

export function overlaps(start: number, end: number, rangeStart: number, rangeEnd: number): boolean {
  return start < rangeEnd && end > rangeStart
}

export function positiveFrame(value: number, label: string): number {
  const result = frame(value, label)
  if (result <= 0) invalid(`${label} must be positive`)
  return result
}

export function frame(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${label} must be a non-negative safe integer frame`)
  return value
}

export function integer(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) invalid(`${label} must be a safe integer`)
  return value
}

export function invalid(message: string): never {
  throw engineError('invalid_operation', message)
}
