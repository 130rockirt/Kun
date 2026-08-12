import type { CanvasShape, ShapeType } from '../canvas-types'
import { createDefaultShape, isArtifactFrame, isImplicitImageSlot, shapeBounds, type DevicePreset } from '../canvas-types'
import { useCanvasShapeStore, withDescendants } from '../canvas-shape-store'
import { useCanvasSelectionStore } from '../canvas-selection-store'
import { useCanvasViewportStore } from '../canvas-viewport-store'
import { centerRectInViewport, placeRectInViewportAvoiding } from '../canvas-placement'
import { alignShapes, collectiveBounds, distributeShapes, type AlignAxis, type DistributeAxis } from '../canvas-align'
import { getScreenArtifactFactory, getScreenCreationFactory, setScreenBrief } from '../screen-artifact-bridge'
import { selectedReusableScreenTargetFrameId } from '../screen-lifecycle'
import { normalizeRunningAppUrl } from '../running-app-frame'
import type { ExecuteOpsOptions, OpError, ShapeOp } from './schema'
import {
  LINEAR_TYPES,
  applyConstraintsOnResize,
  bboxRelative,
  createScreenLikeShape,
  defaultScreenDevicePreset,
  findShape,
  htmlFramePatchChangesSize,
  htmlFrameRects,
  mergeAutoLayout,
  objectHasLayout,
  promoteHtmlFrameToManualNode,
  reflowFrame,
  suggestionForMissingId
} from './context'

function normalizeRunningAppShape(
  type: CanvasShape['type'],
  patch: Partial<CanvasShape>,
  errors: OpError[]
): boolean {
  if (!patch.runningApp) return true
  if (type !== 'frame') {
    errors.push({ code: 'UNSUPPORTED_TYPE', message: 'runningApp can only be attached to frame shapes' })
    return false
  }
  const url = normalizeRunningAppUrl(patch.runningApp.url)
  if (!url) {
    errors.push({ code: 'INVALID_OP', message: 'runningApp.url must be an http or https URL' })
    return false
  }
  patch.runningApp = { ...patch.runningApp, url }
  patch.clipContent = true
  return true
}

function imageChildFillShouldUpdateParentSlot(op: Extract<ShapeOp, { op: 'add' }>): CanvasShape | null {
  if (op.shape.type !== 'image') return null
  const imageUrl = typeof op.shape.imageUrl === 'string' ? op.shape.imageUrl.trim() : ''
  if (!imageUrl || !op.parentId) return null
  const parent = findShape(op.parentId)
  if (!parent) return null
  const selected = useCanvasSelectionStore.getState().selectedIds.has(parent.id)
  if (!isImplicitImageSlot(parent) || (!parent.aiImageHolder && !selected)) return null
  return parent
}

