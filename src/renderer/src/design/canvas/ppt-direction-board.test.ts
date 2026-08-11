import { describe, expect, it } from 'vitest'
import { createDefaultShape, type CanvasShape } from './canvas-types'
import { ShapeOpSchema } from './shape-ops'
import {
  isPptDirectionBundle,
  pptDirectionBoardOps,
  pptDirectionCleanupOps,
  serializeActivePptDirectionContexts,
  type PptDirectionBundle
} from './ppt-direction-board'

const directionIds = ['editorial', 'signal', 'warm'] as const
const bundle: PptDirectionBundle = {
  schemaVersion: 1,
  workflowId: 'workflow-a',
  childId: 'child-a',
  manifestPath: 'deck/.kun-ppt-review/manifest.json',
  previewMode: 'image-first',
  deckTitle: 'Direction deck',
  phase: 'awaiting_direction',
  recommendedDirectionId: 'signal',
  slides: [{ slideId: 'slide-1', index: 0, title: 'Opening' }],
  directions: directionIds.map((directionId, index) => ({
    directionId,
    name: `${directionId} direction`,
    rationale: `A meaningfully distinct ${directionId} visual system for this deck.`,
    revision: 1,
    recommended: directionId === 'signal',
    fonts: [`Display ${index}`, `Body ${index}`],
    colors: ['#0F172A', '#F8FAFC', '#22C55E', '#F59E0B'],
    layout: `${index + 2}-column modular grid`,
    background: index === 0 ? 'paper' : 'solid',
    imagery: `${directionId} editorial photography`,
    previews: (['cover', 'representative', 'complex'] as const).map((role) => ({
      role,
      imagePath: `.kun/images/${directionId}-${role}.png`
    }))
  }))
}

function materialize(ops: unknown[]): CanvasShape[] {
  return ops.flatMap((value, index) => {
    const op = value as { op: string; shape?: Partial<CanvasShape> & Pick<CanvasShape, 'type' | 'name'> }
    if (op.op !== 'add' || !op.shape) return []
    return [{ ...createDefaultShape(op.shape.type, 0, 0), ...op.shape, id: `shape-${index}` } as CanvasShape]
  })
}

