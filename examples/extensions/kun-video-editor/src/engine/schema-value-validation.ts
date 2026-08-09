import { engineError } from './errors.js'
import { PROJECT_LIMITS } from './schema-model.js'
import { RationalSchema } from './schema-codecs.js'
import {
  array,
  boundedArray,
  boundedString,
  fail,
  finite,
  finiteRange,
  identifier,
  isoTimestamp,
  nonNegativeInteger,
  object,
  oneOf,
  optionalBoolean,
  optionalIdentifier,
  optionalRelativePath,
  positiveInteger,
  uniqueObjectIds
} from './schema-primitives.js'

export function validateCanvas(value: unknown): void {
  const canvas = object(value, 'canvas')
  oneOf(canvas.preset, ['16:9', '9:16', '1:1'], 'canvas.preset')
  positiveInteger(canvas.width, 'canvas.width')
  positiveInteger(canvas.height, 'canvas.height')
  oneOf(canvas.fit, ['fit', 'crop', 'pad'], 'canvas.fit')
  boundedString(canvas.background, 'canvas.background', 1, 32)
}

export function validateAsset(value: unknown, index: number): void {
  const asset = object(value, `assets[${index}]`)
  identifier(asset.id, `assets[${index}].id`)
  boundedString(asset.name, `assets[${index}].name`, 1, 255)
  oneOf(asset.kind, ['video', 'audio', 'image', 'animation'], `assets[${index}].kind`)
  optionalIdentifier(asset.mediaHandleId, `assets[${index}].mediaHandleId`)
  optionalRelativePath(asset.workspaceRelativePath, `assets[${index}].workspaceRelativePath`)
  if (asset.mediaHandleId === undefined && asset.workspaceRelativePath === undefined) {
    fail(`assets[${index}] must contain a media handle or workspace-relative path`)
  }
  positiveInteger(asset.durationUs, `assets[${index}].durationUs`)
  boundedString(asset.container, `assets[${index}].container`, 1, 64)
  if (asset.video !== undefined) validateVideoStream(asset.video, index)
  if (asset.audio !== undefined) validateAudioStream(asset.audio, index)
  if (asset.still !== undefined) validateStillImage(asset.still, index)
  if ((asset.kind === 'image' || asset.kind === 'animation') && asset.still === undefined) {
    fail(`assets[${index}] image and animation assets require still metadata`)
  }
  if (asset.kind === 'image' && object(asset.still, `assets[${index}].still`).animated === true) {
    fail(`assets[${index}] image assets cannot be marked animated`)
  }
  if (asset.kind === 'animation' && object(asset.still, `assets[${index}].still`).animated !== true) {
    fail(`assets[${index}] animation assets must be marked animated`)
  }
  optionalIdentifier(asset.folderId, `assets[${index}].folderId`)
  if (asset.generatedLineage !== undefined) {
    validateGeneratedLineage(asset.generatedLineage, `assets[${index}].generatedLineage`)
  }
  array(asset.transcriptIds, `assets[${index}].transcriptIds`).forEach((entry, child) =>
    identifier(entry, `assets[${index}].transcriptIds[${child}]`)
  )
  if (asset.availability !== undefined) {
    oneOf(asset.availability, ['online', 'offline', 'revoked', 'changed'], `assets[${index}].availability`)
  }
  if (asset.sourceIdentity !== undefined) validateSourceIdentity(asset.sourceIdentity, `assets[${index}].sourceIdentity`)
  if (asset.recovery !== undefined) {
    const recovery = object(asset.recovery, `assets[${index}].recovery`)
    if (recovery.reason !== undefined) {
      oneOf(
        recovery.reason,
        ['missing', 'revoked', 'changed', 'manifest-unreadable'],
        `assets[${index}].recovery.reason`
      )
    }
    if (recovery.lastVerifiedAt !== undefined) isoTimestamp(recovery.lastVerifiedAt, `assets[${index}].recovery.lastVerifiedAt`)
    optionalIdentifier(recovery.previousMediaHandleId, `assets[${index}].recovery.previousMediaHandleId`)
  }
}

