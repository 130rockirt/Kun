import { engineError } from './errors.js'
import type { Rational } from './schema.js'
import { normalizeRational, rescaleFrames } from './time.js'
import {
  MULTICAM_LIMITS,
  type MulticamFrameRange,
  type MulticamLayout,
  type MulticamMember,
  type MulticamMemberSync,
  type MulticamPlan,
  type MulticamProgramFragment,
  type MulticamProgramSelection,
  type MulticamSourceSlice,
  type MulticamTransactionOperation
} from './multicam-model.js'

export function normalizeRanges(input: readonly MulticamFrameRange[]): MulticamFrameRange[] {
  const sorted = input.map(cloneRange).sort((left, right) => left.startFrame - right.startFrame)
  const result: MulticamFrameRange[] = []
  for (const range of sorted) {
    const previous = result.at(-1)
    if (previous && range.startFrame <= previous.endFrame) {
      previous.endFrame = Math.max(previous.endFrame, range.endFrame)
    } else {
      result.push(range)
    }
  }
  return result
}

export function intersectRangeSets(
  leftInput: readonly MulticamFrameRange[],
  rightInput: readonly MulticamFrameRange[]
): MulticamFrameRange[] {
  const left = normalizeRanges(leftInput)
  const right = normalizeRanges(rightInput)
  const result: MulticamFrameRange[] = []
  let leftIndex = 0
  let rightIndex = 0
  while (leftIndex < left.length && rightIndex < right.length) {
    const overlap = intersection(left[leftIndex]!, right[rightIndex]!)
    if (overlap) result.push(overlap)
    if (left[leftIndex]!.endFrame <= right[rightIndex]!.endFrame) leftIndex += 1
    else rightIndex += 1
  }
  return normalizeRanges(result)
}

export function subtractRanges(
  range: MulticamFrameRange,
  removalsInput: readonly MulticamFrameRange[]
): MulticamFrameRange[] {
  const removals = normalizeRanges(removalsInput).filter((candidate) => overlaps(range, candidate))
  const result: MulticamFrameRange[] = []
  let cursor = range.startFrame
  for (const removal of removals) {
    const start = Math.max(range.startFrame, removal.startFrame)
    const end = Math.min(range.endFrame, removal.endFrame)
    if (start > cursor) result.push({ startFrame: cursor, endFrame: start })
    cursor = Math.max(cursor, end)
  }
  if (cursor < range.endFrame) result.push({ startFrame: cursor, endFrame: range.endFrame })
  return result
}

export function intersection(
  left: MulticamFrameRange,
  right: MulticamFrameRange
): MulticamFrameRange | undefined {
  const startFrame = Math.max(left.startFrame, right.startFrame)
  const endFrame = Math.min(left.endFrame, right.endFrame)
  return endFrame > startFrame ? { startFrame, endFrame } : undefined
}

export function overlaps(left: MulticamFrameRange, right: MulticamFrameRange): boolean {
  return left.startFrame < right.endFrame && right.startFrame < left.endFrame
}

export function assertNonOverlappingProgram(program: readonly MulticamProgramFragment[]): void {
  for (let index = 1; index < program.length; index += 1) {
    if (program[index]!.startFrame < program[index - 1]!.endFrame) {
      invalid('Multicam program fragments must be non-overlapping')
    }
  }
}

export function frameRange(
  value: MulticamFrameRange,
  maximum: number,
  name: string
): MulticamFrameRange {
  const startFrame = boundedInteger(value?.startFrame, 0, maximum, `${name}.startFrame`)
  const endFrame = boundedInteger(value?.endFrame, 1, maximum, `${name}.endFrame`)
  if (endFrame <= startFrame) invalid(`${name} must be a non-empty half-open frame range`)
  return { startFrame, endFrame }
}

export function planId(
  kind: MulticamPlan['kind'],
  groupId: string,
  requestedRange: MulticamFrameRange,
  selection: MulticamProgramSelection | undefined,
  beforeDigest: string,
  afterDigest: string
): string {
  return `multicam-plan:${stableDigest([
    kind,
    groupId,
    requestedRange.startFrame,
    requestedRange.endFrame,
    selection ? selectionKey(selection) : 'none',
    beforeDigest,
    afterDigest
  ])}`
}

export function selectionEquals(left: MulticamProgramSelection, right: MulticamProgramSelection): boolean {
  return selectionKey(left) === selectionKey(right)
}

export function selectionKey(selection: MulticamProgramSelection): string {
  return selection.kind === 'angle' ? `angle:${selection.memberId}` : `layout:${selection.layoutId}`
}

