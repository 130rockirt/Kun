import { engineError } from './errors.js'
import {
  validateMulticamGroup,
  type MulticamGroup
} from './multicam.js'
import {
  MAX_PROJECT_HISTORY,
  PROJECT_LIMITS,
  PROJECT_SCHEMA_VERSION,
  type MediaAsset,
  type MediaFolder,
  type ProjectSelection,
  type Rational,
  type Sequence
} from './schema-model.js'
import { RationalSchema } from './schema-codecs.js'
import { validateOperation } from './schema-operation-validation.js'
import {
  array,
  boundedArray,
  boundedString,
  exactObjectKeys,
  fail,
  identifier,
  isoTimestamp,
  nonNegativeInteger,
  object,
  oneOf,
  optionalIdentifier,
  positiveInteger
} from './schema-primitives.js'
import {
  validateAgentUndoEntry,
  validateAsset,
  validateCanvas,
  validateCaption,
  validateDerivedReference,
  validateItem,
  validateLinkGroup,
  validateMediaFolder,
  validateRecovery,
  validateSelection,
  validateSequence,
  validateTrack,
  validateTranscript
} from './schema-value-validation.js'

export function validateProjectShape(value: unknown): void {
  const project = object(value, 'project')
  if (project.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    throw engineError('unsupported_schema_version', 'Unsupported project schema version', {
      schemaVersion: project.schemaVersion,
      supportedSchemaVersion: PROJECT_SCHEMA_VERSION
    })
  }
  identifier(project.id, 'project.id')
  boundedString(project.name, 'project.name', 1, 160)
  isoTimestamp(project.createdAt, 'project.createdAt')
  isoTimestamp(project.updatedAt, 'project.updatedAt')
  RationalSchema.parse(project.fps)
  validateCanvas(project.canvas)
  boundedArray(project.assets, 'project.assets', PROJECT_LIMITS.assets).forEach(validateAsset)
  if (project.mediaFolders !== undefined) {
    boundedArray(project.mediaFolders, 'project.mediaFolders', PROJECT_LIMITS.mediaFolders).forEach(validateMediaFolder)
  }
  boundedArray(project.tracks, 'project.tracks', PROJECT_LIMITS.tracksPerSequence).forEach(validateTrack)
  boundedArray(project.items, 'project.items', PROJECT_LIMITS.itemsPerSequence).forEach(validateItem)
  boundedArray(project.captions, 'project.captions', PROJECT_LIMITS.captionsPerSequence).forEach(validateCaption)
  boundedArray(project.sequences, 'project.sequences', PROJECT_LIMITS.sequences, 1).forEach(validateSequence)
  identifier(project.activeSequenceId, 'project.activeSequenceId')
  boundedArray(project.linkGroups, 'project.linkGroups', PROJECT_LIMITS.linkGroups).forEach(validateLinkGroup)
  validateSelection(project.selection)
  boundedArray(project.transcripts, 'project.transcripts', PROJECT_LIMITS.transcripts).forEach(validateTranscript)
  boundedArray(
    project.derivedReferences,
    'project.derivedReferences',
    PROJECT_LIMITS.derivedReferences
  ).forEach(validateDerivedReference)
  if (project.multicamGroups !== undefined) {
    boundedArray(
      project.multicamGroups,
      'project.multicamGroups',
      PROJECT_LIMITS.multicamGroups
    ).forEach(validatePersistedMulticamGroup)
  }
  nonNegativeInteger(project.currentRevision, 'project.currentRevision')
  nonNegativeInteger(project.eventGeneration, 'project.eventGeneration')
  array(project.revisions, 'project.revisions').forEach(validateRevision)
  array(project.undoStack, 'project.undoStack').forEach((entry, index) =>
    nonNegativeInteger(entry, `project.undoStack[${index}]`)
  )
  array(project.redoStack, 'project.redoStack').forEach((entry, index) =>
    nonNegativeInteger(entry, `project.redoStack[${index}]`)
  )
  boundedArray(project.agentUndoStack, 'project.agentUndoStack', MAX_PROJECT_HISTORY).forEach(
    (entry, index) => validateAgentUndoEntry(entry, index)
  )
  validateRecovery(project.recovery)
  validateActiveProjection(project)
  validateMediaLibraryReferences(project)
  validateMulticamReferences(project)
}

