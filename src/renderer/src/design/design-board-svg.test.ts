import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildDesignArtifactSyncKey,
  removedLinkedArtifactIds,
  removedLinkedArtifactReferences,
  syncDesignArtifactsToBoardDocument,
  syncSvgFrameNodesToArtifacts
} from './design-board-svg'
import {
  createDefaultShape,
  createEmptyDocument,
  createHtmlFrameShape,
  createSvgFrameShape,
  isSvgFrame
} from './canvas/canvas-types'
import { useCanvasViewportStore } from './canvas/canvas-viewport-store'
import { useDesignWorkspaceStore } from './design-workspace-store'
import { artifact, installDesignDocument } from './design-board.test-helpers'

describe('SVG artifact board synchronization', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      kunGui: { writeWorkspaceFile: vi.fn(async () => ({ ok: true as const })) }
    })
    useCanvasViewportStore.getState().setContainerSize(1200, 800)
    useCanvasViewportStore.getState().setVbox({ x: -600, y: -400, width: 1200, height: 800 })
    useDesignWorkspaceStore.setState({ designContext: { designTarget: 'web' } })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('includes SVG version, geometry, and hidden state in the artifact sync key', () => {
    const visible = artifact('motion', 'svg', {
      relativePath: '.kun-design/doc/motion/v1.svg',
      node: { x: 10, y: 20, width: 320, height: 240, sizeMode: 'manual' }
    })
    const changed = {
      ...visible,
      relativePath: '.kun-design/doc/motion/v2.svg',
      node: { ...visible.node!, boardHidden: true }
    }
    expect(buildDesignArtifactSyncKey([visible], 'web')).not.toBe(
      buildDesignArtifactSyncKey([changed], 'web')
    )
  })

  it('materializes a persisted SVG artifact as a first-class linked frame', () => {
    const motion = artifact('motion', 'svg', {
      title: 'Orbit loader',
      relativePath: '.kun-design/doc/motion/v1.svg',
      node: { x: 120, y: 80, width: 320, height: 240, sizeMode: 'manual', viewMode: 'preview' }
    })
    const synced = syncDesignArtifactsToBoardDocument(createEmptyDocument(), [motion])

    expect(synced.addedFrameIds).toHaveLength(1)
    const frame = synced.document.objects[synced.addedFrameIds[0]]
    expect(frame && isSvgFrame(frame)).toBe(true)
    expect(frame).toMatchObject({
      name: 'Orbit loader',
      x: 120,
      y: 80,
      width: 320,
      height: 240,
      parentId: synced.document.rootId,
      frameId: null,
      embeddedArtifact: { id: 'motion', kind: 'svg' }
    })
  })

  it('repairs legacy nested SVG frames back to the root tree', () => {
    const motion = artifact('motion', 'svg')
    const document = createEmptyDocument()
    const container = createSvgFrameShape('Wrong parent', 0, 0, 'other')
    delete container.embeddedArtifact
    container.type = 'group'
    container.parentId = document.rootId
    const frame = createSvgFrameShape('Motion', 20, 30, motion.id)
    frame.parentId = container.id
    frame.frameId = container.id
    container.children = [frame.id]
    document.objects[container.id] = container
    document.objects[frame.id] = frame
    document.objects[document.rootId].children = [container.id]

    const synced = syncDesignArtifactsToBoardDocument(document, [motion])

    expect(synced.updatedFrameIds).toContain(frame.id)
    expect(synced.document.objects[frame.id]).toMatchObject({
      parentId: synced.document.rootId,
      frameId: null
    })
    expect(synced.document.objects[container.id].children).not.toContain(frame.id)
    expect(synced.document.objects[synced.document.rootId].children).toContain(frame.id)
  })

  it('keeps DOM-backed artifact frames in the explicit top portal layer', () => {
    const motion = artifact('motion', 'svg')
    const document = createEmptyDocument()
    const frame = createSvgFrameShape('Motion', 20, 30, motion.id)
    const rect = createDefaultShape('rect', 20, 30)
    frame.parentId = document.rootId
    rect.parentId = document.rootId
    document.objects[frame.id] = frame
    document.objects[rect.id] = rect
    // A regular canvas shape cannot actually paint above an iframe portal.
    document.objects[document.rootId].children = [frame.id, rect.id]

    const synced = syncDesignArtifactsToBoardDocument(document, [motion])
    expect(synced.document.objects[synced.document.rootId].children).toEqual([rect.id, frame.id])
  })

  it('removes duplicate SVG links and detects deletion of the last linked frame', () => {
    const motion = artifact('motion', 'svg')
    const before = createEmptyDocument()
    const first = createSvgFrameShape('Motion', 0, 0, motion.id)
    const duplicate = createSvgFrameShape('Duplicate', 700, 0, motion.id)
    before.objects[first.id] = { ...first, parentId: before.rootId }
    before.objects[duplicate.id] = { ...duplicate, parentId: before.rootId }
    before.objects[before.rootId] = {
      ...before.objects[before.rootId],
      children: [first.id, duplicate.id]
    }

    const deduped = syncDesignArtifactsToBoardDocument(before, [motion])
    expect(deduped.removedFrameIds).toEqual([duplicate.id])
    expect(removedLinkedArtifactIds(deduped.document, createEmptyDocument())).toEqual(['motion'])
  })

  it('reports a removed HTML version frame even when other versions remain', () => {
    const before = createEmptyDocument()
    const v1 = createHtmlFrameShape('Home · v1', 0, 0, 'home', 'desktop', 'home-v1')
    const v2 = createHtmlFrameShape('Home', 500, 0, 'home', 'desktop', 'home-v2')
    before.objects[v1.id] = { ...v1, parentId: before.rootId }
    before.objects[v2.id] = { ...v2, parentId: before.rootId }
    before.objects[before.rootId] = { ...before.objects[before.rootId], children: [v1.id, v2.id] }

    const after = createEmptyDocument()
    after.objects[v2.id] = { ...v2, parentId: after.rootId }
    after.objects[after.rootId] = { ...after.objects[after.rootId], children: [v2.id] }

    expect(removedLinkedArtifactReferences(before, after)).toEqual([
      { artifactId: 'home', kind: 'html', versionId: 'home-v1' }
    ])
  })

  it('does not report a version removed while another frame of the same version remains', () => {
    const before = createEmptyDocument()
    const first = createHtmlFrameShape('Home', 0, 0, 'home', 'desktop', 'home-v1')
    const duplicate = createHtmlFrameShape('Home copy', 500, 0, 'home', 'desktop', 'home-v1')
    before.objects[first.id] = { ...first, parentId: before.rootId }
    before.objects[duplicate.id] = { ...duplicate, parentId: before.rootId }
    before.objects[before.rootId] = { ...before.objects[before.rootId], children: [first.id, duplicate.id] }

    const after = createEmptyDocument()
    after.objects[first.id] = { ...first, parentId: after.rootId }
    after.objects[after.rootId] = { ...after.objects[after.rootId], children: [first.id] }

    expect(removedLinkedArtifactReferences(before, after)).toEqual([])
  })

  it('treats a legacy unversioned HTML frame as any frame of the same artifact', () => {
    const before = createEmptyDocument()
    const legacy = createHtmlFrameShape('Home', 0, 0, 'home', 'desktop')
    before.objects[legacy.id] = { ...legacy, parentId: before.rootId }
    before.objects[before.rootId] = { ...before.objects[before.rootId], children: [legacy.id] }

    const after = createEmptyDocument()
    const versioned = createHtmlFrameShape('Home', 0, 0, 'home', 'desktop', 'home-v1')
    after.objects[versioned.id] = { ...versioned, parentId: after.rootId }
    after.objects[after.rootId] = { ...after.objects[after.rootId], children: [versioned.id] }

    expect(removedLinkedArtifactReferences(before, after)).toEqual([])
  })

  it('persists SVG frame geometry back to the artifact node', () => {
    const motion = artifact('motion', 'svg', {
      node: { x: 0, y: 0, width: 640, height: 480, sizeMode: 'manual' }
    })
    installDesignDocument([motion], motion.id)
    const doc = createEmptyDocument()
    const frame = createSvgFrameShape('Motion', 44, 66, motion.id, 420, 280)
    doc.objects[frame.id] = { ...frame, parentId: doc.rootId }
    doc.objects[doc.rootId] = { ...doc.objects[doc.rootId], children: [frame.id] }

    syncSvgFrameNodesToArtifacts(doc)

    expect(useDesignWorkspaceStore.getState().artifacts[0]?.node).toMatchObject({
      x: 44,
      y: 66,
      width: 420,
      height: 280,
      sizeMode: 'manual',
      boardHidden: false
    })
  })
})
