import type { CanvasShape } from './canvas-types'

export type PptReviewSlideBundle = {
  slideId: string
  index: number
  title: string
  previewPath?: string
  revision: number
  status: 'ready' | 'failed'
  error?: string
}

export type PptReviewBundle = {
  workflowId: string
  childId: string
  manifestPath: string
  deckTitle: string
  styleFingerprint: string
  phase: string
  slides: PptReviewSlideBundle[]
}

const CARD_WIDTH = 480
const CARD_HEIGHT = 270
const CARD_GAP_X = 56
const CARD_GAP_Y = 88
const COLUMNS = 3

export function isPptReviewBundle(value: unknown): value is PptReviewBundle {
  if (!isRecord(value) || !Array.isArray(value.slides)) return false
  if (
    !nonEmptyString(value.workflowId) ||
    !nonEmptyString(value.childId) ||
    !workspaceRelativePath(value.manifestPath) ||
    !nonEmptyString(value.deckTitle) ||
    !nonEmptyString(value.styleFingerprint) ||
    value.phase !== 'awaiting_review' ||
    value.slides.length === 0
  ) return false
  const slideIds = new Set<string>()
  const indexes = new Set<number>()
  for (const slide of value.slides) {
    if (
      !isRecord(slide) ||
      !nonEmptyString(slide.slideId) ||
      !Number.isInteger(slide.index) ||
      Number(slide.index) < 0 ||
      !nonEmptyString(slide.title) ||
      !Number.isInteger(slide.revision) ||
      Number(slide.revision) < 0 ||
      (slide.status !== 'ready' && slide.status !== 'failed') ||
      (slide.status === 'ready' && !workspaceRelativePath(slide.previewPath)) ||
      slideIds.has(slide.slideId) ||
      indexes.has(Number(slide.index))
    ) return false
    slideIds.add(slide.slideId)
    indexes.add(Number(slide.index))
  }
  for (let index = 0; index < value.slides.length; index += 1) {
    if (!indexes.has(index)) return false
  }
  return true
}

export function pptReviewBoardOps(
  bundle: PptReviewBundle,
  shapes: readonly CanvasShape[] = [],
  parentThreadId?: string
): unknown[] {
  const byName = new Map(shapes.map((shape) => [shape.name, shape]))
  return bundle.slides.flatMap((slide): unknown[] => {
    const col = slide.index % COLUMNS
    const row = Math.floor(slide.index / COLUMNS)
    const x = col * (CARD_WIDTH + CARD_GAP_X)
    const y = row * (CARD_HEIGHT + CARD_GAP_Y)
    const key = reviewKey(bundle.workflowId, slide.slideId)
    const label = `P${slide.index + 1} · ${slide.title}`
    const status = slide.status === 'failed'
      ? `Preview failed${slide.error ? `: ${slide.error}` : ''}`
      : `Revision ${slide.revision} · visual review`
    const frame = byName.get(`${key}:frame`)
    const preview = byName.get(`${key}:preview`)
    const title = byName.get(`${key}:title`)
    const statusLabel = byName.get(`${key}:status`)
    const frameShape = {
      type: 'frame',
      name: `${key}:frame`,
      x,
      y,
      width: CARD_WIDTH,
      height: CARD_HEIGHT + 48,
      fills: [{ type: 'solid', color: '#111827', opacity: 1 }],
      cornerRadius: 12,
      clipContent: true,
      pptReviewRef: reviewRef(bundle, slide, 'slide-frame', parentThreadId)
    }
    const previewShape = {
      type: 'image',
      name: `${key}:preview`,
      x: x + 8,
      y: y + 8,
      width: CARD_WIDTH - 16,
      height: CARD_HEIGHT - 16,
      imageUrl: slide.previewPath ?? '',
      opacity: slide.status === 'failed' ? 0.2 : 1,
      pptReviewRef: reviewRef(bundle, slide, 'preview-image', parentThreadId)
    }
    const titleShape = {
      type: 'text',
      name: `${key}:title`,
      x: x + 12,
      y: y + CARD_HEIGHT + 2,
      width: CARD_WIDTH - 24,
      height: 20,
      textContent: label,
      fontSize: 15,
      fontWeight: 700,
      fontColor: '#F9FAFB'
    }
    const statusShape = {
      type: 'text',
      name: `${key}:status`,
      x: x + 12,
      y: y + CARD_HEIGHT + 23,
      width: CARD_WIDTH - 24,
      height: 18,
      textContent: status,
      fontSize: 12,
      fontColor: slide.status === 'failed' ? '#FCA5A5' : '#9CA3AF'
    }
    const framePatch = shapePatch(frameShape)
    const previewPatch = shapePatch(previewShape)
    const titlePatch = shapePatch(titleShape)
    const statusPatch = shapePatch(statusShape)
    return [
      frame
        ? { op: 'update', id: frame.id, patch: framePatch }
        : {
        op: 'add',
        shape: frameShape
      },
      preview
        ? { op: 'update', id: preview.id, patch: previewPatch }
        : {
        op: 'add',
        shape: previewShape
      },
      title
        ? { op: 'update', id: title.id, patch: titlePatch }
        : {
        op: 'add',
        shape: titleShape
      },
      statusLabel
        ? { op: 'update', id: statusLabel.id, patch: statusPatch }
        : {
        op: 'add',
        shape: statusShape
      }
    ]
  })
}