export function validateStillImage(value: unknown, index: number): void {
  const still = object(value, `assets[${index}].still`)
  positiveInteger(still.width, `assets[${index}].still.width`)
  positiveInteger(still.height, `assets[${index}].still.height`)
  boundedString(still.format, `assets[${index}].still.format`, 1, 64)
  if (typeof still.animated !== 'boolean') fail(`assets[${index}].still.animated must be a boolean`)
  if (still.frameRate !== undefined) RationalSchema.parse(still.frameRate)
  optionalBoolean(still.loop, `assets[${index}].still.loop`)
}

export function validateGeneratedLineage(value: unknown, path: string): void {
  const lineage = object(value, path)
  identifier(lineage.providerId, `${path}.providerId`)
  identifier(lineage.modelId, `${path}.modelId`)
  identifier(lineage.jobId, `${path}.jobId`)
  if (lineage.promptDigest !== undefined) {
    boundedString(lineage.promptDigest, `${path}.promptDigest`, 64, 64)
    if (typeof lineage.promptDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(lineage.promptDigest)) {
      fail(`${path}.promptDigest must be a lowercase SHA-256 digest`)
    }
  }
  if (lineage.prompt !== undefined) boundedString(lineage.prompt, `${path}.prompt`, 0, 8_192)
  boundedArray(lineage.referenceAssetIds, `${path}.referenceAssetIds`, 32).forEach((entry, index) =>
    identifier(entry, `${path}.referenceAssetIds[${index}]`)
  )
  optionalIdentifier(lineage.variantOfAssetId, `${path}.variantOfAssetId`)
}

export function validateMediaFolder(value: unknown, index: number): void {
  const folder = object(value, `mediaFolders[${index}]`)
  identifier(folder.id, `mediaFolders[${index}].id`)
  boundedString(folder.name, `mediaFolders[${index}].name`, 1, 160)
  optionalIdentifier(folder.parentId, `mediaFolders[${index}].parentId`)
}

export function validateSourceIdentity(value: unknown, path: string): void {
  const identity = object(value, path)
  oneOf(identity.algorithm, ['sha256'], `${path}.algorithm`)
  if (typeof identity.value !== 'string' || !/^[a-f0-9]{64}$/u.test(identity.value)) {
    fail(`${path}.value must be a lowercase SHA-256 digest`)
  }
  if (identity.sizeBytes !== undefined) nonNegativeInteger(identity.sizeBytes, `${path}.sizeBytes`)
  if (identity.modifiedAt !== undefined) isoTimestamp(identity.modifiedAt, `${path}.modifiedAt`)
}

export function validateVideoStream(value: unknown, index: number): void {
  const stream = object(value, `assets[${index}].video`)
  boundedString(stream.codec, `assets[${index}].video.codec`, 1, 64)
  positiveInteger(stream.width, `assets[${index}].video.width`)
  positiveInteger(stream.height, `assets[${index}].video.height`)
  RationalSchema.parse(stream.frameRate)
  if (stream.rotation !== undefined) oneOf(stream.rotation, [0, 90, 180, 270], 'video.rotation')
}

export function validateAudioStream(value: unknown, index: number): void {
  const stream = object(value, `assets[${index}].audio`)
  boundedString(stream.codec, `assets[${index}].audio.codec`, 1, 64)
  positiveInteger(stream.sampleRate, `assets[${index}].audio.sampleRate`)
  positiveInteger(stream.channels, `assets[${index}].audio.channels`)
}

export function validateTrack(value: unknown, index: number): void {
  const track = object(value, `tracks[${index}]`)
  identifier(track.id, `tracks[${index}].id`)
  boundedString(track.name, `tracks[${index}].name`, 1, 128)
  oneOf(track.kind, ['video', 'audio', 'caption'], `tracks[${index}].kind`)
  nonNegativeInteger(track.order, `tracks[${index}].order`)
  oneOf(track.overlap, ['reject', 'mix'], `tracks[${index}].overlap`)
  optionalBoolean(track.muted, `tracks[${index}].muted`)
  optionalBoolean(track.locked, `tracks[${index}].locked`)
  optionalBoolean(track.syncLocked, `tracks[${index}].syncLocked`)
}

