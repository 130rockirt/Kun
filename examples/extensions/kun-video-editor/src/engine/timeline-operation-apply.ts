import { engineError } from './errors.js'
import {
  MAX_PROJECT_HISTORY,
  TimelineOperationSchema,
  VideoProjectSchema,
  syncActiveSequenceProjection,
  type CanvasFit,
  type CanvasPreset,
  type MediaAsset,
  type Rational,
  type TimelineItem,
  type TimelineOperation,
  type Track,
  type VideoProject
} from './schema.js'
import { framesToMicroseconds, microsecondsToFrames, normalizeRational } from './time.js'
import {
  retimeKeyframeTrack,
  splitKeyframeTrack,
  trimKeyframeTrack,
  type KeyframeEditNote
} from './keyframes.js'
import { validateKeyframeProperty } from './effects.js'
import {
  assertSequenceDeleteSafe,
  createEmptySequenceSnapshot,
  duplicateSequenceSnapshot,
  propagateNestedSequenceDuration,
  sequenceDurationFrames,
  sequenceSnapshot
} from './sequences.js'
import {
  applyMulticamTransactionPreview,
  compileMulticamPlanTransaction,
  planMulticamAngleSwitch,
  planMulticamLayout,
  planMulticamMerge,
  validateMulticamGroup,
  type MulticamGroup,
  type MulticamPlan
} from './multicam.js'
import { CANVAS_PRESETS } from './timeline.js'
import type { TimelineOperationNote } from './timeline.js'
import {
  activateSequence,
  addSequenceSnapshot,
  appendKeyframePolicyNotes,
  applyMulticamPlan,
  assertItemEditable,
  multicamGroup
} from './timeline-operation-support.js'
import {
  compareItems,
  duplicate,
  itemIndex,
  missing,
  sourceDeltaUs,
  sourceUsToTimelineFrames
} from './timeline-validation-support.js'

