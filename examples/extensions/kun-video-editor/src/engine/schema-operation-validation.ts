import { engineError } from './errors.js'
import { PROJECT_LIMITS } from './schema-model.js'
import { RationalSchema } from './schema-codecs.js'
import { validatePersistedMulticamGroup } from './schema-project-validation.js'
import {
  boundedArray,
  boundedString,
  fail,
  finiteRange,
  identifier,
  nonNegativeInteger,
  object,
  oneOf,
  optionalBoolean,
  optionalIdentifier,
  positiveInteger,
  validateMulticamRangeOperation
} from './schema-primitives.js'
import {
  validateCaption,
  validateCrop,
  validateEffect,
  validateItem,
  validateKeyframeTrack,
  validateLinkGroup,
  validateSequence
} from './schema-value-validation.js'

export function validateOperation(value: unknown): void {
  const operation = object(value, 'operation')
  boundedString(operation.type, 'operation.type', 1, 64)
  switch (operation.type) {
    case 'add-item':
      validateItem(operation.item, 0)
      break
    case 'split-item':
      identifier(operation.itemId, 'operation.itemId')
      nonNegativeInteger(operation.atFrame, 'operation.atFrame')
      break
    case 'trim-item':
      identifier(operation.itemId, 'operation.itemId')
      nonNegativeInteger(operation.startFrame, 'operation.startFrame')
      positiveInteger(operation.endFrame, 'operation.endFrame')
      break
    case 'delete-item':
      identifier(operation.itemId, 'operation.itemId')
      break
    case 'move-item':
      identifier(operation.itemId, 'operation.itemId')
      identifier(operation.trackId, 'operation.trackId')
      nonNegativeInteger(operation.timelineStartFrame, 'operation.timelineStartFrame')
      break
    case 'reorder-item':
      identifier(operation.itemId, 'operation.itemId')
      optionalIdentifier(operation.beforeItemId, 'operation.beforeItemId')
      break
    case 'update-transform':
      identifier(operation.itemId, 'operation.itemId')
      object(operation.transform, 'operation.transform')
      if (operation.opacity !== undefined) finiteRange(operation.opacity, 'operation.opacity', 0, 1)
      break
    case 'update-track-state':
      identifier(operation.trackId, 'operation.trackId')
      optionalBoolean(operation.muted, 'operation.muted')
      optionalBoolean(operation.locked, 'operation.locked')
      optionalBoolean(operation.syncLocked, 'operation.syncLocked')
      if (operation.muted === undefined && operation.locked === undefined && operation.syncLocked === undefined) {
        fail('update-track-state requires at least one state field')
      }
      break
    case 'update-item-properties':
      identifier(operation.itemId, 'operation.itemId')
      if (operation.volume !== undefined) finiteRange(operation.volume, 'operation.volume', 0, 4)
      if (operation.fadeInFrames !== undefined) nonNegativeInteger(operation.fadeInFrames, 'operation.fadeInFrames')
      if (operation.fadeOutFrames !== undefined) nonNegativeInteger(operation.fadeOutFrames, 'operation.fadeOutFrames')
      optionalBoolean(operation.muted, 'operation.muted')
      optionalBoolean(operation.visible, 'operation.visible')
      optionalBoolean(operation.locked, 'operation.locked')
      if (
        operation.volume === undefined && operation.fadeInFrames === undefined &&
        operation.fadeOutFrames === undefined && operation.muted === undefined &&
        operation.visible === undefined && operation.locked === undefined
      ) {
        fail('update-item-properties requires at least one property field')
      }
      break
    case 'set-link-group':
      validateLinkGroup(operation.group, 0)
      break
    case 'delete-link-group':
      identifier(operation.linkGroupId, 'operation.linkGroupId')
      break
    case 'create-sequence':
      identifier(operation.sequenceId, 'operation.sequenceId')
      boundedString(operation.name, 'operation.name', 1, 160)
      optionalBoolean(operation.activate, 'operation.activate')
      break
    case 'restore-sequence':
      validateSequence(operation.sequence, 0)
      boundedArray(operation.linkGroups, 'operation.linkGroups', PROJECT_LIMITS.linkGroups).forEach(validateLinkGroup)
      if (typeof operation.activate !== 'boolean') fail('operation.activate must be a boolean')
      break
    case 'duplicate-sequence':
      identifier(operation.sourceSequenceId, 'operation.sourceSequenceId')
      identifier(operation.sequenceId, 'operation.sequenceId')
      boundedString(operation.name, 'operation.name', 1, 160)
      optionalBoolean(operation.activate, 'operation.activate')
      break
    case 'rename-sequence':
      identifier(operation.sequenceId, 'operation.sequenceId')
      boundedString(operation.name, 'operation.name', 1, 160)
      break
    case 'select-sequence':
    case 'open-sequence':
    case 'delete-sequence':
      identifier(operation.sequenceId, 'operation.sequenceId')
      break
    case 'close-sequence':
      identifier(operation.sequenceId, 'operation.sequenceId')
      optionalIdentifier(operation.fallbackSequenceId, 'operation.fallbackSequenceId')
      break
    case 'set-sequence-view':
      identifier(operation.sequenceId, 'operation.sequenceId')
      finiteRange(operation.zoom, 'operation.zoom', 0.01, 1_000)
      nonNegativeInteger(operation.scrollFrame, 'operation.scrollFrame')
      break
    case 'set-item-keyframes':
      identifier(operation.itemId, 'operation.itemId')
      boundedArray(
        operation.keyframes,
        'operation.keyframes',
        PROJECT_LIMITS.keyframeTracksPerItem
      ).forEach((track, index) => validateKeyframeTrack(track, `operation.keyframes[${index}]`))
      break
    case 'set-item-effects':
      identifier(operation.itemId, 'operation.itemId')
      boundedArray(operation.effects, 'operation.effects', PROJECT_LIMITS.effectsPerItem)
        .forEach((effect, index) => validateEffect(effect, `operation.effects[${index}]`))
      break
    case 'update-item-composition':
      identifier(operation.itemId, 'operation.itemId')
      if (operation.crop !== undefined) validateCrop(operation.crop, 'operation.crop')
      if (operation.opacity !== undefined) finiteRange(operation.opacity, 'operation.opacity', 0, 1)
      if (operation.blendMode !== undefined) {
        oneOf(operation.blendMode, ['normal', 'multiply', 'screen', 'overlay'], 'operation.blendMode')
      }
      if (operation.crop === undefined && operation.opacity === undefined && operation.blendMode === undefined) {
        fail('update-item-composition requires at least one property field')
      }
      break
    case 'retime-item':
      identifier(operation.itemId, 'operation.itemId')
      RationalSchema.parse(operation.speed)
      break
    case 'add-caption':
      validateCaption(operation.caption, 0)
      break
    case 'update-caption':
      identifier(operation.captionId, 'operation.captionId')
      object(operation.patch, 'operation.patch')
      break
    case 'delete-caption':
      identifier(operation.captionId, 'operation.captionId')
      break
    case 'set-canvas':
      oneOf(operation.preset, ['16:9', '9:16', '1:1'], 'operation.preset')
      oneOf(operation.fit, ['fit', 'crop', 'pad'], 'operation.fit')
      break
    case 'set-multicam-group':
      validatePersistedMulticamGroup(operation.group, 0)
      break
    case 'delete-multicam-group':
    case 'merge-multicam-program':
      identifier(operation.groupId, 'operation.groupId')
      break
    case 'switch-multicam-angle':
      identifier(operation.groupId, 'operation.groupId')
      identifier(operation.memberId, 'operation.memberId')
      validateMulticamRangeOperation(operation)
      break
    case 'apply-multicam-layout':
      identifier(operation.groupId, 'operation.groupId')
      identifier(operation.layoutId, 'operation.layoutId')
      validateMulticamRangeOperation(operation)
      break
    default:
      throw engineError('invalid_operation', `Unsupported timeline operation: ${String(operation.type)}`)
  }
}
