import { describe, expect, it, beforeEach } from 'vitest'
import { executeOps } from './shape-ops'
import { useCanvasShapeStore } from './canvas-shape-store'
import { useCanvasUndoStore } from './canvas-undo-store'
import { useCanvasSelectionStore } from './canvas-selection-store'
import { createDefaultShape, createEmptyDocument, createSvgFrameShape } from './canvas-types'

beforeEach(() => {
  useCanvasShapeStore.getState().loadDocument(createEmptyDocument())
  useCanvasUndoStore.getState().clear()
  useCanvasSelectionStore.getState().clearSelection()
})

describe('executeOps validation', () => {
  it('rejects an op with unknown discriminator', () => {
    const result = executeOps([{ op: 'noSuchOp' }])
    expect(result.ok).toBe(false)
    expect(result.errors[0].code).toBe('INVALID_OP')
  })

  it('rejects an add op with missing required shape.type', () => {
    const result = executeOps([{ op: 'add', shape: {} }])
    expect(result.ok).toBe(false)
    expect(result.errors[0].code).toBe('INVALID_OP')
  })
})

describe('executeOps execution', () => {
  it('add op creates a shape and returns its id', () => {
    const r = executeOps([{ op: 'add', shape: { type: 'rect', x: 0, y: 0, width: 50, height: 50 } }])
    expect(r.ok).toBe(true)
    expect(r.affectedIds).toHaveLength(1)
    const added = useCanvasShapeStore.getState().document.objects[r.affectedIds[0]]
    expect(added?.type).toBe('rect')
    expect(added?.width).toBe(50)
  })

  it('add op can create structured agent note shapes', () => {
    const r = executeOps(
      [
        {
          op: 'add',
          shape: {
            type: 'text',
            name: 'Critique note',
            x: 24,
            y: 36,
            width: 280,
            height: 96,
            textContent: 'Critique: Primary CTA is hard to find.',
            agentNote: {
              kind: 'critique',
              body: 'Primary CTA is hard to find.',
              source: 'critic',
              severity: 'warning',
              targetIds: ['hero']
            }
          }
        }
      ],
      'agent-note'
    )

    const doc = useCanvasShapeStore.getState().document
    const added = doc.objects[r.affectedIds[0]]
    expect(r.ok).toBe(true)
    expect(added).toMatchObject({
      type: 'text',
      agentNote: {
        kind: 'critique',
        body: 'Primary CTA is hard to find.',
        targetIds: ['hero']
      }
    })
    expect(doc.operationJournal?.[0].operations[0]).toMatchObject({
      type: 'create_shape',
      label: 'agent-note'
    })
  })

  it('add op can create running app portal frames', () => {
    const r = executeOps([
      {
        op: 'add',
        shape: {
          type: 'frame',
          name: 'Orders app',
          x: 0,
          y: 0,
          width: 1280,
          height: 800,
          runningApp: {
            url: 'localhost:5173/orders',
            title: 'Orders app',
            routePath: '/orders',
            sourceFile: 'src/app/orders/page.tsx'
          }
        }
      }
    ])

    const doc = useCanvasShapeStore.getState().document
    const added = doc.objects[r.affectedIds[0]]
    expect(r.ok).toBe(true)
    expect(added).toMatchObject({
      type: 'frame',
      clipContent: true,
      runningApp: {
        url: 'http://localhost:5173/orders',
        title: 'Orders app',
        routePath: '/orders'
      }
    })
  })

  it('rejects running app metadata on non-frame shapes', () => {
    const r = executeOps([
      {
        op: 'add',
        shape: {
          type: 'rect',
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          runningApp: { url: 'localhost:5173' }
        }
      }
    ])

    expect(r.ok).toBe(false)
    expect(r.errors[0]).toMatchObject({
      code: 'UNSUPPORTED_TYPE',
      message: 'runningApp can only be attached to frame shapes'
    })
  })

  it('records executed batches in the canvas operation journal', () => {
    const r = executeOps(
      [{ op: 'add', shape: { type: 'rect', name: 'Card', x: 0, y: 0, width: 50, height: 50 } }],
      'agent-add-card'
    )

    const doc = useCanvasShapeStore.getState().document
    expect(r.ok).toBe(true)
    expect(doc.graph?.lastJournalEntryId).toBe(doc.operationJournal?.[0].id)
    expect(doc.operationJournal?.[0]).toMatchObject({
      label: 'agent-add-card',
      status: 'applied',
      affectedIds: r.affectedIds
    })
    expect(doc.operationJournal?.[0].operations[0]).toMatchObject({
      type: 'create_shape',
      source: 'agent'
    })
  })

  it('uses a persisted replay key to avoid duplicating renderer-applied shapes', () => {
    const ops = [
      { op: 'add', shape: { type: 'rect', name: 'Replay card', x: 0, y: 0, width: 80, height: 40 } }
    ]
    const first = executeOps(ops, 'durable-replay', { replayKey: 'thread\0turn\0doc\0tool' })
    const second = executeOps(ops, 'durable-replay', { replayKey: 'thread\0turn\0doc\0tool' })

    expect(second).toEqual(first)
    expect(useCanvasShapeStore.getState().document.operationJournal).toHaveLength(1)
    expect(useCanvasShapeStore.getState().document.rendererReplayKeys).toEqual([
      'thread\0turn\0doc\0tool'
    ])
    const compacted = useCanvasShapeStore.getState().document
    useCanvasShapeStore.getState().loadDocument({ ...compacted, operationJournal: [] })
    expect(executeOps(ops, 'durable-replay', {
      replayKey: 'thread\0turn\0doc\0tool'
    }).affectedIds).toEqual([])
    expect(useCanvasShapeStore.getState().document.objects[useCanvasShapeStore.getState().document.rootId]
      .children).toHaveLength(1)
  })

  it('add + update is one undo entry (atomic batch)', () => {
    const initial = useCanvasUndoStore.getState().undoStack.length
    const r = executeOps([
      { op: 'add', shape: { type: 'rect', x: 0, y: 0, width: 10, height: 10 } }
    ])
    // The first batch becomes one undo entry
    expect(useCanvasUndoStore.getState().undoStack.length).toBe(initial + 1)

    const id = r.affectedIds[0]
    const r2 = executeOps([
      { op: 'update', id, patch: { x: 100 } },
      { op: 'update', id, patch: { y: 200 } }
    ])
    expect(r2.ok).toBe(true)
    // Two updates wrapped in one batch = one new undo entry
    expect(useCanvasUndoStore.getState().undoStack.length).toBe(initial + 2)
  })

  it('update on missing shape returns a structured error with suggestion', () => {
    const r = executeOps([{ op: 'update', id: 'nope', patch: { x: 5 } }])
    expect(r.ok).toBe(false)
    expect(r.errors[0].code).toBe('SHAPE_NOT_FOUND')
    expect(r.errors[0].suggestion).toBeDefined()
  })

  it('move op shifts multiple shapes by dx/dy', () => {
    const r1 = executeOps([
      { op: 'add', shape: { type: 'rect', x: 0, y: 0, width: 10, height: 10 } },
      { op: 'add', shape: { type: 'rect', x: 50, y: 50, width: 10, height: 10 } }
    ])
    const [a, b] = r1.affectedIds
    const r2 = executeOps([{ op: 'move', ids: [a, b], dx: 5, dy: 5 }])
    expect(r2.ok).toBe(true)
    const doc = useCanvasShapeStore.getState().document
    expect(doc.objects[a].x).toBe(5)
    expect(doc.objects[b].x).toBe(55)
  })

  it('move op carries a frame’s descendants along (absolute child coords)', () => {
    const rf = executeOps([
      { op: 'add', shape: { type: 'frame', x: 100, y: 100, width: 200, height: 200 } }
    ])
    const frameId = rf.affectedIds[0]
    const rc = executeOps([
      { op: 'add', shape: { type: 'rect', x: 120, y: 130, width: 40, height: 40 }, parentId: frameId }
    ])
    const childId = rc.affectedIds[0]

    const r = executeOps([{ op: 'move', ids: [frameId], dx: 50, dy: 30 }])
    expect(r.ok).toBe(true)
    // Only the frame was named, but the child moved with it.
    expect(r.affectedIds).toContain(childId)
    const doc = useCanvasShapeStore.getState().document
    expect(doc.objects[frameId].x).toBe(150)
    expect(doc.objects[frameId].y).toBe(130)
    expect(doc.objects[childId].x).toBe(170)
    expect(doc.objects[childId].y).toBe(160)
  })

  it('move op moves a parent+child selection only once each (no double-shift)', () => {
    const rf = executeOps([
      { op: 'add', shape: { type: 'frame', x: 0, y: 0, width: 100, height: 100 } }
    ])
    const frameId = rf.affectedIds[0]
    const rc = executeOps([
      { op: 'add', shape: { type: 'rect', x: 10, y: 10, width: 20, height: 20 }, parentId: frameId }
    ])
    const childId = rc.affectedIds[0]
    // Name both the frame and its child — the child must still shift by exactly dx/dy.
    executeOps([{ op: 'move', ids: [frameId, childId], dx: 5, dy: 5 }])
    const doc = useCanvasShapeStore.getState().document
    expect(doc.objects[childId].x).toBe(15)
    expect(doc.objects[childId].y).toBe(15)
  })

  it('align op repositions multiple shapes', () => {
    const r1 = executeOps([
      { op: 'add', shape: { type: 'rect', x: 0, y: 0, width: 10, height: 10 } },
      { op: 'add', shape: { type: 'rect', x: 50, y: 30, width: 20, height: 20 } }
    ])
    const [a, b] = r1.affectedIds
    const r2 = executeOps([{ op: 'align', ids: [a, b], axis: 'top' }])
    expect(r2.ok).toBe(true)
    const doc = useCanvasShapeStore.getState().document
    expect(doc.objects[a].y).toBe(doc.objects[b].y)
  })

  it('distribute requires ≥3 shapes', () => {
    const r1 = executeOps([
      { op: 'add', shape: { type: 'rect', x: 0, y: 0, width: 10, height: 10 } },
      { op: 'add', shape: { type: 'rect', x: 50, y: 0, width: 10, height: 10 } }
    ])
    const [a, b] = r1.affectedIds
    // Schema gate: distribute with 2 ids fails validation
    const r2 = executeOps([{ op: 'distribute', ids: [a, b], axis: 'horizontal' }])
    expect(r2.ok).toBe(false)
    expect(r2.errors[0].code).toBe('INVALID_OP')
  })

  it('delete removes the shape and reports the affected id', () => {
    const r1 = executeOps([{ op: 'add', shape: { type: 'rect', x: 0, y: 0, width: 10, height: 10 } }])
    const id = r1.affectedIds[0]
    const r2 = executeOps([{ op: 'delete', id }])
    expect(r2.ok).toBe(true)
    expect(useCanvasShapeStore.getState().document.objects[id]).toBeUndefined()
  })
})

