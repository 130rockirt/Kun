import { createHash } from 'node:crypto'
import { validateStructuredArgumentBudget } from './structured-argument-budget.js'

type DesignCanvasAction = 'create_board' | 'add_screen' | 'update_shapes'
type DesignScreenSpec = {
  name: string
  brief?: string
  x?: number
  y?: number
  width?: number
  height?: number
  devicePreset?: 'mobile' | 'tablet' | 'desktop'
}
export const DESIGN_UPDATE_SHAPES_MAX_OPS = 100
const DESIGN_UPDATE_SHAPES_MAX_ARGUMENT_BYTES = 512 * 1024
const DESIGN_UPDATE_SHAPES_MAX_NODES = 2_000
const DESIGN_UPDATE_SHAPES_MAX_DEPTH = 32

export function normalizeDesignCanvasArgs(args: Record<string, unknown>):
  | { ok: true; action: DesignCanvasAction; ops: unknown[]; message: string }
  | { ok: false; error: string } {
  const action = args.action
  if (action !== 'create_board' && action !== 'add_screen' && action !== 'update_shapes') {
    return { ok: false, error: 'action must be one of create_board, add_screen, or update_shapes' }
  }
  if (action === 'create_board') {
    return {
      ok: true,
      action,
      ops: [],
      message: 'Design board is ready.'
    }
  }
  if (action === 'add_screen') {
    const op = copyOptionalFields(
      {
        op: 'add-screen',
        name: typeof args.name === 'string' && args.name.trim() ? args.name.trim() : 'Screen'
      },
      args,
      ['brief', 'x', 'y', 'width', 'height', 'devicePreset']
    )
    return {
      ok: true,
      action,
      ops: [op],
      message: `Accepted screen "${String(op.name)}" for renderer application; this result does not verify that the canvas applied it.`
    }
  }
  const ops = normalizeOps(args.ops)
  if (!ops) {
    return { ok: false, error: 'update_shapes requires ops as an object or array' }
  }
  return {
    ok: true,
    action,
    ops,
    message: `Accepted ${ops.length} shape operation${ops.length === 1 ? '' : 's'} for renderer application; this result does not verify that the canvas applied them.`
  }
}

export function normalizeDesignUpdateShapeOps(args: Record<string, unknown>): unknown[] | null {
  const explicitOps = firstNormalizedOps(
    args.ops,
    args.shapeOps,
    args.shape_ops,
    args.operations
  )
  if (explicitOps) return explicitOps
  if (typeof args.op === 'string' && args.op.trim()) return [normalizeShapeOpAliases(args)]
  const update = normalizeLooseUpdateShapeOp(args)
  return update ? [update] : null
}

export function designShapeMutationBudgetError(args: Record<string, unknown>, ops: unknown[]): string | null {
  if (ops.length > DESIGN_UPDATE_SHAPES_MAX_OPS) {
    return `design_update_shapes accepts at most ${DESIGN_UPDATE_SHAPES_MAX_OPS} operations; split the work into batches of 20-50`
  }
  const budget = validateStructuredArgumentBudget(args, {
    label: 'design_update_shapes',
    maxBytes: DESIGN_UPDATE_SHAPES_MAX_ARGUMENT_BYTES,
    maxNodes: DESIGN_UPDATE_SHAPES_MAX_NODES,
    maxDepth: DESIGN_UPDATE_SHAPES_MAX_DEPTH
  })
  return budget.ok ? null : budget.error
}

function firstNormalizedOps(...values: unknown[]): unknown[] | null {
  for (const value of values) {
    if (value === undefined) continue
    const ops = normalizeOps(value)
    if (ops) return ops
  }
  return null
}

function normalizeLooseUpdateShapeOp(args: Record<string, unknown>): Record<string, unknown> | null {
  const id = stringArg(args.id) ?? stringArg(args.shapeId) ?? stringArg(args.shape_id)
  if (!id) return null
  const patchSource = isRecord(args.patch) ? args.patch : args
  const patch = normalizeLooseShapePatch(patchSource)
  if (Object.keys(patch).length === 0) return null
  return { op: 'update', id, patch }
}

