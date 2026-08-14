import { engineError } from './errors.js'
import type { Rational } from './schema.js'
import { normalizeRational, rescaleFrames } from './time.js'
import {
  DEFAULT_MULTICAM_SYNC_CONFIDENCE,
  MULTICAM_LIMITS,
  validateMulticamGroup,
  type MulticamCoverageReport,
  type MulticamFrameRange,
  type MulticamGroup,
  type MulticamPlan,
  type MulticamPlanTransaction,
  type MulticamProgramFragment,
  type MulticamProgramSelection,
  type MulticamReceiptEvidence,
  type MulticamTransactionOperation
} from './multicam-model.js'
import {
  cloneSyncReceipt,
  evaluateCoverageNormalized,
  fragmentFor,
  normalizeSelection,
  planSelection
} from './multicam-planning-support.js'
import {
  boundedCopy,
  boundedInteger,
  cloneFragment,
  cloneFragments,
  cloneLayout,
  cloneMember,
  cloneTransactionOperation,
  compareFragments,
  deepFreeze,
  fragmentEquals,
  frameRange,
  identifier,
  invalid,
  planId,
  selectionEquals,
  selectionKey,
  stableDigest
} from './multicam-primitives.js'

export function evaluateMulticamCoverage(
  groupInput: MulticamGroup,
  selectionInput: MulticamProgramSelection,
  requestedRangeInput: MulticamFrameRange
): Readonly<MulticamCoverageReport> {
  const group = validateMulticamGroup(groupInput)
  const selection = normalizeSelection(group, selectionInput)
  const requestedRange = frameRange(requestedRangeInput, group.durationFrames, 'requested range')
  return deepFreeze(evaluateCoverageNormalized(group, selection, requestedRange))
}

export function planMulticamAngleSwitch(input: {
  group: MulticamGroup
  memberId: string
  requestedRange: MulticamFrameRange
  coveragePolicy?: 'reject' | 'clamp'
  minimumSyncConfidence?: number
}): Readonly<MulticamPlan> {
  const group = validateMulticamGroup(input.group)
  const memberId = identifier(input.memberId, 'multicam member ID')
  const member = group.members.find(({ id }) => id === memberId)
  if (!member) invalid(`Multicam member does not exist: ${memberId}`)
  return planSelection({
    group,
    kind: 'switch-angle',
    selection: { kind: 'angle', memberId },
    requestedRange: input.requestedRange,
    coveragePolicy: input.coveragePolicy ?? 'reject',
    minimumSyncConfidence: input.minimumSyncConfidence ?? DEFAULT_MULTICAM_SYNC_CONFIDENCE
  })
}

export function planMulticamLayout(input: {
  group: MulticamGroup
  layoutId: string
  requestedRange: MulticamFrameRange
  coveragePolicy?: 'reject' | 'clamp'
  minimumSyncConfidence?: number
}): Readonly<MulticamPlan> {
  const group = validateMulticamGroup(input.group)
  const layoutId = identifier(input.layoutId, 'multicam layout ID')
  if (!group.layouts.some(({ id }) => id === layoutId)) {
    invalid(`Multicam layout does not exist: ${layoutId}`)
  }
  return planSelection({
    group,
    kind: 'apply-layout',
    selection: { kind: 'layout', layoutId },
    requestedRange: input.requestedRange,
    coveragePolicy: input.coveragePolicy ?? 'reject',
    minimumSyncConfidence: input.minimumSyncConfidence ?? DEFAULT_MULTICAM_SYNC_CONFIDENCE
  })
}

export function planMulticamMerge(groupInput: MulticamGroup): Readonly<MulticamPlan> {
  const group = validateMulticamGroup(groupInput)
  const before = cloneFragments(group.programFragments)
  const after: MulticamProgramFragment[] = []
  let mergedCount = 0
  for (const fragment of before) {
    const previous = after.at(-1)
    if (
      previous &&
      previous.endFrame === fragment.startFrame &&
      selectionEquals(previous.selection, fragment.selection)
    ) {
      after[after.length - 1] = fragmentFor(
        group.id,
        previous.startFrame,
        fragment.endFrame,
        previous.selection
      )
      mergedCount += 1
    } else {
      after.push(fragment)
    }
  }
  const beforeDigest = multicamProgramDigest(before)
  const afterDigest = multicamProgramDigest(after)
  const requestedRange = { startFrame: 0, endFrame: group.durationFrames }
  return deepFreeze({
    schemaVersion: 1,
    id: planId('merge-adjacent', group.id, requestedRange, undefined, beforeDigest, afterDigest),
    kind: 'merge-adjacent',
    groupId: group.id,
    sequenceId: group.sequenceId,
    fps: { ...group.fps },
    outcome: 'ready',
    requestedRange,
    appliedRanges: [],
    uncoveredRanges: [],
    limitingMemberIds: [],
    syncEvidence: [],
    sourceSlices: [],
    beforeProgramDigest: beforeDigest,
    afterProgramDigest: afterDigest,
    beforeProgram: before,
    afterProgram: cloneFragments(after),
    warnings: mergedCount > 0
      ? [{ code: 'adjacent-fragments-merged', count: mergedCount }]
      : []
  })
}