export function validateV1ProjectShape(value: unknown): void {
  const project = object(value, 'project')
  if (project.schemaVersion !== 1) {
    throw engineError('unsupported_schema_version', 'Expected a schema-v1 project')
  }
  identifier(project.id, 'project.id')
  boundedString(project.name, 'project.name', 1, 160)
  isoTimestamp(project.createdAt, 'project.createdAt')
  isoTimestamp(project.updatedAt, 'project.updatedAt')
  RationalSchema.parse(project.fps)
  validateCanvas(project.canvas)
  boundedArray(project.assets, 'project.assets', PROJECT_LIMITS.assets).forEach(validateAsset)
  boundedArray(project.tracks, 'project.tracks', PROJECT_LIMITS.tracksPerSequence).forEach(validateTrack)
  boundedArray(project.items, 'project.items', PROJECT_LIMITS.itemsPerSequence).forEach(validateItem)
  boundedArray(project.captions, 'project.captions', PROJECT_LIMITS.captionsPerSequence).forEach(validateCaption)
  boundedArray(project.transcripts, 'project.transcripts', PROJECT_LIMITS.transcripts).forEach(validateTranscript)
  nonNegativeInteger(project.currentRevision, 'project.currentRevision')
  boundedArray(project.revisions, 'project.revisions', MAX_PROJECT_HISTORY).forEach(validateRevision)
  boundedArray(project.undoStack, 'project.undoStack', MAX_PROJECT_HISTORY).forEach((entry, index) =>
    nonNegativeInteger(entry, `project.undoStack[${index}]`)
  )
  boundedArray(project.redoStack, 'project.redoStack', MAX_PROJECT_HISTORY).forEach((entry, index) =>
    nonNegativeInteger(entry, `project.redoStack[${index}]`)
  )
}
export function validateActiveProjection(project: Record<string, unknown>): void {
  const sequences = project.sequences as Sequence[]
  const active = sequences.find(({ id }) => id === project.activeSequenceId)
  if (!active) fail('project.activeSequenceId does not identify a sequence')
  if (
    JSON.stringify(active.tracks) !== JSON.stringify(project.tracks) ||
    JSON.stringify(active.items) !== JSON.stringify(project.items) ||
    JSON.stringify(active.captions) !== JSON.stringify(project.captions)
  ) {
    fail('project active-sequence compatibility projection is stale')
  }
  const sequenceIds = new Set(sequences.map(({ id }) => id))
  if (sequenceIds.size !== sequences.length) fail('project.sequences contains duplicate IDs')
  if ((project.selection as ProjectSelection).sequenceId !== project.activeSequenceId) {
    fail('project.selection must target the active sequence')
  }
  if (!active.viewState.open) fail('project.activeSequenceId must identify an open sequence')
}

export function validateMediaLibraryReferences(project: Record<string, unknown>): void {
  const folders = (project.mediaFolders ?? []) as MediaFolder[]
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  if (byId.size !== folders.length) fail('project.mediaFolders contains duplicate IDs')
  for (const folder of folders) {
    if (folder.parentId !== undefined && !byId.has(folder.parentId)) {
      fail(`Media folder ${folder.id} refers to missing parent ${folder.parentId}`)
    }
    const seen = new Set<string>()
    let cursor: MediaFolder | undefined = folder
    while (cursor) {
      if (seen.has(cursor.id)) fail(`Media folder graph contains a cycle at ${cursor.id}`)
      seen.add(cursor.id)
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
    }
  }
  const assets = project.assets as MediaAsset[]
  const assetIds = new Set(assets.map(({ id }) => id))
  for (const asset of assets) {
    if (asset.folderId !== undefined && !byId.has(asset.folderId)) {
      fail(`Media asset ${asset.id} refers to missing folder ${asset.folderId}`)
    }
    for (const referenceId of asset.generatedLineage?.referenceAssetIds ?? []) {
      if (!assetIds.has(referenceId)) fail(`Generated asset ${asset.id} refers to missing asset ${referenceId}`)
    }
    const variantId = asset.generatedLineage?.variantOfAssetId
    if (variantId !== undefined && !assetIds.has(variantId)) {
      fail(`Generated asset ${asset.id} refers to missing variant source ${variantId}`)
    }
  }
}