export function validateItem(value: unknown, index: number): void {
  const item = object(value, `items[${index}]`)
  identifier(item.id, `items[${index}].id`)
  identifier(item.assetId, `items[${index}].assetId`)
  identifier(item.trackId, `items[${index}].trackId`)
  nonNegativeInteger(item.timelineStartFrame, `items[${index}].timelineStartFrame`)
  positiveInteger(item.durationFrames, `items[${index}].durationFrames`)
  nonNegativeInteger(item.sourceStartUs, `items[${index}].sourceStartUs`)
  positiveInteger(item.sourceEndUs, `items[${index}].sourceEndUs`)
  if (Number(item.sourceEndUs) <= Number(item.sourceStartUs)) fail(`items[${index}] source range is empty`)
  RationalSchema.parse(item.speed)
  validateTransform(item.transform, `items[${index}].transform`)
  finiteRange(item.opacity, `items[${index}].opacity`, 0, 1)
  nonNegativeInteger(item.fadeInFrames, `items[${index}].fadeInFrames`)
  nonNegativeInteger(item.fadeOutFrames, `items[${index}].fadeOutFrames`)
  optionalIdentifier(item.linkGroupId, `items[${index}].linkGroupId`)
  optionalIdentifier(item.nestedSequenceId, `items[${index}].nestedSequenceId`)
  if (item.crop !== undefined) {
    validateCrop(item.crop, `items[${index}].crop`)
  }
  if (item.blendMode !== undefined) {
    oneOf(item.blendMode, ['normal', 'multiply', 'screen', 'overlay'], `items[${index}].blendMode`)
  }
  if (item.volume !== undefined) finiteRange(item.volume, `items[${index}].volume`, 0, 4)
  optionalBoolean(item.muted, `items[${index}].muted`)
  optionalBoolean(item.visible, `items[${index}].visible`)
  optionalBoolean(item.locked, `items[${index}].locked`)
  if (item.effects !== undefined) {
    const effects = boundedArray(item.effects, `items[${index}].effects`, PROJECT_LIMITS.effectsPerItem)
    effects.forEach((effect, child) => validateEffect(effect, `items[${index}].effects[${child}]`))
    uniqueObjectIds(effects, `items[${index}].effects`)
  }
  if (item.keyframes !== undefined) {
    const keyframes = boundedArray(
      item.keyframes,
      `items[${index}].keyframes`,
      PROJECT_LIMITS.keyframeTracksPerItem
    )
    keyframes.forEach((track, child) => validateKeyframeTrack(track, `items[${index}].keyframes[${child}]`))
    uniqueObjectIds(keyframes, `items[${index}].keyframes`)
  }
}

export function validateEffect(value: unknown, path: string): void {
  const effect = object(value, path)
  identifier(effect.id, `${path}.id`)
  boundedString(effect.type, `${path}.type`, 1, 128)
  if (typeof effect.enabled !== 'boolean') fail(`${path}.enabled must be a boolean`)
  const parameters = object(effect.parameters, `${path}.parameters`)
  const entries = Object.entries(parameters)
  if (entries.length > PROJECT_LIMITS.effectParameters) fail(`${path}.parameters exceeds its limit`)
  for (const [key, entry] of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(key)) fail(`${path}.parameters contains an invalid key`)
    if (typeof entry === 'number') finite(entry, `${path}.parameters.${key}`)
    else if (typeof entry === 'string') boundedString(entry, `${path}.parameters.${key}`, 0, 1024)
    else if (typeof entry !== 'boolean') fail(`${path}.parameters.${key} has an unsupported value`)
  }
}