export function compileMulticamPlanTransaction(input: {
  projectId: string
  expectedRevision: number
  group: MulticamGroup
  plan: MulticamPlan
}): Readonly<MulticamPlanTransaction> {
  const projectId = identifier(input.projectId, 'project ID')
  const expectedRevision = boundedInteger(
    input.expectedRevision,
    0,
    Number.MAX_SAFE_INTEGER,
    'expectedRevision'
  )
  const group = validateMulticamGroup(input.group)
  const plan = input.plan
  if (plan.groupId !== group.id || plan.sequenceId !== group.sequenceId) {
    invalid('Multicam plan does not belong to the selected group and sequence')
  }
  if (plan.outcome !== 'ready' || plan.refusal) {
    invalid('A refused multicam plan cannot be compiled into mutation operations')
  }
  const currentDigest = multicamProgramDigest(group.programFragments)
  if (plan.beforeProgramDigest !== currentDigest) {
    throw engineError(
      'revision_conflict',
      'Multicam program changed after planning; refresh before compiling the transaction'
    )
  }

  const beforeById = new Map(plan.beforeProgram.map((fragment) => [fragment.id, fragment]))
  const afterById = new Map(plan.afterProgram.map((fragment) => [fragment.id, fragment]))
  const removedFragmentIds = [...beforeById.keys()]
    .filter((id) => !afterById.has(id))
    .sort()
  const createdFragmentIds = [...afterById.keys()]
    .filter((id) => !beforeById.has(id))
    .sort()
  const changedFragmentIds = [...afterById.keys()]
    .filter((id) => beforeById.has(id) && !fragmentEquals(beforeById.get(id)!, afterById.get(id)!))
    .sort()
  const operations: MulticamTransactionOperation[] = [
    ...removedFragmentIds.map((fragmentId): MulticamTransactionOperation => ({
      type: 'delete-multicam-program-fragment',
      groupId: group.id,
      fragmentId
    })),
    ...[...createdFragmentIds, ...changedFragmentIds].sort().map((fragmentId): MulticamTransactionOperation => ({
      type: 'upsert-multicam-program-fragment',
      groupId: group.id,
      fragment: cloneFragment(afterById.get(fragmentId)!)
    }))
  ]
  const inverseOperations: MulticamTransactionOperation[] = [
    ...createdFragmentIds.map((fragmentId): MulticamTransactionOperation => ({
      type: 'delete-multicam-program-fragment',
      groupId: group.id,
      fragmentId
    })),
    ...[...removedFragmentIds, ...changedFragmentIds].sort().map((fragmentId): MulticamTransactionOperation => ({
      type: 'upsert-multicam-program-fragment',
      groupId: group.id,
      fragment: cloneFragment(beforeById.get(fragmentId)!)
    }))
  ]
  if (operations.length > MULTICAM_LIMITS.operationsPerTransaction) {
    invalid(
      `Multicam plan requires ${operations.length} operations; ` +
      `the bounded transaction limit is ${MULTICAM_LIMITS.operationsPerTransaction}`
    )
  }
  const appliedRanges = boundedCopy(plan.appliedRanges, MULTICAM_LIMITS.receiptRanges)
  const uncoveredRanges = boundedCopy(plan.uncoveredRanges, MULTICAM_LIMITS.receiptRanges)
  const sourceSlices = boundedCopy(plan.sourceSlices, MULTICAM_LIMITS.receiptSourceSlices)
  const receiptEvidence: MulticamReceiptEvidence = {
    schemaVersion: 1,
    planId: plan.id,
    planKind: plan.kind,
    groupId: group.id,
    sequenceId: group.sequenceId,
    requestedRange: { ...plan.requestedRange },
    appliedRanges,
    uncoveredRanges,
    limitingAngles: plan.limitingMemberIds.map((memberId) => ({
      memberId,
      angleLabel: group.members.find(({ id }) => id === memberId)!.angleLabel
    })),
    sync: plan.syncEvidence.map(cloneSyncReceipt),
    sourceSlices,
    createdFragmentIds,
    changedFragmentIds,
    removedFragmentIds,
    previousProgramDigest: currentDigest,
    nextProgramDigest: plan.afterProgramDigest,
    truncated: {
      appliedRanges: Math.max(0, plan.appliedRanges.length - appliedRanges.length),
      uncoveredRanges: Math.max(0, plan.uncoveredRanges.length - uncoveredRanges.length),
      sourceSlices: Math.max(0, plan.sourceSlices.length - sourceSlices.length)
    }
  }
  return deepFreeze({
    schemaVersion: 1,
    id: `multicam-tx:${stableDigest([projectId, expectedRevision, plan.id])}`,
    projectId,
    sequenceId: group.sequenceId,
    groupId: group.id,
    expectedRevision,
    expectedProgramDigest: currentDigest,
    nextProgramDigest: plan.afterProgramDigest,
    operations,
    inverseOperations,
    receiptEvidence
  })
}

