import type { CanvasShape, Rect } from '../canvas-types'
import { createDefaultShape, isArtifactFrame, shapeBounds, type DevicePreset } from '../canvas-types'
import { useCanvasShapeStore, withDescendants } from '../canvas-shape-store'
import { useCanvasViewportStore } from '../canvas-viewport-store'
import { centerRectInViewport, layoutRectsInViewport, placeRectInViewportAvoiding } from '../canvas-placement'
import { currentCanvasOccupiedRects } from '../canvas-occupied-regions'
import { collectiveBounds } from '../canvas-align'
import { lintDesignSystem, setLastLintFindings } from '../design-lint'
import { applyDesignSystemTemplateOp, type DesignSystemTemplateOp } from '../design-system-template'
import { getScreenArtifactFactory, getScreenCreationFactory, setScreenBrief } from '../screen-artifact-bridge'
import { selectedReusableScreenTargetFrameId } from '../screen-lifecycle'
import { useDesignSystemStore } from '../design-system-store'
import type { ExecuteOpsOptions, OpError, ShapeOp } from './schema'
import {
  DEVICE_DIMS,
  cloneLiveSubtree,
  createScreenLikeShape,
  defaultScreenDevicePreset,
  findShape,
  mergeAutoLayout,
  rebindThemeOnSubtree,
  recolorSubtree,
  reflowFrame,
  responsiveReflowFrame,
  suggestionForMissingId
} from './context'