export function applyOne(
  project: VideoProject,
  operation: TimelineOperation,
  changedIds: Set<string>,
  notes: TimelineOperationNote[]
): TimelineOperation[] {
  switch (operation.type) {
    case 'add-item': {
      if (project.items.some(({ id }) => id === operation.item.id)) duplicate(operation.item.id)
      const track = project.tracks.find(({ id }) => id === operation.item.trackId)
      if (track?.locked) throw engineError('invalid_operation', `Timeline track is locked: ${track.id}`)
      project.items.push(structuredClone(operation.item))
      changedIds.add(operation.item.id)
      return [{ type: 'delete-item', itemId: operation.item.id }]
    }
    case 'delete-item': {
      assertItemEditable(project, operation.itemId)
      const index = itemIndex(project, operation.itemId)
      const [removed] = project.items.splice(index, 1)
      changedIds.add(operation.itemId)
      return [{ type: 'add-item', item: removed! }]
    }
    case 'split-item': {
      assertItemEditable(project, operation.itemId)
      const index = itemIndex(project, operation.itemId)
      const original = project.items[index]!
      const relativeFrame = operation.atFrame - original.timelineStartFrame
      if (relativeFrame <= 0 || relativeFrame >= original.durationFrames) {
        throw engineError('invalid_operation', 'Split frame must be strictly inside the item')
      }
      const sourceSplit = original.sourceStartUs + sourceDeltaUs(relativeFrame, original.speed, project.fps)
      if (sourceSplit <= original.sourceStartUs || sourceSplit >= original.sourceEndUs) {
        throw engineError('invalid_operation', 'Split frame cannot be represented in the source range')
      }
      const leftKeyframes = original.keyframes?.map((track) => {
        const result = splitKeyframeTrack(track, relativeFrame, original.durationFrames)
        appendKeyframePolicyNotes(notes, original.id, 'split', [...result.left.notes, ...result.right.notes])
        return result.left.track
      })
      const rightKeyframes = original.keyframes?.map((track) =>
        splitKeyframeTrack(track, relativeFrame, original.durationFrames).right.track
      )
      const left: TimelineItem = {
        ...original,
        id: `${original.id}-part-1`,
        durationFrames: relativeFrame,
        sourceEndUs: sourceSplit,
        fadeInFrames: Math.min(original.fadeInFrames, relativeFrame),
        fadeOutFrames: 0,
        ...(leftKeyframes ? { keyframes: leftKeyframes } : {})
      }
      const right: TimelineItem = {
        ...original,
        id: `${original.id}-part-2`,
        timelineStartFrame: operation.atFrame,
        durationFrames: original.durationFrames - relativeFrame,
        sourceStartUs: sourceSplit,
        fadeInFrames: 0,
        fadeOutFrames: Math.min(original.fadeOutFrames, original.durationFrames - relativeFrame),
        ...(rightKeyframes ? { keyframes: rightKeyframes } : {})
      }
      project.items.splice(index, 1, left, right)
      changedIds.add(original.id)
      changedIds.add(left.id)
      changedIds.add(right.id)
      return [
        { type: 'delete-item', itemId: right.id },
        { type: 'delete-item', itemId: left.id },
        { type: 'add-item', item: original }
      ]
    }
    case 'trim-item': {
      assertItemEditable(project, operation.itemId)
      const index = itemIndex(project, operation.itemId)
      const original = project.items[index]!
      const originalEnd = original.timelineStartFrame + original.durationFrames
      if (
        operation.startFrame < original.timelineStartFrame ||
        operation.endFrame > originalEnd ||
        operation.endFrame <= operation.startFrame
      ) {
        throw engineError('invalid_operation', 'Trim range must be a positive range within the item')
      }
      const startDelta = operation.startFrame - original.timelineStartFrame
      const endDelta = originalEnd - operation.endFrame
      const durationFrames = operation.endFrame - operation.startFrame
      const fadeInFrames = Math.min(original.fadeInFrames, durationFrames)
      const keyframes = original.keyframes?.map((track) => {
        const result = trimKeyframeTrack(
          track,
          startDelta,
          original.durationFrames - endDelta,
          'preserve-boundaries'
        )
        appendKeyframePolicyNotes(notes, original.id, 'trim', result.notes)
        return result.track
      })
      project.items[index] = {
        ...original,
        timelineStartFrame: operation.startFrame,
        durationFrames,
        sourceStartUs: original.sourceStartUs + sourceDeltaUs(startDelta, original.speed, project.fps),
        sourceEndUs: original.sourceEndUs - sourceDeltaUs(endDelta, original.speed, project.fps),
        fadeInFrames,
        fadeOutFrames: Math.min(original.fadeOutFrames, durationFrames - fadeInFrames),
        ...(keyframes ? { keyframes } : {})
      }
      changedIds.add(original.id)
      return [
        { type: 'delete-item', itemId: original.id },
        { type: 'add-item', item: original }
      ]
    }
    case 'move-item': {
      assertItemEditable(project, operation.itemId)
      const index = itemIndex(project, operation.itemId)
      const original = project.items[index]!
      project.items[index] = {
        ...original,
        trackId: operation.trackId,
        timelineStartFrame: operation.timelineStartFrame
      }
      changedIds.add(original.id)
      return [{
        type: 'move-item',
        itemId: original.id,
        trackId: original.trackId,
        timelineStartFrame: original.timelineStartFrame
      }]
    }
    case 'reorder-item': {
      assertItemEditable(project, operation.itemId)
      const target = project.items[itemIndex(project, operation.itemId)]!
      const track = project.tracks.find(({ id }) => id === target.trackId)
      if (!track || track.overlap === 'mix') {
        throw engineError('invalid_operation', 'Reordering requires a non-overlapping track')
      }
      const ordered = project.items.filter(({ trackId }) => trackId === target.trackId).sort(compareItems)
      const previousMoves = ordered.map((item): TimelineOperation => ({
        type: 'move-item',
        itemId: item.id,
        trackId: item.trackId,
        timelineStartFrame: item.timelineStartFrame
      }))
      const withoutTarget = ordered.filter(({ id }) => id !== target.id)
      const insertion = operation.beforeItemId === undefined
        ? withoutTarget.length
        : withoutTarget.findIndex(({ id }) => id === operation.beforeItemId)
      if (insertion < 0) throw engineError('invalid_operation', 'Reorder target does not exist on the same track')
      withoutTarget.splice(insertion, 0, target)
      let cursor = Math.min(...ordered.map(({ timelineStartFrame }) => timelineStartFrame))
      for (const item of withoutTarget) {
        item.timelineStartFrame = cursor
        cursor += item.durationFrames
        changedIds.add(item.id)
      }
      return previousMoves
    }
    case 'update-transform': {
      assertItemEditable(project, operation.itemId)
      const index = itemIndex(project, operation.itemId)
      const original = project.items[index]!
      project.items[index] = {
        ...original,
        transform: { ...original.transform, ...operation.transform },
        opacity: operation.opacity ?? original.opacity
      }
      changedIds.add(original.id)
      return [{
        type: 'update-transform',
        itemId: original.id,
        transform: original.transform,
        opacity: original.opacity
      }]
    }
    case 'update-track-state': {
      const index = project.tracks.findIndex(({ id }) => id === operation.trackId)
      if (index < 0) missing(operation.trackId)
      const original = project.tracks[index]!
      project.tracks[index] = {
        ...original,
        ...(operation.muted !== undefined ? { muted: operation.muted } : {}),
        ...(operation.locked !== undefined ? { locked: operation.locked } : {}),
        ...(operation.syncLocked !== undefined ? { syncLocked: operation.syncLocked } : {})
      }
      changedIds.add(original.id)
      return [{
        type: 'update-track-state',
        trackId: original.id,
        muted: original.muted ?? false,
        locked: original.locked ?? false,
        syncLocked: original.syncLocked ?? false
      }]
    }
    case 'update-item-properties': {
      const index = itemIndex(project, operation.itemId)
      const original = project.items[index]!
      if (
        (original.locked || project.tracks.find(({ id }) => id === original.trackId)?.locked) &&
        operation.locked !== false
      ) {
        throw engineError('invalid_operation', `Timeline item is locked: ${original.id}`)
      }
      project.items[index] = {
        ...original,
        ...(operation.volume !== undefined ? { volume: operation.volume } : {}),
        ...(operation.fadeInFrames !== undefined ? { fadeInFrames: operation.fadeInFrames } : {}),
        ...(operation.fadeOutFrames !== undefined ? { fadeOutFrames: operation.fadeOutFrames } : {}),
        ...(operation.muted !== undefined ? { muted: operation.muted } : {}),
        ...(operation.visible !== undefined ? { visible: operation.visible } : {}),
        ...(operation.locked !== undefined ? { locked: operation.locked } : {})
      }
      changedIds.add(original.id)
      return [{
        type: 'update-item-properties',
        itemId: original.id,
        volume: original.volume ?? 1,
        fadeInFrames: original.fadeInFrames,
        fadeOutFrames: original.fadeOutFrames,
        muted: original.muted ?? false,
        visible: original.visible ?? true,
        locked: original.locked ?? false
      }]
    }
    case 'set-link-group': {
      const group = structuredClone(operation.group)
      const existingIndex = project.linkGroups.findIndex(({ id }) => id === group.id)
      const existing = existingIndex >= 0 ? structuredClone(project.linkGroups[existingIndex]!) : undefined
      for (const itemId of existing?.itemIds ?? []) assertItemEditable(project, itemId)
      for (const itemId of group.itemIds) {
        assertItemEditable(project, itemId)
        const item = project.items[itemIndex(project, itemId)]!
        if (item.linkGroupId && item.linkGroupId !== group.id) {
          throw engineError('invalid_operation', `Timeline item already belongs to link group ${item.linkGroupId}`)
        }
      }
      if (existing) {
        const retained = new Set(group.itemIds)
        for (const itemId of existing.itemIds) {
          if (retained.has(itemId)) continue
          const item = project.items[itemIndex(project, itemId)]!
          delete item.linkGroupId
          changedIds.add(item.id)
        }
        project.linkGroups[existingIndex] = group
      } else {
        project.linkGroups.push(group)
      }
      for (const itemId of group.itemIds) {
        project.items[itemIndex(project, itemId)]!.linkGroupId = group.id
        changedIds.add(itemId)
      }
      changedIds.add(group.id)
      return [existing
        ? { type: 'set-link-group', group: existing }
        : { type: 'delete-link-group', linkGroupId: group.id }]
    }
    case 'delete-link-group': {
      const index = project.linkGroups.findIndex(({ id }) => id === operation.linkGroupId)
      if (index < 0) missing(operation.linkGroupId)
      const [removed] = project.linkGroups.splice(index, 1)
      for (const itemId of removed!.itemIds) {
        assertItemEditable(project, itemId)
        const item = project.items[itemIndex(project, itemId)]!
        delete item.linkGroupId
        changedIds.add(item.id)
      }
      changedIds.add(operation.linkGroupId)
      return [{ type: 'set-link-group', group: removed! }]
    }
    case 'create-sequence': {
      const previousActiveId = project.activeSequenceId
      const snapshot = createEmptySequenceSnapshot(project, operation.sequenceId, operation.name)
      addSequenceSnapshot(project, snapshot.sequence, snapshot.linkGroups)
      changedIds.add(snapshot.sequence.id)
      if (operation.activate) activateSequence(project, snapshot.sequence.id, changedIds)
      return operation.activate
        ? [
            { type: 'select-sequence', sequenceId: previousActiveId },
            { type: 'close-sequence', sequenceId: snapshot.sequence.id },
            { type: 'delete-sequence', sequenceId: snapshot.sequence.id }
          ]
        : [
            { type: 'close-sequence', sequenceId: snapshot.sequence.id },
            { type: 'delete-sequence', sequenceId: snapshot.sequence.id }
          ]
    }
    case 'restore-sequence': {
      const previousActiveId = project.activeSequenceId
      addSequenceSnapshot(project, operation.sequence, operation.linkGroups)
      changedIds.add(operation.sequence.id)
      if (operation.activate) activateSequence(project, operation.sequence.id, changedIds)
      return operation.activate
        ? [
            { type: 'select-sequence', sequenceId: previousActiveId },
            { type: 'close-sequence', sequenceId: operation.sequence.id },
            { type: 'delete-sequence', sequenceId: operation.sequence.id }
          ]
        : [
            ...(operation.sequence.viewState.open
              ? [{ type: 'close-sequence' as const, sequenceId: operation.sequence.id }]
              : []),
            { type: 'delete-sequence', sequenceId: operation.sequence.id }
          ]
    }
    case 'duplicate-sequence': {
      const previousActiveId = project.activeSequenceId
      const snapshot = duplicateSequenceSnapshot(
        project,
        operation.sourceSequenceId,
        operation.sequenceId,
        operation.name
      )
      addSequenceSnapshot(project, snapshot.sequence, snapshot.linkGroups)
      snapshot.sequence.items.forEach(({ id }) => changedIds.add(id))
      snapshot.sequence.captions.forEach(({ id }) => changedIds.add(id))
      snapshot.linkGroups.forEach(({ id }) => changedIds.add(id))
      changedIds.add(snapshot.sequence.id)
      if (operation.activate) activateSequence(project, snapshot.sequence.id, changedIds)
      return operation.activate
        ? [
            { type: 'select-sequence', sequenceId: previousActiveId },
            { type: 'close-sequence', sequenceId: snapshot.sequence.id },
            { type: 'delete-sequence', sequenceId: snapshot.sequence.id }
          ]
        : [
            { type: 'close-sequence', sequenceId: snapshot.sequence.id },
            { type: 'delete-sequence', sequenceId: snapshot.sequence.id }
          ]
    }
    case 'rename-sequence': {
      const sequence = project.sequences.find(({ id }) => id === operation.sequenceId)
      if (!sequence) missing(operation.sequenceId)
      const previousName = sequence.name
      sequence.name = operation.name
      changedIds.add(sequence.id)
      return [{ type: 'rename-sequence', sequenceId: sequence.id, name: previousName }]
    }
    case 'select-sequence': {
      const previousActiveId = project.activeSequenceId
      if (previousActiveId === operation.sequenceId) return []
      activateSequence(project, operation.sequenceId, changedIds)
      return [{ type: 'select-sequence', sequenceId: previousActiveId }]
    }
    case 'open-sequence': {
      const sequence = project.sequences.find(({ id }) => id === operation.sequenceId)
      if (!sequence) missing(operation.sequenceId)
      if (sequence.viewState.open) return []
      sequence.viewState.open = true
      changedIds.add(sequence.id)
      return [{ type: 'close-sequence', sequenceId: sequence.id }]
    }
    case 'close-sequence': {
      const sequence = project.sequences.find(({ id }) => id === operation.sequenceId)
      if (!sequence) missing(operation.sequenceId)
      if (!sequence.viewState.open) return []
      const wasActive = project.activeSequenceId === sequence.id
      if (wasActive) {
        if (!operation.fallbackSequenceId || operation.fallbackSequenceId === sequence.id) {
          throw engineError('invalid_operation', 'Closing the active sequence requires an open fallback sequence')
        }
        activateSequence(project, operation.fallbackSequenceId, changedIds)
      }
      sequence.viewState.open = false
      changedIds.add(sequence.id)
      return wasActive
        ? [
            { type: 'open-sequence', sequenceId: sequence.id },
            { type: 'select-sequence', sequenceId: sequence.id }
          ]
        : [{ type: 'open-sequence', sequenceId: sequence.id }]
    }
    case 'delete-sequence': {
      const multicamOwner = (project.multicamGroups ?? []).find(
        ({ sequenceId }) => sequenceId === operation.sequenceId
      )
      if (multicamOwner) {
        throw engineError(
          'invalid_operation',
          `Sequence ${operation.sequenceId} still owns multicam group ${multicamOwner.id}`
        )
      }
      assertSequenceDeleteSafe(project, operation.sequenceId)
      const snapshot = sequenceSnapshot(project, operation.sequenceId)
      const sequenceItemIds = new Set(snapshot.sequence.items.map(({ id }) => id))
      project.sequences = project.sequences.filter(({ id }) => id !== operation.sequenceId)
      project.linkGroups = project.linkGroups.filter((group) =>
        !group.itemIds.every((itemId) => sequenceItemIds.has(itemId))
      )
      snapshot.sequence.items.forEach(({ id }) => changedIds.add(id))
      snapshot.sequence.captions.forEach(({ id }) => changedIds.add(id))
      snapshot.linkGroups.forEach(({ id }) => changedIds.add(id))
      changedIds.add(snapshot.sequence.id)
      return [{
        type: 'restore-sequence',
        sequence: snapshot.sequence,
        linkGroups: snapshot.linkGroups,
        activate: false
      }]
    }
    case 'set-sequence-view': {
      const sequence = project.sequences.find(({ id }) => id === operation.sequenceId)
      if (!sequence) missing(operation.sequenceId)
      const previous = structuredClone(sequence.viewState)
      sequence.viewState.zoom = operation.zoom
      sequence.viewState.scrollFrame = operation.scrollFrame
      changedIds.add(sequence.id)
      return [{
        type: 'set-sequence-view',
        sequenceId: sequence.id,
        zoom: previous.zoom,
        scrollFrame: previous.scrollFrame
      }]
    }
    case 'set-item-keyframes': {
      assertItemEditable(project, operation.itemId)
      const index = itemIndex(project, operation.itemId)
      const original = project.items[index]!
      const properties = new Set<string>()
      for (const track of operation.keyframes) {
        validateKeyframeProperty(original, track)
        if (properties.has(track.property)) {
          throw engineError('invalid_operation', `Duplicate keyframe property: ${track.property}`)
        }
        if (track.points.some(({ frame }) => frame > original.durationFrames)) {
          throw engineError('invalid_operation', `Keyframe track exceeds item duration: ${track.id}`)
        }
        properties.add(track.property)
      }
      const previous = structuredClone(original.keyframes ?? [])
      project.items[index] = { ...original, keyframes: structuredClone(operation.keyframes) }
      changedIds.add(original.id)
      return [{ type: 'set-item-keyframes', itemId: original.id, keyframes: previous }]
    }
    case 'set-item-effects': {
      assertItemEditable(project, operation.itemId)
      const index = itemIndex(project, operation.itemId)
      const original = project.items[index]!
      const previous = structuredClone(original.effects ?? [])
      const replacement = { ...original, effects: structuredClone(operation.effects) }
      for (const track of replacement.keyframes ?? []) validateKeyframeProperty(replacement, track)
      project.items[index] = replacement
      changedIds.add(original.id)
      return [{ type: 'set-item-effects', itemId: original.id, effects: previous }]
    }
    case 'update-item-composition': {
      assertItemEditable(project, operation.itemId)
      const index = itemIndex(project, operation.itemId)
      const original = project.items[index]!
      project.items[index] = {
        ...original,
        ...(operation.crop !== undefined ? { crop: structuredClone(operation.crop) } : {}),
        ...(operation.opacity !== undefined ? { opacity: operation.opacity } : {}),
        ...(operation.blendMode !== undefined ? { blendMode: operation.blendMode } : {})
      }
      changedIds.add(original.id)
      return [{
        type: 'update-item-composition',
        itemId: original.id,
        crop: structuredClone(original.crop ?? { left: 0, top: 0, right: 0, bottom: 0 }),
        opacity: original.opacity,
        blendMode: original.blendMode ?? 'normal'
      }]
    }
    case 'retime-item': {
      assertItemEditable(project, operation.itemId)
      const index = itemIndex(project, operation.itemId)
      const original = project.items[index]!
      const speed = normalizeRational(operation.speed)
      const durationFrames = sourceUsToTimelineFrames(
        original.sourceEndUs - original.sourceStartUs,
        speed,
        project.fps
      )
      if (durationFrames <= 0) throw engineError('invalid_operation', 'Retime would empty the timeline item')
      const keyframes = original.keyframes?.map((track) => {
        const result = retimeKeyframeTrack(track, original.durationFrames, durationFrames)
        appendKeyframePolicyNotes(notes, original.id, 'retime', result.notes)
        return result.track
      })
      project.items[index] = {
        ...original,
        speed,
        durationFrames,
        fadeInFrames: Math.min(original.fadeInFrames, durationFrames),
        fadeOutFrames: Math.min(original.fadeOutFrames, Math.max(0, durationFrames - original.fadeInFrames)),
        ...(keyframes ? { keyframes } : {})
      }
      changedIds.add(original.id)
      return [{ type: 'retime-item', itemId: original.id, speed: original.speed }]
    }
    case 'add-caption': {
      if (project.captions.some(({ id }) => id === operation.caption.id)) duplicate(operation.caption.id)
      project.captions.push(structuredClone(operation.caption))
      changedIds.add(operation.caption.id)
      return [{ type: 'delete-caption', captionId: operation.caption.id }]
    }
    case 'update-caption': {
      const index = project.captions.findIndex(({ id }) => id === operation.captionId)
      if (index < 0) missing(operation.captionId)
      const original = project.captions[index]!
      project.captions[index] = { ...original, ...structuredClone(operation.patch), id: original.id }
      changedIds.add(original.id)
      return [{ type: 'update-caption', captionId: original.id, patch: original }]
    }
    case 'delete-caption': {
      const index = project.captions.findIndex(({ id }) => id === operation.captionId)
      if (index < 0) missing(operation.captionId)
      const [removed] = project.captions.splice(index, 1)
      changedIds.add(operation.captionId)
      return [{ type: 'add-caption', caption: removed! }]
    }
    case 'set-canvas': {
      const previousPreset = project.canvas.preset
      const previousFit = project.canvas.fit
      const dimensions = CANVAS_PRESETS[operation.preset]
      project.canvas = { ...project.canvas, ...dimensions, preset: operation.preset, fit: operation.fit }
      changedIds.add('canvas')
      return [{ type: 'set-canvas', preset: previousPreset, fit: previousFit }]
    }
    case 'set-multicam-group': {
      const group = structuredClone(validateMulticamGroup(operation.group)) as MulticamGroup
      const groups = project.multicamGroups ?? (project.multicamGroups = [])
      const index = groups.findIndex(({ id }) => id === group.id)
      const previous = index < 0 ? undefined : structuredClone(groups[index]!)
      if (index < 0) groups.push(group)
      else groups[index] = group
      changedIds.add(group.id)
      group.programFragments.forEach(({ id }) => changedIds.add(id))
      return [previous
        ? { type: 'set-multicam-group', group: previous }
        : { type: 'delete-multicam-group', groupId: group.id }]
    }
    case 'delete-multicam-group': {
      const groups = project.multicamGroups ?? []
      const index = groups.findIndex(({ id }) => id === operation.groupId)
      if (index < 0) missing(operation.groupId)
      const [removed] = groups.splice(index, 1)
      changedIds.add(operation.groupId)
      removed!.programFragments.forEach(({ id }) => changedIds.add(id))
      return [{ type: 'set-multicam-group', group: removed! }]
    }
    case 'switch-multicam-angle': {
      const group = multicamGroup(project, operation.groupId)
      const plan = planMulticamAngleSwitch({
        group,
        memberId: operation.memberId,
        requestedRange: { startFrame: operation.startFrame, endFrame: operation.endFrame },
        ...(operation.coveragePolicy ? { coveragePolicy: operation.coveragePolicy } : {}),
        ...(operation.minimumSyncConfidence === undefined
          ? {}
          : { minimumSyncConfidence: operation.minimumSyncConfidence })
      })
      return applyMulticamPlan(project, group, plan, changedIds, notes)
    }
    case 'apply-multicam-layout': {
      const group = multicamGroup(project, operation.groupId)
      const plan = planMulticamLayout({
        group,
        layoutId: operation.layoutId,
        requestedRange: { startFrame: operation.startFrame, endFrame: operation.endFrame },
        ...(operation.coveragePolicy ? { coveragePolicy: operation.coveragePolicy } : {}),
        ...(operation.minimumSyncConfidence === undefined
          ? {}
          : { minimumSyncConfidence: operation.minimumSyncConfidence })
      })
      return applyMulticamPlan(project, group, plan, changedIds, notes)
    }
    case 'merge-multicam-program': {
      const group = multicamGroup(project, operation.groupId)
      return applyMulticamPlan(project, group, planMulticamMerge(group), changedIds, notes)
    }
  }
}
