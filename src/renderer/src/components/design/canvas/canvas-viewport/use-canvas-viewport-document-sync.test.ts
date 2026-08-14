import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDefaultShape,
  createEmptyDocument,
  type CanvasDocument
} from '../../../../design/canvas/canvas-types'
import { canvasDocumentKey } from '../../../../design/canvas/canvas-persistence'
import { useCanvasShapeStore } from '../../../../design/canvas/canvas-shape-store'
import { useCanvasViewportStore } from '../../../../design/canvas/canvas-viewport-store'
import type { DesignArtifact } from '../../../../design/design-types'
import { useDesignWorkspaceStore } from '../../../../design/design-workspace-store'

const persistence = vi.hoisted(() => ({
  loadCanvasDocument: vi.fn(),
  persistCanvasDocument: vi.fn()
}))

vi.mock('../../../../design/canvas/canvas-persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../design/canvas/canvas-persistence')>(),
  loadCanvasDocument: persistence.loadCanvasDocument,
  persistCanvasDocument: persistence.persistCanvasDocument
}))

import {
  loadCanvasDocumentWithinDeadline,
  useCanvasViewportDocumentSync
} from './use-canvas-viewport-document-sync'

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('window', { localStorage: { getItem: vi.fn(() => null), setItem: vi.fn() } })
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  persistence.loadCanvasDocument.mockReset()
  persistence.persistCanvasDocument.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('loadCanvasDocumentWithinDeadline', () => {
  it('returns a resolved canvas document', async () => {
    const document = createEmptyDocument()

    await expect(loadCanvasDocumentWithinDeadline(async () => document, 100)).resolves.toEqual({
      status: 'resolved',
      document
    })
  })

  it('settles a hung historical-board read instead of loading forever', async () => {
    vi.useFakeTimers()
    const pending = new Promise<never>(() => undefined)
    const result = loadCanvasDocumentWithinDeadline(() => pending, 100)

    await vi.advanceTimersByTimeAsync(100)

    await expect(result).resolves.toEqual({ status: 'timeout', document: null })
  })

  it('normalizes rejected reads into a reconstructable result', async () => {
    await expect(
      loadCanvasDocumentWithinDeadline(async () => {
        throw new Error('read failed')
      }, 100)
    ).resolves.toEqual({ status: 'rejected', document: null })
  })

  it('mounts a stale historical board without reconciling or persisting it', async () => {
    const staleBoard = createEmptyDocument()
    const screen: DesignArtifact = {
      id: 'screen-1', kind: 'html', title: 'Screen', relativePath: '.kun-design/doc/screen/v1.html',
      createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z',
      versions: [{
        id: 'screen-v1', relativePath: '.kun-design/doc/screen/v1.html',
        createdAt: '2026-08-12T00:00:00.000Z', summary: ''
      }]
    }
    persistence.loadCanvasDocument.mockResolvedValue(staleBoard)
    useDesignWorkspaceStore.setState({ artifacts: [screen], activeArtifactId: screen.id })
    const Harness = () => {
      useCanvasViewportDocumentSync({
        workspaceRoot: '/workspace', artifactId: 'board', viewportStorageKey: 'view',
        documentKey: 'historical-board', htmlFrameSyncEnabled: true,
        designArtifacts: [screen], persistenceEnabled: false
      })
      return null
    }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(createElement(Harness)) })
    await act(async () => { await Promise.resolve() })

    expect(persistence.loadCanvasDocument).toHaveBeenCalledTimes(1)
    expect(persistence.persistCanvasDocument).not.toHaveBeenCalled()
    await act(async () => renderer.unmount())
  })

  it('fits loaded content instead of restoring a saved camera that makes the board blank', async () => {
    const document = createEmptyDocument()
    const image = createDefaultShape('image', -300, -300)
    image.width = 600
    image.height = 600
    document.objects[image.id] = { ...image, parentId: document.rootId }
    document.objects[document.rootId]!.children.push(image.id)
    persistence.loadCanvasDocument.mockResolvedValue(document)
    vi.stubGlobal('window', {
      localStorage: {
        getItem: vi.fn(() => JSON.stringify({ x: 402, y: 631, width: 805, height: 1_222 })),
        setItem: vi.fn()
      }
    })
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      callback(0)
      return 1
    }))
    useCanvasViewportStore.setState({
      containerWidth: 800,
      containerHeight: 600,
      vbox: { x: -400, y: -300, width: 800, height: 600 }
    })
    const Harness = () => {
      useCanvasViewportDocumentSync({
        workspaceRoot: '/workspace', artifactId: 'board', viewportStorageKey: 'view',
        documentKey: 'visible-board', htmlFrameSyncEnabled: false,
        designArtifacts: [], persistenceEnabled: false
      })
      return null
    }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(createElement(Harness)) })
    await act(async () => { await Promise.resolve() })

    const view = useCanvasViewportStore.getState().vbox
    expect(view.x).toBeLessThanOrEqual(-300)
    expect(view.y).toBeLessThanOrEqual(-300)
    expect(view.x + view.width).toBeGreaterThanOrEqual(300)
    expect(view.y + view.height).toBeGreaterThanOrEqual(300)
    await act(async () => renderer.unmount())
  })

  it('does not certify a rejected read as safe for approval actions', async () => {
    persistence.loadCanvasDocument.mockRejectedValue(new Error('read failed'))
    const onDocumentLoadStateChange = vi.fn()
    const Harness = () => {
      useCanvasViewportDocumentSync({
        workspaceRoot: '/workspace', artifactId: 'board', viewportStorageKey: 'view',
        documentKey: 'approval-board', htmlFrameSyncEnabled: false,
        designArtifacts: [], persistenceEnabled: false, onDocumentLoadStateChange
      })
      return null
    }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(createElement(Harness)) })
    await act(async () => { await Promise.resolve() })

    expect(onDocumentLoadStateChange).toHaveBeenLastCalledWith(false)
    await act(async () => renderer.unmount())
  })

  it('adopts a late authoritative read after the deadline timeout', async () => {
    vi.useFakeTimers()
    let resolveRead!: (document: CanvasDocument | null) => void
    persistence.loadCanvasDocument.mockImplementation(
      () => new Promise<CanvasDocument | null>((resolve) => { resolveRead = resolve })
    )
    const onDocumentLoadStateChange = vi.fn()
    const onError = vi.fn()
    const Harness = () => {
      useCanvasViewportDocumentSync({
        workspaceRoot: '/workspace', artifactId: 'board', viewportStorageKey: 'view',
        documentKey: 'late-board', htmlFrameSyncEnabled: false,
        designArtifacts: [], persistenceEnabled: false,
        onDocumentLoadStateChange, onError
      })
      return null
    }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(createElement(Harness)) })
    await act(async () => { await vi.advanceTimersByTimeAsync(4_100) })

    expect(onError).toHaveBeenLastCalledWith(
      'Canvas loading timed out; the whiteboard is read-only until the board loads.'
    )
    expect(onDocumentLoadStateChange).toHaveBeenLastCalledWith(false)
    expect(useCanvasShapeStore.getState().document.objects['late-shape']).toBeUndefined()

    const authoritative = createEmptyDocument()
    const shape = createDefaultShape('rect', 10, 20)
    shape.id = 'late-shape'
    authoritative.objects[shape.id] = { ...shape, parentId: authoritative.rootId }
    const root = authoritative.objects[authoritative.rootId]
    authoritative.objects[authoritative.rootId] = {
      ...root,
      children: [...(root?.children ?? []), shape.id]
    }
    await act(async () => {
      resolveRead(authoritative)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(useCanvasShapeStore.getState().document.objects['late-shape']).toBeTruthy()
    expect(onError).toHaveBeenLastCalledWith(null)
    expect(onDocumentLoadStateChange).toHaveBeenLastCalledWith(true)
    await act(async () => renderer.unmount())
  })

  it('defers shape persistence until the late authoritative read can be merged safely', async () => {
    vi.useFakeTimers()
    let resolveRead!: (document: CanvasDocument | null) => void
    persistence.loadCanvasDocument.mockImplementation(
      () => new Promise<CanvasDocument | null>((resolve) => { resolveRead = resolve })
    )
    const documentKey = canvasDocumentKey('/workspace', 'board')
    const Harness = () => {
      useCanvasViewportDocumentSync({
        workspaceRoot: '/workspace', artifactId: 'board', viewportStorageKey: 'view',
        documentKey, htmlFrameSyncEnabled: false,
        designArtifacts: [], persistenceEnabled: true
      })
      return null
    }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(createElement(Harness)) })
    await act(async () => { await vi.advanceTimersByTimeAsync(4_100) })

    const liveShape = createDefaultShape('rect', 24, 36)
    liveShape.id = 'live-before-authoritative-read'
    await act(async () => { useCanvasShapeStore.getState().addShape(liveShape) })
    expect(persistence.persistCanvasDocument).not.toHaveBeenCalled()
    await act(async () => {
      resolveRead(createEmptyDocument())
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(persistence.persistCanvasDocument).toHaveBeenCalledTimes(1)
    expect(persistence.persistCanvasDocument.mock.calls[0]?.[2].objects[liveShape.id]).toBeTruthy()
    await act(async () => renderer.unmount())
  })

  it('skips persistence when the shape document key does not match the artifact', async () => {
    persistence.loadCanvasDocument.mockResolvedValue(createEmptyDocument())
    const documentKey = canvasDocumentKey('/workspace', 'board')
    const Harness = () => {
      useCanvasViewportDocumentSync({
        workspaceRoot: '/workspace', artifactId: 'board', viewportStorageKey: 'view',
        documentKey, htmlFrameSyncEnabled: false,
        designArtifacts: [], persistenceEnabled: true
      })
      return null
    }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(createElement(Harness)) })
    await act(async () => { await Promise.resolve() })

    await act(async () => {
      useCanvasShapeStore.getState().loadDocument(
        createEmptyDocument(),
        canvasDocumentKey('/workspace', 'other')
      )
    })
    expect(persistence.persistCanvasDocument).not.toHaveBeenCalled()
    await act(async () => renderer.unmount())
  })
})
