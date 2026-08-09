import { engineError } from './errors.js'
import type { Rational } from './schema.js'
import { normalizeRational, rescaleFrames } from './time.js'
import {
  evaluateCoverageNormalized,
  normalizeFragment,
  normalizeLayout,
  normalizeMember,
  selectionMemberIds,
  validateMemberSync
} from './multicam-planning-support.js'
import {
  assertNonOverlappingProgram,
  boundedInteger,
  compareFragments,
  deepFreeze,
  identifier,
  invalid,
  label,
  unique,
  uniqueCaseInsensitive
} from './multicam-primitives.js'

export const MULTICAM_LIMITS = Object.freeze({
  groupsPerProject: 64,
  membersPerGroup: 32,
  coverageSegmentsPerMember: 256,
  layoutsPerGroup: 32,
  layoutSlots: 16,
  programFragmentsPerGroup: 4_096,
  syncEvidencePerMember: 16,
  operationsPerTransaction: 200,
  receiptRanges: 64,
  receiptSourceSlices: 128,
  idLength: 128,
  labelLength: 96,
  durationFrames: 31_104_000,
  syncOffsetFrames: 31_104_000
} as const)

export const DEFAULT_MULTICAM_SYNC_CONFIDENCE = 0.82

export type MulticamFrameRange = {
  startFrame: number
  endFrame: number
}

export type MulticamSyncEvidence = {
  id: string
  analysisId: string
  kind: 'audio-correlation' | 'timecode' | 'manual-confirmation'
  referenceMemberId: string
  targetMemberId: string
  confidence: number
  algorithmId: string
  algorithmVersion: string
}

export type MulticamMemberSync = {
  status: 'reference' | 'verified' | 'uncertain' | 'unknown'
  /** Offset from the member's source frame zero to the group frame timebase. */
  offsetFrames: number
  confidence?: number
  evidence: MulticamSyncEvidence[]
}

export type MulticamCoverageSegment = {
  id: string
  /** Half-open range on the shared multicam timebase. */
  startFrame: number
  endFrame: number
  /** Half-open source range on sourceFps. */
  sourceStartFrame: number
  sourceEndFrame: number
}

export type MulticamMember = {
  id: string
  assetId: string
  memberLabel: string
  angleLabel: string
  sourceFps: Rational
  sync: MulticamMemberSync
  coverage: MulticamCoverageSegment[]
}

export type MulticamLayoutSlot = {
  memberId: string
  x: number
  y: number
  width: number
  height: number
  zIndex: number
  opacity: number
  audioEnabled: boolean
}

export type MulticamLayout = {
  id: string
  label: string
  slots: MulticamLayoutSlot[]
}

export type MulticamProgramSelection =
  | { kind: 'angle'; memberId: string }
  | { kind: 'layout'; layoutId: string }

export type MulticamProgramFragment = MulticamFrameRange & {
  id: string
  selection: MulticamProgramSelection
}

export type MulticamGroup = {
  schemaVersion: 1
  id: string
  sequenceId: string
  name: string
  fps: Rational
  durationFrames: number
  referenceMemberId: string
  members: MulticamMember[]
  layouts: MulticamLayout[]
  programFragments: MulticamProgramFragment[]
}

export type MulticamSourceSlice = MulticamFrameRange & {
  id: string
  memberId: string
  assetId: string
  sourceStartFrame: number
  sourceEndFrame: number
  sourceFps: Rational
}

export type MulticamCoverageReport = {
  schemaVersion: 1
  groupId: string
  selection: MulticamProgramSelection
  requestedRange: MulticamFrameRange
  coveredRanges: MulticamFrameRange[]
  uncoveredRanges: MulticamFrameRange[]
  limitingMemberIds: string[]
  sourceSlices: MulticamSourceSlice[]
}

export type MulticamSyncReceiptEvidence = {
  memberId: string
  angleLabel: string
  status: MulticamMemberSync['status']
  offsetFrames: number
  confidence?: number
  evidenceIds: string[]
}

export type MulticamPlanRefusal = {
  code:
    | 'sync-evidence-unavailable'
    | 'sync-evidence-uncertain'
    | 'sync-confidence-below-threshold'
    | 'coverage-incomplete'
    | 'angle-not-recording'
  message: string
  memberIds: string[]
}

export type MulticamPlan = {
  schemaVersion: 1
  id: string
  kind: 'switch-angle' | 'apply-layout' | 'merge-adjacent'
  groupId: string
  sequenceId: string
  fps: Rational
  outcome: 'ready' | 'refused'
  requestedRange: MulticamFrameRange
  selection?: MulticamProgramSelection
  appliedRanges: MulticamFrameRange[]
  uncoveredRanges: MulticamFrameRange[]
  limitingMemberIds: string[]
  syncEvidence: MulticamSyncReceiptEvidence[]
  sourceSlices: MulticamSourceSlice[]
  beforeProgramDigest: string
  afterProgramDigest: string
  beforeProgram: MulticamProgramFragment[]
  afterProgram: MulticamProgramFragment[]
  warnings: Array<{
    code: 'partial-coverage-clamped' | 'adjacent-fragments-merged'
    memberId?: string
    count?: number
  }>
  refusal?: MulticamPlanRefusal
}