function normalizeLooseShapePatch(source: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  const skip = new Set([
    'id',
    'shapeId',
    'shape_id',
    'op',
    'ops',
    'shapeOps',
    'shape_ops',
    'operations',
    'action',
    'tool',
    'patch'
  ])
  for (const [key, value] of Object.entries(source)) {
    if (skip.has(key) || value === undefined) continue
    const normalizedKey =
      key === 'image_url' || key === 'relative_path' || key === 'relativePath'
        ? 'imageUrl'
        : key === 'text_content' || key === 'text' || key === 'content'
          ? 'textContent'
          : key
    patch[normalizedKey] = value
  }
  return patch
}

export function normalizeScreenSpecs(args: Record<string, unknown>):
  | { ok: true; specs: DesignScreenSpec[] }
  | { ok: false; error: string } {
  if (Array.isArray(args.screens)) {
    const specs = args.screens.map(normalizeScreenSpec).filter(Boolean) as DesignScreenSpec[]
    if (specs.length === 0) return { ok: false, error: 'screens must contain at least one valid screen spec' }
    return { ok: true, specs }
  }
  const spec = normalizeScreenSpec(args)
  if (!spec) return { ok: false, error: 'name is required for design_create_screen' }
  return { ok: true, specs: [spec] }
}

function normalizeScreenSpec(value: unknown): DesignScreenSpec | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const name = typeof source.name === 'string' && source.name.trim() ? source.name.trim() : ''
  if (!name) return null
  return copyOptionalFields({ name }, source, ['brief', 'x', 'y', 'width', 'height', 'devicePreset']) as DesignScreenSpec
}

export function normalizeStructuredDesignSystemOps(args: Record<string, unknown>): Record<string, unknown>[] {
  const ops: Record<string, unknown>[] = []
  if (Array.isArray(args.tokens)) {
    for (const token of args.tokens) {
      if (!isRecord(token)) continue
      const name = stringArg(token.name)
      const kind = oneOf(token.kind, ['color', 'gradient', 'type', 'space', 'radius', 'shadow'])
      if (name && kind && Object.hasOwn(token, 'value')) ops.push({ op: 'define-token', name, kind, value: token.value })
    }
  }
  if (Array.isArray(args.captureComponents)) {
    for (const item of args.captureComponents) {
      if (!isRecord(item)) continue
      const name = stringArg(item.name)
      const fromId = stringArg(item.fromId)
      if (!name || !fromId) continue
      ops.push({
        op: 'define-component',
        name,
        fromId,
        slots: Array.isArray(item.slots) ? item.slots.filter(isRecord) : []
      })
    }
  }
  if (Array.isArray(args.variants)) {
    for (const item of args.variants) {
      if (!isRecord(item)) continue
      const name = stringArg(item.component)
      const key = stringArg(item.key)
      if (!name || !key || !isRecord(item.selection) || !isRecord(item.overrides)) continue
      ops.push({ op: 'set-component-variant', name, key, selection: item.selection, overrides: item.overrides })
    }
  }
  if (Array.isArray(args.deleteTokenNames)) {
    for (const name of args.deleteTokenNames) if (stringArg(name)) ops.push({ op: 'delete-token', name: stringArg(name) })
  }
  if (Array.isArray(args.deleteComponentNames)) {
    for (const name of args.deleteComponentNames) if (stringArg(name)) ops.push({ op: 'delete-component', name: stringArg(name) })
  }
  return ops
}

