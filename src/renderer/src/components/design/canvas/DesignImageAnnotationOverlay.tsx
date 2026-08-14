import type { ReactElement } from 'react'
import type { CanvasDocument } from '../../../design/canvas/canvas-types'
import {
  isCodeCanvasDocumentKey,
  isDesignCanvasDocumentKey
} from '../../../design/canvas/image-annotation-dispatch'
import {
  ImageAnnotationEditor,
  type ImageAnnotationResult
} from './ImageAnnotationEditor'

export type ImageAnnotationOverlayModel = {
  imageUrl: string
  workspaceRoot: string
  title: string
}

export type ResolveImageAnnotationOverlayOptions = {
  route: string
  activeSddDraft: boolean
  canvasDocumentKey?: string | null
  annotatingShapeId?: string | null
  canvasDocument: CanvasDocument
  activeCodeCanvasWorkspace: string
  designWorkspaceRoot?: string | null
  fallbackWorkspaceRoot?: string | null
}

export function resolveImageAnnotationOverlayModel(
  options: ResolveImageAnnotationOverlayOptions
): ImageAnnotationOverlayModel | null {
  const isCodeCanvasAnnotation = options.canvasDocumentKey
    ? isCodeCanvasDocumentKey(options.canvasDocumentKey)
    : options.route === 'chat'
  // The production Design whiteboard is embedded in the chat workbench. Its
  // document key lives under `.kun-design`, while the adjacent Code whiteboard
  // lives under `.kun-canvas`; both are valid chat-route annotation targets.
  const isEmbeddedDesignAnnotation = isDesignCanvasDocumentKey(options.canvasDocumentKey)
  if (
    options.route !== 'design' &&
    !(options.route === 'chat' && (isCodeCanvasAnnotation || isEmbeddedDesignAnnotation))
  ) return null
  if (options.route === 'chat' && options.activeSddDraft) return null
  const annotatingShape = options.annotatingShapeId
    ? options.canvasDocument.objects[options.annotatingShapeId]
    : undefined
  if (!annotatingShape || annotatingShape.type !== 'image' || !annotatingShape.imageUrl) {
    return null
  }
  const workspaceRoot = isCodeCanvasAnnotation
    ? options.activeCodeCanvasWorkspace
    : options.designWorkspaceRoot || options.fallbackWorkspaceRoot || ''
  return {
    imageUrl: annotatingShape.imageUrl,
    workspaceRoot,
    title: annotatingShape.name
  }
}

export type DesignImageAnnotationOverlayProps = ResolveImageAnnotationOverlayOptions & {
  busy: boolean
  onCancel: () => void
  onApply: (result: ImageAnnotationResult) => void
}

export function DesignImageAnnotationOverlay(
  props: DesignImageAnnotationOverlayProps
): ReactElement | null {
  const model = resolveImageAnnotationOverlayModel(props)
  if (!model) return null
  return (
    <ImageAnnotationEditor
      imageUrl={model.imageUrl}
      workspaceRoot={model.workspaceRoot}
      title={model.title}
      busy={props.busy}
      onCancel={props.onCancel}
      onApply={props.onApply}
    />
  )
}
