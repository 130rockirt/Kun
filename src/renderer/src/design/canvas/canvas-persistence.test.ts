import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_CANVAS_CHILDREN_PER_SHAPE,
  MAX_CANVAS_DOCUMENT_OBJECTS,
  MAX_CANVAS_GRAPH_DEPTH,
  cancelPendingCanvasDocument,
  canvasDocumentKey,
  canvasDocPath,
  clearCanvasDocumentPersistenceForTests,
  flushPendingCanvasDocuments,
  parseCanvasDocument,
  persistCanvasDocument,
  serializeCanvasDocument
} from './canvas-persistence'
import { createDefaultShape, createEmptyDocument, createHtmlFrameShape, isHtmlFrame, isRunningAppFrame } from './canvas-types'
import { createRunningAppFrameShape } from './running-app-frame'

describe('canvas-persistence round-trip', () => {
  it('builds a stable document key from workspace and canvas path', () => {
    expect(canvasDocumentKey('/workspace', 'code-thread-1', '.kun-canvas')).toBe(
      `/workspace\0${canvasDocPath('code-thread-1', '.kun-canvas')}`
    )
  })

  it('preserves htmlArtifactId and devicePreset across serialize → parse', () => {
    const doc = createEmptyDocument()
    const root = doc.objects[doc.rootId]
    const frame = createHtmlFrameShape('Enjoy It', 0, 0, 'artifact-123', 'desktop')
    doc.objects[frame.id] = { ...frame, parentId: doc.rootId }
    doc.objects[doc.rootId] = { ...root, children: [frame.id] }

    const reloaded = parseCanvasDocument(serializeCanvasDocument(doc))
    expect(reloaded).not.toBeNull()
    const loadedFrame = reloaded!.objects[frame.id]
    // The htmlArtifactId link is what makes HtmlFrameOverlay mount the webview.
    // Dropping it on reload turns the screen into a blank white frame.
    expect(loadedFrame.htmlArtifactId).toBe('artifact-123')
    expect(loadedFrame.devicePreset).toBe('desktop')
    expect(isHtmlFrame(loadedFrame)).toBe(true)
  })

  it('preserves a first-class SVG artifact reference across serialize and parse', () => {
    const doc = createEmptyDocument()
    const frame = createDefaultShape('frame', 20, 40)
    frame.embeddedArtifact = { id: 'motion-123', kind: 'svg' }
    frame.width = 320
    frame.height = 240
    doc.objects[frame.id] = { ...frame, parentId: doc.rootId }
    doc.objects[doc.rootId] = { ...doc.objects[doc.rootId], children: [frame.id] }

    const parsed = parseCanvasDocument(serializeCanvasDocument(doc))
    expect(parsed?.objects[frame.id]).toMatchObject({
      embeddedArtifact: { id: 'motion-123', kind: 'svg' },
      width: 320,
      height: 240
    })
    expect(parsed?.objects[frame.id]?.htmlArtifactId).toBeUndefined()
  })

  it('preserves PPT review and visual-direction identities across reload', () => {
    const doc = createEmptyDocument()
    const review = createDefaultShape('frame', 0, 0)
    review.pptReviewRef = {
      workflowId: 'workflow-a', childId: 'child-a', slideId: 'slide-1', revision: 2,
      parentThreadId: 'thread-a', role: 'slide-frame'
    }
    const direction = createDefaultShape('image', 20, 20)
    direction.pptDirectionRef = {
      workflowId: 'workflow-a', childId: 'child-a', directionId: 'direction-b', revision: 3,
      parentThreadId: 'thread-a', role: 'preview-image'
    }
    doc.objects[review.id] = { ...review, parentId: doc.rootId }
    doc.objects[direction.id] = { ...direction, parentId: doc.rootId }
    doc.objects[doc.rootId] = { ...doc.objects[doc.rootId], children: [review.id, direction.id] }

    const parsed = parseCanvasDocument(serializeCanvasDocument(doc))!
    expect(parsed.objects[review.id].pptReviewRef).toEqual(review.pptReviewRef)
    expect(parsed.objects[direction.id].pptDirectionRef).toEqual(direction.pptDirectionRef)
  })

  it('does not invent htmlArtifactId for plain frames', () => {
    const doc = createEmptyDocument()
    const reloaded = parseCanvasDocument(serializeCanvasDocument(doc))
    expect(reloaded).not.toBeNull()
    const root = reloaded!.objects[reloaded!.rootId]
    expect(root.htmlArtifactId).toBeUndefined()
    expect(isHtmlFrame(root)).toBe(false)
  })

  it('preserves running app frames across serialize -> parse', () => {
    const doc = createEmptyDocument()
    const frame = createRunningAppFrameShape({
      x: 24,
      y: 36,
      url: 'localhost:3000/settings',
      title: 'Settings route',
      routePath: '/settings',
      sourceFile: 'src/app/settings/page.tsx'
    })!
    doc.objects[frame.id] = { ...frame, parentId: doc.rootId }
    doc.objects[doc.rootId] = { ...doc.objects[doc.rootId], children: [frame.id] }

    const reloaded = parseCanvasDocument(serializeCanvasDocument(doc))
    const loadedFrame = reloaded!.objects[frame.id]

    expect(isRunningAppFrame(loadedFrame)).toBe(true)
    expect(loadedFrame.runningApp).toMatchObject({
      url: 'http://localhost:3000/settings',
      title: 'Settings route',
      routePath: '/settings',
      sourceFile: 'src/app/settings/page.tsx'
    })
  })

  it('migrates v1 relative child coords to absolute (v2) and bumps version', () => {
    // v1 stored children relative to their parent; v2 is absolute. A child at
    // relative (10, 20) inside a frame at (200, 100) must become absolute (210, 120),
    // and a grandchild accumulates the whole ancestor chain.
    const raw = JSON.stringify({
      version: 1,
      rootId: '__root__',
      objects: {
        __root__: { id: '__root__', type: 'frame', name: 'Root', parentId: null, x: 0, y: 0, children: ['frame'] },
        frame: { id: 'frame', type: 'frame', name: 'F', parentId: '__root__', x: 200, y: 100, children: ['child'] },
        child: { id: 'child', type: 'group', name: 'C', parentId: 'frame', x: 10, y: 20, children: ['leaf'] },
        leaf: { id: 'leaf', type: 'rect', name: 'L', parentId: 'child', x: 5, y: 5, children: [] }
      }
    })
    const reloaded = parseCanvasDocument(raw)
    expect(reloaded).not.toBeNull()
    expect(reloaded!.version).toBe(2)
    expect(reloaded!.objects.frame.x).toBe(200)
    expect(reloaded!.objects.frame.y).toBe(100)
    expect(reloaded!.objects.child.x).toBe(210)
    expect(reloaded!.objects.child.y).toBe(120)
    // leaf = 5 + (200 + 10) , 5 + (100 + 20)
    expect(reloaded!.objects.leaf.x).toBe(215)
    expect(reloaded!.objects.leaf.y).toBe(125)
  })

  it('leaves an already-absolute v2 doc untouched on load', () => {
    const raw = JSON.stringify({
      version: 2,
      rootId: '__root__',
      objects: {
        __root__: { id: '__root__', type: 'frame', name: 'Root', parentId: null, x: 0, y: 0, children: ['frame'] },
        frame: { id: 'frame', type: 'frame', name: 'F', parentId: '__root__', x: 200, y: 100, children: ['child'] },
        child: { id: 'child', type: 'rect', name: 'C', parentId: 'frame', x: 210, y: 120, children: [] }
      }
    })
    const reloaded = parseCanvasDocument(raw)
    expect(reloaded).not.toBeNull()
    expect(reloaded!.objects.child.x).toBe(210)
    expect(reloaded!.objects.child.y).toBe(120)
  })

  it('preserves the aiImageHolder flag across serialize → parse', () => {
    const doc = createEmptyDocument()
    const root = doc.objects[doc.rootId]
    const holder = createDefaultShape('image', 0, 0)
    holder.aiImageHolder = true
    const plain = createDefaultShape('image', 0, 0)
    doc.objects[holder.id] = { ...holder, parentId: doc.rootId }
    doc.objects[plain.id] = { ...plain, parentId: doc.rootId }
    doc.objects[doc.rootId] = { ...root, children: [holder.id, plain.id] }

    const reloaded = parseCanvasDocument(serializeCanvasDocument(doc))
    expect(reloaded).not.toBeNull()
    // parseShape is an allowlist — a dropped flag silently demotes the holder.
    expect(reloaded!.objects[holder.id].aiImageHolder).toBe(true)
    expect(reloaded!.objects[plain.id].aiImageHolder).toBeUndefined()
  })

  it('preserves graph metadata and operation journal entries across serialize -> parse', () => {
    const doc = createEmptyDocument()
    const root = doc.objects[doc.rootId]
    const rect = createDefaultShape('rect', 10, 20)
    doc.objects[rect.id] = { ...rect, parentId: doc.rootId }
    doc.objects[doc.rootId] = { ...root, children: [rect.id] }
    doc.graph = {
      version: 1,
      projectId: 'board_1',
      updatedAt: '2026-07-02T00:00:00.000Z',
      lastJournalEntryId: 'journal_1'
    }
    doc.operationJournal = [
      {
        id: 'journal_1',
        label: 'add-card',
        createdAt: '2026-07-02T00:00:00.000Z',
        status: 'applied',
        affectedIds: [rect.id],
        errors: [],
        operations: [
          {
            id: 'op_1',
            type: 'create_shape',
            label: 'add-card',
            source: 'agent',
            createdAt: '2026-07-02T00:00:00.000Z',
            targetIds: [],
            payload: { op: 'add' }
          }
        ]
      }
    ]
    doc.rendererReplayKeys = ['thread\0turn\0document\0assistant:0']
    doc.rendererReplayWatermarkTurnId = 'turn_materialized'
    doc.codeBindings = [
      {
        id: 'binding_1',
        designObjectId: rect.id,
        kind: 'dom-node',
        status: 'active',
        createdAt: '2026-07-02T00:00:00.000Z',
        target: {
          sourceFile: 'src/app/page.tsx',
          componentName: 'CheckoutCard',
          onlookId: 'oid_123',
          domId: 'checkout-card'
        }
      }
    ]

    const reloaded = parseCanvasDocument(serializeCanvasDocument(doc))

    expect(reloaded?.graph).toMatchObject({
      projectId: 'board_1',
      lastJournalEntryId: 'journal_1'
    })
    expect(reloaded?.operationJournal?.[0]).toMatchObject({
      id: 'journal_1',
      label: 'add-card',
      status: 'applied',
      affectedIds: [rect.id]
    })
    expect(reloaded?.rendererReplayKeys).toEqual(['thread\0turn\0document\0assistant:0'])
    expect(reloaded?.rendererReplayWatermarkTurnId).toBe('turn_materialized')
    expect(reloaded?.codeBindings?.[0]).toMatchObject({
      id: 'binding_1',
      designObjectId: rect.id,
      kind: 'dom-node',
      status: 'active',
      target: {
        sourceFile: 'src/app/page.tsx',
        componentName: 'CheckoutCard',
        onlookId: 'oid_123',
        domId: 'checkout-card'
      }
    })
  })

  it('ignores a malformed devicePreset value', () => {
    const raw = JSON.stringify({
      version: 1,
      rootId: '__root__',
      objects: {
        __root__: { id: '__root__', type: 'frame', name: 'Root', parentId: null, children: ['f1'] },
        f1: { id: 'f1', type: 'frame', name: 'F', parentId: '__root__', children: [], htmlArtifactId: 'a1', devicePreset: 'watch' }
      }
    })
    const reloaded = parseCanvasDocument(raw)
    expect(reloaded).not.toBeNull()
    const frame = reloaded!.objects.f1
    expect(frame.htmlArtifactId).toBe('a1')
    expect(frame.devicePreset).toBeUndefined()
  })

  it.each([
    {
      label: 'missing child',
      objects: {
        __root__: { type: 'frame', parentId: null, children: ['missing'] }
      }
    },
    {
      label: 'duplicate child',
      objects: {
        __root__: { type: 'frame', parentId: null, children: ['a', 'a'] },
        a: { type: 'rect', parentId: '__root__', children: [] }
      }
    },
    {
      label: 'multiple parents',
      objects: {
        __root__: { type: 'frame', parentId: null, children: ['a', 'b'] },
        a: { type: 'frame', parentId: '__root__', children: ['child'] },
        b: { type: 'frame', parentId: '__root__', children: ['child'] },
        child: { type: 'rect', parentId: 'a', children: [] }
      }
    },
    {
      label: 'parent mismatch',
      objects: {
        __root__: { type: 'frame', parentId: null, children: ['a'] },
        a: { type: 'rect', parentId: 'other', children: [] }
      }
    },
    {
      label: 'cycle',
      objects: {
        __root__: { type: 'frame', parentId: null, children: ['a'] },
        a: { type: 'frame', parentId: '__root__', children: ['b'] },
        b: { type: 'frame', parentId: 'a', children: ['a'] }
      }
    },
    {
      label: 'unreachable object',
      objects: {
        __root__: { type: 'frame', parentId: null, children: [] },
        orphan: { type: 'rect', parentId: null, children: [] }
      }
    }
  ])('rejects a malformed graph with $label', ({ objects }) => {
    expect(parseCanvasDocument(JSON.stringify({ version: 2, rootId: '__root__', objects }))).toBeNull()
  })

  it('rejects non-finite geometry before it reaches canvas consumers', () => {
    expect(parseCanvasDocument(
      '{"version":2,"rootId":"__root__","objects":{"__root__":{"type":"frame","parentId":null,"x":1e400,"children":[]}}}'
    )).toBeNull()
  })

  it('rejects object and child collections above their limits', () => {
    const tooManyObjects: Record<string, unknown> = {}
    for (let index = 0; index <= MAX_CANVAS_DOCUMENT_OBJECTS; index += 1) {
      tooManyObjects[`shape-${index}`] = { type: 'rect', parentId: null, children: [] }
    }
    expect(parseCanvasDocument(JSON.stringify({
      version: 2,
      rootId: 'shape-0',
      objects: tooManyObjects
    }))).toBeNull()

    expect(parseCanvasDocument(JSON.stringify({
      version: 2,
      rootId: '__root__',
      objects: {
        __root__: {
          type: 'frame',
          parentId: null,
          children: Array.from({ length: MAX_CANVAS_CHILDREN_PER_SHAPE + 1 }, (_, index) => `child-${index}`)
        }
      }
    }))).toBeNull()
  })

  it('rejects a graph deeper than recursive canvas consumers can safely traverse', () => {
    const objects: Record<string, unknown> = {}
    for (let depth = 0; depth <= MAX_CANVAS_GRAPH_DEPTH + 1; depth += 1) {
      const id = `node-${depth}`
      objects[id] = {
        type: depth === 0 ? 'frame' : 'group',
        parentId: depth === 0 ? null : `node-${depth - 1}`,
        children: depth <= MAX_CANVAS_GRAPH_DEPTH ? [`node-${depth + 1}`] : []
      }
    }

    expect(parseCanvasDocument(JSON.stringify({
      version: 2,
      rootId: 'node-0',
      objects
    }))).toBeNull()
  })
})

