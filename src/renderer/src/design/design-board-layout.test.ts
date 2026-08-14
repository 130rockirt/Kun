import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildHtmlArtifactSyncKey,
  findDesignBoardArtifact,
  removedLinkedHtmlArtifactIds,
  syncHtmlArtifactsToBoardDocument,
  syncHtmlFrameNodesToArtifacts
} from './design-board'
import { useCanvasSelectionStore } from './canvas/canvas-selection-store'
import { useCanvasShapeStore } from './canvas/canvas-shape-store'
import { createDefaultShape, createEmptyDocument, createHtmlFrameShape, isHtmlFrame } from './canvas/canvas-types'
import { useCanvasUndoStore } from './canvas/canvas-undo-store'
import { useCanvasViewportStore } from './canvas/canvas-viewport-store'
import { defaultPreviewNodeSizeForDesignTarget } from './design-context'
import { resolvePrototypeViewportFrame } from './prototype-player'
import { useDesignWorkspaceStore } from './design-workspace-store'
import { defaultDesignArtifactNode } from './design-types'
import { artifact, createdAt, installDesignDocument } from './design-board.test-helpers'

beforeEach(() => {
  vi.stubGlobal('window', {
    kunGui: {
      writeWorkspaceFile: vi.fn(async () => ({ ok: true as const }))
    }
  })
  useCanvasShapeStore.getState().loadDocument(createEmptyDocument())
  useCanvasUndoStore.getState().clear()
  useCanvasSelectionStore.getState().clearSelection()
  useCanvasViewportStore.getState().setContainerSize(1200, 800)
  useCanvasViewportStore.getState().setVbox({ x: -600, y: -400, width: 1200, height: 800 })
  useDesignWorkspaceStore.setState({ designContext: { designTarget: 'web' } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('design board layout persistence', () => {
  it('keeps artifact nodes and prototype viewport aligned after target resize sync', () => {
    const screen = artifact('home', 'html', {
      title: 'Home',
      node: {
        x: 80,
        y: 120,
        width: 1280,
        height: 800,
        sizeMode: 'auto'
      }
    })
    installDesignDocument([screen], screen.id)
    useDesignWorkspaceStore.setState({ designContext: { designTarget: 'app' } })

    const doc = createEmptyDocument()
    const root = doc.objects[doc.rootId]
    const frame = createHtmlFrameShape('Home', 80, 120, 'home', 'desktop')
    frame.width = 1280
    frame.height = 800
    doc.objects[frame.id] = { ...frame, parentId: doc.rootId }
    doc.objects[doc.rootId] = { ...root, children: [frame.id] }

    const synced = syncHtmlArtifactsToBoardDocument(doc, useDesignWorkspaceStore.getState().artifacts)
    syncHtmlFrameNodesToArtifacts(synced.document)

    const updated = useDesignWorkspaceStore.getState().artifacts.find((item) => item.id === 'home')
    expect(updated?.node).toMatchObject({
      x: 80,
      y: 120,
      width: 390,
      height: 844,
      sizeMode: 'auto'
    })
    expect(resolvePrototypeViewportFrame(updated, 'app')).toEqual({
      width: 390,
      height: 844,
      orientation: 'portrait'
    })
  })

  it('places a newly synced implicit screen beside existing board frames', () => {
    useCanvasViewportStore.getState().setVbox({ x: 1000, y: 500, width: 1600, height: 1000 })
    const doc = createEmptyDocument()
    const root = doc.objects[doc.rootId]
    const existing = createHtmlFrameShape('Home', 1160, 600, 'home', 'desktop')
    doc.objects[existing.id] = { ...existing, parentId: doc.rootId }
    doc.objects[doc.rootId] = { ...root, children: [existing.id] }

    const synced = syncHtmlArtifactsToBoardDocument(doc, [
      artifact('home', 'html'),
      artifact('settings', 'html', { node: defaultDesignArtifactNode(1) })
    ])

    expect(synced.addedFrameIds).toHaveLength(1)
    const frame = synced.document.objects[synced.addedFrameIds[0]]
    expect(frame).toMatchObject({
      htmlArtifactId: 'settings',
      x: 2520,
      y: 600,
      width: 1280,
      height: 800
    })
  })

  it('keeps a regular (non-foundation) screen at its measured auto-grown HEIGHT across re-syncs, but pins width to the device target', () => {
    // Regression test: HtmlFrameOverlay's live measurement grows a REGULAR page's
    // frame (not just foundation design-system/logo docs) to match its real HTML
    // content height and writes that into the artifact node. Because board sync
    // recomputes for every artifact whenever ANY artifact's node changes, it must
    // not stomp this measured height back to the generic target placeholder size
    // on the next (unrelated) re-sync — that reset is exactly what produced a
    // short, clipped frame showing mostly blank space below real content.
    //
    // Width, however, must stay pinned to the fixed device target size even if
    // the artifact node holds a stray measured width (from window.innerWidth-based
    // measurement, which is sensitive to webview zoom timing and produced wildly
    // inconsistent per-screen widths) — regular screens are a fixed-width device
    // viewport, not a width-auto-growing reference document.
    const doc = createEmptyDocument()
    const root = doc.objects[doc.rootId]
    const existing = createHtmlFrameShape('首页', 2080, -400, 'home', 'desktop')
    existing.width = 1280
    existing.height = 800
    doc.objects[existing.id] = { ...existing, parentId: doc.rootId }
    doc.objects[doc.rootId] = { ...root, children: [existing.id] }

    const measuredArtifact = artifact('home', 'html', {
      title: '首页',
      node: { x: 2080, y: -400, width: 1852, height: 2903, sizeMode: 'auto' }
    })

    const firstSync = syncHtmlArtifactsToBoardDocument(doc, [measuredArtifact])
    expect(firstSync.updatedFrameIds).toEqual([existing.id])
    expect(firstSync.document.objects[existing.id]).toMatchObject({
      width: 1280,
      height: 2903
    })

    // Re-run sync again (as happens whenever any other artifact's node changes)
    // against the now-updated document. The already-measured height must stay put.
    const secondSync = syncHtmlArtifactsToBoardDocument(firstSync.document, [measuredArtifact])
    expect(secondSync.updatedFrameIds).toEqual([])
    expect(secondSync.document.objects[existing.id]).toMatchObject({
      width: 1280,
      height: 2903
    })
  })

  it('does not let artifact node geometry overwrite an existing linked frame', () => {
    const doc = createEmptyDocument()
    const root = doc.objects[doc.rootId]
    const existing = createHtmlFrameShape('Old', 10, 20, 'custom', 'desktop')
    existing.width = 1280
    existing.height = 900
    doc.objects[existing.id] = { ...existing, parentId: doc.rootId }
    doc.objects[doc.rootId] = { ...root, children: [existing.id] }

    const synced = syncHtmlArtifactsToBoardDocument(doc, [
      artifact('custom', 'html', {
        title: 'Renamed',
        node: { x: 300, y: 400, width: 700, height: 500, sizeMode: 'manual' }
      })
    ])

    expect(synced.addedFrameIds).toEqual([])
    expect(synced.updatedFrameIds).toEqual([existing.id])
    expect(synced.document.objects[existing.id]).toMatchObject({
      name: 'Renamed',
      x: 10,
      y: 20,
      width: 1280,
      height: 900
    })
  })
})