export function executeBasicShapeOp(
  op: ShapeOp,
  affectedIds: Set<string>,
  errors: OpError[],
  options: ExecuteOpsOptions = {}
): boolean {
  const store = useCanvasShapeStore.getState()
  switch (op.op) {
    case 'add': {
      // Validate an explicit parent up front: addShape silently no-ops when the
      // parent is missing, so without this the op would report phantom success
      // (a bogus affected id) and the agent would never learn its frame id was wrong.
      if (op.parentId && !findShape(op.parentId)) {
        errors.push({
          code: 'PARENT_NOT_FOUND',
          message: `Cannot add shape: parent "${op.parentId}" does not exist`,
          suggestion: suggestionForMissingId(op.parentId)
        })
        return true
      }
      if (op.parentId && isArtifactFrame(findShape(op.parentId)!)) {
        errors.push({
          code: 'INVALID_OP',
          message: 'Cannot add canvas shapes inside an HTML or SVG artifact frame.'
        })
        return true
      }
      const parentImageSlot = imageChildFillShouldUpdateParentSlot(op)
      if (parentImageSlot) {
        const imageUrl = typeof op.shape.imageUrl === 'string' ? op.shape.imageUrl.trim() : op.shape.imageUrl
        const patch: Partial<CanvasShape> = {
          type: 'image',
          imageUrl,
          aiImageHolder: false
        }
        if (typeof op.shape.name === 'string' && op.shape.name.trim()) {
          patch.name = op.shape.name.trim()
        }
        store.updateShape(parentImageSlot.id, patch)
        affectedIds.add(parentImageSlot.id)
        break
      }
      const shapeSpec: Partial<CanvasShape> & { type: CanvasShape['type'] } = { ...op.shape }
      if (!normalizeRunningAppShape(shapeSpec.type, shapeSpec, errors)) return true
      const { type } = shapeSpec
      const x = shapeSpec.x ?? 0
      const y = shapeSpec.y ?? 0
      const base = createDefaultShape(type as ShapeType, x, y, options.shapePreset)
      // Apply optional overrides from the op (excluding type/x/y already baked in).
      const overrides: Partial<CanvasShape> = { ...shapeSpec }
      delete (overrides as Record<string, unknown>).type
      delete (overrides as Record<string, unknown>).x
      delete (overrides as Record<string, unknown>).y
      Object.assign(base, overrides)
      if (LINEAR_TYPES.has(base.type) && base.points && base.points.length > 0) {
        Object.assign(base, bboxRelative(base.points))
      }
      store.addShape(base, op.parentId)
      affectedIds.add(base.id)
      if (op.parentId) reflowFrame(op.parentId, affectedIds)
      break
    }
    case 'update': {
      const existing = findShape(op.id)
      if (!existing) {
        errors.push({
          code: 'SHAPE_NOT_FOUND',
          message: `No shape with id "${op.id}"`,
          suggestion: suggestionForMissingId(op.id)
        })
        return true
      }
      {
        const patch: Partial<CanvasShape> = { ...op.patch }
        if (!normalizeRunningAppShape(existing.type, patch, errors)) return true
        if (
          typeof patch.imageUrl === 'string' &&
          patch.imageUrl.trim() &&
          existing.type !== 'image' &&
          isImplicitImageSlot(existing)
        ) {
          patch.type = 'image'
        }
        if (LINEAR_TYPES.has(existing.type) && patch.points && patch.points.length > 0) {
          Object.assign(patch, bboxRelative(patch.points))
        }
        const shouldPromoteHtmlFrame = htmlFramePatchChangesSize(patch)
        store.updateShape(op.id, patch)
        if (shouldPromoteHtmlFrame) promoteHtmlFrameToManualNode(op.id)
      }
      affectedIds.add(op.id)
      break
    }
    case 'delete': {
      const target = findShape(op.id)
      if (!target) {
        errors.push({
          code: 'SHAPE_NOT_FOUND',
          message: `No shape with id "${op.id}"`,
          suggestion: suggestionForMissingId(op.id)
        })
        return true
      }
      const parentId = target.parentId
      store.deleteShape(op.id)
      affectedIds.add(op.id)
      // Closing the gap a deleted child left in a laid-out container.
      if (parentId && objectHasLayout(parentId)) reflowFrame(parentId, affectedIds)
      break
    }
    case 'reparent': {
      const shape = findShape(op.id)
      if (!shape) {
        errors.push({ code: 'SHAPE_NOT_FOUND', message: `No shape "${op.id}"` })
        return true
      }
      const newParent = findShape(op.newParentId)
      if (!newParent) {
        errors.push({ code: 'PARENT_NOT_FOUND', message: `No parent "${op.newParentId}"` })
        return true
      }
      if (isArtifactFrame(newParent) || (isArtifactFrame(shape) && op.newParentId !== store.document.rootId)) {
        errors.push({
          code: 'INVALID_OP',
          message: 'HTML and SVG artifact frames must remain root-level canvas portals.'
        })
        return true
      }
      if (!store.reparentShape(op.id, op.newParentId, op.index)) {
        errors.push({
          code: 'INVALID_OP',
          message: `Cannot reparent "${op.id}" below "${op.newParentId}" because the target is not a valid container or would create a cycle.`
        })
        return true
      }
      affectedIds.add(op.id)
      if (objectHasLayout(op.newParentId)) reflowFrame(op.newParentId, affectedIds)
      break
    }
    case 'move': {
      // Validate the explicitly-named ids, then move them AND their descendants
      // by the same delta — children store absolute coords, so a frame's move
      // must carry them along (deduped so an id named twice moves once).
      const present = op.ids.filter((id) => {
        if (findShape(id)) return true
        errors.push({ code: 'SHAPE_NOT_FOUND', message: `No shape "${id}"` })
        return false
      })
      const objects = useCanvasShapeStore.getState().document.objects
      for (const id of withDescendants(objects, present)) {
        const s = findShape(id)
        if (!s) continue
        store.updateShape(id, { x: s.x + op.dx, y: s.y + op.dy })
        affectedIds.add(id)
      }
      break
    }
    case 'resize': {
      const target = findShape(op.id)
      if (!target) {
        errors.push({ code: 'SHAPE_NOT_FOUND', message: `No shape "${op.id}"` })
        return true
      }
      const oldBounds = { x: target.x, y: target.y, width: target.width, height: target.height }
      const newBounds = {
        x: op.bounds.x,
        y: op.bounds.y,
        width: op.bounds.width,
        height: op.bounds.height
      }
      store.updateShape(op.id, newBounds)
      affectedIds.add(op.id)
      if (target.layout) {
        // Auto-layout owns child positions — re-flow to the new box.
        reflowFrame(op.id, affectedIds)
      } else if (target.type === 'frame' || target.type === 'group') {
        // Otherwise honor each child's resize constraints.
        applyConstraintsOnResize(op.id, oldBounds, newBounds, affectedIds)
      }
      promoteHtmlFrameToManualNode(op.id)
      break
    }
    case 'align': {
      const doc = useCanvasShapeStore.getState().document
      const shapes = op.ids
        .map((id) => doc.objects[id])
        .filter((s): s is CanvasShape => Boolean(s))
        .map((s) => ({ id: s.id, x: s.x, y: s.y, width: s.width, height: s.height }))
      if (shapes.length < 2) {
        errors.push({ code: 'INVALID_OP', message: 'align requires ≥2 valid shapes' })
        return true
      }
      const out = alignShapes(shapes, op.axis as AlignAxis)
      for (const [id, patch] of out) {
        store.updateShape(id, patch)
        affectedIds.add(id)
      }
      break
    }
    case 'distribute': {
      const doc = useCanvasShapeStore.getState().document
      const shapes = op.ids
        .map((id) => doc.objects[id])
        .filter((s): s is CanvasShape => Boolean(s))
        .map((s) => ({ id: s.id, x: s.x, y: s.y, width: s.width, height: s.height }))
      if (shapes.length < 3) {
        errors.push({ code: 'INVALID_OP', message: 'distribute requires ≥3 valid shapes' })
        return true
      }
      const out = distributeShapes(shapes, op.axis as DistributeAxis)
      for (const [id, patch] of out) {
        store.updateShape(id, patch)
        affectedIds.add(id)
      }
      break
    }
    case 'duplicate': {
      if (!findShape(op.id)) {
        errors.push({
          code: 'SHAPE_NOT_FOUND',
          message: `No shape with id "${op.id}"`,
          suggestion: suggestionForMissingId(op.id)
        })
        return true
      }
      const count = Math.max(1, Math.min(op.count ?? 1, 20))
      const dx = op.offset?.dx ?? 24
      const dy = op.offset?.dy ?? 24
      for (let i = 0; i < count; i += 1) {
        const newId = store.duplicateShape(op.id)
        if (!newId) {
          errors.push({ code: 'INVALID_OP', message: `Cannot duplicate "${op.id}" (root or detached shapes can't be duplicated)` })
          break
        }
        // Stagger each copy so duplicates don't stack exactly on the original.
        // Children store ABSOLUTE coords, so the whole clone subtree shifts together.
        if (dx !== 0 || dy !== 0) {
          const objects = useCanvasShapeStore.getState().document.objects
          const step = i + 1
          for (const cloneId of withDescendants(objects, [newId])) {
            const cs = objects[cloneId]
            if (cs) store.updateShape(cloneId, { x: cs.x + dx * step, y: cs.y + dy * step })
          }
        }
        affectedIds.add(newId)
      }
      break
    }
    case 'reorder': {
      const shape = findShape(op.id)
      if (!shape) {
        errors.push({
          code: 'SHAPE_NOT_FOUND',
          message: `No shape with id "${op.id}"`,
          suggestion: suggestionForMissingId(op.id)
        })
        return true
      }
      const parent = shape.parentId ? findShape(shape.parentId) : null
      const siblings = parent?.children ?? []
      const current = siblings.indexOf(op.id)
      if (!parent || current < 0) {
        errors.push({ code: 'INVALID_OP', message: `Shape "${op.id}" has no parent layer order to change` })
        return true
      }
      const last = siblings.length - 1
      const target =
        op.action === 'front'
          ? last
          : op.action === 'back'
            ? 0
            : op.action === 'forward'
              ? Math.min(last, current + 1)
              : Math.max(0, current - 1)
      if (target !== current) store.reorderShape(op.id, target)
      affectedIds.add(op.id)
      break
    }
    case 'add-screen': {
      const creationFactory = getScreenCreationFactory()
      const factory = getScreenArtifactFactory()
      const allowPlainFrame = options.screenFallback === 'plain-frame'
      const targetFrameId = !allowPlainFrame ? selectedReusableScreenTargetFrameId() : null
      const targetFrame = targetFrameId ? findShape(targetFrameId) : null
      const preset = (op.devicePreset ?? defaultScreenDevicePreset()) as DevicePreset
      const centered = createScreenLikeShape(op.name, 0, 0, preset, null)
      const width = targetFrame?.width ?? op.width ?? centered.width
      const height = targetFrame?.height ?? op.height ?? centered.height
      const fallbackRect = placeRectInViewportAvoiding(
        { width, height },
        useCanvasViewportStore.getState().vbox,
        htmlFrameRects()
      )
      const x = targetFrame?.x ?? op.x ?? fallbackRect.x
      const y = targetFrame?.y ?? op.y ?? fallbackRect.y
      if (creationFactory && !allowPlainFrame) {
        const created = creationFactory({
          name: op.name,
          ...(op.brief ? { brief: op.brief } : {}),
          x,
          y,
          width,
          height,
          ...(targetFrameId ? { targetFrameId } : {}),
          devicePreset: preset,
          preparePreview: false
        })
        if (!created) {
          errors.push({ code: 'INVALID_OP', message: 'Cannot create screen artifact — handler returned no screen' })
          return true
        }
        if (op.brief) setScreenBrief(created.shapeId, op.brief)
        affectedIds.add(created.shapeId)
        break
      }
      const artifactId = factory?.(op.name) ?? null
      if (!artifactId && !allowPlainFrame) {
        errors.push({ code: 'INVALID_OP', message: 'Cannot create screen artifact — no handler registered' })
        return true
      }
      const shape = createScreenLikeShape(
        op.name,
        x,
        y,
        preset,
        artifactId
      )
      if (op.width) shape.width = op.width
      if (op.height) shape.height = op.height
      store.addShape(shape)
      // Keep the agent's expanded brief so the follow-up HTML-generation turn
      // designs from it instead of the raw user prompt (see the turn-complete hook).
      if (artifactId && op.brief) setScreenBrief(shape.id, op.brief)
      affectedIds.add(shape.id)
      break
    }
    case 'group': {
      const doc0 = useCanvasShapeStore.getState().document
      const members = op.ids
        .map((id) => doc0.objects[id])
        .filter((s): s is CanvasShape => Boolean(s) && s.id !== doc0.rootId)
      if (members.length === 0) {
        errors.push({
          code: 'SHAPE_NOT_FOUND',
          message: `group: none of [${op.ids.join(', ')}] exist`,
          suggestion: suggestionForMissingId(op.ids[0])
        })
        return true
      }
      if (members.some(isArtifactFrame)) {
        errors.push({
          code: 'INVALID_OP',
          message: 'HTML and SVG artifact frames cannot be grouped because portal previews must remain root-level.'
        })
        return true
      }
      // The group lands under the first member's parent so it sits where the
      // content already is; bounds wrap the whole selection.
      const parentId = members[0].parentId ?? doc0.rootId
      const bounds = collectiveBounds(
        members.map((s) => ({ id: s.id, x: s.x, y: s.y, width: s.width, height: s.height }))
      )
      const container = createDefaultShape(
        op.asFrame ? 'frame' : 'group',
        bounds.x,
        bounds.y,
        options.shapePreset
      )
      container.name = op.name ?? (op.asFrame ? 'Frame' : 'Group')
      container.width = bounds.width
      container.height = bounds.height
      if (op.asFrame) {
        container.clipContent = false
      } else {
        container.fills = []
      }
      store.addShape(container, parentId)
      // Reparent members into the container, preserving their on-canvas order.
      for (const m of members) {
        store.reparentShape(m.id, container.id)
        affectedIds.add(m.id)
      }
      affectedIds.add(container.id)
      break
    }
    case 'ungroup': {
      const group = findShape(op.id)
      if (!group) {
        errors.push({
          code: 'SHAPE_NOT_FOUND',
          message: `No shape with id "${op.id}"`,
          suggestion: suggestionForMissingId(op.id)
        })
        return true
      }
      const grandparentId = group.parentId
      if (!grandparentId) {
        errors.push({ code: 'INVALID_OP', message: `Cannot ungroup "${op.id}" — it has no parent to lift children into` })
        return true
      }
      // Snapshot children first: reparenting mutates group.children as we go.
      const childIds = [...group.children]
      for (const childId of childIds) {
        store.reparentShape(childId, grandparentId)
        affectedIds.add(childId)
      }
      store.deleteShape(op.id)
      affectedIds.add(op.id)
      if (objectHasLayout(grandparentId)) reflowFrame(grandparentId, affectedIds)
      break
    }
    case 'set-style': {
      const present = op.ids.filter((id) => {
        if (findShape(id)) return true
        errors.push({ code: 'SHAPE_NOT_FOUND', message: `No shape "${id}"`, suggestion: suggestionForMissingId(id) })
        return false
      })
      if (present.length === 0) return true
      const patch = op.style as Partial<CanvasShape>
      for (const id of present) {
        store.updateShape(id, patch)
        affectedIds.add(id)
      }
      break
    }
    case 'auto-layout': {
      const frame = findShape(op.id)
      if (!frame) {
        errors.push({
          code: 'SHAPE_NOT_FOUND',
          message: `No shape with id "${op.id}"`,
          suggestion: suggestionForMissingId(op.id)
        })
        return true
      }
      if (frame.type !== 'frame' && frame.type !== 'group') {
        errors.push({
          code: 'UNSUPPORTED_TYPE',
          message: `auto-layout needs a frame or group, got "${frame.type}"`,
          suggestion: 'Group the shapes first (op "group"), then auto-layout the group.'
        })
        return true
      }
      if (op.clear) {
        store.updateShape(op.id, { layout: undefined })
        affectedIds.add(op.id)
        break
      }
      const merged = mergeAutoLayout(frame.layout, op.layout)
      store.updateShape(op.id, { layout: merged })
      affectedIds.add(op.id)
      reflowFrame(op.id, affectedIds)
      break
    }
    default:
      return false
  }
  return true
}
