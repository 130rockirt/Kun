import { engineError } from './errors.js'
import type { Rational } from './schema.js'
import { normalizeRational, rescaleFrames } from './time.js'
import {
  MULTICAM_LIMITS,
  validateMulticamGroup,
  type MulticamCoverageReport,
  type MulticamCoverageSegment,
  type MulticamFrameRange,
  type MulticamGroup,
  type MulticamLayout,
  type MulticamLayoutSlot,
  type MulticamMember,
  type MulticamMemberSync,
  type MulticamPlan,
  type MulticamPlanRefusal,
  type MulticamProgramFragment,
  type MulticamProgramSelection,
  type MulticamSourceSlice,
  type MulticamSyncEvidence,
  type MulticamSyncReceiptEvidence
} from './multicam-model.js'
import { multicamProgramDigest } from './multicam-planning.js'
import {
  assertNonOverlappingProgram,
  boundedInteger,
  cloneFragment,
  cloneFragments,
  cloneRange,
  cloneSourceSlice,
  compareFragments,
  confidence,
  deepFreeze,
  frameRange,
  identifier,
  intersectRangeSets,
  intersection,
  invalid,
  label,
  normalizeRanges,
  overlaps,
  planId,
  positiveUnit,
  selectionKey,
  signedInteger,
  stableDigest,
  subtractRanges,
  syncStatus,
  unique,
  unitInterval
} from './multicam-primitives.js'

export function planSelection(input: {
  group: Readonly<MulticamGroup>
  kind: 'switch-angle' | 'apply-layout'
  selection: MulticamProgramSelection
  requestedRange: MulticamFrameRange
  coveragePolicy: 'reject' | 'clamp'
  minimumSyncConfidence: number
}): Readonly<MulticamPlan> {
  const { group, kind } = input
  const selection = normalizeSelection(group, input.selection)
  const requestedRange = frameRange(input.requestedRange, group.durationFrames, 'requested range')
  const minimumSyncConfidence = confidence(input.minimumSyncConfidence, 'minimum sync confidence')
  const selectedMembers = selectionMemberIds(group, selection)
    .map((memberId) => group.members.find(({ id }) => id === memberId)!)
  const syncEvidence = selectedMembers.map(syncReceipt)
  const unswitchable = selectedMembers
    .map((member) => ({ member, refusal: syncRefusal(member, minimumSyncConfidence) }))
    .filter((entry): entry is { member: MulticamMember; refusal: MulticamPlanRefusal['code'] } =>
      entry.refusal !== undefined
    )
  const coverage = evaluateCoverageNormalized(group, selection, requestedRange)
  const before = cloneFragments(group.programFragments)
  const beforeDigest = multicamProgramDigest(before)
  if (unswitchable.length > 0) {
    const code = unswitchable[0]!.refusal
    const memberIds = unswitchable.map(({ member }) => member.id).sort()
    return refusedPlan({
      group,
      kind,
      selection,
      requestedRange,
      before,
      beforeDigest,
      coverage,
      syncEvidence,
      refusal: {
        code,
        message: syncRefusalMessage(code, memberIds),
        memberIds
      }
    })
  }
  if (coverage.uncoveredRanges.length > 0 && input.coveragePolicy === 'reject') {
    const code = coverage.coveredRanges.length === 0 ? 'angle-not-recording' : 'coverage-incomplete'
    return refusedPlan({
      group,
      kind,
      selection,
      requestedRange,
      before,
      beforeDigest,
      coverage,
      syncEvidence,
      refusal: {
        code,
        message: 'The selected multicam source does not cover the complete requested range',
        memberIds: coverage.limitingMemberIds
      }
    })
  }
  if (coverage.coveredRanges.length === 0) {
    return refusedPlan({
      group,
      kind,
      selection,
      requestedRange,
      before,
      beforeDigest,
      coverage,
      syncEvidence,
      refusal: {
        code: 'angle-not-recording',
        message: 'The selected multicam source was not recording in the requested range',
        memberIds: coverage.limitingMemberIds
      }
    })
  }

  const after = replaceProgramRanges(group.id, before, coverage.coveredRanges, selection)
  const afterDigest = multicamProgramDigest(after)
  const plan: MulticamPlan = {
    schemaVersion: 1,
    id: planId(kind, group.id, requestedRange, selection, beforeDigest, afterDigest),
    kind,
    groupId: group.id,
    sequenceId: group.sequenceId,
    fps: { ...group.fps },
    outcome: 'ready',
    requestedRange,
    selection,
    appliedRanges: coverage.coveredRanges.map(cloneRange),
    uncoveredRanges: coverage.uncoveredRanges.map(cloneRange),
    limitingMemberIds: [...coverage.limitingMemberIds],
    syncEvidence,
    sourceSlices: coverage.sourceSlices.map(cloneSourceSlice),
    beforeProgramDigest: beforeDigest,
    afterProgramDigest: afterDigest,
    beforeProgram: before,
    afterProgram: after,
    warnings: coverage.uncoveredRanges.length > 0
      ? [{ code: 'partial-coverage-clamped', memberId: coverage.limitingMemberIds[0] }]
      : []
  }
  // Re-validate the complete program before exposing a commit candidate.
  validateMulticamGroup({ ...group, programFragments: cloneFragments(after) })
  return deepFreeze(plan)
}