describe('set-style batch op', () => {
  it('applies one style to many shapes at once', () => {
    const r1 = executeOps([
      { op: 'add', shape: { type: 'rect', x: 0, y: 0, width: 10, height: 10 } },
      { op: 'add', shape: { type: 'rect', x: 50, y: 0, width: 10, height: 10 } }
    ])
    const [a, b] = r1.affectedIds
    const r2 = executeOps([
      {
        op: 'set-style',
        ids: [a, b],
        style: {
          fills: [{ type: 'solid', color: '#3b82d8', opacity: 1 }],
          shadows: [{ x: 0, y: 4, blur: 12, color: '#0f172a', opacity: 0.2 }]
        }
      }
    ])
    expect(r2.ok).toBe(true)
    const doc = useCanvasShapeStore.getState().document
    for (const id of [a, b]) {
      const fill = doc.objects[id].fills[0]
      expect(fill.type === 'solid' && fill.color).toBe('#3b82d8')
      expect(doc.objects[id].shadows?.[0].blur).toBe(12)
    }
  })

  it('reports missing ids but styles the present ones', () => {
    const r1 = executeOps([{ op: 'add', shape: { type: 'rect', x: 0, y: 0, width: 10, height: 10 } }])
    const a = r1.affectedIds[0]
    const r2 = executeOps([
      { op: 'set-style', ids: [a, 'ghost'], style: { opacity: 0.5 } }
    ])
    expect(r2.errors.some((e) => e.code === 'SHAPE_NOT_FOUND')).toBe(true)
    expect(useCanvasShapeStore.getState().document.objects[a].opacity).toBe(0.5)
  })
})