export function normalizeArrangeOp(args: Record<string, unknown>):
  | { ok: true; op: Record<string, unknown> }
  | { ok: false; error: string } {
  const operation = args.operation
  const ids = Array.isArray(args.ids) ? args.ids.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : []
  if (operation === 'align') {
    const axis = oneOf(args.axis, ['left', 'h-center', 'right', 'top', 'v-center', 'bottom'])
    if (ids.length < 2 || !axis) return { ok: false, error: 'align requires ids (2+) and axis' }
    return { ok: true, op: { op: 'align', ids, axis } }
  }
  if (operation === 'distribute') {
    const axis = oneOf(args.axis, ['horizontal', 'vertical'])
    if (ids.length < 3 || !axis) return { ok: false, error: 'distribute requires ids (3+) and axis horizontal|vertical' }
    return { ok: true, op: { op: 'distribute', ids, axis } }
  }
  if (operation === 'stack') {
    const direction = oneOf(args.direction, ['horizontal', 'vertical'])
    if (ids.length < 1 || !direction) return { ok: false, error: 'stack requires ids and direction' }
    return {
      ok: true,
      op: {
        op: 'stack',
        ids,
        direction,
        ...(numberArg(args.gap) !== undefined ? { gap: numberArg(args.gap) } : {}),
        ...(stringArg(args.name) ? { name: stringArg(args.name) } : {}),
        ...(args.asFrame === true ? { asFrame: true } : {})
      }
    }
  }
  if (operation === 'grid') {
    const id = stringArg(args.id)
    const cols = numberArg(args.cols)
    if (!id || !cols) return { ok: false, error: 'grid requires id and positive cols' }
    return {
      ok: true,
      op: {
        op: 'grid',
        id,
        cols,
        ...(numberArg(args.rowGap) !== undefined ? { rowGap: numberArg(args.rowGap) } : {}),
        ...(numberArg(args.colGap) !== undefined ? { colGap: numberArg(args.colGap) } : {})
      }
    }
  }
  if (operation === 'responsive_reflow') {
    const frameId = stringArg(args.frameId) || stringArg(args.id)
    const device = oneOf(args.device, ['mobile', 'tablet', 'desktop'])
    if (!frameId || !device) return { ok: false, error: 'responsive_reflow requires frameId and device' }
    return { ok: true, op: { op: 'responsive-reflow', frameId, device } }
  }
  return { ok: false, error: 'operation must be align, distribute, stack, grid, or responsive_reflow' }
}

/**
 * Deterministic receipt key shared between the Kun tool result and the
 * renderer's application receipt. The renderer recomputes the same seed
 * (threadId/turnId/callId + canonical ops JSON) and POSTs it back.
 */
export function designCanvasReceiptKey(
  threadId: string | undefined,
  turnId: string | undefined,
  callId: string | undefined,
  ops: unknown[]
): string {
  const seed = [threadId ?? '', turnId ?? '', callId ?? '', JSON.stringify(ops)].join('\u0000')
  return `design-receipt-${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`
}

export function designToolOutput(tool: string, action: string, ops: unknown[], extra: Record<string, unknown> = {}): { output: Record<string, unknown> } {
  return {
    output: {
      ok: true,
      tool,
      action,
      ...extra,
      ops,
      message: `Accepted ${ops.length} design operation${ops.length === 1 ? '' : 's'} for renderer application; this result does not verify that the canvas applied them.`
    }
  }
}

export function designToolError(error: string): { output: Record<string, unknown>; isError: true } {
  return { output: { ok: false, error }, isError: true }
}

export function stringArg(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function safeCanvasExportStem(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 64)
  return normalized || 'kun-whiteboard'
}

export function numberArg(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function oneOf<const T extends readonly string[]>(value: unknown, values: T): T[number] | undefined {
  return typeof value === 'string' && values.includes(value) ? value as T[number] : undefined
}

function normalizeOps(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value.map(normalizeShapeOpAliases)
  if (value && typeof value === 'object') return [normalizeShapeOpAliases(value)]
  return null
}

function normalizeShapeOpAliases(value: unknown): unknown {
  if (!isRecord(value)) return value
  if (value.op === 'update') {
    if (isRecord(value.patch)) {
      return { ...value, patch: normalizeShapeTextAliases(value.patch) }
    }
    // A loose top-level update such as {op:'update', id:'x', text:'English'}
    // has no patch. Reuse the loose-patch normalization so `text`/`content`
    // aliases become `patch.textContent` instead of leaking as unknown fields.
    const id = stringArg(value.id)
    if (!id) return value
    const patch = normalizeLooseShapePatch(value)
    if (Object.keys(patch).length === 0) return value
    return { op: 'update', id, patch }
  }
  if (value.op === 'add' && isRecord(value.shape)) {
    return { ...value, shape: normalizeShapeTextAliases(value.shape) }
  }
  return value
}

function normalizeShapeTextAliases(value: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...value }
  const hasCanonical = typeof normalized.textContent === 'string'
  const fallbackText = typeof normalized.text === 'string'
    ? normalized.text
    : typeof normalized.content === 'string' ? normalized.content : undefined
  // `textContent` is canonical. Always drop the loose aliases so a strict
  // renderer schema never rejects a leftover `text`/`content` field.
  delete normalized.text
  delete normalized.content
  if (!hasCanonical && fallbackText !== undefined) normalized.textContent = fallbackText
  return normalized
}

function copyOptionalFields(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  keys: string[]
): Record<string, unknown> {
  for (const key of keys) {
    if (source[key] !== undefined) target[key] = source[key]
  }
  return target
}