export function refusedPlan(input: {
  group: Readonly<MulticamGroup>
  kind: 'switch-angle' | 'apply-layout'
  selection: MulticamProgramSelection
  requestedRange: MulticamFrameRange
  before: MulticamProgramFragment[]
  beforeDigest: string
  coverage: MulticamCoverageReport
  syncEvidence: MulticamSyncReceiptEvidence[]
  refusal: MulticamPlanRefusal
}): Readonly<MulticamPlan> {
  const plan: MulticamPlan = {
    schemaVersion: 1,
    id: planId(
      input.kind,
      input.group.id,
      input.requestedRange,
      input.selection,
      input.beforeDigest,
      `refused:${input.refusal.code}`
    ),
    kind: input.kind,
    groupId: input.group.id,
    sequenceId: input.group.sequenceId,
    fps: { ...input.group.fps },
    outcome: 'refused',
    requestedRange: cloneRange(input.requestedRange),
    selection: { ...input.selection },
    appliedRanges: [],
    uncoveredRanges: [cloneRange(input.requestedRange)],
    limitingMemberIds: [...new Set(input.refusal.memberIds)].sort(),
    syncEvidence: input.syncEvidence.map(cloneSyncReceipt),
    sourceSlices: [],
    beforeProgramDigest: input.beforeDigest,
    afterProgramDigest: input.beforeDigest,
    beforeProgram: cloneFragments(input.before),
    afterProgram: cloneFragments(input.before),
    warnings: [],
    refusal: {
      ...input.refusal,
      memberIds: [...new Set(input.refusal.memberIds)].sort()
    }
  }
  return deepFreeze(plan)
}

export function evaluateCoverageNormalized(
  group: Readonly<MulticamGroup>,
  selection: MulticamProgramSelection,
  requestedRange: MulticamFrameRange
): MulticamCoverageReport {
  const memberIds = selectionMemberIds(group, selection)
  const memberRanges = memberIds.map((memberId) => {
    const member = group.members.find(({ id }) => id === memberId)!
    return normalizeRanges(member.coverage.map(({ startFrame, endFrame }) => ({ startFrame, endFrame })))
  })
  const common = memberRanges.slice(1).reduce(
    (current, ranges) => intersectRangeSets(current, ranges),
    memberRanges[0] ?? []
  )
  const coveredRanges = intersectRangeSets([requestedRange], common)
  const uncoveredRanges = subtractRanges(requestedRange, coveredRanges)
  const limitingMemberIds = memberIds.filter((memberId, index) =>
    subtractRanges(requestedRange, intersectRangeSets([requestedRange], memberRanges[index]!)).length > 0
  ).sort()
  const sourceSlices = resolveSourceSlices(group, memberIds, coveredRanges)
  return {
    schemaVersion: 1,
    groupId: group.id,
    selection: { ...selection },
    requestedRange: cloneRange(requestedRange),
    coveredRanges,
    uncoveredRanges,
    limitingMemberIds,
    sourceSlices
  }
}