describe('gradient fills', () => {
  it('accepts a linear gradient fill on add', () => {
    const r = executeOps([
      {
        op: 'add',
        shape: {
          type: 'rect',
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          fills: [
            {
              type: 'linear',
              angle: 90,
              opacity: 1,
              stops: [
                { offset: 0, color: '#6366f1' },
                { offset: 1, color: '#8b5cf6' }
              ]
            }
          ]
        }
      }
    ])
    expect(r.ok).toBe(true)
    const fill = useCanvasShapeStore.getState().document.objects[r.affectedIds[0]].fills[0]
    expect(fill.type).toBe('linear')
  })

  it('rejects a gradient with fewer than 2 stops', () => {
    const r = executeOps([
      {
        op: 'add',
        shape: {
          type: 'rect',
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          fills: [{ type: 'linear', opacity: 1, stops: [{ offset: 0, color: '#fff' }] }]
        }
      }
    ])
    expect(r.ok).toBe(false)
    expect(r.errors[0].code).toBe('INVALID_OP')
  })
})

describe('group / ungroup ops', () => {
  it('keeps artifact portals root-level instead of grouping them', () => {
    const store = useCanvasShapeStore.getState()
    const svg = createSvgFrameShape('Motion', 0, 0, 'svg-artifact')
    store.addShape(svg)
    const added = executeOps([
      { op: 'add', shape: { type: 'rect', x: 100, y: 100, width: 50, height: 50 } }
    ])

    const grouped = executeOps([{ op: 'group', ids: [svg.id, added.affectedIds[0]] }])

    expect(grouped.ok).toBe(false)
    const document = useCanvasShapeStore.getState().document
    expect(document.objects[svg.id].parentId).toBe(document.rootId)
    expect(document.objects[document.rootId].children).toContain(svg.id)
    expect(Object.values(document.objects).some((shape) => shape.type === 'group')).toBe(false)
  })

  it('rejects direct drag-style reparenting of an artifact portal', () => {
    const store = useCanvasShapeStore.getState()
    const svg = createSvgFrameShape('Motion', 0, 0, 'svg-artifact')
    const group = createDefaultShape('group', 0, 0)
    store.addShape(svg)
    store.addShape(group)

    store.reparentShape(svg.id, group.id)

    const document = useCanvasShapeStore.getState().document
    expect(document.objects[svg.id].parentId).toBe(document.rootId)
    expect(document.objects[group.id].children).not.toContain(svg.id)
    expect(document.objects[document.rootId].children).toContain(svg.id)
  })

  it('reports an invalid ShapeOp when reparenting an artifact portal below root', () => {
    const store = useCanvasShapeStore.getState()
    const svg = createSvgFrameShape('Motion', 0, 0, 'svg-artifact')
    const group = createDefaultShape('group', 0, 0)
    store.addShape(svg)
    store.addShape(group)

    const result = executeOps([{ op: 'reparent', id: svg.id, newParentId: group.id }])

    expect(result.ok).toBe(false)
    expect(result.errors[0]).toMatchObject({ code: 'INVALID_OP' })
    expect(useCanvasShapeStore.getState().document.objects[svg.id].parentId).toBe(
      useCanvasShapeStore.getState().document.rootId
    )
  })

  it('reports an invalid ShapeOp instead of creating a parent cycle', () => {
    const store = useCanvasShapeStore.getState()
    const frame = createDefaultShape('frame', 0, 0)
    const group = createDefaultShape('group', 20, 20)
    store.addShape(frame)
    store.addShape(group, frame.id)
    useCanvasUndoStore.getState().clear()

    const result = executeOps([{ op: 'reparent', id: frame.id, newParentId: group.id }])

    expect(result.ok).toBe(false)
    expect(result.errors[0]).toMatchObject({ code: 'INVALID_OP' })
    expect(useCanvasShapeStore.getState().document.objects[frame.id].parentId).toBe(
      useCanvasShapeStore.getState().document.rootId
    )
    expect(useCanvasUndoStore.getState().undoStack).toHaveLength(0)
  })

  it('groups shapes, wrapping them in a group sized to their bounds', () => {
    const r1 = executeOps([
      { op: 'add', shape: { type: 'rect', x: 0, y: 0, width: 50, height: 50 } },
      { op: 'add', shape: { type: 'rect', x: 100, y: 100, width: 50, height: 50 } }
    ])
    const [a, b] = r1.affectedIds
    const r2 = executeOps([{ op: 'group', ids: [a, b], name: 'Card' }])
    expect(r2.ok).toBe(true)
    const doc = useCanvasShapeStore.getState().document
    const groupId = r2.affectedIds.find((id) => doc.objects[id]?.type === 'group')
    expect(groupId).toBeDefined()
    const group = doc.objects[groupId!]
    expect(group.width).toBe(150)
    expect(group.height).toBe(150)
    // Members now parented under the group.
    expect(doc.objects[a].parentId).toBe(groupId)
    expect(doc.objects[b].parentId).toBe(groupId)
  })

  it('keeps diagram styling when grouping nodes into a frame', () => {
    const added = executeOps([
      { op: 'add', shape: { type: 'rect', x: 0, y: 0, width: 50, height: 50 } },
      { op: 'add', shape: { type: 'rect', x: 80, y: 0, width: 50, height: 50 } }
    ], 'diagram-add', { shapePreset: 'diagram' })
    const grouped = executeOps([
      { op: 'group', ids: added.affectedIds, name: 'Services', asFrame: true }
    ], 'diagram-group', { shapePreset: 'diagram' })
    const doc = useCanvasShapeStore.getState().document
    const frame = grouped.affectedIds
      .map((id) => doc.objects[id])
      .find((shape) => shape?.type === 'frame')

    expect(frame?.fills).toEqual([])
    expect(frame?.cornerRadius).toBe(16)
    expect(frame?.strokes[0]).toMatchObject({ color: 'currentColor', dash: 'dashed' })
  })

  it('ungroup lifts children back to the grandparent and deletes the group', () => {
    const r1 = executeOps([
      { op: 'add', shape: { type: 'rect', x: 0, y: 0, width: 50, height: 50 } },
      { op: 'add', shape: { type: 'rect', x: 100, y: 100, width: 50, height: 50 } }
    ])
    const [a, b] = r1.affectedIds
    const rg = executeOps([{ op: 'group', ids: [a, b] }])
    const doc1 = useCanvasShapeStore.getState().document
    const groupId = rg.affectedIds.find((id) => doc1.objects[id]?.type === 'group')!
    const ru = executeOps([{ op: 'ungroup', id: groupId }])
    expect(ru.ok).toBe(true)
    const doc = useCanvasShapeStore.getState().document
    expect(doc.objects[groupId]).toBeUndefined()
    expect(doc.objects[a].parentId).toBe(doc.rootId)
    expect(doc.objects[b].parentId).toBe(doc.rootId)
  })
})

