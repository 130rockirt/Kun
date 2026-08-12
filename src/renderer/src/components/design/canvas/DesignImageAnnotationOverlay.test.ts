import { describe, expect, it } from 'vitest'
import {
  createDefaultShape,
  createEmptyDocument
} from '../../../design/canvas/canvas-types'
import { resolveImageAnnotationOverlayModel } from './DesignImageAnnotationOverlay'

function imageDocument() {
  const document = createEmptyDocument()
  const image = createDefaultShape('image', 0, 0)
  image.id = 'image_1'
  image.name = 'Annotated image'
  image.imageUrl = '.deepseekgui-images/image.png'
  document.objects[image.id] = image
  return document
}

describe('DesignImageAnnotationOverlay', () => {
  it('shows the editor for design image annotations', () => {
    expect(resolveImageAnnotationOverlayModel({
      route: 'design',
      activeSddDraft: false,
      canvasDocument: imageDocument(),
      annotatingShapeId: 'image_1',
      activeCodeCanvasWorkspace: '/code',
      designWorkspaceRoot: '/design',
      fallbackWorkspaceRoot: '/fallback'
    })).toEqual({
      imageUrl: '.deepseekgui-images/image.png',
      workspaceRoot: '/design',
      title: 'Annotated image'
    })
  })

  it('uses the code workspace for code-canvas annotations', () => {
    expect(resolveImageAnnotationOverlayModel({
      route: 'chat',
      activeSddDraft: false,
      canvasDocumentKey: `workspace\0.kun-canvas/code-thread/canvas.json`,
      canvasDocument: imageDocument(),
      annotatingShapeId: 'image_1',
      activeCodeCanvasWorkspace: '/code',
      designWorkspaceRoot: '/design',
      fallbackWorkspaceRoot: '/fallback'
    })?.workspaceRoot).toBe('/code')
  })

  it('shows the embedded Design editor on the production chat route', () => {
    expect(resolveImageAnnotationOverlayModel({
      route: 'chat',
      activeSddDraft: false,
      canvasDocumentKey: `workspace\0.kun-design/doc/board/canvas.json`,
      canvasDocument: imageDocument(),
      annotatingShapeId: 'image_1',
      activeCodeCanvasWorkspace: '/code',
      designWorkspaceRoot: '/design',
      fallbackWorkspaceRoot: '/fallback'
    })).toEqual({
      imageUrl: '.deepseekgui-images/image.png',
      workspaceRoot: '/design',
      title: 'Annotated image'
    })
  })

  it('hides unrelated chat contexts and while an SDD draft is active', () => {
    const document = imageDocument()

    expect(resolveImageAnnotationOverlayModel({
      route: 'chat',
      activeSddDraft: false,
      canvasDocumentKey: 'workspace/notes/document.md',
      canvasDocument: document,
      annotatingShapeId: 'image_1',
      activeCodeCanvasWorkspace: '/code'
    })).toBeNull()

    expect(resolveImageAnnotationOverlayModel({
      route: 'chat',
      activeSddDraft: true,
      canvasDocumentKey: `workspace\0.kun-canvas/code-thread/canvas.json`,
      canvasDocument: document,
      annotatingShapeId: 'image_1',
      activeCodeCanvasWorkspace: '/code'
    })).toBeNull()
  })

  it('requires a selected filled image shape', () => {
    const document = createEmptyDocument()
    const emptyImage = createDefaultShape('image', 0, 0)
    emptyImage.id = 'image_1'
    document.objects[emptyImage.id] = emptyImage

    expect(resolveImageAnnotationOverlayModel({
      route: 'design',
      activeSddDraft: false,
      canvasDocument: document,
      annotatingShapeId: 'image_1',
      activeCodeCanvasWorkspace: '/code'
    })).toBeNull()
  })
})