export function validateKeyframeTrack(value: unknown, path: string): void {
  const track = object(value, path)
  identifier(track.id, `${path}.id`)
  boundedString(track.property, `${path}.property`, 1, 128)
  oneOf(track.interpolation, ['hold', 'linear', 'ease'], `${path}.interpolation`)
  const points = boundedArray(track.points, `${path}.points`, PROJECT_LIMITS.keyframePointsPerTrack, 1)
  uniqueObjectIds(points, `${path}.points`)
  let previousFrame = -1
  points.forEach((value, index) => {
    const point = object(value, `${path}.points[${index}]`)
    identifier(point.id, `${path}.points[${index}].id`)
    nonNegativeInteger(point.frame, `${path}.points[${index}].frame`)
    finite(point.value, `${path}.points[${index}].value`)
    if (Number(point.frame) <= previousFrame) fail(`${path}.points must have unique ascending frames`)
    previousFrame = Number(point.frame)
  })
}

export function validateTransform(value: unknown, path: string): void {
  const transform = object(value, path)
  finite(transform.x, `${path}.x`)
  finite(transform.y, `${path}.y`)
  finiteRange(transform.scaleX, `${path}.scaleX`, 0.01, 100)
  finiteRange(transform.scaleY, `${path}.scaleY`, 0.01, 100)
  finite(transform.rotation, `${path}.rotation`)
}

export function validateCrop(value: unknown, path: string): void {
  const crop = object(value, path)
  for (const side of ['left', 'top', 'right', 'bottom'] as const) {
    finiteRange(crop[side], `${path}.${side}`, 0, 1)
  }
  if (Number(crop.left) + Number(crop.right) >= 1 || Number(crop.top) + Number(crop.bottom) >= 1) {
    fail(`${path} removes the complete frame`)
  }
}

export function validateCaption(value: unknown, index: number): void {
  const caption = object(value, `captions[${index}]`)
  identifier(caption.id, `captions[${index}].id`)
  identifier(caption.trackId, `captions[${index}].trackId`)
  nonNegativeInteger(caption.startFrame, `captions[${index}].startFrame`)
  positiveInteger(caption.endFrame, `captions[${index}].endFrame`)
  if (Number(caption.endFrame) <= Number(caption.startFrame)) fail(`captions[${index}] range is empty`)
  boundedString(caption.text, `captions[${index}].text`, 1, 4096)
  oneOf(caption.placement, ['top', 'center', 'bottom'], `captions[${index}].placement`)
  if (caption.style !== undefined) {
    const style = object(caption.style, `captions[${index}].style`)
    if (style.fontSize !== undefined) {
      finiteRange(style.fontSize, `captions[${index}].style.fontSize`, 8, 256)
    }
    for (const key of ['color', 'background'] as const) {
      if (style[key] === undefined) continue
      boundedString(style[key], `captions[${index}].style.${key}`, 7, 7)
      if (!/^#[0-9A-Fa-f]{6}$/u.test(String(style[key]))) {
        fail(`captions[${index}].style.${key} must be a six-digit hexadecimal color`)
      }
    }
    if (style.fontFamily !== undefined) boundedString(style.fontFamily, `captions[${index}].style.fontFamily`, 1, 128)
    if (style.fontWeight !== undefined) finiteRange(style.fontWeight, `captions[${index}].style.fontWeight`, 100, 900)
    if (style.maxWidthRatio !== undefined) finiteRange(style.maxWidthRatio, `captions[${index}].style.maxWidthRatio`, 0.1, 1)
  }
  optionalIdentifier(caption.sourceTranscriptId, `captions[${index}].sourceTranscriptId`)
  if (caption.sourceSegmentIds !== undefined) {
    boundedArray(caption.sourceSegmentIds, `captions[${index}].sourceSegmentIds`, 256).forEach(
      (entry, child) => identifier(entry, `captions[${index}].sourceSegmentIds[${child}]`)
    )
  }
  if (caption.speakerAttribution !== undefined) {
    validateSpeakerAttribution(caption.speakerAttribution, `captions[${index}].speakerAttribution`)
  }
  if (caption.words !== undefined) {
    const words = boundedArray(caption.words, `captions[${index}].words`, 512)
    uniqueObjectIds(words, `captions[${index}].words`)
    words.forEach((value, child) => {
      const word = object(value, `captions[${index}].words[${child}]`)
      identifier(word.id, `captions[${index}].words[${child}].id`)
      boundedString(word.text, `captions[${index}].words[${child}].text`, 1, 1024)
      nonNegativeInteger(word.startFrame, `captions[${index}].words[${child}].startFrame`)
      positiveInteger(word.endFrame, `captions[${index}].words[${child}].endFrame`)
      if (Number(word.endFrame) <= Number(word.startFrame)) fail(`captions[${index}].words[${child}] range is empty`)
      optionalIdentifier(word.sourceWordId, `captions[${index}].words[${child}].sourceWordId`)
    })
  }
  if (caption.animation !== undefined) {
    const animation = object(caption.animation, `captions[${index}].animation`)
    oneOf(animation.kind, ['none', 'word-highlight', 'fade'], `captions[${index}].animation.kind`)
    if (animation.durationFrames !== undefined) {
      nonNegativeInteger(animation.durationFrames, `captions[${index}].animation.durationFrames`)
    }
  }
}

