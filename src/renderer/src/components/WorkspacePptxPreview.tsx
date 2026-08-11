import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { WorkspaceOfficePreviewSuccess } from '@shared/office-document'
import { WorkspaceOfficePreviewToolbar } from './WorkspaceOfficePreviewToolbar'
import {
  openWorkspaceOfficeExternalLink,
  secureWorkspaceOfficeLinks
} from './workspace-office-external-link'

type PptxPreviewer = ReturnType<typeof import('pptx-preview')['init']>

export function WorkspacePptxPreview({
  result,
  loading,
  refreshError
}: {
  result: WorkspaceOfficePreviewSuccess
  loading: boolean
  refreshError?: string | null
}): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const previewerRef = useRef<PptxPreviewer | null>(null)
  const renderIdRef = useRef(0)
  const [slide, setSlide] = useState(1)
  const [slideCount, setSlideCount] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const renderId = ++renderIdRef.current
    const staging = document.createElement('div')
    staging.className = 'workspace-pptx-stage'
    staging.style.visibility = 'hidden'
    host.append(staging)
    let stagedPreviewer: PptxPreviewer | null = null
    void import('pptx-preview')
      .then(async ({ init }) => {
        stagedPreviewer = init(staging, { width: 960, height: 540, mode: 'slide' })
        await stagedPreviewer.preview(asArrayBuffer(result.data))
        if (renderId !== renderIdRef.current) {
          stagedPreviewer.destroy()
          staging.remove()
          return
        }
        secureWorkspaceOfficeLinks(staging)
        previewerRef.current?.destroy()
        for (const child of Array.from(host.children)) {
          if (child !== staging) child.remove()
        }
        staging.style.visibility = 'visible'
        previewerRef.current = stagedPreviewer
        const count = Math.max(1, stagedPreviewer.slideCount)
        setSlideCount(count)
        setSlide(1)
        setError(null)
      })
      .catch((cause) => {
        stagedPreviewer?.destroy()
        staging.remove()
        if (renderId === renderIdRef.current) setError(errorMessage(cause))
      })
    return () => {
      renderIdRef.current += 1
      if (stagedPreviewer !== previewerRef.current) {
        stagedPreviewer?.destroy()
        staging.remove()
      }
    }
  }, [result.data, result.sourceSha256])

  useEffect(() => () => {
    renderIdRef.current += 1
    previewerRef.current?.destroy()
    previewerRef.current = null
    hostRef.current?.replaceChildren()
  }, [])

  const goToSlide = (next: number): void => {
    const safeSlide = Math.min(slideCount, Math.max(1, next))
    previewerRef.current?.renderSingleSlide(safeSlide - 1)
    if (hostRef.current) secureWorkspaceOfficeLinks(hostRef.current)
    setSlide(safeSlide)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-ds-surface-subtle">
      <WorkspaceOfficePreviewToolbar
        result={result}
        loading={loading}
        refreshError={refreshError}
        viewerError={error}
        zoom={zoom}
        onZoomChange={setZoom}
      >
        <div className="flex items-center gap-1 rounded border border-ds-border-muted px-1 py-0.5">
          <button type="button" aria-label="Previous slide" disabled={slide <= 1} className="rounded p-0.5 hover:bg-ds-hover disabled:opacity-40" onClick={() => goToSlide(slide - 1)}>
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span aria-label={`Slide ${slide} of ${slideCount}`}>Slide {slide} / {slideCount}</span>
          <button type="button" aria-label="Next slide" disabled={slide >= slideCount} className="rounded p-0.5 hover:bg-ds-hover disabled:opacity-40" onClick={() => goToSlide(slide + 1)}>
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </WorkspaceOfficePreviewToolbar>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div
          className="mx-auto origin-top"
          style={{ width: '960px', minHeight: '540px', transform: `scale(${zoom})` }}
        >
          <div
            ref={hostRef}
            onClick={openWorkspaceOfficeExternalLink}
            className="workspace-pptx-preview [&_.pptx-preview-wrapper-next]:hidden [&_.pptx-preview-wrapper-pagination]:hidden"
          />
        </div>
      </div>
    </div>
  )
}

function asArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message || 'This PowerPoint presentation could not be rendered.'
}