export function validatePersistedMulticamGroup(value: unknown, index: number): void {
  const path = `multicamGroups[${index}]`
  const group = object(value, path)
  exactObjectKeys(group, [
    'schemaVersion', 'id', 'sequenceId', 'name', 'fps', 'durationFrames',
    'referenceMemberId', 'members', 'layouts', 'programFragments'
  ], path)
  identifier(group.id, `${path}.id`)
  identifier(group.sequenceId, `${path}.sequenceId`)
  exactObjectKeys(object(group.fps, `${path}.fps`), ['numerator', 'denominator'], `${path}.fps`)
  const members = boundedArray(group.members, `${path}.members`, 32, 2)
  members.forEach((value, memberIndex) => {
    const memberPath = `${path}.members[${memberIndex}]`
    const member = object(value, memberPath)
    exactObjectKeys(
      member,
      ['id', 'assetId', 'memberLabel', 'angleLabel', 'sourceFps', 'sync', 'coverage'],
      memberPath
    )
    identifier(member.id, `${memberPath}.id`)
    identifier(member.assetId, `${memberPath}.assetId`)
    exactObjectKeys(
      object(member.sourceFps, `${memberPath}.sourceFps`),
      ['numerator', 'denominator'],
      `${memberPath}.sourceFps`
    )
    const sync = object(member.sync, `${memberPath}.sync`)
    exactObjectKeys(sync, ['status', 'offsetFrames', 'confidence', 'evidence'], `${memberPath}.sync`)
    boundedArray(sync.evidence, `${memberPath}.sync.evidence`, 16).forEach((entry, evidenceIndex) => {
      const evidencePath = `${memberPath}.sync.evidence[${evidenceIndex}]`
      const evidence = object(entry, evidencePath)
      exactObjectKeys(evidence, [
        'id', 'analysisId', 'kind', 'referenceMemberId', 'targetMemberId',
        'confidence', 'algorithmId', 'algorithmVersion'
      ], evidencePath)
      for (const key of ['id', 'analysisId', 'referenceMemberId', 'targetMemberId', 'algorithmId'] as const) {
        identifier(evidence[key], `${evidencePath}.${key}`)
      }
    })
    boundedArray(member.coverage, `${memberPath}.coverage`, 256).forEach((entry, coverageIndex) => {
      const coveragePath = `${memberPath}.coverage[${coverageIndex}]`
      const coverage = object(entry, coveragePath)
      exactObjectKeys(
        coverage,
        ['id', 'startFrame', 'endFrame', 'sourceStartFrame', 'sourceEndFrame'],
        coveragePath
      )
      identifier(coverage.id, `${coveragePath}.id`)
    })
  })
  boundedArray(group.layouts, `${path}.layouts`, 32).forEach((entry, layoutIndex) => {
    const layoutPath = `${path}.layouts[${layoutIndex}]`
    const layout = object(entry, layoutPath)
    exactObjectKeys(layout, ['id', 'label', 'slots'], layoutPath)
    identifier(layout.id, `${layoutPath}.id`)
    boundedArray(layout.slots, `${layoutPath}.slots`, 16, 2).forEach((entry, slotIndex) => {
      const slotPath = `${layoutPath}.slots[${slotIndex}]`
      const slot = object(entry, slotPath)
      exactObjectKeys(
        slot,
        ['memberId', 'x', 'y', 'width', 'height', 'zIndex', 'opacity', 'audioEnabled'],
        slotPath
      )
      identifier(slot.memberId, `${slotPath}.memberId`)
    })
  })
  boundedArray(group.programFragments, `${path}.programFragments`, 4_096).forEach((entry, fragmentIndex) => {
    const fragmentPath = `${path}.programFragments[${fragmentIndex}]`
    const fragment = object(entry, fragmentPath)
    exactObjectKeys(fragment, ['id', 'startFrame', 'endFrame', 'selection'], fragmentPath)
    identifier(fragment.id, `${fragmentPath}.id`)
    const selection = object(fragment.selection, `${fragmentPath}.selection`)
    if (selection.kind === 'angle') {
      exactObjectKeys(selection, ['kind', 'memberId'], `${fragmentPath}.selection`)
      identifier(selection.memberId, `${fragmentPath}.selection.memberId`)
    } else {
      exactObjectKeys(selection, ['kind', 'layoutId'], `${fragmentPath}.selection`)
      identifier(selection.layoutId, `${fragmentPath}.selection.layoutId`)
    }
  })
  validateMulticamGroup(value as MulticamGroup)
}