export function resolveSourceSlices(
  group: Readonly<MulticamGroup>,
  memberIds: readonly string[],
  coveredRanges: readonly MulticamFrameRange[]
): MulticamSourceSlice[] {
  const slices: MulticamSourceSlice[] = []
  for (const memberId of memberIds) {
    const member = group.members.find(({ id }) => id === memberId)!
    for (const range of coveredRanges) {
      for (const segment of member.coverage) {
        const overlap = intersection(range, segment)
        if (!overlap) continue
        const relativeStart = overlap.startFrame - segment.startFrame
        const relativeEnd = overlap.endFrame - segment.startFrame
        const sourceStartFrame = segment.sourceStartFrame + rescaleFrames(
          relativeStart,
          group.fps,
          member.sourceFps
        )
        const sourceEndFrame = segment.sourceStartFrame + rescaleFrames(
          relativeEnd,
          group.fps,
          member.sourceFps
        )
        if (
          sourceStartFrame < segment.sourceStartFrame ||
          sourceEndFrame > segment.sourceEndFrame ||
          sourceEndFrame <= sourceStartFrame
        ) {
          invalid(`Multicam source mapping exceeds coverage for member ${member.id}`)
        }
        slices.push({
          id: `multicam-slice:${stableDigest([
            group.id,
            member.id,
            overlap.startFrame,
            overlap.endFrame,
            sourceStartFrame,
            sourceEndFrame
          ])}`,
          memberId: member.id,
          assetId: member.assetId,
          startFrame: overlap.startFrame,
          endFrame: overlap.endFrame,
          sourceStartFrame,
          sourceEndFrame,
          sourceFps: { ...member.sourceFps }
        })
      }
    }
  }
  return slices.sort((left, right) =>
    left.startFrame - right.startFrame || left.memberId.localeCompare(right.memberId)
  )
}

export function normalizeMember(
  input: MulticamMember,
  groupFps: Rational,
  durationFrames: number
): MulticamMember {
  const id = identifier(input.id, 'multicam member ID')
  const sourceFps = normalizeRational(input.sourceFps)
  const sync: MulticamMemberSync = {
    status: syncStatus(input.sync?.status),
    offsetFrames: signedInteger(
      input.sync?.offsetFrames,
      MULTICAM_LIMITS.syncOffsetFrames,
      `sync offset for ${id}`
    ),
    ...(input.sync?.confidence === undefined
      ? {}
      : { confidence: confidence(input.sync.confidence, `sync confidence for ${id}`) }),
    evidence: normalizeSyncEvidence(input.sync?.evidence, id)
  }
  if (
    !Array.isArray(input.coverage) ||
    input.coverage.length === 0 ||
    input.coverage.length > MULTICAM_LIMITS.coverageSegmentsPerMember
  ) {
    invalid(
      `Multicam member ${id} requires 1-${MULTICAM_LIMITS.coverageSegmentsPerMember} coverage segments`
    )
  }
  const coverage = input.coverage.map((segment): MulticamCoverageSegment => {
    const range = frameRange(segment, durationFrames, `coverage for ${id}`)
    const sourceStartFrame = boundedInteger(
      segment.sourceStartFrame,
      0,
      Number.MAX_SAFE_INTEGER,
      `sourceStartFrame for ${id}`
    )
    const sourceEndFrame = boundedInteger(
      segment.sourceEndFrame,
      1,
      Number.MAX_SAFE_INTEGER,
      `sourceEndFrame for ${id}`
    )
    if (sourceEndFrame <= sourceStartFrame) invalid(`Source coverage is empty for member ${id}`)
    const mappedStart = rescaleFrames(sourceStartFrame, sourceFps, groupFps) + sync.offsetFrames
    const mappedEnd = rescaleFrames(sourceEndFrame, sourceFps, groupFps) + sync.offsetFrames
    if (mappedStart !== range.startFrame || mappedEnd !== range.endFrame) {
      invalid(`Coverage and sync offset disagree for multicam member ${id}`)
    }
    return {
      id: identifier(segment.id, `coverage ID for ${id}`),
      ...range,
      sourceStartFrame,
      sourceEndFrame
    }
  }).sort((left, right) => left.startFrame - right.startFrame || left.id.localeCompare(right.id))
  unique(coverage, `coverage segment for ${id}`)
  for (let index = 1; index < coverage.length; index += 1) {
    if (coverage[index]!.startFrame < coverage[index - 1]!.endFrame) {
      invalid(`Coverage segments overlap for multicam member ${id}`)
    }
  }
  return {
    id,
    assetId: identifier(input.assetId, `asset ID for ${id}`),
    memberLabel: label(input.memberLabel, `member label for ${id}`),
    angleLabel: label(input.angleLabel, `angle label for ${id}`),
    sourceFps,
    sync,
    coverage
  }
}