export function executeAdvancedShapeOp(
  op: ShapeOp,
  affectedIds: Set<string>,
  errors: OpError[],
  options: ExecuteOpsOptions = {}
): boolean {
  const store = useCanvasShapeStore.getState()
  switch (op.op) {
    case 'add-screens': {
      const creationFactory = getScreenCreationFactory()
      const factory = getScreenArtifactFactory()
      const allowPlainFrame = options.screenFallback === 'plain-frame'
      if (!creationFactory && !factory && !allowPlainFrame) {
        errors.push({ code: 'INVALID_OP', message: 'Cannot create screen artifacts — no handler registered' })
        return true
      }
      const specs = op.specs.map((spec) => {
        const preset = (spec.devicePreset ?? defaultScreenDevicePreset()) as DevicePreset
        const base = createScreenLikeShape(spec.name, 0, 0, preset, null)
        return {
          spec,
          preset,
          width: spec.width ?? base.width,
          height: spec.height ?? base.height
        }
      })
      const occupiedRects = currentCanvasOccupiedRects()
      const vbox = useCanvasViewportStore.getState().vbox
      const hasExplicitPlacements = specs.some(({ spec }) => spec.x !== undefined || spec.y !== undefined)
      const targetFrameId = !allowPlainFrame && specs.length === 1 ? selectedReusableScreenTargetFrameId() : null
      const targetFrame = targetFrameId ? findShape(targetFrameId) : null
      const batchRects = layoutRectsInViewport(
        specs.map((spec) => ({ width: spec.width, height: spec.height })),
        vbox
      )
      const placedRects: Rect[] = []
      for (let i = 0; i < specs.length; i += 1) {
        const { spec, preset, width, height } = specs[i]
        const batchRect = batchRects[i] ?? centerRectInViewport(width, height, vbox)
        const autoRect =
          occupiedRects.length === 0 && !hasExplicitPlacements
            ? batchRect
            : placeRectInViewportAvoiding({ width, height }, vbox, [...occupiedRects, ...placedRects])
        const reuseTargetFrame = i === 0 ? targetFrame : null
        const x = reuseTargetFrame?.x ?? spec.x ?? autoRect.x
        const y = reuseTargetFrame?.y ?? spec.y ?? autoRect.y
        const nextWidth = reuseTargetFrame?.width ?? width
        const nextHeight = reuseTargetFrame?.height ?? height
        if (creationFactory && !allowPlainFrame) {
          const created = creationFactory({
            name: spec.name,
            ...(spec.brief ? { brief: spec.brief } : {}),
            x,
            y,
            width: nextWidth,
            height: nextHeight,
            ...(reuseTargetFrame ? { targetFrameId: reuseTargetFrame.id } : {}),
            devicePreset: preset,
            preparePreview: false
          })
          if (!created) {
            errors.push({ code: 'INVALID_OP', message: `Cannot create screen artifact for "${spec.name}"` })
            continue
          }
          placedRects.push({ x, y, width: nextWidth, height: nextHeight })
          if (spec.brief) setScreenBrief(created.shapeId, spec.brief)
          affectedIds.add(created.shapeId)
          continue
        }
        const artifactId = factory?.(spec.name) ?? null
        if (!artifactId && !allowPlainFrame) {
          errors.push({ code: 'INVALID_OP', message: `Cannot create screen artifact for "${spec.name}"` })
          continue
        }
        const shape = createScreenLikeShape(spec.name, x, y, preset, artifactId)
        shape.width = nextWidth
        shape.height = nextHeight
        store.addShape(shape)
        placedRects.push(shapeBounds(shape))
        if (artifactId && spec.brief) setScreenBrief(shape.id, spec.brief)
        affectedIds.add(shape.id)
      }
      break
    }
    case 'bulk-edit': {
      const objects = useCanvasShapeStore.getState().document.objects
      const f = op.filter
      const compId = f.component
        ? useDesignSystemStore.getState().getComponent(f.component)?.id
        : undefined
      const nameNeedle = f.nameContains?.toLowerCase()
      const matches = Object.values(objects).filter((s) => {
        if (s.id === store.document.rootId) return false
        if (f.type && s.type !== f.type) return false
        if (nameNeedle && !s.name.toLowerCase().includes(nameNeedle)) return false
        if (f.boundToken && !Object.values(s.tokenBindings ?? {}).includes(f.boundToken)) return false
        if (f.component && s.componentId !== compId) return false
        if (f.inFrame && s.frameId !== f.inFrame && s.parentId !== f.inFrame) return false
        return true
      })
      if (matches.length === 0) {
        errors.push({
          code: 'INVALID_OP',
          message: 'bulk-edit matched no shapes',
          suggestion: 'Loosen the filter (type/nameContains/component/boundToken/inFrame).'
        })
        break
      }
      const patch = op.set as Partial<CanvasShape>
      for (const s of matches) {
        store.updateShape(s.id, patch)
        affectedIds.add(s.id)
      }
      break
    }
    case 'grid': {
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
          message: `grid needs a frame or group, got "${frame.type}"`,
          suggestion: 'Group the shapes first (op "group" or "stack"), then grid the container.'
        })
        return true
      }
      const objs = useCanvasShapeStore.getState().document.objects
      const children = frame.children
        .map((id) => objs[id])
        .filter((s): s is CanvasShape => Boolean(s))
      if (children.length === 0) break
      const cellW = Math.max(...children.map((c) => c.width))
      const cellH = Math.max(...children.map((c) => c.height))
      const colGap = op.colGap ?? 16
      const rowGap = op.rowGap ?? 16
      children.forEach((child, i) => {
        const col = i % op.cols
        const row = Math.floor(i / op.cols)
        const nx = frame.x + col * (cellW + colGap)
        const ny = frame.y + row * (cellH + rowGap)
        const dx = nx - child.x
        const dy = ny - child.y
        if (dx !== 0 || dy !== 0) {
          const all = useCanvasShapeStore.getState().document.objects
          for (const id of withDescendants(all, [child.id])) {
            const s = all[id]
            if (s) store.updateShape(id, { x: s.x + dx, y: s.y + dy })
          }
        }
        affectedIds.add(child.id)
      })
      break
    }
    case 'stack': {
      const doc0 = useCanvasShapeStore.getState().document
      const members = op.ids
        .map((id) => doc0.objects[id])
        .filter((s): s is CanvasShape => Boolean(s) && s.id !== doc0.rootId)
      if (members.length === 0) {
        errors.push({
          code: 'SHAPE_NOT_FOUND',
          message: `stack: none of [${op.ids.join(', ')}] exist`,
          suggestion: suggestionForMissingId(op.ids[0])
        })
        return true
      }
      if (members.some(isArtifactFrame)) {
        errors.push({
          code: 'INVALID_OP',
          message: 'HTML and SVG artifact frames cannot be stacked because portal previews must remain root-level.'
        })
        return true
      }
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
      container.name = op.name ?? 'Stack'
      container.width = bounds.width
      container.height = bounds.height
      if (op.asFrame) container.clipContent = false
      else container.fills = []
      container.layout = mergeAutoLayout(undefined, { direction: op.direction, gap: op.gap })
      store.addShape(container, parentId)
      for (const m of members) {
        store.reparentShape(m.id, container.id)
        affectedIds.add(m.id)
      }
      affectedIds.add(container.id)
      reflowFrame(container.id, affectedIds)
      break
    }
    case 'apply-theme': {
      for (const id of op.ids) {
        if (!findShape(id)) {
          errors.push({
            code: 'SHAPE_NOT_FOUND',
            message: `No shape with id "${id}"`,
            suggestion: suggestionForMissingId(id)
          })
          continue
        }
        rebindThemeOnSubtree(id, op.remap, affectedIds)
      }
      break
    }
    case 'recolor': {
      for (const id of op.ids) {
        if (!findShape(id)) {
          errors.push({
            code: 'SHAPE_NOT_FOUND',
            message: `No shape with id "${id}"`,
            suggestion: suggestionForMissingId(id)
          })
          continue
        }
        recolorSubtree(id, op.mapping, affectedIds)
      }
      break
    }
    case 'responsive-reflow': {
      if (!findShape(op.frameId)) {
        errors.push({
          code: 'SHAPE_NOT_FOUND',
          message: `No shape with id "${op.frameId}"`,
          suggestion: suggestionForMissingId(op.frameId)
        })
        return true
      }
      responsiveReflowFrame(op.frameId, op.device, affectedIds)
      break
    }
    case 'variant-matrix': {
      const base = findShape(op.baseId)
      if (!base) {
        errors.push({
          code: 'SHAPE_NOT_FOUND',
          message: `No base shape with id "${op.baseId}"`,
          suggestion: suggestionForMissingId(op.baseId)
        })
        return true
      }
      const parentId = base.parentId ?? store.document.rootId
      const devices = op.devices && op.devices.length ? op.devices : [base.devicePreset ?? 'desktop']
      const themes = op.themes && op.themes.length ? op.themes : [{ name: 'default', remap: {} }]
      const gap = op.gap ?? 80
      const at = op.at ?? { x: base.x, y: base.y + base.height + gap }
      let cursorY = at.y
      for (const theme of themes) {
        let cursorX = at.x
        let rowH = 0
        for (const device of devices) {
          const dims = DEVICE_DIMS[device]
          const cloneRoot = cloneLiveSubtree(op.baseId, cursorX - base.x, cursorY - base.y, parentId)
          responsiveReflowFrame(cloneRoot, device, affectedIds)
          if (Object.keys(theme.remap).length > 0) {
            rebindThemeOnSubtree(cloneRoot, theme.remap, affectedIds)
          }
          affectedIds.add(cloneRoot)
          cursorX += dims.width + gap
          rowH = Math.max(rowH, dims.height)
        }
        cursorY += rowH + gap
      }
      break
    }
    case 'design-system-template': {
      if (op.operation === 'validate') {
        setLastLintFindings(
          lintDesignSystem(
            useCanvasShapeStore.getState().document,
            useDesignSystemStore.getState().system,
            { scopeIds: op.targetIds }
          ),
          options?.lintFeedbackKey
        )
      } else {
        applyDesignSystemTemplateOp(op as DesignSystemTemplateOp, affectedIds, errors)
      }
      break
    }
    case 'lint-design-system': {
      // Pure analysis — stash findings for the next turn's prompt (no mutation).
      setLastLintFindings(
        lintDesignSystem(
          useCanvasShapeStore.getState().document,
          useDesignSystemStore.getState().system,
          { scopeIds: op.targetIds }
        ),
        options?.lintFeedbackKey
      )
      break
    }
    default:
      return false
  }
  return true
}