export function validateMulticamReferences(project: Record<string, unknown>): void {
  const groups = (project.multicamGroups ?? []) as MulticamGroup[]
  const groupIds = new Set(groups.map(({ id }) => id))
  if (groupIds.size !== groups.length) fail('project.multicamGroups contains duplicate IDs')
  const sequences = new Set((project.sequences as Sequence[]).map(({ id }) => id))
  const assets = new Map((project.assets as MediaAsset[]).map((asset) => [asset.id, asset]))
  for (const group of groups) {
    if (!sequences.has(group.sequenceId)) {
      fail(`Multicam group ${group.id} refers to missing sequence ${group.sequenceId}`)
    }
    if (!sameRationalValue(group.fps, project.fps as Rational)) {
      fail(`Multicam group ${group.id} must use the project frame rate`)
    }
    for (const member of group.members) {
      const asset = assets.get(member.assetId)
      if (!asset?.video) fail(`Multicam member ${member.id} requires an existing video asset`)
      if (!sameRationalValue(member.sourceFps, asset.video.frameRate)) {
        fail(`Multicam member ${member.id} frame rate differs from asset ${asset.id}`)
      }
      const sourceFrameCount = durationFrameCount(asset.durationUs, asset.video.frameRate)
      if (member.coverage.some(({ sourceEndFrame }) => sourceEndFrame > sourceFrameCount)) {
        fail(`Multicam member ${member.id} coverage exceeds asset ${asset.id}`)
      }
    }
  }
}

export function durationFrameCount(durationUs: number, fps: Rational): number {
  return Number(
    BigInt(durationUs) * BigInt(fps.numerator) /
    (1_000_000n * BigInt(fps.denominator))
  )
}

export function sameRationalValue(left: Rational, right: Rational): boolean {
  return BigInt(left.numerator) * BigInt(right.denominator) ===
    BigInt(right.numerator) * BigInt(left.denominator)
}

export function validateRevision(value: unknown, index: number): void {
  const revision = object(value, `revisions[${index}]`)
  nonNegativeInteger(revision.revision, `revisions[${index}].revision`)
  if (revision.parentRevision !== null) nonNegativeInteger(revision.parentRevision, 'revision.parentRevision')
  oneOf(revision.author, ['manual', 'agent', 'system'], 'revision.author')
  optionalIdentifier(revision.actorId, 'revision.actorId')
  optionalIdentifier(revision.transactionId, 'revision.transactionId')
  boundedString(revision.sourceOperation, 'revision.sourceOperation', 1, 128)
  isoTimestamp(revision.timestamp, 'revision.timestamp')
  boundedString(revision.summary, 'revision.summary', 1, 1024)
  array(revision.operations, 'revision.operations').forEach(validateOperation)
  array(revision.inverseOperations, 'revision.inverseOperations').forEach(validateOperation)
  if (revision.restoredFromRevision !== undefined) {
    nonNegativeInteger(revision.restoredFromRevision, 'revision.restoredFromRevision')
  }
}