describe('PPT visual direction board', () => {
  it('accepts only a fenced three-direction bundle with one recommendation and safe previews', () => {
    expect(isPptDirectionBundle(bundle)).toBe(true)
    expect(isPptDirectionBundle({ ...bundle, phase: 'awaiting_review' })).toBe(false)
    expect(isPptDirectionBundle({ ...bundle, recommendedDirectionId: 'editorial' })).toBe(false)
    expect(isPptDirectionBundle({
      ...bundle,
      directions: bundle.directions.map((direction) => ({ ...direction, recommended: true }))
    })).toBe(false)
    expect(isPptDirectionBundle({
      ...bundle,
      directions: bundle.directions.map((direction, index) => index === 0
        ? { ...direction, previews: direction.previews.map((preview) => ({ ...preview, imagePath: '/outside.png' })) }
        : direction)
    })).toBe(false)
  })

  it('lays out three columns with three 16:9 previews and visual-system summaries', () => {
    const ops = pptDirectionBoardOps(bundle, [], 'thread-a')
    expect(ops.every((op) => ShapeOpSchema.safeParse(op).success)).toBe(true)
    const shapes = materialize(ops)
    const cards = shapes.filter((shape) => shape.pptDirectionRef?.role === 'direction-card')
    const previews = shapes.filter((shape) => shape.pptDirectionRef?.role === 'preview-image')
    expect(cards.map((shape) => shape.x)).toEqual([0, 504, 1_008])
    expect(previews).toHaveLength(9)
    expect(previews.every((shape) => shape.width / shape.height > 1.77 && shape.width / shape.height < 1.78)).toBe(true)
    expect(shapes.find((shape) => shape.name.endsWith(':signal:title'))?.textContent).toContain('Recommended')
    const summary = shapes.find((shape) => shape.name.endsWith(':editorial:summary'))?.textContent
    expect(summary).toContain('Fonts · Display 0 / Body 0')
    expect(summary).toContain('Layout · 2-column modular grid')
    expect(summary).toContain('Background · paper')
    expect(summary).toContain('Imagery · editorial editorial photography')
    expect(shapes.filter((shape) => shape.name.includes(':color:'))).toHaveLength(12)
  })

  it('updates stable layers in place and deletes stale direction layers on revision', () => {
    const initial = materialize(pptDirectionBoardOps(bundle, [], 'thread-a'))
    const revised: PptDirectionBundle = {
      ...bundle,
      directions: bundle.directions.map((direction, index) => index === 0
        ? {
            ...direction,
            directionId: 'editorial-v2',
            revision: 2,
            previews: direction.previews.map((preview) => ({
              ...preview,
              imagePath: `.kun/images/editorial-v2-${preview.role}.png`
            }))
          }
        : direction)
    }
    const ops = pptDirectionBoardOps(revised, initial, 'thread-a') as Array<{
      op: string; id?: string; shape?: Partial<CanvasShape>; patch?: Partial<CanvasShape>
    }>
    const staleIds = new Set(initial
      .filter((shape) => shape.pptDirectionRef?.directionId === 'editorial')
      .map((shape) => shape.id))
    expect(ops.filter((op) => op.op === 'delete').map((op) => op.id).every((id) => staleIds.has(id!))).toBe(true)
    expect(ops.filter((op) => op.op === 'add' && op.shape?.pptDirectionRef?.directionId === 'editorial-v2').length)
      .toBeGreaterThan(0)
    expect(ops.filter((op) => op.op === 'update').length).toBeGreaterThan(0)
  })

  it('removes only the matching direction workflow when slide review begins', () => {
    const shapes = materialize(pptDirectionBoardOps(bundle, [], 'thread-a'))
    const unrelated = shapes.map((shape) => ({
      ...shape,
      id: `other-${shape.id}`,
      pptDirectionRef: shape.pptDirectionRef
        ? { ...shape.pptDirectionRef, workflowId: 'other-workflow' }
        : undefined
    }))
    expect(pptDirectionCleanupOps(bundle.workflowId, bundle.childId, [...shapes, ...unrelated]))
      .toHaveLength(shapes.length)
  })

  it('serializes only the uniquely selected direction and keeps host identity fences', () => {
    const shapes = materialize(pptDirectionBoardOps(bundle, [], 'thread-a'))
    const selectedLayers = shapes.filter((shape) => shape.pptDirectionRef?.directionId === 'signal').slice(0, 2)
    expect(serializeActivePptDirectionContexts(
      shapes, new Set(selectedLayers.map((shape) => shape.id)), 'thread-a'
    )).toEqual([{
      workflowId: 'workflow-a',
      childId: 'child-a',
      revision: 1,
      directions: [{ directionId: 'signal', revision: 1 }]
    }])
    expect(serializeActivePptDirectionContexts(shapes, new Set(), 'thread-a')[0].directions).toEqual([])
    expect(serializeActivePptDirectionContexts(shapes, new Set(), 'thread-b')).toEqual([])
  })

  it('rejects multiple unique directions and preserves stale revisions for runtime rejection', () => {
    const shapes = materialize(pptDirectionBoardOps(bundle, [], 'thread-a'))
    const editorial = shapes.find((shape) => shape.pptDirectionRef?.directionId === 'editorial')!
    const signal = shapes.find((shape) => shape.pptDirectionRef?.directionId === 'signal')!
    expect(() => serializeActivePptDirectionContexts(
      shapes, new Set([editorial.id, signal.id]), 'thread-a'
    )).toThrow('at most one')

    editorial.pptDirectionRef = { ...editorial.pptDirectionRef!, revision: 99 }
    expect(serializeActivePptDirectionContexts(shapes, new Set([editorial.id]), 'thread-a')[0].directions)
      .toEqual([{ directionId: 'editorial', revision: 99 }])
  })
})