export function validateTranscript(value: unknown, index: number): void {
  const transcript = object(value, `transcripts[${index}]`)
  identifier(transcript.id, `transcripts[${index}].id`)
  identifier(transcript.assetId, `transcripts[${index}].assetId`)
  boundedString(transcript.language, `transcripts[${index}].language`, 1, 32)
  oneOf(transcript.provenance, ['srt', 'vtt', 'json', 'local-asr'], `transcripts[${index}].provenance`)
  boundedArray(
    transcript.segments,
    `transcripts[${index}].segments`,
    PROJECT_LIMITS.transcriptSegments
  ).forEach((segment, child) =>
    validateTranscriptSegment(segment, `transcripts[${index}].segments[${child}]`)
  )
  if (transcript.adapter !== undefined) {
    const adapter = object(transcript.adapter, `transcripts[${index}].adapter`)
    identifier(adapter.id, `transcripts[${index}].adapter.id`)
    boundedString(adapter.version, `transcripts[${index}].adapter.version`, 1, 64)
    if (adapter.modelId !== undefined) boundedString(adapter.modelId, `transcripts[${index}].adapter.modelId`, 1, 128)
    oneOf(adapter.execution, ['local', 'import'], `transcripts[${index}].adapter.execution`)
    if (adapter.sourceFormat !== undefined) {
      oneOf(adapter.sourceFormat, ['srt', 'vtt', 'json'], `transcripts[${index}].adapter.sourceFormat`)
    }
  }
  if (transcript.sourceFingerprint !== undefined) {
    validateSourceIdentity(transcript.sourceFingerprint, `transcripts[${index}].sourceFingerprint`)
  }
}

export function validateTranscriptSegment(value: unknown, path: string): void {
  const segment = object(value, path)
  identifier(segment.id, `${path}.id`)
  nonNegativeInteger(segment.startUs, `${path}.startUs`)
  positiveInteger(segment.endUs, `${path}.endUs`)
  if (Number(segment.endUs) <= Number(segment.startUs)) fail(`${path} range is empty`)
  boundedString(segment.text, `${path}.text`, 1, 16_384)
  if (segment.words !== undefined) {
    const words = boundedArray(segment.words, `${path}.words`, PROJECT_LIMITS.transcriptWordsPerSegment)
    uniqueObjectIds(words, `${path}.words`)
    words.forEach((word, index) => {
      const parsed = object(word, `${path}.words[${index}]`)
      identifier(parsed.id, `${path}.words[${index}].id`)
      nonNegativeInteger(parsed.startUs, `${path}.words[${index}].startUs`)
      positiveInteger(parsed.endUs, `${path}.words[${index}].endUs`)
      boundedString(parsed.text, `${path}.words[${index}].text`, 1, 1024)
      if (parsed.confidence !== undefined) finiteRange(parsed.confidence, 'word.confidence', 0, 1)
      if (parsed.provenance !== undefined) validateEvidenceProvenance(parsed.provenance, `${path}.words[${index}].provenance`)
    })
  }
  if (segment.tags !== undefined) {
    array(segment.tags, `${path}.tags`).forEach((tag) => oneOf(tag, ['filler', 'silence'], `${path}.tags`))
  }
  if (segment.confidence !== undefined) finiteRange(segment.confidence, `${path}.confidence`, 0, 1)
  if (segment.speakerAttribution !== undefined) {
    validateSpeakerAttribution(segment.speakerAttribution, `${path}.speakerAttribution`)
  }
  if (segment.provenance !== undefined) validateEvidenceProvenance(segment.provenance, `${path}.provenance`)
}