describe('auto-layout op', () => {
  it('sets a layout and reflows the frame children', () => {
    const rf = executeOps([
      { op: 'add', shape: { type: 'frame', x: 0, y: 0, width: 200, height: 400 } }
    ])
    const frameId = rf.affectedIds[0]
    executeOps([
      { op: 'add', shape: { type: 'rect', x: 999, y: 999, width: 50, height: 30 }, parentId: frameId },
      { op: 'add', shape: { type: 'rect', x: 999, y: 999, width: 50, height: 40 }, parentId: frameId }
    ])
    const r = executeOps([
      {
        op: 'auto-layout',
        id: frameId,
        layout: { direction: 'vertical', gap: 10, padding: 16 }
      }
    ])
    expect(r.ok).toBe(true)
    const doc = useCanvasShapeStore.getState().document
    const [c1, c2] = doc.objects[frameId].children
    expect(doc.objects[c1].x).toBe(16)
    expect(doc.objects[c1].y).toBe(16)
    expect(doc.objects[c2].y).toBe(56) // 16 + 30 + 10
  })

  it('rejects auto-layout on a non-container shape', () => {
    const rr = executeOps([{ op: 'add', shape: { type: 'rect', x: 0, y: 0, width: 10, height: 10 } }])
    const r = executeOps([{ op: 'auto-layout', id: rr.affectedIds[0], layout: { direction: 'horizontal' } }])
    expect(r.ok).toBe(false)
    expect(r.errors[0].code).toBe('UNSUPPORTED_TYPE')
  })

  it('adding a child to a laid-out frame reflows it automatically', () => {
    const rf = executeOps([
      { op: 'add', shape: { type: 'frame', x: 0, y: 0, width: 200, height: 400 } }
    ])
    const frameId = rf.affectedIds[0]
    executeOps([{ op: 'auto-layout', id: frameId, layout: { direction: 'vertical', gap: 8, padding: 10 } }])
    const ra = executeOps([
      { op: 'add', shape: { type: 'rect', x: 500, y: 500, width: 40, height: 20 }, parentId: frameId }
    ])
    const childId = ra.affectedIds.find((id) => {
      const s = useCanvasShapeStore.getState().document.objects[id]
      return s?.type === 'rect'
    })!
    const doc = useCanvasShapeStore.getState().document
    expect(doc.objects[childId].x).toBe(10)
    expect(doc.objects[childId].y).toBe(10)
  })
})