export function validateMutationReceipt(value: unknown): void {
  const receipt = object(value, 'receipt')
  if (receipt.schemaVersion !== 1) fail('receipt.schemaVersion is unsupported')
  identifier(receipt.transactionId, 'receipt.transactionId')
  identifier(receipt.projectId, 'receipt.projectId')
  identifier(receipt.sequenceId, 'receipt.sequenceId')
  nonNegativeInteger(receipt.previousRevision, 'receipt.previousRevision')
  positiveInteger(receipt.newRevision, 'receipt.newRevision')
  if (Number(receipt.newRevision) !== Number(receipt.previousRevision) + 1) {
    fail('receipt revision transition must advance exactly once')
  }
  positiveInteger(receipt.generation, 'receipt.generation')
  const attribution = object(receipt.attribution, 'receipt.attribution')
  oneOf(attribution.author, ['manual', 'agent', 'system'], 'receipt.attribution.author')
  optionalIdentifier(attribution.actorId, 'receipt.attribution.actorId')
  boundedString(attribution.sourceOperation, 'receipt.attribution.sourceOperation', 1, 128)
  for (const key of ['createdIds', 'changedIds', 'removedIds'] as const) {
    boundedArray(receipt[key], `receipt.${key}`, PROJECT_LIMITS.receiptIds).forEach((value, index) => {
      const id = object(value, `receipt.${key}[${index}]`)
      oneOf(
        id.kind,
        [
          'asset', 'media-folder', 'sequence', 'track', 'item', 'caption', 'link-group',
          'transcript', 'derived', 'multicam-group', 'multicam-fragment'
        ],
        `receipt.${key}[${index}].kind`
      )
      identifier(id.id, `receipt.${key}[${index}].id`)
    })
  }
  boundedArray(receipt.shifts, 'receipt.shifts', PROJECT_LIMITS.receiptShifts).forEach((value, index) => {
    const shift = object(value, `receipt.shifts[${index}]`)
    identifier(shift.sequenceId, `receipt.shifts[${index}].sequenceId`)
    optionalIdentifier(shift.trackId, `receipt.shifts[${index}].trackId`)
    nonNegativeInteger(shift.fromFrame, `receipt.shifts[${index}].fromFrame`)
    if (!Number.isSafeInteger(shift.deltaFrames) || Number(shift.deltaFrames) === 0) {
      fail(`receipt.shifts[${index}].deltaFrames must be a non-zero safe integer`)
    }
    positiveInteger(shift.count, `receipt.shifts[${index}].count`)
  })
  for (const key of ['sequenceChanges', 'trackChanges'] as const) {
    boundedArray(receipt[key], `receipt.${key}`, PROJECT_LIMITS.receiptChanges).forEach((entry, index) =>
      boundedString(entry, `receipt.${key}[${index}]`, 1, 256)
    )
  }
  if (typeof receipt.proofInvalidated !== 'boolean') fail('receipt.proofInvalidated must be a boolean')
  boundedArray(receipt.notes, 'receipt.notes', PROJECT_LIMITS.receiptNotes).forEach((value, index) => {
    const note = object(value, `receipt.notes[${index}]`)
    boundedString(note.code, `receipt.notes[${index}].code`, 1, 128)
    boundedString(note.messageKey, `receipt.notes[${index}].messageKey`, 1, 128)
    oneOf(note.severity, ['info', 'warning'], `receipt.notes[${index}].severity`)
    if (note.values !== undefined) {
      const values = object(note.values, `receipt.notes[${index}].values`)
      if (Object.keys(values).length > 32) fail(`receipt.notes[${index}].values exceeds its limit`)
      Object.values(values).forEach((entry) => {
        if (typeof entry !== 'string' && typeof entry !== 'number') fail('receipt note values must be scalar')
      })
    }
  })
  const truncated = object(receipt.truncated, 'receipt.truncated')
  for (const key of ['created', 'changed', 'removed', 'shifts', 'sequenceChanges', 'trackChanges', 'notes']) {
    nonNegativeInteger(truncated[key], `receipt.truncated.${key}`)
  }
}

export function validateRenderPreset(value: unknown): void {
  const preset = object(value, 'renderPreset')
  oneOf(
    preset.id,
    ['proof-frame', 'preview', 'h264-mp4', 'audio-aac', 'subtitles-srt', 'subtitles-vtt'],
    'renderPreset.id'
  )
  if (preset.width !== undefined) positiveInteger(preset.width, 'renderPreset.width')
  if (preset.height !== undefined) positiveInteger(preset.height, 'renderPreset.height')
  if (preset.videoBitrate !== undefined) boundedString(preset.videoBitrate, 'renderPreset.videoBitrate', 1, 32)
  if (preset.audioBitrate !== undefined) boundedString(preset.audioBitrate, 'renderPreset.audioBitrate', 1, 32)
}