export function fragmentEquals(left: MulticamProgramFragment, right: MulticamProgramFragment): boolean {
  return left.id === right.id &&
    left.startFrame === right.startFrame &&
    left.endFrame === right.endFrame &&
    selectionEquals(left.selection, right.selection)
}

export function compareFragments(left: MulticamProgramFragment, right: MulticamProgramFragment): number {
  return left.startFrame - right.startFrame ||
    left.endFrame - right.endFrame ||
    left.id.localeCompare(right.id)
}

export function cloneFragment(fragment: MulticamProgramFragment): MulticamProgramFragment {
  return { ...fragment, selection: { ...fragment.selection } }
}

export function cloneTransactionOperation(
  operation: MulticamTransactionOperation
): MulticamTransactionOperation {
  return operation.type === 'delete-multicam-program-fragment'
    ? { ...operation }
    : { ...operation, fragment: cloneFragment(operation.fragment) }
}

export function cloneFragments(fragments: readonly MulticamProgramFragment[]): MulticamProgramFragment[] {
  return fragments.map(cloneFragment)
}

export function cloneRange(range: MulticamFrameRange): MulticamFrameRange {
  return { startFrame: range.startFrame, endFrame: range.endFrame }
}

export function cloneSourceSlice(slice: MulticamSourceSlice): MulticamSourceSlice {
  return { ...slice, sourceFps: { ...slice.sourceFps } }
}

export function cloneMember(member: Readonly<MulticamMember>): MulticamMember {
  return {
    id: member.id,
    assetId: member.assetId,
    memberLabel: member.memberLabel,
    angleLabel: member.angleLabel,
    sourceFps: { ...member.sourceFps },
    sync: {
      ...member.sync,
      evidence: member.sync.evidence.map((evidence) => ({ ...evidence }))
    },
    coverage: member.coverage.map((segment) => ({ ...segment }))
  }
}

export function cloneLayout(layout: Readonly<MulticamLayout>): MulticamLayout {
  return { id: layout.id, label: layout.label, slots: layout.slots.map((slot) => ({ ...slot })) }
}

export function boundedCopy<T>(values: readonly T[], maximum: number): T[] {
  return values.slice(0, maximum).map((value) => structuredClone(value))
}

export function syncStatus(value: unknown): MulticamMemberSync['status'] {
  if (value === 'reference' || value === 'verified' || value === 'uncertain' || value === 'unknown') {
    return value
  }
  invalid('Unknown multicam synchronization status')
}

export function identifier(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MULTICAM_LIMITS.idLength ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  ) {
    invalid(`${name} is invalid or path-like`)
  }
  return value
}

export function label(value: unknown, name: string): string {
  if (typeof value !== 'string') invalid(`${name} must be a string`)
  const result = value.trim()
  if (
    result.length === 0 ||
    result.length > MULTICAM_LIMITS.labelLength ||
    looksLikeExternalLocator(result)
  ) {
    invalid(`${name} is invalid or exposes an external locator`)
  }
  return result
}

export function looksLikeExternalLocator(value: string): boolean {
  return /^(?:\/|~[/\\]|[A-Za-z]:[/\\]|\\\\|[A-Za-z][A-Za-z0-9+.-]*:\/\/)/u.test(value)
}

export function unique(values: readonly { id: string }[], name: string): void {
  if (new Set(values.map(({ id }) => id)).size !== values.length) invalid(`Duplicate ${name} ID`)
}

export function uniqueCaseInsensitive(values: readonly string[], name: string): void {
  const normalized = values.map((value) => value.toLocaleLowerCase('en-US'))
  if (new Set(normalized).size !== values.length) invalid(`Duplicate ${name}`)
}

export function confidence(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    invalid(`${name} must be between 0 and 1`)
  }
  return Number(value.toFixed(8))
}

export function unitInterval(value: unknown, name: string): number {
  return confidence(value, name)
}

export function positiveUnit(value: unknown, name: string): number {
  const result = confidence(value, name)
  if (result <= 0) invalid(`${name} must be greater than zero`)
  return result
}

export function signedInteger(value: unknown, maximumAbsolute: number, name: string): number {
  if (!Number.isSafeInteger(value) || Math.abs(value as number) > maximumAbsolute) {
    invalid(`${name} must be a bounded safe integer`)
  }
  return value as number
}

export function boundedInteger(value: unknown, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalid(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return value as number
}

export function stableDigest(value: unknown): string {
  const input = JSON.stringify(value)
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash.toString(16).padStart(16, '0')
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
  }
  return value
}

export function invalid(message: string): never {
  throw engineError('invalid_operation', message)
}
