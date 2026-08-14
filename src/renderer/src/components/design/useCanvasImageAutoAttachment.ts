import { useCallback, useEffect, useRef } from 'react'
import type { AttachmentReference } from '../../agent/types'
import {
  canvasAutoAttachmentReference,
  parseCanvasImageDataUrl,
  removeCanvasAutoAttachmentById,
  selectedCanvasImageAttachmentCandidate
} from '../../design/canvas/canvas-image-auto-attachment'
import type { CanvasDocument } from '../../design/canvas/canvas-types'
import type { ImageAttachmentUploadCapabilities } from '../../lib/image-attachment-upload'
import { uploadRuntimeImageAttachment } from '../../lib/runtime-image-attachment'
import type { ComposerAttachmentUpdater } from '../workbench-composer-attachments'

export type CanvasImageAutoAttachmentOptions = {
  route: string
  attachmentScope?: 'chat' | 'design'
  selectedIds: ReadonlySet<string>
  document: CanvasDocument
  workspaceRoot: string
  activeThreadId: string | null
  attachmentCapabilities?: ImageAttachmentUploadCapabilities
  setComposerAttachmentsForScope: (
    scope: 'chat' | 'design',
    updater: ComposerAttachmentUpdater
  ) => void
  getActiveWorkspace: () => string | undefined
}

export type CanvasImageAutoAttachmentState = {
  clearAutoAttachment: () => void
}

export function useCanvasImageAutoAttachment(
  options: CanvasImageAutoAttachmentOptions
): CanvasImageAutoAttachmentState {
  const autoAttachmentIdRef = useRef<string | null>(null)
  const seqRef = useRef(0)
  const dynamicRef = useRef(options)
  dynamicRef.current = options

  const clearAutoAttachment = useCallback((): void => {
    const id = autoAttachmentIdRef.current
    if (id) {
      const scope = dynamicRef.current.attachmentScope ?? 'design'
      dynamicRef.current.setComposerAttachmentsForScope(scope, (cur: AttachmentReference[]) =>
        removeCanvasAutoAttachmentById(cur, id)
      )
      autoAttachmentIdRef.current = null
    }
  }, [])

  useEffect(() => {
    const candidate = selectedCanvasImageAttachmentCandidate({
      route: options.route,
      selectedIds: options.selectedIds,
      document: options.document
    })
    if (!candidate) {
      clearAutoAttachment()
      return
    }

    const seq = ++seqRef.current

    void (async () => {
      try {
        let imageData = parseCanvasImageDataUrl(candidate.imageUrl)
        if (!imageData) {
          if (typeof window.kunGui?.readWorkspaceImage !== 'function') return
          const result = await window.kunGui.readWorkspaceImage({
            path: candidate.imageUrl,
            workspaceRoot: dynamicRef.current.workspaceRoot
          })
          if (!result.ok || seqRef.current !== seq) return
          imageData = parseCanvasImageDataUrl(result.dataUrl)
          if (!imageData) return
        } else {
          imageData = { ...imageData }
        }
        if (seqRef.current !== seq) return

        const caps = dynamicRef.current.attachmentCapabilities
        if (!caps || typeof window.kunGui?.uploadRuntimeImageAttachment !== 'function') return
        if (seqRef.current !== seq) return

        const workspace = dynamicRef.current.getActiveWorkspace()
        const threadId = dynamicRef.current.activeThreadId
        const result = await uploadRuntimeImageAttachment({
          source: {
            kind: 'base64',
            dataBase64: imageData.dataBase64,
            mimeType: imageData.mimeType
          },
          name: candidate.shapeName,
          ...(threadId ? { threadId } : {}),
          ...(workspace ? { workspace } : {})
        })
        if (seqRef.current !== seq) return

        clearAutoAttachment()
        const ref = canvasAutoAttachmentReference({
          uploaded: result.attachment,
          preview: result.preview
        })
        const scope = dynamicRef.current.attachmentScope ?? 'design'
        dynamicRef.current.setComposerAttachmentsForScope(scope, (cur) => [...cur, ref])
        autoAttachmentIdRef.current = result.attachment.id
      } catch {
        // Keep canvas selection interactions quiet if an image cannot be uploaded.
      }
    })()

    return () => {
      seqRef.current += 1
    }
  }, [
    clearAutoAttachment,
    options.attachmentScope,
    options.document,
    options.route,
    options.selectedIds
  ])

  return { clearAutoAttachment }
}