export function validateSpeakerAttribution(value: unknown, path: string): void {
  const attribution = object(value, path)
  analysisIdentifier(attribution.analysisId, `${path}.analysisId`)
  optionalIdentifier(attribution.speakerId, `${path}.speakerId`)
  if (attribution.speakerLabel !== undefined) {
    boundedString(attribution.speakerLabel, `${path}.speakerLabel`, 1, 128)
  }
  finiteRange(attribution.confidence, `${path}.confidence`, 0, 1)
  oneOf(attribution.status, ['identified', 'unknown', 'overlap', 'uncertain'], `${path}.status`)
  const sourceTurnIds = boundedArray(attribution.sourceTurnIds, `${path}.sourceTurnIds`, 32, 1)
  sourceTurnIds.forEach((entry, index) => identifier(entry, `${path}.sourceTurnIds[${index}]`))
  if (attribution.status === 'identified') {
    if (attribution.speakerId === undefined || attribution.speakerLabel === undefined) {
      fail(`${path} identified attribution requires a speaker identity and label`)
    }
  } else if (attribution.speakerId !== undefined || attribution.speakerLabel !== undefined) {
    fail(`${path} uncertain attribution must not assert a speaker identity`)
  }
}

export function analysisIdentifier(value: unknown, path: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,511}$/u.test(value)) {
    fail(`${path} must be a bounded local analysis identifier`)
  }
}

export function validateEvidenceProvenance(value: unknown, path: string): void {
  const provenance = object(value, path)
  identifier(provenance.adapterId, `${path}.adapterId`)
  optionalIdentifier(provenance.sourceId, `${path}.sourceId`)
}

export function validateSequence(value: unknown, index: number): void {
  const sequence = object(value, `sequences[${index}]`)
  identifier(sequence.id, `sequences[${index}].id`)
  boundedString(sequence.name, `sequences[${index}].name`, 1, 160)
  boundedArray(sequence.tracks, `sequences[${index}].tracks`, PROJECT_LIMITS.tracksPerSequence).forEach(validateTrack)
  boundedArray(sequence.items, `sequences[${index}].items`, PROJECT_LIMITS.itemsPerSequence).forEach(validateItem)
  boundedArray(sequence.captions, `sequences[${index}].captions`, PROJECT_LIMITS.captionsPerSequence).forEach(validateCaption)
  const viewState = object(sequence.viewState, `sequences[${index}].viewState`)
  finiteRange(viewState.zoom, `sequences[${index}].viewState.zoom`, 0.01, 1_000)
  nonNegativeInteger(viewState.scrollFrame, `sequences[${index}].viewState.scrollFrame`)
  if (typeof viewState.open !== 'boolean') fail(`sequences[${index}].viewState.open must be a boolean`)
}

export function validateLinkGroup(value: unknown, index: number): void {
  const group = object(value, `linkGroups[${index}]`)
  identifier(group.id, `linkGroups[${index}].id`)
  oneOf(group.kind, ['av', 'sync', 'custom'], `linkGroups[${index}].kind`)
  boundedArray(group.itemIds, `linkGroups[${index}].itemIds`, PROJECT_LIMITS.linkGroupMembers, 2).forEach(
    (entry, child) => identifier(entry, `linkGroups[${index}].itemIds[${child}]`)
  )
  if (typeof group.locked !== 'boolean') fail(`linkGroups[${index}].locked must be a boolean`)
}

