import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { WorkspaceOfficePreviewSuccess, WorkspaceOfficeSelection } from '@shared/office-document'
import { WorkspaceOfficePreviewToolbar } from './WorkspaceOfficePreviewToolbar'
import {
  openWorkspaceOfficeExternalLink,
  secureWorkspaceOfficeLinks
} from './workspace-office-external-link'
import {
  emptyWorkspaceOfficeSelection,
  pageFromDocxNode,
  selectionFromOfficeDom
} from './workspace-office-selection'
import { subscribeKnowledgeSourceNavigation } from '../lib/knowledge-source-navigation'

export function WorkspaceDocxPreview({
  result,
  loading,
  refreshError,
  onSelectionChange
}: {
  result: WorkspaceOfficePreviewSuccess
  loading: boolean
  refreshError?: string | null
  onSelectionChange?: (selection: WorkspaceOfficeSelection) => void
}): ReactElement {
  const bodyRef = useRef<HTMLDivElement>(null)
  const styleRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const renderIdRef = useRef(0)
  const [page, setPage] = useState(1)
  const [pageCount, setPageCount] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const body = bodyRef.current
    const style = styleRef.current
    if (!body || !style) return
    const renderId = ++renderIdRef.current
    const stagedBody = document.createElement('div')
    const stagedStyle = document.createElement('div')
    void import('docx-preview')
      .then(async ({ renderAsync }) => {
        await renderAsync(result.data, stagedBody, stagedStyle, {
          breakPages: true,
          ignoreLastRenderedPageBreak: false,
          renderAltChunks: false,
          useBase64URL: true
        })
        if (renderId !== renderIdRef.current) return
        secureWorkspaceOfficeLinks(stagedBody)
        body.replaceChildren(...Array.from(stagedBody.childNodes))
        style.replaceChildren(...Array.from(stagedStyle.childNodes))
        const count = Math.max(1, docxPages(body).length)
        setPageCount(count)
        setPage((current) => Math.min(current, count))
        setError(null)
      })
      .catch((cause) => {
        if (renderId === renderIdRef.current) setError(errorMessage(cause))
      })
    return () => {
      renderIdRef.current += 1
    }
  }, [result.data, result.sourceSha256])

  useEffect(() => {
    if (!onSelectionChange) return
    const empty = (): void => onSelectionChange(
      emptyWorkspaceOfficeSelection('word', result.sourceFormat)
    )
    const sync = (): void => {
      const body = bodyRef.current
      const selection = window.getSelection()
      if (!body || !selection?.anchorNode || !body.contains(selection.anchorNode)) return
      onSelectionChange(selectionFromOfficeDom(
        body,
        'word',
        result.sourceFormat,
        (node) => ({ page: pageFromDocxNode(node, body) })
      ))
    }
    empty()
    document.addEventListener('selectionchange', sync)
    return () => {
      document.removeEventListener('selectionchange', sync)
      empty()
    }
  }, [onSelectionChange, result.sourceFormat, result.sourceSha256, zoom])

  useEffect(() => () => {
    renderIdRef.current += 1
    bodyRef.current?.replaceChildren()
    styleRef.current?.replaceChildren()
  }, [])

  const goToPage = (next: number): void => {
    const safePage = Math.min(pageCount, Math.max(1, next))
    onSelectionChange?.(emptyWorkspaceOfficeSelection('word', result.sourceFormat))
    window.getSelection()?.removeAllRanges()
    setPage(safePage)
    docxPages(bodyRef.current)[safePage - 1]?.scrollIntoView({ block: 'start' })
  }

  useEffect(() => subscribeKnowledgeSourceNavigation(result.path, (location) => {
    if (location.kind !== 'word') return false
    const paragraphs = bodyRef.current?.querySelectorAll<HTMLElement>('p')
    const target = paragraphs?.[Math.max(0, location.paragraphStart - 1)]
    if (!target) return false
    target.scrollIntoView({ block: 'center' })
    return true
  }), [pageCount, result.path])

  const onScroll = (): void => {
    const viewport = scrollRef.current
    if (!viewport) return
    const viewportTop = viewport.getBoundingClientRect().top
    let nearestPage = 1
    let nearestDistance = Number.POSITIVE_INFINITY
    docxPages(bodyRef.current).forEach((section, index) => {
      const distance = Math.abs(section.getBoundingClientRect().top - viewportTop)
      if (distance < nearestDistance) {
        nearestPage = index + 1
        nearestDistance = distance
      }
    })
    setPage(nearestPage)
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
          <button type="button" aria-label="Previous page" disabled={page <= 1} className="rounded p-0.5 hover:bg-ds-hover disabled:opacity-40" onClick={() => goToPage(page - 1)}>
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span aria-label={`Page ${page} of ${pageCount}`}>Page {page} / {pageCount}</span>
          <button type="button" aria-label="Next page" disabled={page >= pageCount} className="rounded p-0.5 hover:bg-ds-hover disabled:opacity-40" onClick={() => goToPage(page + 1)}>
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </WorkspaceOfficePreviewToolbar>
      <div ref={styleRef} className="hidden" />
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-auto p-4">
        <div
          className="origin-top-left"
          style={{ width: `${100 / zoom}%`, transform: `scale(${zoom})` }}
          onClick={openWorkspaceOfficeExternalLink}
        >
          <div ref={bodyRef} className="workspace-docx-preview" />
        </div>
      </div>
    </div>
  )
}

function docxPages(container: HTMLElement | null): HTMLElement[] {
  return container ? Array.from(container.querySelectorAll<HTMLElement>('section.docx')) : []
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message || 'This Word document could not be rendered.'
}