export function validateMemberSync(
  member: MulticamMember,
  referenceMemberId: string,
  members: ReadonlyMap<string, MulticamMember>
): void {
  const { sync } = member
  if (member.id === referenceMemberId) {
    if (sync.status !== 'reference' || sync.offsetFrames !== 0 || sync.confidence !== 1) {
      invalid('Reference multicam member requires status reference, zero offset, and confidence 1')
    }
  } else if (sync.status === 'reference') {
    invalid(`Only ${referenceMemberId} may use reference synchronization status`)
  }
  if (sync.status === 'verified' || sync.status === 'uncertain') {
    if (sync.confidence === undefined || sync.evidence.length === 0) {
      invalid(`${sync.status} multicam synchronization requires confidence and evidence`)
    }
    if (!sync.evidence.some(({ confidence: evidenceConfidence }) => evidenceConfidence >= sync.confidence!)) {
      invalid(`Multicam synchronization confidence exceeds all evidence for ${member.id}`)
    }
  }
  if (sync.status === 'unknown' && (sync.confidence !== undefined || sync.evidence.length > 0)) {
    invalid('Unknown multicam synchronization cannot claim confidence or evidence')
  }
  for (const evidence of sync.evidence) {
    if (evidence.referenceMemberId !== referenceMemberId || evidence.targetMemberId !== member.id) {
      invalid(`Synchronization evidence does not identify the member pair for ${member.id}`)
    }
    if (!members.has(evidence.referenceMemberId) || !members.has(evidence.targetMemberId)) {
      invalid(`Synchronization evidence references a missing member for ${member.id}`)
    }
  }
}

export function normalizeSyncEvidence(
  input: readonly MulticamSyncEvidence[] | undefined,
  memberId: string
): MulticamSyncEvidence[] {
  if (!Array.isArray(input) || input.length > MULTICAM_LIMITS.syncEvidencePerMember) {
    invalid(
      `Multicam member ${memberId} supports at most ` +
      `${MULTICAM_LIMITS.syncEvidencePerMember} synchronization evidence records`
    )
  }
  const result = input.map((evidence): MulticamSyncEvidence => {
    if (!['audio-correlation', 'timecode', 'manual-confirmation'].includes(evidence.kind)) {
      invalid(`Unknown multicam synchronization evidence kind for ${memberId}`)
    }
    return {
      id: identifier(evidence.id, `sync evidence ID for ${memberId}`),
      analysisId: identifier(evidence.analysisId, `analysis ID for ${memberId}`),
      kind: evidence.kind,
      referenceMemberId: identifier(evidence.referenceMemberId, 'reference member ID'),
      targetMemberId: identifier(evidence.targetMemberId, 'target member ID'),
      confidence: confidence(evidence.confidence, `evidence confidence for ${memberId}`),
      algorithmId: identifier(evidence.algorithmId, `algorithm ID for ${memberId}`),
      algorithmVersion: label(evidence.algorithmVersion, `algorithm version for ${memberId}`)
    }
  })
  unique(result, `sync evidence for ${memberId}`)
  return result
}