describe('persistCanvasDocument debounce', () => {
  afterEach(() => {
    clearCanvasDocumentPersistenceForTests()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('does not let one canvas save cancel another canvas save', () => {
    vi.useFakeTimers()
    const writeWorkspaceFile = vi.fn(async () => ({ ok: true as const }))
    vi.stubGlobal('window', { kunGui: { writeWorkspaceFile } })

    const designDoc = createEmptyDocument()
    const codeDoc = createEmptyDocument()

    persistCanvasDocument('/workspace', 'design-board', designDoc)
    persistCanvasDocument('/workspace', 'code-thread-1', codeDoc, '.kun-canvas')
    vi.advanceTimersByTime(600)

    expect(writeWorkspaceFile).toHaveBeenCalledTimes(2)
    expect(writeWorkspaceFile).toHaveBeenCalledWith({
      path: canvasDocPath('design-board'),
      workspaceRoot: '/workspace',
      content: serializeCanvasDocument(designDoc)
    })
    expect(writeWorkspaceFile).toHaveBeenCalledWith({
      path: canvasDocPath('code-thread-1', '.kun-canvas'),
      workspaceRoot: '/workspace',
      content: serializeCanvasDocument(codeDoc)
    })
  })

  it('keeps debouncing repeated saves for the same canvas', () => {
    vi.useFakeTimers()
    const writeWorkspaceFile = vi.fn(async () => ({ ok: true as const }))
    vi.stubGlobal('window', { kunGui: { writeWorkspaceFile } })

    const firstDoc = createEmptyDocument()
    const latestDoc = createEmptyDocument()
    const root = latestDoc.objects[latestDoc.rootId]
    const rect = createDefaultShape('rect', 10, 20)
    rect.name = 'Latest'
    latestDoc.objects[rect.id] = { ...rect, parentId: latestDoc.rootId }
    latestDoc.objects[latestDoc.rootId] = { ...root, children: [rect.id] }

    persistCanvasDocument('/workspace', 'code-thread-1', firstDoc, '.kun-canvas')
    persistCanvasDocument('/workspace', 'code-thread-1', latestDoc, '.kun-canvas')
    vi.advanceTimersByTime(600)

    expect(writeWorkspaceFile).toHaveBeenCalledTimes(1)
    expect(writeWorkspaceFile).toHaveBeenCalledWith({
      path: canvasDocPath('code-thread-1', '.kun-canvas'),
      workspaceRoot: '/workspace',
      content: serializeCanvasDocument(latestDoc)
    })
  })

  it('flushes the latest debounced canvas without waiting for the timer', async () => {
    vi.useFakeTimers()
    const writeWorkspaceFile = vi.fn(async ({ path }: { path: string }) => ({
      ok: true as const,
      path,
      savedAt: 'now'
    }))
    vi.stubGlobal('window', { kunGui: { writeWorkspaceFile } })
    const latestDoc = createEmptyDocument()
    const rect = createDefaultShape('rect', 12, 24)
    latestDoc.objects[rect.id] = { ...rect, parentId: latestDoc.rootId }
    latestDoc.objects[latestDoc.rootId].children = [rect.id]

    persistCanvasDocument('/workspace', 'board', createEmptyDocument())
    persistCanvasDocument('/workspace', 'board', latestDoc)
    await flushPendingCanvasDocuments('/workspace')

    expect(writeWorkspaceFile).toHaveBeenCalledTimes(1)
    expect(writeWorkspaceFile).toHaveBeenCalledWith({
      path: canvasDocPath('board'),
      workspaceRoot: '/workspace',
      content: serializeCanvasDocument(latestDoc)
    })
  })

  it('retires a deleted canvas so a queued or later stale save cannot recreate it', async () => {
    vi.useFakeTimers()
    let finishWrite: ((value: { ok: true }) => void) | undefined
    const writeWorkspaceFile = vi.fn(() => new Promise<{ ok: true }>((resolve) => {
      finishWrite = resolve
    }))
    vi.stubGlobal('window', { kunGui: { writeWorkspaceFile } })

    persistCanvasDocument('/workspace', 'deleted-board', createEmptyDocument(), '.kun-whiteboards')
    vi.advanceTimersByTime(600)
    expect(writeWorkspaceFile).toHaveBeenCalledOnce()

    let cancelled = false
    const cancel = cancelPendingCanvasDocument('/workspace', 'deleted-board', '.kun-whiteboards')
      .then(() => { cancelled = true })
    await Promise.resolve()
    expect(cancelled).toBe(false)

    finishWrite?.({ ok: true })
    await cancel

    // A late store subscription for the unmounted board must be a no-op too.
    persistCanvasDocument('/workspace', 'deleted-board', createEmptyDocument(), '.kun-whiteboards')
    vi.advanceTimersByTime(600)
    expect(writeWorkspaceFile).toHaveBeenCalledOnce()
  })
})
