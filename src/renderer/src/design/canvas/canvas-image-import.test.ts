import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCanvasSelectionStore } from './canvas-selection-store'
import {
  computeImportedImagePlacement,
  importWorkspaceImageToCanvas,
  pasteClipboardImageToCanvas
} from './canvas-image-import'
import { useCanvasShapeStore } from './canvas-shape-store'
import { createEmptyDocument } from './canvas-types'
import { useCanvasUndoStore } from './canvas-undo-store'
import { useCanvasViewportStore } from './canvas-viewport-store'

beforeEach(() => {
  useCanvasShapeStore.getState().loadDocument(createEmptyDocument())
  useCanvasUndoStore.getState().clear()
  useCanvasSelectionStore.getState().clearSelection()
  useCanvasViewportStore.getState().setVbox({ x: -500, y: -300, width: 1000, height: 600 })
  useCanvasViewportStore.getState().setActiveTool('hand')
  vi.stubGlobal('window', {
    kunGui: {
      pickWorkspaceImage: vi.fn()
    }
  })
})

describe('computeImportedImagePlacement', () => {
  it('centers and scales large images into the current viewport', () => {
    const rect = computeImportedImagePlacement(
      { x: -500, y: -300, width: 1000, height: 600 },
      { width: 1600, height: 900 }
    )

    expect(rect.width).toBe(520)
    expect(rect.height).toBe(292.5)
    expect(rect.x).toBe(-260)
    expect(rect.y).toBe(-146.25)
  })

  it('uses fallback dimensions when image metadata is unavailable', () => {
    const rect = computeImportedImagePlacement({ x: 0, y: 0, width: 800, height: 600 })

    expect(rect).toEqual({
      x: 240,
      y: 190,
      width: 320,
      height: 220
    })
  })

  it('avoids occupied virtual canvas regions', () => {
    const rect = computeImportedImagePlacement(
      { x: 0, y: 0, width: 800, height: 600 },
      { width: 320, height: 220 },
      [{ x: 240, y: 190, width: 320, height: 220 }]
    )

    expect(rect).toEqual({ x: 640, y: 190, width: 320, height: 220 })
  })
})