export function normalizeLayout(
  input: MulticamLayout,
  members: ReadonlyMap<string, MulticamMember>
): MulticamLayout {
  const id = identifier(input.id, 'multicam layout ID')
  if (!Array.isArray(input.slots) || input.slots.length < 2 || input.slots.length > MULTICAM_LIMITS.layoutSlots) {
    invalid(`Multicam layout ${id} requires 2-${MULTICAM_LIMITS.layoutSlots} slots`)
  }
  const slots = input.slots.map((slot): MulticamLayoutSlot => {
    const memberId = identifier(slot.memberId, `layout member ID for ${id}`)
    if (!members.has(memberId)) invalid(`Multicam layout ${id} references missing member ${memberId}`)
    const x = unitInterval(slot.x, `layout x for ${memberId}`)
    const y = unitInterval(slot.y, `layout y for ${memberId}`)
    const width = positiveUnit(slot.width, `layout width for ${memberId}`)
    const height = positiveUnit(slot.height, `layout height for ${memberId}`)
    if (x + width > 1 || y + height > 1) {
      invalid(`Multicam layout slot exceeds the normalized canvas for ${memberId}`)
    }
    return {
      memberId,
      x,
      y,
      width,
      height,
      zIndex: boundedInteger(slot.zIndex, 0, MULTICAM_LIMITS.layoutSlots - 1, 'layout zIndex'),
      opacity: unitInterval(slot.opacity, `layout opacity for ${memberId}`),
      audioEnabled: Boolean(slot.audioEnabled)
    }
  }).sort((left, right) => left.zIndex - right.zIndex || left.memberId.localeCompare(right.memberId))
  if (new Set(slots.map(({ memberId }) => memberId)).size !== slots.length) {
    invalid(`Multicam layout ${id} contains a duplicate member`)
  }
  if (new Set(slots.map(({ zIndex }) => zIndex)).size !== slots.length) {
    invalid(`Multicam layout ${id} contains a duplicate zIndex`)
  }
  return { id, label: label(input.label, `layout label for ${id}`), slots }
}

export function normalizeFragment(
  input: MulticamProgramFragment,
  durationFrames: number,
  members: ReadonlyMap<string, MulticamMember>,
  layouts: ReadonlyMap<string, MulticamLayout>
): MulticamProgramFragment {
  const selection = input.selection
  if (selection?.kind === 'angle') {
    const memberId = identifier(selection.memberId, 'program member ID')
    if (!members.has(memberId)) invalid(`Multicam program references missing member ${memberId}`)
    return {
      id: identifier(input.id, 'multicam fragment ID'),
      ...frameRange(input, durationFrames, 'multicam program fragment'),
      selection: { kind: 'angle', memberId }
    }
  }
  if (selection?.kind === 'layout') {
    const layoutId = identifier(selection.layoutId, 'program layout ID')
    if (!layouts.has(layoutId)) invalid(`Multicam program references missing layout ${layoutId}`)
    return {
      id: identifier(input.id, 'multicam fragment ID'),
      ...frameRange(input, durationFrames, 'multicam program fragment'),
      selection: { kind: 'layout', layoutId }
    }
  }
  invalid('Multicam program fragment has an invalid selection')
}

export function normalizeSelection(
  group: Readonly<MulticamGroup>,
  selection: MulticamProgramSelection
): MulticamProgramSelection {
  if (selection?.kind === 'angle') {
    const memberId = identifier(selection.memberId, 'multicam member ID')
    if (!group.members.some(({ id }) => id === memberId)) invalid(`Multicam member does not exist: ${memberId}`)
    return { kind: 'angle', memberId }
  }
  if (selection?.kind === 'layout') {
    const layoutId = identifier(selection.layoutId, 'multicam layout ID')
    if (!group.layouts.some(({ id }) => id === layoutId)) invalid(`Multicam layout does not exist: ${layoutId}`)
    return { kind: 'layout', layoutId }
  }
  invalid('Unknown multicam program selection')
}