export type MulticamTransactionOperation =
  | { type: 'delete-multicam-program-fragment'; groupId: string; fragmentId: string }
  | { type: 'upsert-multicam-program-fragment'; groupId: string; fragment: MulticamProgramFragment }

export type MulticamReceiptEvidence = {
  schemaVersion: 1
  planId: string
  planKind: MulticamPlan['kind']
  groupId: string
  sequenceId: string
  requestedRange: MulticamFrameRange
  appliedRanges: MulticamFrameRange[]
  uncoveredRanges: MulticamFrameRange[]
  limitingAngles: Array<{ memberId: string; angleLabel: string }>
  sync: MulticamSyncReceiptEvidence[]
  sourceSlices: MulticamSourceSlice[]
  createdFragmentIds: string[]
  changedFragmentIds: string[]
  removedFragmentIds: string[]
  previousProgramDigest: string
  nextProgramDigest: string
  truncated: {
    appliedRanges: number
    uncoveredRanges: number
    sourceSlices: number
  }
}

export type MulticamPlanTransaction = {
  schemaVersion: 1
  id: string
  projectId: string
  sequenceId: string
  groupId: string
  expectedRevision: number
  expectedProgramDigest: string
  nextProgramDigest: string
  operations: MulticamTransactionOperation[]
  inverseOperations: MulticamTransactionOperation[]
  receiptEvidence: MulticamReceiptEvidence
}

export function validateMulticamGroup(input: MulticamGroup): Readonly<MulticamGroup> {
  const fps = normalizeRational(input.fps)
  const groupId = identifier(input.id, 'multicam group ID')
  const sequenceId = identifier(input.sequenceId, 'sequence ID')
  const name = label(input.name, 'multicam group name')
  const durationFrames = boundedInteger(
    input.durationFrames,
    1,
    MULTICAM_LIMITS.durationFrames,
    'multicam durationFrames'
  )
  if (input.schemaVersion !== 1) invalid('Unsupported multicam group schema version')
  if (!Array.isArray(input.members) || input.members.length < 2) {
    invalid('A multicam group requires at least two members')
  }
  if (input.members.length > MULTICAM_LIMITS.membersPerGroup) {
    invalid(`A multicam group supports at most ${MULTICAM_LIMITS.membersPerGroup} members`)
  }

  const members = input.members.map((member) => normalizeMember(member, fps, durationFrames))
  unique(members, 'multicam member')
  uniqueCaseInsensitive(members.map(({ angleLabel }) => angleLabel), 'angle label')
  const memberMap = new Map(members.map((member) => [member.id, member]))
  const referenceMemberId = identifier(input.referenceMemberId, 'reference member ID')
  const reference = memberMap.get(referenceMemberId)
  if (!reference) invalid(`Reference multicam member does not exist: ${referenceMemberId}`)
  for (const member of members) validateMemberSync(member, referenceMemberId, memberMap)
  if (reference!.sync.status !== 'reference') {
    invalid('The reference member must use reference synchronization status')
  }
  if (members.filter(({ sync }) => sync.status === 'reference').length !== 1) {
    invalid('A multicam group must contain exactly one reference synchronization member')
  }

  if (!Array.isArray(input.layouts) || input.layouts.length > MULTICAM_LIMITS.layoutsPerGroup) {
    invalid(`A multicam group supports at most ${MULTICAM_LIMITS.layoutsPerGroup} layouts`)
  }
  const layouts = input.layouts.map((layoutValue) => normalizeLayout(layoutValue, memberMap))
  unique(layouts, 'multicam layout')
  const layoutMap = new Map(layouts.map((layoutValue) => [layoutValue.id, layoutValue]))

  if (
    !Array.isArray(input.programFragments) ||
    input.programFragments.length > MULTICAM_LIMITS.programFragmentsPerGroup
  ) {
    invalid(`A multicam program supports at most ${MULTICAM_LIMITS.programFragmentsPerGroup} fragments`)
  }
  const programFragments = input.programFragments
    .map((fragment) => normalizeFragment(fragment, durationFrames, memberMap, layoutMap))
    .sort(compareFragments)
  unique(programFragments, 'multicam program fragment')
  assertNonOverlappingProgram(programFragments)

  const normalized: MulticamGroup = {
    schemaVersion: 1,
    id: groupId,
    sequenceId,
    name,
    fps,
    durationFrames,
    referenceMemberId,
    members,
    layouts,
    programFragments
  }
  for (const fragment of programFragments) {
    const report = evaluateCoverageNormalized(normalized, fragment.selection, fragment)
    if (report.uncoveredRanges.length > 0) {
      invalid(`Multicam program fragment exceeds source coverage: ${fragment.id}`)
    }
    for (const memberId of selectionMemberIds(normalized, fragment.selection)) {
      const status = memberMap.get(memberId)!.sync.status
      if (status === 'unknown' || status === 'uncertain') {
        invalid(`Multicam program fragment uses an unsynchronized member: ${memberId}`)
      }
    }
  }
  return deepFreeze(normalized)
}