export function invertMulticamPlanTransaction(
  transaction: MulticamPlanTransaction,
  expectedRevision: number
): Readonly<MulticamPlanTransaction> {
  const revision = boundedInteger(
    expectedRevision,
    0,
    Number.MAX_SAFE_INTEGER,
    'expectedRevision'
  )
  const receipt = transaction.receiptEvidence
  return deepFreeze({
    schemaVersion: 1,
    id: `multicam-undo-tx:${stableDigest([transaction.id, revision])}`,
    projectId: identifier(transaction.projectId, 'project ID'),
    sequenceId: identifier(transaction.sequenceId, 'sequence ID'),
    groupId: identifier(transaction.groupId, 'multicam group ID'),
    expectedRevision: revision,
    expectedProgramDigest: transaction.nextProgramDigest,
    nextProgramDigest: transaction.expectedProgramDigest,
    operations: transaction.inverseOperations.map(cloneTransactionOperation),
    inverseOperations: transaction.operations.map(cloneTransactionOperation),
    receiptEvidence: {
      ...structuredClone(receipt),
      planId: `undo:${receipt.planId}`,
      createdFragmentIds: [...receipt.removedFragmentIds],
      changedFragmentIds: [...receipt.changedFragmentIds],
      removedFragmentIds: [...receipt.createdFragmentIds],
      previousProgramDigest: receipt.nextProgramDigest,
      nextProgramDigest: receipt.previousProgramDigest
    }
  })
}

/**
 * Applies a compiled transaction to an isolated group snapshot. The project command
 * service remains responsible for the real revision commit and receipt.
 */
export function applyMulticamTransactionPreview(input: {
  projectId: string
  sequenceId: string
  currentRevision: number
  group: MulticamGroup
  transaction: MulticamPlanTransaction
}): Readonly<{ group: Readonly<MulticamGroup>; receiptEvidence: Readonly<MulticamReceiptEvidence> }> {
  const projectId = identifier(input.projectId, 'project ID')
  const sequenceId = identifier(input.sequenceId, 'sequence ID')
  const currentRevision = boundedInteger(
    input.currentRevision,
    0,
    Number.MAX_SAFE_INTEGER,
    'currentRevision'
  )
  const group = validateMulticamGroup(input.group)
  const transaction = input.transaction
  if (
    transaction.projectId !== projectId ||
    transaction.sequenceId !== sequenceId ||
    transaction.groupId !== group.id ||
    group.sequenceId !== sequenceId ||
    transaction.expectedRevision !== currentRevision
  ) {
    throw engineError('revision_conflict', 'Multicam transaction ownership or revision is stale')
  }
  if (transaction.operations.length > MULTICAM_LIMITS.operationsPerTransaction) {
    invalid('Multicam transaction exceeds the bounded operation limit')
  }
  const currentDigest = multicamProgramDigest(group.programFragments)
  if (transaction.expectedProgramDigest !== currentDigest) {
    throw engineError('revision_conflict', 'Multicam program digest is stale')
  }

  const fragments = new Map(group.programFragments.map((fragment) => [fragment.id, cloneFragment(fragment)]))
  for (const operation of transaction.operations) {
    if (operation.groupId !== group.id) invalid('Multicam operation targets another group')
    if (operation.type === 'delete-multicam-program-fragment') {
      if (!fragments.delete(operation.fragmentId)) {
        throw engineError('revision_conflict', `Multicam fragment is no longer available: ${operation.fragmentId}`)
      }
    } else {
      fragments.set(operation.fragment.id, cloneFragment(operation.fragment))
    }
  }
  const next = validateMulticamGroup({
    schemaVersion: 1,
    id: group.id,
    sequenceId: group.sequenceId,
    name: group.name,
    fps: group.fps,
    durationFrames: group.durationFrames,
    referenceMemberId: group.referenceMemberId,
    members: group.members.map(cloneMember),
    layouts: group.layouts.map(cloneLayout),
    programFragments: [...fragments.values()]
  })
  if (multicamProgramDigest(next.programFragments) !== transaction.nextProgramDigest) {
    invalid('Multicam transaction did not produce its declared program digest')
  }
  return deepFreeze({
    group: next,
    receiptEvidence: transaction.receiptEvidence
  })
}

export function multicamProgramDigest(fragments: readonly MulticamProgramFragment[]): string {
  return stableDigest([...fragments]
    .sort(compareFragments)
    .map((fragment) => [
      fragment.id,
      fragment.startFrame,
      fragment.endFrame,
      selectionKey(fragment.selection)
    ]))
}