export function selectionMemberIds(
  group: Readonly<MulticamGroup>,
  selection: MulticamProgramSelection
): string[] {
  if (selection.kind === 'angle') return [selection.memberId]
  const layout = group.layouts.find(({ id }) => id === selection.layoutId)
  if (!layout) invalid(`Multicam layout does not exist: ${selection.layoutId}`)
  return layout!.slots.map(({ memberId }) => memberId).sort()
}

export function replaceProgramRanges(
  groupId: string,
  program: readonly MulticamProgramFragment[],
  replacementRanges: readonly MulticamFrameRange[],
  selection: MulticamProgramSelection
): MulticamProgramFragment[] {
  const ranges = normalizeRanges(replacementRanges)
  const result: MulticamProgramFragment[] = []
  for (const fragment of program) {
    if (!ranges.some((range) => overlaps(fragment, range))) {
      result.push(cloneFragment(fragment))
      continue
    }
    for (const remainder of subtractRanges(fragment, ranges)) {
      result.push(fragmentFor(groupId, remainder.startFrame, remainder.endFrame, fragment.selection))
    }
  }
  for (const range of ranges) {
    result.push(fragmentFor(groupId, range.startFrame, range.endFrame, selection))
  }
  const sorted = result.sort(compareFragments)
  assertNonOverlappingProgram(sorted)
  if (sorted.length > MULTICAM_LIMITS.programFragmentsPerGroup) {
    invalid('Multicam plan exceeds the bounded program fragment limit')
  }
  return sorted
}

export function fragmentFor(
  groupId: string,
  startFrame: number,
  endFrame: number,
  selection: MulticamProgramSelection
): MulticamProgramFragment {
  return {
    // Program fragments are persisted as project entities and therefore use
    // the same colon-free stable-ID alphabet as other project records.
    id: `multicam-fragment-${stableDigest([groupId, startFrame, endFrame, selectionKey(selection)])}`,
    startFrame,
    endFrame,
    selection: { ...selection }
  }
}

export function syncRefusal(
  member: Readonly<MulticamMember>,
  minimumConfidence: number
): MulticamPlanRefusal['code'] | undefined {
  if (member.sync.status === 'reference') return undefined
  if (member.sync.status === 'unknown') return 'sync-evidence-unavailable'
  if (member.sync.status === 'uncertain') return 'sync-evidence-uncertain'
  if ((member.sync.confidence ?? 0) < minimumConfidence) return 'sync-confidence-below-threshold'
  return undefined
}

export function syncRefusalMessage(code: MulticamPlanRefusal['code'], memberIds: readonly string[]): string {
  const suffix = memberIds.join(', ')
  if (code === 'sync-evidence-unavailable') return `Synchronization evidence is unavailable for: ${suffix}`
  if (code === 'sync-evidence-uncertain') return `Synchronization evidence is uncertain for: ${suffix}`
  return `Synchronization confidence is below the requested threshold for: ${suffix}`
}

export function syncReceipt(member: Readonly<MulticamMember>): MulticamSyncReceiptEvidence {
  return {
    memberId: member.id,
    angleLabel: member.angleLabel,
    status: member.sync.status,
    offsetFrames: member.sync.offsetFrames,
    ...(member.sync.confidence === undefined ? {} : { confidence: member.sync.confidence }),
    evidenceIds: member.sync.evidence.map(({ id }) => id).sort()
  }
}

export function cloneSyncReceipt(value: MulticamSyncReceiptEvidence): MulticamSyncReceiptEvidence {
  return { ...value, evidenceIds: [...value.evidenceIds] }
}
