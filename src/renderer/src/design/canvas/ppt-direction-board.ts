import type { CanvasShape } from './canvas-types'

export type PptDirectionPreview = {
  role: 'cover' | 'representative' | 'complex'
  imagePath: string
}

export type PptDirectionCandidateBundle = {
  directionId: string
  name: string
  rationale: string
  revision: number
  recommended: boolean
  fonts: string[]
  colors: string[]
  layout: string
  background: string
  imagery: string
  previews: PptDirectionPreview[]
}

export type PptDirectionBundle = {
  schemaVersion: 1
  workflowId: string
  childId: string
  manifestPath: string
  previewMode: 'image-first' | 'editable'
  deckTitle: string
  phase: 'awaiting_direction'
  recommendedDirectionId: string
  slides: Array<{ slideId: string; index: number; title: string }>
  directions: PptDirectionCandidateBundle[]
}

export type SerializedPptDirectionContext = {
  workflowId: string
  childId: string
  revision: number
  directions: Array<{ directionId: string; revision: number }>
}

const COLUMN_WIDTH = 456
const COLUMN_GAP = 48
const CARD_HEIGHT = 1_152
const PREVIEW_WIDTH = 424
const PREVIEW_HEIGHT = 239
const PREVIEW_START_Y = 124
const PREVIEW_GAP = 286
const PREVIEW_LABELS: Record<PptDirectionPreview['role'], string> = {
  cover: 'Cover',
  representative: 'Representative content',
  complex: 'Complex / data / action'
}

type ShapeSpec = Partial<CanvasShape> & Pick<CanvasShape, 'type' | 'name'>

export function isPptDirectionBundle(value: unknown): value is PptDirectionBundle {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.phase !== 'awaiting_direction') return false
  if (!nonEmptyString(value.workflowId) || !nonEmptyString(value.childId) ||
    !workspaceRelativePath(value.manifestPath) || !nonEmptyString(value.deckTitle) ||
    (value.previewMode !== 'image-first' && value.previewMode !== 'editable') ||
    !nonEmptyString(value.recommendedDirectionId) || !Array.isArray(value.slides) || value.slides.length === 0 ||
    !Array.isArray(value.directions) || value.directions.length !== 3) return false

  const slideIndexes = new Set<number>()
  const slideIds = new Set<string>()
  for (const slide of value.slides) {
    if (!isRecord(slide) || !nonEmptyString(slide.slideId) || !Number.isInteger(slide.index) ||
      Number(slide.index) < 0 || !nonEmptyString(slide.title) || slideIds.has(slide.slideId) ||
      slideIndexes.has(Number(slide.index))) return false
    slideIds.add(slide.slideId)
    slideIndexes.add(Number(slide.index))
  }
  for (let index = 0; index < value.slides.length; index += 1) {
    if (!slideIndexes.has(index)) return false
  }

  const directionIds = new Set<string>()
  let recommendedCount = 0
  for (const direction of value.directions) {
    if (!isDirection(direction) || directionIds.has(direction.directionId)) return false
    directionIds.add(direction.directionId)
    if (direction.recommended) recommendedCount += 1
  }
  const recommended = value.directions.find((direction) => direction.recommended)
  return recommendedCount === 1 && recommended?.directionId === value.recommendedDirectionId
}

export function pptDirectionBoardOps(
  bundle: PptDirectionBundle,
  shapes: readonly CanvasShape[] = [],
  parentThreadId?: string
): unknown[] {
  const byName = new Map(shapes.map((shape) => [shape.name, shape]))
  const specs = bundle.directions.flatMap((direction, column) =>
    directionSpecs(bundle, direction, column, parentThreadId))
  const expectedNames = new Set(specs.map((shape) => shape.name))
  const cleanup = shapes
    .filter((shape) => shape.pptDirectionRef?.workflowId === bundle.workflowId &&
      shape.pptDirectionRef.childId === bundle.childId && !expectedNames.has(shape.name))
    .map((shape) => ({ op: 'delete', id: shape.id }))
  const upserts = specs.map((shape) => {
    const existing = byName.get(shape.name)
    return existing
      ? { op: 'update', id: existing.id, patch: shapePatch(shape) }
      : { op: 'add', shape }
  })
  return [...cleanup, ...upserts]
}