describe('importWorkspaceImageToCanvas', () => {
  it('creates a selected image shape from the picked workspace-relative path', async () => {
    const pickWorkspaceImage = vi.fn().mockResolvedValue({
      ok: true,
      path: '/workspace/img/hero.png',
      relativePath: 'img/hero.png',
      workspaceRelativePath: 'img/hero.png',
      width: 1200,
      height: 800,
      createdAt: '2026-06-22T00:00:00.000Z'
    })
    vi.stubGlobal('window', { kunGui: { pickWorkspaceImage } })

    const result = await importWorkspaceImageToCanvas({
      workspaceRoot: '/workspace',
      vbox: { x: -500, y: -300, width: 1000, height: 600 }
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(pickWorkspaceImage).toHaveBeenCalledWith({ workspaceRoot: '/workspace' })

    const shape = useCanvasShapeStore.getState().document.objects[result.shapeId]
    expect(shape).toMatchObject({
      type: 'image',
      name: 'hero',
      imageUrl: 'img/hero.png',
      width: 468,
      height: 312
    })
    expect(shape.x).toBe(-234)
    expect(shape.y).toBe(-156)
    expect(useCanvasSelectionStore.getState().selectedIds.has(result.shapeId)).toBe(true)
    expect(useCanvasViewportStore.getState().activeTool).toBe('select')
  })

  it('does not mutate the canvas when the picker is canceled', async () => {
    vi.stubGlobal('window', {
      kunGui: {
        pickWorkspaceImage: vi.fn().mockResolvedValue({ ok: false, canceled: true })
      }
    })

    const result = await importWorkspaceImageToCanvas({
      workspaceRoot: '/workspace',
      vbox: { x: 0, y: 0, width: 800, height: 600 }
    })

    expect(result).toEqual({ ok: false, canceled: true })
    expect(useCanvasShapeStore.getState().getAllShapeIds()).toEqual([])
    expect(useCanvasSelectionStore.getState().selectedIds.size).toBe(0)
  })
})

describe('pasteClipboardImageToCanvas', () => {
  it('creates a selected image shape from clipboard data', async () => {
    const readClipboardImage = vi.fn().mockResolvedValue({
      ok: true,
      name: 'img-20260622-001',
      localFilePath: '/tmp/clipboard/1234.png',
      mimeType: 'image/png',
      dataBase64: 'iVBORw0KGgo=',
      byteSize: 1024,
      width: 800,
      height: 600
    })
    vi.stubGlobal('window', { kunGui: { readClipboardImage } })

    const result = await pasteClipboardImageToCanvas({
      vbox: { x: -500, y: -300, width: 1000, height: 600 }
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(readClipboardImage).toHaveBeenCalled()

    const shape = useCanvasShapeStore.getState().document.objects[result.shapeId]
    expect(shape).toMatchObject({
      type: 'image',
      name: 'img-20260622-001',
      imageUrl: 'data:image/png;base64,iVBORw0KGgo='
    })
    expect(shape.width).toBeGreaterThan(0)
    expect(shape.height).toBeGreaterThan(0)
    expect(useCanvasSelectionStore.getState().selectedIds.has(result.shapeId)).toBe(true)
    expect(useCanvasViewportStore.getState().activeTool).toBe('select')
  })

  it('returns failure when clipboard has no image', async () => {
    vi.stubGlobal('window', {
      kunGui: {
        readClipboardImage: vi.fn().mockResolvedValue({
          ok: false,
          message: 'Clipboard does not currently contain an image.'
        })
      }
    })

    const result = await pasteClipboardImageToCanvas({
      vbox: { x: 0, y: 0, width: 800, height: 600 }
    })

    expect(result.ok).toBe(false)
    expect(useCanvasShapeStore.getState().getAllShapeIds()).toEqual([])
  })

  it('persists bytes to .deepseekgui-images/ and stores the workspace-relative path', async () => {
    const readClipboardImage = vi.fn().mockResolvedValue({
      ok: true,
      name: 'img-y',
      localFilePath: '/ws/clipboard.png',
      mimeType: 'image/png',
      dataBase64: 'iVBORw0KGgo=',
      byteSize: 8,
      width: 800,
      height: 600
    })
    const saveWorkspaceClipboardImage = vi.fn().mockResolvedValue({
      ok: true,
      path: '/ws/.deepseekgui-images/img-y.png',
      markdownPath: '.deepseekgui-images/img-y.png',
      createdAt: '2026-06-23T00:00:00.000Z'
    })
    vi.stubGlobal('window', {
      kunGui: { readClipboardImage, saveWorkspaceClipboardImage }
    })

    const result = await pasteClipboardImageToCanvas({
      vbox: { x: 0, y: 0, width: 800, height: 600 },
      workspaceRoot: '/ws'
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(saveWorkspaceClipboardImage).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRoot: '/ws' })
    )
    const shape = useCanvasShapeStore.getState().document.objects[result.shapeId]
    expect(shape.imageUrl).toBe('.deepseekgui-images/img-y.png')
    expect(shape.imageUrl?.startsWith('data:')).toBe(false)
  })

  it('does NOT use saved.markdownPath when the absolute path is missing or outside the workspace (would resolve outside workspace)', async () => {
    const readClipboardImage = vi.fn().mockResolvedValue({
      ok: true,
      name: 'img-z',
      localFilePath: '/ws/clipboard.png',
      mimeType: 'image/png',
      dataBase64: 'iVBORw0KGgo=',
      byteSize: 8,
      width: 800,
      height: 600
    })
    // saved.path is null (or outside workspace) — only markdownPath is returned.
    // markdownPath was computed relative to dirname(currentFilePath); since we
    // pass workspaceRoot as currentFilePath, its dirname is the workspace's
    // parent and the path would resolve OUTSIDE the workspace. We must fall
    // back to the data: URL (snapshot safety-net strips it) rather than trust
    // the wrongly-anchored markdownPath.
    const saveWorkspaceClipboardImage = vi.fn().mockResolvedValue({
      ok: true,
      path: null,
      markdownPath: 'ws/.deepseekgui-images/img-z.png',
      createdAt: '2026-06-23T00:00:00.000Z'
    })
    vi.stubGlobal('window', {
      kunGui: { readClipboardImage, saveWorkspaceClipboardImage }
    })

    const result = await pasteClipboardImageToCanvas({
      vbox: { x: 0, y: 0, width: 800, height: 600 },
      workspaceRoot: '/ws'
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const shape = useCanvasShapeStore.getState().document.objects[result.shapeId]
    expect(shape.imageUrl?.startsWith('data:image/png;base64,')).toBe(true)
    expect(shape.imageUrl).not.toContain('ws/.deepseekgui-images/img-z.png')
  })

  it('falls back to data: URL when no workspaceRoot is provided (legacy unit-test path)', async () => {
    const readClipboardImage = vi.fn().mockResolvedValue({
      ok: true,
      name: 'img-y',
      localFilePath: '/tmp/clipboard.png',
      mimeType: 'image/png',
      dataBase64: 'iVBORw0KGgo=',
      byteSize: 8,
      width: 800,
      height: 600
    })
    vi.stubGlobal('window', { kunGui: { readClipboardImage } })

    const result = await pasteClipboardImageToCanvas({
      vbox: { x: 0, y: 0, width: 800, height: 600 }
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const shape = useCanvasShapeStore.getState().document.objects[result.shapeId]
    expect(shape.imageUrl?.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('falls back to default name when clipboard image has no name', async () => {
    vi.stubGlobal('window', {
      kunGui: {
        readClipboardImage: vi.fn().mockResolvedValue({
          ok: true,
          name: '',
          localFilePath: '/tmp/clipboard/1234.png',
          mimeType: 'image/png',
          dataBase64: 'AAAA',
          byteSize: 3
        })
      }
    })

    const result = await pasteClipboardImageToCanvas({
      vbox: { x: 0, y: 0, width: 800, height: 600 }
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const shape = useCanvasShapeStore.getState().document.objects[result.shapeId]
    expect(shape.name).toBe('Pasted Image')
  })

  it('does not insert into a different canvas when clipboard reading finishes late', async () => {
    let resolveRead!: (value: {
      ok: true
      name: string
      mimeType: string
      dataBase64: string
      byteSize: number
    }) => void
    const readClipboardImage = vi.fn(() => new Promise((resolve) => {
      resolveRead = resolve
    }))
    vi.stubGlobal('window', { kunGui: { readClipboardImage } })
    useCanvasShapeStore.getState().loadDocument(createEmptyDocument(), 'source-document')

    const pending = pasteClipboardImageToCanvas({
      vbox: { x: 0, y: 0, width: 800, height: 600 },
      workspaceRoot: '/workspace',
      expectedDocumentKey: 'source-document'
    })
    useCanvasShapeStore.getState().loadDocument(createEmptyDocument(), 'target-document')
    resolveRead({
      ok: true,
      name: 'late-image',
      mimeType: 'image/png',
      dataBase64: 'AAAA',
      byteSize: 3
    })

    await expect(pending).resolves.toEqual({ ok: false, reason: 'document-changed' })
    expect(useCanvasShapeStore.getState().documentKey).toBe('target-document')
    expect(useCanvasShapeStore.getState().getAllShapeIds()).toEqual([])
  })
})
