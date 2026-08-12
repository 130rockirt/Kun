import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  commitInspectorUpdate,
  nextInspectorOpenForSelection,
  propertiesPanelShellClass,
  propertiesPanelTriggerClass,
  shouldPromoteHtmlFrameInspectorUpdateToManual,
  shouldShowImageAnnotationAction
} from './PropertiesPanel'
import { useCanvasShapeStore } from '../../../design/canvas/canvas-shape-store'
import { createEmptyDocument, createHtmlFrameShape } from '../../../design/canvas/canvas-types'
import { useCanvasUndoStore } from '../../../design/canvas/canvas-undo-store'
import { useDesignWorkspaceStore } from '../../../design/design-workspace-store'
import type { DesignArtifact, DesignDocument } from '../../../design/design-types'

const createdAt = '2026-06-20T00:00:00.000Z'

function artifact(id: string): DesignArtifact {
  const relativePath = `.kun-design/doc/${id}/v1.html`
  return {
    id,
    kind: 'html',
    title: id,
    relativePath,
    createdAt,
    updatedAt: createdAt,
    versions: [{ id: `${id}-v1`, relativePath, createdAt, summary: '' }]
  }
}

function installHtmlFrame(): string {
  const frame = createHtmlFrameShape('Home', 40, 60, 'home', 'mobile')
  const doc = createEmptyDocument()
  doc.objects[frame.id] = { ...frame, parentId: doc.rootId }
  doc.objects[doc.rootId] = { ...doc.objects[doc.rootId], children: [frame.id] }
  useCanvasShapeStore.getState().loadDocument(doc)
  const screen = artifact('home')
  const designDoc: DesignDocument = {
    id: 'doc',
    title: 'Doc',
    createdAt,
    updatedAt: createdAt,
    order: 0,
    artifacts: [
      {
        ...screen,
        node: {
          x: 40,
          y: 60,
          width: 390,
          height: 844,
          sizeMode: 'auto',
          viewMode: 'preview'
        }
      }
    ],
    activeArtifactId: screen.id
  }
  useDesignWorkspaceStore.setState({
    workspaceRoot: '/workspace',
    documents: [designDoc],
    activeDocumentId: designDoc.id,
    artifacts: designDoc.artifacts,
    activeArtifactId: screen.id,
    designContext: { designTarget: 'app' },
    fileError: null
  })
  return frame.id
}

beforeEach(() => {
  vi.stubGlobal('window', {
    kunGui: {
      writeWorkspaceFile: vi.fn(async () => ({ ok: true as const }))
    }
  })
  useCanvasShapeStore.getState().loadDocument(createEmptyDocument())
  useCanvasUndoStore.getState().clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PropertiesPanel surface layout', () => {
  it('uses a compact inspector shell on the code whiteboard', () => {
    const className = propertiesPanelShellClass('code')

    expect(className).toContain('right-[64px]')
    expect(className).toContain('top-[60px]')
    expect(className).toContain('bottom-[92px]')
    expect(className).toContain('w-[236px]')
    expect(className).toContain('max-w-[calc(100%-80px)]')
    expect(className).toContain('rounded-[14px]')
    expect(className).not.toContain('right-[76px]')
    expect(className).not.toContain('w-[252px]')
    expect(propertiesPanelShellClass('work')).toBe(className)
  })

  it('keeps the full canvas inspector shell on the design surface', () => {
    const className = propertiesPanelShellClass('design')

    expect(className).toContain('right-[76px]')
    expect(className).toContain('top-[72px]')
    expect(className).toContain('bottom-[104px]')
    expect(className).toContain('w-[252px]')
    expect(className).toContain('rounded-[18px]')
    expect(className).not.toContain('max-w-[calc(100%-80px)]')
  })

  it('positions the collapsed inspector trigger for both whiteboards', () => {
    const codeClass = propertiesPanelTriggerClass('code')
    const workClass = propertiesPanelTriggerClass('work')
    const designClass = propertiesPanelTriggerClass('design')

    expect(codeClass).toContain('right-[64px]')
    expect(codeClass).toContain('top-[60px]')
    expect(codeClass).toContain('rounded-full')
    expect(workClass).toBe(codeClass)
    expect(designClass).toContain('right-[76px]')
    expect(designClass).toContain('top-[72px]')
    expect(designClass).toContain('rounded-full')
  })

  it('shows image annotation actions on both design and code surfaces', () => {
    expect(shouldShowImageAnnotationAction('design', true)).toBe(true)
    expect(shouldShowImageAnnotationAction('code', true)).toBe(true)
    expect(shouldShowImageAnnotationAction('work', true)).toBe(true)
    expect(shouldShowImageAnnotationAction('code', false)).toBe(false)
  })

  it('collapses the inspector by default for a newly selected object', () => {
    expect(nextInspectorOpenForSelection('', 'shape-1', false, false)).toBe(false)
  })

  it('keeps the inspector open for the same selection after the user expands it', () => {
    expect(nextInspectorOpenForSelection('shape-1', 'shape-1', true, false)).toBe(true)
  })

  it('opens a new selection only when the inspector is pinned', () => {
    expect(nextInspectorOpenForSelection('shape-1', 'shape-2', true, false)).toBe(false)
    expect(nextInspectorOpenForSelection('shape-1', 'shape-2', false, true)).toBe(true)
  })

  it('collapses when the canvas selection is cleared', () => {
    expect(nextInspectorOpenForSelection('shape-1', '', true, true)).toBe(false)
  })

  it('promotes design HTML frame inspector width/height edits to manual sizing', () => {
    const frameId = installHtmlFrame()

    commitInspectorUpdate('design', 'set-w', [frameId], { width: 520 })

    const shape = useCanvasShapeStore.getState().document.objects[frameId]
    const node = useDesignWorkspaceStore.getState().artifacts.find((item) => item.id === 'home')?.node

    expect(shape.width).toBe(520)
    expect(node).toMatchObject({
      x: 40,
      y: 60,
      width: 520,
      height: 844,
      sizeMode: 'manual',
      boardHidden: false,
      viewMode: 'preview'
    })
  })

  it('keeps device preset changes in auto sizing mode', () => {
    const frameId = installHtmlFrame()

    commitInspectorUpdate('design', 'set-device-preset', [frameId], {
      devicePreset: 'desktop',
      width: 1280,
      height: 800
    })

    const shape = useCanvasShapeStore.getState().document.objects[frameId]
    const node = useDesignWorkspaceStore.getState().artifacts.find((item) => item.id === 'home')?.node

    expect(shape).toMatchObject({ devicePreset: 'desktop', width: 1280, height: 800 })
    expect(node).toMatchObject({ width: 390, height: 844, sizeMode: 'auto' })
  })

  it('does not promote non-design inspector size edits', () => {
    expect(shouldPromoteHtmlFrameInspectorUpdateToManual('code', { width: 500 })).toBe(false)
    expect(shouldPromoteHtmlFrameInspectorUpdateToManual('work', { width: 500 })).toBe(false)
    expect(shouldPromoteHtmlFrameInspectorUpdateToManual('design', { x: 20 })).toBe(false)
    expect(shouldPromoteHtmlFrameInspectorUpdateToManual('design', {
      devicePreset: 'mobile',
      width: 390,
      height: 844
    })).toBe(false)
  })
})