export type SerializedPptReviewContext = {
  workflowId: string
  childId: string
  slides: Array<{ slideId: string; revision: number; imagePath?: string; annotations?: string[] }>
}

export function serializeActivePptReviewContexts(
  shapes: readonly CanvasShape[],
  parentThreadId?: string
): SerializedPptReviewContext[] {
  const workflows = new Map<string, { childId: string; slides: Map<string, { frame?: CanvasShape; preview?: CanvasShape }> }>()
  for (const shape of shapes) {
    const ref = shape.pptReviewRef
    if (!ref || ref.role === 'annotation' || (parentThreadId && ref.parentThreadId !== parentThreadId)) continue
    const workflow = workflows.get(ref.workflowId) ?? { childId: ref.childId, slides: new Map() }
    const slide = workflow.slides.get(ref.slideId) ?? {}
    if (ref.role === 'slide-frame') slide.frame = shape
    if (ref.role === 'preview-image') slide.preview = shape
    workflow.slides.set(ref.slideId, slide)
    workflows.set(ref.workflowId, workflow)
  }
  return [...workflows.entries()].map(([workflowId, workflow]) => ({
    workflowId,
    childId: workflow.childId,
    slides: [...workflow.slides.entries()].map(([slideId, slide]) => {
      const revision = slide.preview?.pptReviewRef?.revision ?? slide.frame?.pptReviewRef?.revision ?? 0
      const annotations = slide.frame
        ? shapes
            .filter((shape) => shape.type === 'text' &&
              !shape.name.endsWith(':title') &&
              !shape.name.endsWith(':status') &&
              shape.x >= slide.frame!.x &&
              shape.y >= slide.frame!.y &&
              shape.x + shape.width <= slide.frame!.x + slide.frame!.width &&
              shape.y + shape.height <= slide.frame!.y + slide.frame!.height)
            .map((shape) => shape.textContent?.trim() ?? '')
            .filter(Boolean)
        : []
      return {
        slideId,
        revision,
        ...(slide.preview?.type === 'image' && slide.preview.imageUrl ? { imagePath: slide.preview.imageUrl } : {}),
        ...(annotations.length ? { annotations } : {})
      }
    })
  }))
}

export function serializePptReviewContext(
  bundle: PptReviewBundle,
  shapes: readonly CanvasShape[],
  userFeedback = ''
): { workflowId: string; slides: Array<{ slideId: string; revision: number; feedback?: string; annotations?: string[]; imagePath?: string }> } {
  const byName = new Map(shapes.map((shape) => [shape.name, shape]))
  return {
    workflowId: bundle.workflowId,
    slides: bundle.slides.map((slide) => {
      const prefix = `${reviewKey(bundle.workflowId, slide.slideId)}:`
      const annotations = shapes
        .filter((shape) => shape.name.startsWith(prefix) && shape.type === 'text' && !shape.name.endsWith(':title') && !shape.name.endsWith(':status'))
        .map((shape) => shape.textContent?.trim() ?? '')
        .filter(Boolean)
      const image = byName.get(`${prefix}preview`)
      return {
        slideId: slide.slideId,
        revision: slide.revision,
        ...(userFeedback.trim() ? { feedback: userFeedback.trim() } : {}),
        ...(annotations.length ? { annotations } : {}),
        ...(image?.type === 'image' && image.imageUrl ? { imagePath: image.imageUrl } : {})
      }
    })
  }
}

function reviewRef(
  bundle: PptReviewBundle,
  slide: PptReviewSlideBundle,
  role: 'slide-frame' | 'preview-image',
  parentThreadId?: string
): NonNullable<CanvasShape['pptReviewRef']> {
  return {
    workflowId: bundle.workflowId,
    childId: bundle.childId,
    slideId: slide.slideId,
    revision: slide.revision,
    ...(parentThreadId ? { parentThreadId } : {}),
    role
  }
}

function reviewKey(workflowId: string, slideId: string): string {
  return `ppt-review:${workflowId}:${slideId}`
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
  return !path.startsWith('/') &&
    !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) &&
    !path.split('/').includes('..')
}

function shapePatch<T extends { type: string }>(shape: T): Omit<T, 'type'> {
  const { type, ...patch } = shape
  void type
  return patch
}