export function pptDirectionCleanupOps(
  workflowId: string,
  childId: string,
  shapes: readonly CanvasShape[]
): unknown[] {
  return shapes
    .filter((shape) => shape.pptDirectionRef?.workflowId === workflowId &&
      shape.pptDirectionRef.childId === childId)
    .map((shape) => ({ op: 'delete', id: shape.id }))
}

export function serializeActivePptDirectionContexts(
  shapes: readonly CanvasShape[],
  selectedIds: ReadonlySet<string>,
  parentThreadId?: string
): SerializedPptDirectionContext[] {
  const directionShapes = shapes.filter((shape) => {
    const ref = shape.pptDirectionRef
    return ref && (!parentThreadId || ref.parentThreadId === parentThreadId)
  })
  const selected = new Map<string, NonNullable<CanvasShape['pptDirectionRef']>>()
  for (const shape of directionShapes) {
    const ref = shape.pptDirectionRef!
    if (!selectedIds.has(shape.id)) continue
    selected.set([ref.workflowId, ref.childId, ref.directionId, ref.revision].join('\0'), ref)
  }
  if (selected.size > 1) throw new Error('Select at most one PPT visual direction')

  const selectedRef = [...selected.values()][0]
  const workflows = new Map<string, { childId: string; revision: number }>()
  for (const shape of directionShapes) {
    const ref = shape.pptDirectionRef!
    const current = workflows.get(ref.workflowId)
    if (current && current.childId !== ref.childId) {
      throw new Error(`PPT direction workflow ${ref.workflowId} has conflicting child identities`)
    }
    workflows.set(ref.workflowId, {
      childId: ref.childId,
      revision: Math.max(current?.revision ?? 0, ref.revision)
    })
  }
  return [...workflows.entries()].map(([workflowId, workflow]) => ({
    workflowId,
    childId: workflow.childId,
    revision: workflow.revision,
    directions: selectedRef?.workflowId === workflowId && selectedRef.childId === workflow.childId
      ? [{ directionId: selectedRef.directionId, revision: selectedRef.revision }]
      : []
  }))
}