export function validateSelection(value: unknown): void {
  const selection = object(value, 'project.selection')
  nonNegativeInteger(selection.generation, 'project.selection.generation')
  nonNegativeInteger(selection.revision, 'project.selection.revision')
  identifier(selection.sequenceId, 'project.selection.sequenceId')
  nonNegativeInteger(selection.playheadFrame, 'project.selection.playheadFrame')
  for (const key of ['selectedAssetIds', 'selectedItemIds', 'selectedCaptionIds', 'selectedWordIds'] as const) {
    boundedArray(selection[key], `project.selection.${key}`, PROJECT_LIMITS.selectedIds).forEach((entry, index) =>
      identifier(entry, `project.selection.${key}[${index}]`)
    )
  }
  if (selection.range !== undefined) {
    const range = object(selection.range, 'project.selection.range')
    nonNegativeInteger(range.startFrame, 'project.selection.range.startFrame')
    positiveInteger(range.endFrame, 'project.selection.range.endFrame')
    if (Number(range.endFrame) <= Number(range.startFrame)) fail('project.selection.range is empty')
  }
}

export function validateDerivedReference(value: unknown, index: number): void {
  const reference = object(value, `derivedReferences[${index}]`)
  identifier(reference.id, `derivedReferences[${index}].id`)
  oneOf(
    reference.kind,
    ['waveform', 'thumbnail', 'filmstrip', 'transcript', 'analysis', 'embedding', 'proxy', 'proof', 'preview'],
    `derivedReferences[${index}].kind`
  )
  optionalIdentifier(reference.sourceAssetId, `derivedReferences[${index}].sourceAssetId`)
  boundedArray(reference.dependencyIds, `derivedReferences[${index}].dependencyIds`, 128).forEach((entry, child) =>
    identifier(entry, `derivedReferences[${index}].dependencyIds[${child}]`)
  )
  boundedString(reference.producerVersion, `derivedReferences[${index}].producerVersion`, 1, 128)
  oneOf(
    reference.status,
    ['pending', 'processing', 'ready', 'failed', 'interrupted', 'invalid'],
    `derivedReferences[${index}].status`
  )
  nonNegativeInteger(reference.bytes, `derivedReferences[${index}].bytes`)
  if (typeof reference.pinned !== 'boolean') fail(`derivedReferences[${index}].pinned must be a boolean`)
  if (reference.sourceFingerprint !== undefined) {
    validateSourceIdentity(reference.sourceFingerprint, `derivedReferences[${index}].sourceFingerprint`)
  }
  isoTimestamp(reference.updatedAt, `derivedReferences[${index}].updatedAt`)
  if (reference.errorCode !== undefined) boundedString(reference.errorCode, `derivedReferences[${index}].errorCode`, 1, 128)
}

export function validateAgentUndoEntry(value: unknown, index: number): void {
  const entry = object(value, `project.agentUndoStack[${index}]`)
  nonNegativeInteger(entry.revision, `project.agentUndoStack[${index}].revision`)
  identifier(entry.actorId, `project.agentUndoStack[${index}].actorId`)
  identifier(entry.transactionId, `project.agentUndoStack[${index}].transactionId`)
}

export function validateRecovery(value: unknown): void {
  const recovery = object(value, 'project.recovery')
  oneOf(recovery.mode, ['healthy', 'write-blocked'], 'project.recovery.mode')
  if (recovery.recoveredFromRevision !== undefined) {
    nonNegativeInteger(recovery.recoveredFromRevision, 'project.recovery.recoveredFromRevision')
  }
  boundedArray(
    recovery.unreadableManifestKinds,
    'project.recovery.unreadableManifestKinds',
    3
  ).forEach((entry) => oneOf(entry, ['project', 'media', 'derived'], 'project.recovery.unreadableManifestKinds'))
  boundedArray(
    recovery.interruptedJobIds,
    'project.recovery.interruptedJobIds',
    PROJECT_LIMITS.recoveryEntries
  ).forEach((entry, index) => identifier(entry, `project.recovery.interruptedJobIds[${index}]`))
  boundedArray(recovery.notes, 'project.recovery.notes', PROJECT_LIMITS.recoveryEntries).forEach((entry, index) =>
    boundedString(entry, `project.recovery.notes[${index}]`, 1, 512)
  )
}
