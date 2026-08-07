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

describe('design board helpers', () => {
  it('finds the most recently updated canvas artifact as the board', () => {
    const oldBoard = artifact('old', 'canvas', { updatedAt: '2026-06-20T00:00:00.000Z' })
    const newBoard = artifact('new', 'canvas', { updatedAt: '2026-06-21T00:00:00.000Z' })

    expect(findDesignBoardArtifact([oldBoard, artifact('screen', 'html'), newBoard])?.id).toBe('new')
  })

  it('includes design target in the HTML screen sync key', () => {
    const screen = artifact('screen', 'html', {
      title: 'Home',
      node: defaultDesignArtifactNode(0)
    })

    expect(buildHtmlArtifactSyncKey([screen], 'web')).not.toBe(buildHtmlArtifactSyncKey([screen], 'app'))
    expect(buildHtmlArtifactSyncKey([screen], undefined)).toBe(buildHtmlArtifactSyncKey([screen], 'web'))
  })

  it('includes frame size mode and view mode in the HTML screen sync key', () => {
    const baseNode = { x: 40, y: 60, width: 1280, height: 800 }
    const autoPreview = artifact('screen', 'html', {
      title: 'Home',
      node: { ...baseNode, sizeMode: 'auto', viewMode: 'preview' }
    })
    const manualPreview = artifact('screen', 'html', {
      title: 'Home',
      node: { ...baseNode, sizeMode: 'manual', viewMode: 'preview' }
    })
    const autoCode = artifact('screen', 'html', {
      title: 'Home',
      node: { ...baseNode, sizeMode: 'auto', viewMode: 'code' }
    })

    expect(buildHtmlArtifactSyncKey([autoPreview], 'web')).not.toBe(buildHtmlArtifactSyncKey([manualPreview], 'web'))
    expect(buildHtmlArtifactSyncKey([autoPreview], 'web')).not.toBe(buildHtmlArtifactSyncKey([autoCode], 'web'))
  })

  it('includes board hidden state in the HTML screen sync key', () => {
    const node = { x: 40, y: 60, width: 1280, height: 800, sizeMode: 'auto' as const }
    const visible = artifact('screen', 'html', { node })
    const hidden = artifact('screen', 'html', { node: { ...node, boardHidden: true } })

    expect(buildHtmlArtifactSyncKey([visible], 'web')).not.toBe(buildHtmlArtifactSyncKey([hidden], 'web'))
  })

  it('syncs unmounted HTML artifacts into screen frames only once', () => {
    const screen = artifact('screen', 'html', {
      title: 'Login',
      node: { x: 40, y: 60, width: 390, height: 844, sizeMode: 'manual' }
    })

    const first = syncHtmlArtifactsToBoardDocument(createEmptyDocument(), [screen])
    expect(first.addedFrameIds).toHaveLength(1)
    const frame = first.document.objects[first.addedFrameIds[0]]
    expect(frame).toMatchObject({
      type: 'frame',
      name: 'Login',
      htmlArtifactId: 'screen',
      x: 40,
      y: 60,
      width: 390,
      height: 844,
      parentId: first.document.rootId,
      frameId: null
    })
    expect(isHtmlFrame(frame)).toBe(true)

    const second = syncHtmlArtifactsToBoardDocument(first.document, [screen])
    expect(second.addedFrameIds).toEqual([])
    expect(second.updatedFrameIds).toEqual([])
  })

  // HTML frame sizing sync cases live in design-board.frame-sizing.test.ts.

  it('creates one canvas frame per HTML version by default and keeps each snapshot linked', () => {
    const v1Path = '.kun-design/doc/home/v1.html'
    const v2Path = '.kun-design/doc/home/v2.html'
    const screen = artifact('home', 'html', {
      title: 'Home',
      relativePath: v2Path,
      versions: [
        { id: 'home-v2', relativePath: v2Path, createdAt, summary: 'Second pass' },
        { id: 'home-v1', relativePath: v1Path, createdAt, summary: 'First pass' }
      ]
    })

    const first = syncHtmlArtifactsToBoardDocument(createEmptyDocument(), [screen])
    const frames = first.addedFrameIds.map((id) => first.document.objects[id])

    expect(frames).toHaveLength(2)
    expect(frames.map((frame) => frame?.embeddedArtifact?.versionId)).toEqual(['home-v1', 'home-v2'])
    expect(frames.map((frame) => frame?.name)).toEqual(['Home · v1', 'Home'])

    const second = syncHtmlArtifactsToBoardDocument(first.document, [screen])
    expect(second.addedFrameIds).toEqual([])
    expect(second.removedFrameIds).toEqual([])
    expect(second.document.objects).toEqual(first.document.objects)
  })

  it('does not recreate a tombstoned historical version frame across syncs and reloads', () => {
    const screen = artifact('home', 'html', {
      title: 'Home',
      relativePath: '.kun-design/doc/home/v2.html',
      versions: [
        { id: 'home-v2', relativePath: '.kun-design/doc/home/v2.html', createdAt, summary: 'Second pass' },
        { id: 'home-v1', relativePath: '.kun-design/doc/home/v1.html', createdAt, summary: 'First pass' }
      ],
      node: { x: 40, y: 60, width: 390, height: 844, sizeMode: 'manual', boardHiddenVersionIds: ['home-v1'] }
    })

    const first = syncHtmlArtifactsToBoardDocument(createEmptyDocument(), [screen])
    expect(first.addedFrameIds.map((id) => first.document.objects[id]?.embeddedArtifact?.versionId))
      .toEqual(['home-v2'])

    const second = syncHtmlArtifactsToBoardDocument(first.document, [screen])
    expect(second.addedFrameIds).toEqual([])
    expect(second.document.objects).toEqual(first.document.objects)

    // A fresh load from disk must reconstruct the same board without v1.
    const reloaded = syncHtmlArtifactsToBoardDocument(createEmptyDocument(), [screen])
    expect(reloaded.addedFrameIds.map((id) => reloaded.document.objects[id]?.embeddedArtifact?.versionId))
      .toEqual(['home-v2'])
  })

  it('lets a newly generated version appear while older tombstoned versions stay hidden', () => {
    const withV3 = artifact('home', 'html', {
      title: 'Home',
      relativePath: '.kun-design/doc/home/v3.html',
      versions: [
        { id: 'home-v3', relativePath: '.kun-design/doc/home/v3.html', createdAt, summary: 'Third pass' },
        { id: 'home-v2', relativePath: '.kun-design/doc/home/v2.html', createdAt, summary: 'Second pass' },
        { id: 'home-v1', relativePath: '.kun-design/doc/home/v1.html', createdAt, summary: 'First pass' }
      ],
      node: { x: 40, y: 60, width: 390, height: 844, sizeMode: 'manual', boardHiddenVersionIds: ['home-v1'] }
    })

    const synced = syncHtmlArtifactsToBoardDocument(createEmptyDocument(), [withV3])
    expect(synced.addedFrameIds.map((id) => synced.document.objects[id]?.embeddedArtifact?.versionId))
      .toEqual(['home-v2', 'home-v3'])
  })

  it('clears a version tombstone when its frame is restored (undo path)', () => {
    const screen = artifact('home', 'html', {
      title: 'Home',
      relativePath: '.kun-design/doc/home/v2.html',
      versions: [
        { id: 'home-v2', relativePath: '.kun-design/doc/home/v2.html', createdAt, summary: 'Second pass' },
        { id: 'home-v1', relativePath: '.kun-design/doc/home/v1.html', createdAt, summary: 'First pass' }
      ],
      node: { x: 40, y: 60, width: 390, height: 844, sizeMode: 'manual', boardHiddenVersionIds: ['home-v1'] }
    })
    installDesignDocument([screen], screen.id)
    const synced = syncHtmlArtifactsToBoardDocument(createEmptyDocument(), [screen])
    const restored = createHtmlFrameShape('Home · v1', 100, 100, 'home', 'desktop', 'home-v1')
    restored.width = 300
    restored.height = 400
    synced.document.objects[restored.id] = { ...restored, parentId: synced.document.rootId }
    const root = synced.document.objects[synced.document.rootId]
    synced.document.objects[synced.document.rootId] = { ...root, children: [...root.children, restored.id] }

    syncHtmlFrameNodesToArtifacts(synced.document)

    expect(useDesignWorkspaceStore.getState().artifacts.find((item) => item.id === 'home')?.node)
      .toMatchObject({ boardHiddenVersionIds: [] })
  })

  it('keeps legacy boardHidden as a current-version-only hidden marker', () => {
    const screen = artifact('home', 'html', {
      title: 'Home',
      relativePath: '.kun-design/doc/home/v2.html',
      versions: [
        { id: 'home-v2', relativePath: '.kun-design/doc/home/v2.html', createdAt, summary: 'Second pass' },
        { id: 'home-v1', relativePath: '.kun-design/doc/home/v1.html', createdAt, summary: 'First pass' }
      ],
      node: { x: 40, y: 60, width: 390, height: 844, sizeMode: 'auto', boardHidden: true }
    })

    const synced = syncHtmlArtifactsToBoardDocument(createEmptyDocument(), [screen])
    expect(synced.addedFrameIds.map((id) => synced.document.objects[id]?.embeddedArtifact?.versionId))
      .toEqual(['home-v1'])
  })

  it('does not recreate a board-hidden HTML artifact after its linked frame was deleted', () => {
    const screen = artifact('screen', 'html', {
      node: { x: 40, y: 60, width: 390, height: 844, sizeMode: 'auto', boardHidden: true }
    })

    const synced = syncHtmlArtifactsToBoardDocument(createEmptyDocument(), [screen])
    const root = synced.document.objects[synced.document.rootId]

    expect(synced.addedFrameIds).toEqual([])
    expect(root.children).toEqual([])
  })

  it('recreates a previously hidden HTML artifact once boardHidden is cleared', () => {
    const screen = artifact('screen', 'html', {
      title: 'Restored',
      node: { x: 40, y: 60, width: 390, height: 844, sizeMode: 'auto', boardHidden: false }
    })

    const synced = syncHtmlArtifactsToBoardDocument(createEmptyDocument(), [screen])
    const frame = synced.document.objects[synced.addedFrameIds[0]]

    expect(synced.addedFrameIds).toHaveLength(1)
    expect(frame).toMatchObject({
      type: 'frame',
      name: 'Restored',
      htmlArtifactId: 'screen',
      x: 40,
      y: 60,
      width: 1280,
      height: 844
    })
  })

  it('keeps an existing board-hidden frame and clears the hidden flag during node sync', () => {
    const screen = artifact('screen', 'html', {
      title: 'Restored',
      node: { x: 40, y: 60, width: 390, height: 844, sizeMode: 'auto', boardHidden: true }
    })
    installDesignDocument([screen], screen.id)
    useDesignWorkspaceStore.setState({ designContext: { designTarget: 'app' } })
    const doc = createEmptyDocument()
    const frame = createHtmlFrameShape('Restored', 40, 60, 'screen', 'mobile')
    doc.objects[frame.id] = { ...frame, parentId: doc.rootId }
    doc.objects[doc.rootId] = { ...doc.objects[doc.rootId], children: [frame.id] }

    const synced = syncHtmlArtifactsToBoardDocument(doc, [screen])
    syncHtmlFrameNodesToArtifacts(synced.document)

    expect(synced.addedFrameIds).toEqual([])
    expect(synced.removedFrameIds).toEqual([])
    expect(useDesignWorkspaceStore.getState().artifacts.find((item) => item.id === 'screen')?.node)
      .toMatchObject({ boardHidden: false, x: 40, y: 60, width: 390, height: 844 })
  })

  it('only writes the current version frame back to the artifact node', () => {
    const v1 = artifact('home', 'html', {
      relativePath: '.kun-design/doc/home/v2.html',
      versions: [
        { id: 'home-v2', relativePath: '.kun-design/doc/home/v2.html', createdAt, summary: 'Current' },
        { id: 'home-v1', relativePath: '.kun-design/doc/home/v1.html', createdAt, summary: 'History' }
      ],
      node: { x: 10, y: 20, width: 1280, height: 800, sizeMode: 'manual' }
    })
    installDesignDocument([v1], v1.id)
    const doc = createEmptyDocument()
    const historical = createHtmlFrameShape('Home · v1', 100, 100, 'home', 'desktop', 'home-v1')
    historical.width = 300
    historical.height = 400
    const current = createHtmlFrameShape('Home', 500, 120, 'home', 'desktop', 'home-v2')
    current.width = 1280
    current.height = 800
    doc.objects[historical.id] = { ...historical, parentId: doc.rootId }
    doc.objects[current.id] = { ...current, parentId: doc.rootId }
    doc.objects[doc.rootId] = { ...doc.objects[doc.rootId], children: [historical.id, current.id] }

    syncHtmlFrameNodesToArtifacts(doc)

    expect(useDesignWorkspaceStore.getState().artifacts[0]?.node).toMatchObject({
      x: 500,
      y: 120,
      width: 1280,
      height: 800
    })
  })

  it('detects deleted linked HTML frames only when no replacement frame remains', () => {
    const before = createEmptyDocument()
    const frame = createHtmlFrameShape('Screen', 40, 60, 'screen', 'mobile')
    before.objects[frame.id] = { ...frame, parentId: before.rootId }
    before.objects[before.rootId] = { ...before.objects[before.rootId], children: [frame.id] }

    expect(removedLinkedHtmlArtifactIds(before, createEmptyDocument())).toEqual(['screen'])

    const replacement = createHtmlFrameShape('Screen copy', 80, 90, 'screen', 'mobile')
    const afterWithReplacement = createEmptyDocument()
    afterWithReplacement.objects[replacement.id] = { ...replacement, parentId: afterWithReplacement.rootId }
    afterWithReplacement.objects[afterWithReplacement.rootId] = {
      ...afterWithReplacement.objects[afterWithReplacement.rootId],
      children: [replacement.id]
    }
    expect(removedLinkedHtmlArtifactIds(before, afterWithReplacement)).toEqual([])
  })

  it('removes linked HTML frames whose artifact has been deleted', () => {
    const doc = createEmptyDocument()
    const root = doc.objects[doc.rootId]
    const orphan = createHtmlFrameShape('Deleted Screen', 40, 60, 'deleted-artifact', 'desktop')
    const child = createDefaultShape('rect', 80, 120)
    child.parentId = orphan.id
    orphan.children = [child.id]
    doc.objects[orphan.id] = { ...orphan, parentId: doc.rootId }
    doc.objects[child.id] = child
    doc.objects[doc.rootId] = { ...root, children: [orphan.id] }

    const synced = syncHtmlArtifactsToBoardDocument(doc, [])

    expect(synced.removedFrameIds).toEqual([orphan.id])
    expect(synced.addedFrameIds).toEqual([])
    expect(synced.updatedFrameIds).toEqual([])
    expect(synced.document.objects[orphan.id]).toBeUndefined()
    expect(synced.document.objects[child.id]).toBeUndefined()
    expect(synced.document.objects[synced.document.rootId]?.children).toEqual([])
  })

  it('removes duplicate linked frames for the same HTML artifact and keeps the first frame', () => {
    const doc = createEmptyDocument()
    const root = doc.objects[doc.rootId]
    const first = createHtmlFrameShape('Home copy 1', 40, 60, 'home', 'desktop')
    const duplicate = createHtmlFrameShape('Home copy 2', 1440, 60, 'home', 'desktop')
    const duplicateChild = createDefaultShape('rect', 1480, 120)
    duplicateChild.parentId = duplicate.id
    duplicate.children = [duplicateChild.id]
    doc.objects[first.id] = { ...first, parentId: doc.rootId }
    doc.objects[duplicate.id] = { ...duplicate, parentId: doc.rootId }
    doc.objects[duplicateChild.id] = duplicateChild
    doc.objects[doc.rootId] = { ...root, children: [first.id, duplicate.id] }

    const synced = syncHtmlArtifactsToBoardDocument(doc, [
      artifact('home', 'html', {
        title: 'Home',
        node: { x: 40, y: 60, width: 1280, height: 800, sizeMode: 'auto' }
      })
    ])

    expect(synced.removedFrameIds).toEqual([duplicate.id])
    expect(synced.addedFrameIds).toEqual([])
    expect(synced.document.objects[first.id]).toMatchObject({
      htmlArtifactId: 'home',
      name: 'Home'
    })
    expect(synced.document.objects[duplicate.id]).toBeUndefined()
    expect(synced.document.objects[duplicateChild.id]).toBeUndefined()
    expect(synced.document.objects[synced.document.rootId]?.children).toEqual([first.id])
  })

  it('uses real screen dimensions and current viewport placement for implicit default artifact nodes', () => {
    useCanvasViewportStore.getState().setVbox({ x: 1000, y: 500, width: 1600, height: 1000 })
    const screen = artifact('home', 'html', { node: defaultDesignArtifactNode(5) })

    const synced = syncHtmlArtifactsToBoardDocument(createEmptyDocument(), [screen])

    expect(synced.addedFrameIds).toHaveLength(1)
    const frame = synced.document.objects[synced.addedFrameIds[0]]
    expect(frame).toMatchObject({
      htmlArtifactId: 'home',
      x: 1160,
      y: 600,
      width: 1280,
      height: 800
    })
  })

  it('clamps tiny manual artifact nodes to the minimum usable HTML frame size', () => {
    const screen = artifact('tiny', 'html', {
      node: { x: 40, y: 60, width: 100, height: 120, sizeMode: 'manual' }
    })

    const synced = syncHtmlArtifactsToBoardDocument(createEmptyDocument(), [screen])

    expect(synced.addedFrameIds).toHaveLength(1)
    const frame = synced.document.objects[synced.addedFrameIds[0]]
    expect(frame).toMatchObject({
      htmlArtifactId: 'tiny',
      x: 40,
      y: 60,
      width: 240,
      height: 180
    })
  })

  it('repairs existing linked HTML frames that are smaller than the usable minimum', () => {
    const doc = createEmptyDocument()
    const root = doc.objects[doc.rootId]
    const existing = createHtmlFrameShape('Tiny', 80, 120, 'tiny', 'desktop')
    existing.width = 100
    existing.height = 120
    doc.objects[existing.id] = { ...existing, parentId: doc.rootId }
    doc.objects[doc.rootId] = { ...root, children: [existing.id] }

    const synced = syncHtmlArtifactsToBoardDocument(doc, [
      artifact('tiny', 'html', {
        title: 'Tiny',
        node: { x: 80, y: 120, width: 100, height: 120, sizeMode: 'manual' }
      })
    ])

    expect(synced.updatedFrameIds).toEqual([existing.id])
    expect(synced.document.objects[existing.id]).toMatchObject({
      x: 80,
      y: 120,
      width: 240,
      height: 180
    })
  })

  it('syncs implicit app-target preview nodes into mobile screen frames', () => {
    useDesignWorkspaceStore.setState({ designContext: { designTarget: 'app' } })
    const screen = artifact('home', 'html', {
      node: {
        ...defaultDesignArtifactNode(0),
        ...defaultPreviewNodeSizeForDesignTarget('app')
      }
    })

    const synced = syncHtmlArtifactsToBoardDocument(createEmptyDocument(), [screen])

    expect(synced.addedFrameIds).toHaveLength(1)
    const frame = synced.document.objects[synced.addedFrameIds[0]]
    expect(frame).toMatchObject({
      htmlArtifactId: 'home',
      width: 390,
      height: 844,
      devicePreset: 'mobile'
    })
  })

  it('uses full desktop frames for foundation artifacts instead of compact preview cards', () => {
    useDesignWorkspaceStore.setState({ designContext: { designTarget: 'app' } })
    const logo = artifact('logo', 'html', {
      title: 'Logo',
      role: 'logo',
      node: defaultDesignArtifactNode(0)
    })

    const synced = syncHtmlArtifactsToBoardDocument(createEmptyDocument(), [logo])

    expect(synced.addedFrameIds).toHaveLength(1)
    const frame = synced.document.objects[synced.addedFrameIds[0]]
    expect(frame).toMatchObject({
      htmlArtifactId: 'logo',
      width: 1280,
      height: 800,
      devicePreset: 'desktop'
    })
  })

  it('uses full desktop frames for localized foundation-title artifacts when role metadata is missing', () => {
    useDesignWorkspaceStore.setState({ designContext: { designTarget: 'app' } })
    const system = artifact('system', 'html', {
      title: '设计系统',
      node: { x: 80, y: 120, width: 390, height: 844, sizeMode: 'manual' }
    })

    const synced = syncHtmlArtifactsToBoardDocument(createEmptyDocument(), [system])

    expect(synced.addedFrameIds).toHaveLength(1)
    const frame = synced.document.objects[synced.addedFrameIds[0]]
    expect(frame).toMatchObject({
      htmlArtifactId: 'system',
      width: 1280,
      height: 800,
      devicePreset: 'desktop'
    })
  })

  it('preserves custom manual foundation frame nodes when syncing unmounted artifacts', () => {
    useDesignWorkspaceStore.setState({ designContext: { designTarget: 'app' } })
    const system = artifact('system', 'html', {
      title: '设计系统',
      node: { x: 80, y: 120, width: 760, height: 1320, sizeMode: 'manual' }
    })

    const synced = syncHtmlArtifactsToBoardDocument(createEmptyDocument(), [system])

    expect(synced.addedFrameIds).toHaveLength(1)
    const frame = synced.document.objects[synced.addedFrameIds[0]]
    expect(frame).toMatchObject({
      htmlArtifactId: 'system',
      x: 80,
      y: 120,
      width: 760,
      height: 1320,
      devicePreset: 'desktop'
    })
  })

  it('upgrades existing foundation frames from old manual mobile nodes to full desktop frames', () => {
    useDesignWorkspaceStore.setState({ designContext: { designTarget: 'app' } })
    const doc = createEmptyDocument()
    const root = doc.objects[doc.rootId]
    const existing = createHtmlFrameShape('Logo', 80, 120, 'logo', 'mobile')
    existing.width = 390
    existing.height = 844
    doc.objects[existing.id] = { ...existing, parentId: doc.rootId }
    doc.objects[doc.rootId] = { ...root, children: [existing.id] }

    const synced = syncHtmlArtifactsToBoardDocument(doc, [
      artifact('logo', 'html', {
        title: 'Logo',
        role: 'logo',
        node: { x: 80, y: 120, width: 390, height: 844, sizeMode: 'manual' }
      })
    ])

    expect(synced.updatedFrameIds).toEqual([existing.id])
    expect(synced.document.objects[existing.id]).toMatchObject({
      x: 80,
      y: 120,
      width: 1280,
      height: 800,
      devicePreset: 'desktop'
    })
  })

  it('keeps existing manually resized foundation frames fixed across board sync', () => {
    useDesignWorkspaceStore.setState({ designContext: { designTarget: 'app' } })
    const doc = createEmptyDocument()
    const root = doc.objects[doc.rootId]
    const existing = createHtmlFrameShape('设计系统', 80, 120, 'system', 'desktop')
    existing.width = 760
    existing.height = 1320
    doc.objects[existing.id] = { ...existing, parentId: doc.rootId }
    doc.objects[doc.rootId] = { ...root, children: [existing.id] }

    const synced = syncHtmlArtifactsToBoardDocument(doc, [
      artifact('system', 'html', {
        title: '设计系统',
        node: { x: 80, y: 120, width: 760, height: 1320, sizeMode: 'manual' }
      })
    ])

    expect(synced.updatedFrameIds).toEqual([])
    expect(synced.document.objects[existing.id]).toMatchObject({
      x: 80,
      y: 120,
      width: 760,
      height: 1320,
      devicePreset: 'desktop'
    })
  })

  it('keeps measured auto height but upgrades legacy compact foundation width after board sync', () => {
    useDesignWorkspaceStore.setState({ designContext: { designTarget: 'app' } })
    const doc = createEmptyDocument()
    const root = doc.objects[doc.rootId]
    const existing = createHtmlFrameShape('设计系统', 80, 120, 'system', 'desktop')
    existing.width = 420
    existing.height = 340
    doc.objects[existing.id] = { ...existing, parentId: doc.rootId }
    doc.objects[doc.rootId] = { ...root, children: [existing.id] }

    const synced = syncHtmlArtifactsToBoardDocument(doc, [
      artifact('system', 'html', {
        title: '设计系统',
        node: { x: 80, y: 120, width: 420, height: 236, sizeMode: 'auto' }
      })
    ])

    expect(synced.updatedFrameIds).toEqual([existing.id])
    expect(synced.document.objects[existing.id]).toMatchObject({
      x: 80,
      y: 120,
      width: 1280,
      height: 236,
      devicePreset: 'desktop'
    })
  })

  it('keeps target-default synced frames in auto size mode', () => {
    const screen = artifact('home', 'html', {
      node: {
        ...defaultDesignArtifactNode(0),
        ...defaultPreviewNodeSizeForDesignTarget('web')
      }
    })
    installDesignDocument([screen], screen.id)
    const doc = createEmptyDocument()
    const root = doc.objects[doc.rootId]
    const frame = createHtmlFrameShape('Home', 80, 120, 'home', 'desktop')
    frame.width = 1280
    frame.height = 800
    doc.objects[frame.id] = { ...frame, parentId: doc.rootId }
    doc.objects[doc.rootId] = { ...root, children: [frame.id] }

    syncHtmlFrameNodesToArtifacts(doc)

    const updated = useDesignWorkspaceStore.getState().artifacts.find((item) => item.id === 'home')
    expect(updated?.node).toMatchObject({
      x: 80,
      y: 120,
      width: 1280,
      height: 800,
      sizeMode: 'auto'
    })
  })

  it('does not let duplicate linked frames overwrite artifact node geometry', () => {
    const screen = artifact('home', 'html', {
      node: {
        x: 80,
        y: 120,
        width: 1280,
        height: 800,
        sizeMode: 'auto'
      }
    })
    installDesignDocument([screen], screen.id)
    const doc = createEmptyDocument()
    const root = doc.objects[doc.rootId]
    const first = createHtmlFrameShape('Home', 80, 120, 'home', 'desktop')
    first.width = 1280
    first.height = 800
    const duplicate = createHtmlFrameShape('Home copy', 2400, 900, 'home', 'desktop')
    duplicate.width = 600
    duplicate.height = 420
    doc.objects[first.id] = { ...first, parentId: doc.rootId }
    doc.objects[duplicate.id] = { ...duplicate, parentId: doc.rootId }
    doc.objects[doc.rootId] = { ...root, children: [first.id, duplicate.id] }

    syncHtmlFrameNodesToArtifacts(doc)

    const updated = useDesignWorkspaceStore.getState().artifacts.find((item) => item.id === 'home')
    expect(updated?.node).toMatchObject({
      x: 80,
      y: 120,
      width: 1280,
      height: 800,
      sizeMode: 'auto'
    })
  })

  it('resizes existing auto frames when the design target changes', () => {
    useDesignWorkspaceStore.setState({ designContext: { designTarget: 'app' } })
    const screen = artifact('home', 'html', {
      node: {
        x: 80,
        y: 120,
        width: 1280,
        height: 800,
        sizeMode: 'auto'
      }
    })
    const doc = createEmptyDocument()
    const root = doc.objects[doc.rootId]
    const frame = createHtmlFrameShape('Home', 80, 120, 'home', 'desktop')
    frame.width = 1280
    frame.height = 800
    doc.objects[frame.id] = { ...frame, parentId: doc.rootId }
    doc.objects[doc.rootId] = { ...root, children: [frame.id] }

    const synced = syncHtmlArtifactsToBoardDocument(doc, [screen])

    expect(synced.updatedFrameIds).toEqual([frame.id])
    expect(synced.document.objects[frame.id]).toMatchObject({
      x: 80,
      y: 120,
      width: 390,
      height: 844,
      devicePreset: 'mobile'
    })
  })

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