function directionSpecs(
  bundle: PptDirectionBundle,
  direction: PptDirectionCandidateBundle,
  column: number,
  parentThreadId?: string
): ShapeSpec[] {
  const x = column * (COLUMN_WIDTH + COLUMN_GAP)
  const key = directionKey(bundle.workflowId, direction.directionId)
  const ref = (role: NonNullable<CanvasShape['pptDirectionRef']>['role']) => ({
    workflowId: bundle.workflowId,
    childId: bundle.childId,
    directionId: direction.directionId,
    revision: direction.revision,
    ...(parentThreadId ? { parentThreadId } : {}),
    role
  })
  const summary = [
    `Fonts · ${direction.fonts.join(' / ')}`,
    `Layout · ${direction.layout}`,
    `Background · ${direction.background}`,
    `Imagery · ${direction.imagery}`
  ].join('\n')
  const specs: ShapeSpec[] = [{
    type: 'frame', name: `${key}:card`, x, y: 0, width: COLUMN_WIDTH, height: CARD_HEIGHT,
    fills: [{ type: 'solid', color: '#0B1220', opacity: 1 }],
    strokes: [{ color: direction.recommended ? '#34D399' : '#334155', width: direction.recommended ? 3 : 1,
      opacity: 1, position: 'inside' }],
    cornerRadius: 16, clipContent: true, pptDirectionRef: ref('direction-card')
  }, {
    type: 'text', name: `${key}:title`, x: x + 16, y: 16, width: COLUMN_WIDTH - 32, height: 30,
    textContent: `${direction.recommended ? '★ Recommended · ' : ''}${direction.name}`,
    fontSize: 20, fontWeight: 700, fontColor: direction.recommended ? '#6EE7B7' : '#F8FAFC',
    pptDirectionRef: ref('summary')
  }, {
    type: 'text', name: `${key}:rationale`, x: x + 16, y: 52, width: COLUMN_WIDTH - 32, height: 58,
    textContent: direction.rationale, fontSize: 13, lineHeight: 1.35, fontColor: '#CBD5E1',
    pptDirectionRef: ref('summary')
  }]

  for (const [index, preview] of direction.previews.entries()) {
    const previewY = PREVIEW_START_Y + index * PREVIEW_GAP
    specs.push({
      type: 'image', name: `${key}:preview:${preview.role}`, x: x + 16, y: previewY,
      width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT, imageUrl: preview.imagePath,
      cornerRadius: 8, pptDirectionRef: ref('preview-image')
    }, {
      type: 'text', name: `${key}:preview-label:${preview.role}`, x: x + 16, y: previewY + PREVIEW_HEIGHT + 8,
      width: PREVIEW_WIDTH, height: 20, textContent: PREVIEW_LABELS[preview.role],
      fontSize: 12, fontWeight: 600, fontColor: '#94A3B8', pptDirectionRef: ref('summary')
    })
  }

  const paletteY = 1_068
  const swatchWidth = Math.min(44, Math.floor((PREVIEW_WIDTH - 7 * 8) / Math.min(direction.colors.length, 8)))
  direction.colors.slice(0, 8).forEach((color, index) => specs.push({
    type: 'rect', name: `${key}:color:${index}`, x: x + 16 + index * (swatchWidth + 8), y: paletteY,
    width: swatchWidth, height: 24, fills: [{ type: 'solid', color, opacity: 1 }], cornerRadius: 6,
    pptDirectionRef: ref('summary')
  }))
  specs.push({
    type: 'text', name: `${key}:summary`, x: x + 16, y: 976, width: COLUMN_WIDTH - 32, height: 78,
    textContent: summary, fontSize: 12, lineHeight: 1.35, fontColor: '#CBD5E1',
    pptDirectionRef: ref('summary')
  }, {
    type: 'text', name: `${key}:palette`, x: x + 16, y: 1_100, width: COLUMN_WIDTH - 32, height: 38,
    textContent: `Palette · ${direction.colors.join('  ')}`, fontSize: 10, fontColor: '#94A3B8',
    pptDirectionRef: ref('summary')
  })
  return specs
}

function isDirection(value: unknown): value is PptDirectionCandidateBundle {
  if (!isRecord(value) || !nonEmptyString(value.directionId) || !nonEmptyString(value.name) ||
    !nonEmptyString(value.rationale) || !Number.isInteger(value.revision) || Number(value.revision) < 1 ||
    typeof value.recommended !== 'boolean' || !Array.isArray(value.fonts) || value.fonts.length < 2 ||
    value.fonts.some((font) => !nonEmptyString(font)) || !Array.isArray(value.colors) || value.colors.length < 4 ||
    value.colors.some((color) => typeof color !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(color)) ||
    !nonEmptyString(value.layout) || !nonEmptyString(value.background) || !nonEmptyString(value.imagery) ||
    !Array.isArray(value.previews) || value.previews.length !== 3) return false
  const roles = new Set<string>()
  for (const preview of value.previews) {
    if (!isRecord(preview) || (preview.role !== 'cover' && preview.role !== 'representative' && preview.role !== 'complex') ||
      !workspaceRelativePath(preview.imagePath) || roles.has(preview.role)) return false
    roles.add(preview.role)
  }
  return roles.size === 3
}

function directionKey(workflowId: string, directionId: string): string {
  return `ppt-direction:${workflowId}:${directionId}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function workspaceRelativePath(value: unknown): value is string {
  if (!nonEmptyString(value)) return false
  const path = value.replaceAll('\\', '/')
  return !path.startsWith('/') && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) && !path.split('/').includes('..')
}

function shapePatch(shape: ShapeSpec): Omit<ShapeSpec, 'type'> {
  const { type, ...patch } = shape
  void type
  return patch
}