describe('resize honors child constraints', () => {
  it('a right-constrained child sticks to the frame’s right edge on resize', () => {
    const rf = executeOps([
      { op: 'add', shape: { type: 'frame', x: 0, y: 0, width: 200, height: 200 } }
    ])
    const frameId = rf.affectedIds[0]
    const rc = executeOps([
      {
        op: 'add',
        shape: { type: 'rect', x: 130, y: 10, width: 50, height: 50, constraints: { h: 'right', v: 'top' } },
        parentId: frameId
      }
    ])
    const childId = rc.affectedIds.find((id) => useCanvasShapeStore.getState().document.objects[id]?.type === 'rect')!
    executeOps([{ op: 'resize', id: frameId, bounds: { x: 0, y: 0, width: 400, height: 200 } }])
    const doc = useCanvasShapeStore.getState().document
    // Trailing gap was 20px (200 - 180); preserved against the new 400 width → x 330.
    expect(doc.objects[childId].x).toBe(330)
  })
})

describe('addShape unique naming', () => {
  it('renames duplicates with " 2", " 3" etc. under the same parent', () => {
    executeOps([{ op: 'add', shape: { type: 'rect', name: 'Card', x: 0, y: 0, width: 10, height: 10 } }])
    executeOps([{ op: 'add', shape: { type: 'rect', name: 'Card', x: 0, y: 0, width: 10, height: 10 } }])
    executeOps([{ op: 'add', shape: { type: 'rect', name: 'Card', x: 0, y: 0, width: 10, height: 10 } }])
    const doc = useCanvasShapeStore.getState().document
    const root = doc.objects[doc.rootId]
    const names = root.children.map((cid) => doc.objects[cid].name)
    expect(names).toEqual(['Card', 'Card 2', 'Card 3'])
  })
})
