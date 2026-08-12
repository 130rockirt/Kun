import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type RefObject } from 'react'
import { ChevronLeft, ChevronRight, Loader2, Minus, Plus, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy
} from 'pdfjs-dist/build/pdf.mjs'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'
import type {
  WriteEditorSelectionState,
  WriteSelectionPageRect
} from './WriteMarkdownEditor'
import { subscribeKnowledgeSourceNavigation } from '../../lib/knowledge-source-navigation'

GlobalWorkerOptions.workerSrc = pdfWorkerUrl

type Props = {
  filePath: string
  dataBase64: string
  size: number
  mtimeMs: number
  workspaceRoot: string
  viewerRef?: RefObject<HTMLDivElement | null>
  onSelectionChange: (selection: WriteEditorSelectionState) => void
}

import {
  WritePdfPage,
  bytesFromBase64,
  emptyPdfSelection,
  formatSize,
  selectionFromPdf,
  type PageText
} from './WritePdfPage'
export function WritePdfViewer({
  filePath,
  dataBase64,
  size,
  mtimeMs,
  workspaceRoot,
  viewerRef,
  onSelectionChange
}: Props): ReactElement {
  const { t } = useTranslation('common')
  const localViewerRef = useRef<HTMLDivElement | null>(null)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const selectionSyncTimerRef = useRef<number | null>(null)
  const scrollRafRef = useRef<number | null>(null)
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [scale, setScale] = useState(1.15)
  const [pageInput, setPageInput] = useState('1')
  const [currentPage, setCurrentPage] = useState(1)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchIndex, setSearchIndex] = useState(0)
  const [pageTexts, setPageTexts] = useState<PageText[]>([])
  const [committedSelectionRects, setCommittedSelectionRects] = useState<WriteSelectionPageRect[]>([])
  // Precise fragment rects are shown while dragging and kept after focus moves
  // into the assist popup, while the DOM Selection remains the text source.
  const pageCount = pdfDocument?.numPages ?? 0
  const rootRef = viewerRef ?? localViewerRef

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    setPdfDocument(null)
    setPageTexts([])
    setCommittedSelectionRects([])
    onSelectionChange(emptyPdfSelection())
    const task = getDocument({
      data: bytesFromBase64(dataBase64),
      isEvalSupported: false
    })
    void task.promise.then((pdf) => {
      if (cancelled) {
        void pdf.destroy()
        return
      }
      setPdfDocument(pdf)
      setPageInput('1')
      setCurrentPage(1)
      setLoading(false)
    }).catch((reason: unknown) => {
      if (!cancelled) {
        setError(reason instanceof Error ? reason.message : String(reason))
        setLoading(false)
      }
    })
    return () => {
      cancelled = true
      task.destroy()
    }
  }, [dataBase64, filePath, mtimeMs, onSelectionChange])

  useEffect(() => {
    return () => {
      if (pdfDocument) void pdfDocument.destroy()
    }
  }, [pdfDocument])

  useEffect(() => {
    setCommittedSelectionRects([])
    onSelectionChange(emptyPdfSelection())
  }, [onSelectionChange, scale])

  const searchMatches = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return []
    return pageTexts
      .filter((page) => page.text.toLowerCase().includes(query))
      .map((page) => page.page)
      .sort((a, b) => a - b)
  }, [pageTexts, searchQuery])
  const allPageTextLoaded = pageCount > 0 && pageTexts.length >= pageCount
  const pdfHasText = pageTexts.some((page) => page.text.trim().length > 0)
  const committedRectsByPage = useMemo(() => {
    const byPage = new Map<number, WriteSelectionPageRect[]>()
    for (const rect of committedSelectionRects) {
      const pageRects = byPage.get(rect.page)
      if (pageRects) pageRects.push(rect)
      else byPage.set(rect.page, [rect])
    }
    return byPage
  }, [committedSelectionRects])

  const updatePageText = useCallback((page: PageText): void => {
    setPageTexts((current) => {
      const existing = current.find((item) => item.page === page.page)
      if (existing?.text === page.text) return current
      const next = current.filter((item) => item.page !== page.page)
      next.push(page)
      return next.sort((a, b) => a.page - b.page)
    })
  }, [])

  const scrollToPage = useCallback((page: number): void => {
    const clamped = Math.max(1, Math.min(pageCount || 1, Math.round(page)))
    setCurrentPage(clamped)
    setPageInput(String(clamped))
    pageRefs.current.get(clamped)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [pageCount])

  useEffect(() => subscribeKnowledgeSourceNavigation(filePath, (location) => {
    if (location.kind !== 'pdf' || !pdfDocument) return false
    scrollToPage(location.pageStart)
    return true
  }), [filePath, pdfDocument, scrollToPage])

  const updateCurrentPageFromScroll = useCallback((): void => {
    const scroller = scrollerRef.current
    if (!scroller || pageRefs.current.size === 0) return
    const scrollerRect = scroller.getBoundingClientRect()
    const targetY = scrollerRect.top + scrollerRect.height * 0.42
    let bestPage = 1
    let bestDistance = Number.POSITIVE_INFINITY

    pageRefs.current.forEach((node, page) => {
      const rect = node.getBoundingClientRect()
      const distance = targetY >= rect.top && targetY <= rect.bottom
        ? 0
        : Math.min(Math.abs(targetY - rect.top), Math.abs(targetY - rect.bottom))
      if (distance < bestDistance) {
        bestDistance = distance
        bestPage = page
      }
    })

    setCurrentPage((value) => value === bestPage ? value : bestPage)
    setPageInput((value) => value === String(bestPage) ? value : String(bestPage))
  }, [])

  const schedulePageSync = useCallback((): void => {
    if (scrollRafRef.current != null) return
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null
      updateCurrentPageFromScroll()
    })
  }, [updateCurrentPageFromScroll])

  const jumpSearch = (direction: 1 | -1): void => {
    if (searchMatches.length === 0) return
    const nextIndex = (searchIndex + direction + searchMatches.length) % searchMatches.length
    setSearchIndex(nextIndex)
    scrollToPage(searchMatches[nextIndex])
  }

  useEffect(() => {
    setSearchIndex(0)
    if (searchMatches.length > 0) scrollToPage(searchMatches[0])
  }, [scrollToPage, searchMatches])

  const syncSelection = useCallback((): void => {
    const root = rootRef.current
    if (!root) return
    const next = selectionFromPdf(root)
    onSelectionChange(next)
    if (next.text.trim()) {
      setCommittedSelectionRects(next.rects ?? [])
    } else {
      setCommittedSelectionRects([])
    }
  }, [onSelectionChange, rootRef])

  const syncSelectionSoon = useCallback((): void => {
    if (selectionSyncTimerRef.current != null) {
      window.clearTimeout(selectionSyncTimerRef.current)
    }
    selectionSyncTimerRef.current = window.setTimeout(() => {
      selectionSyncTimerRef.current = null
      syncSelection()
    }, 0)
  }, [syncSelection])

  useEffect(() => {
    const handleSelectionChange = (): void => {
      const root = rootRef.current
      const selection = window.getSelection()
      if (!root) return
      if (!selection || selection.rangeCount === 0) {
        return
      }
      const anchorInside = selection.anchorNode ? root.contains(selection.anchorNode) : false
      const focusInside = selection.focusNode ? root.contains(selection.focusNode) : false
      if (anchorInside || focusInside) {
        syncSelectionSoon()
        return
      }
      // If selection moved elsewhere (e.g. into the assist popup input), keep
      // the committed snapshot visible in the overlay.
    }
    window.document.addEventListener('selectionchange', handleSelectionChange)
    return () => {
      window.document.removeEventListener('selectionchange', handleSelectionChange)
      if (selectionSyncTimerRef.current != null) {
        window.clearTimeout(selectionSyncTimerRef.current)
        selectionSyncTimerRef.current = null
      }
    }
  }, [rootRef, syncSelectionSoon])

  useEffect(() => {
    return () => {
      if (scrollRafRef.current != null) {
        window.cancelAnimationFrame(scrollRafRef.current)
        scrollRafRef.current = null
      }
    }
  }, [])

  const beginPdfSelection = useCallback((): void => {
    setCommittedSelectionRects([])
    onSelectionChange(emptyPdfSelection())
  }, [onSelectionChange])

  return (
    <div
      ref={rootRef}
      className="write-pdf-viewer flex h-full min-h-0 min-w-0 flex-col"
    >
      <div className="write-pdf-toolbar shrink-0 border-b border-ds-border-muted bg-white/88 px-3 py-2 dark:bg-ds-card/95">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1 truncate text-[12px] text-ds-muted">
            {formatSize(size)} · {workspaceRoot ? filePath.replace(`${workspaceRoot}/`, '') : filePath}
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-ds-border-muted bg-ds-surface-subtle p-1 dark:bg-white/6">
            <button
              type="button"
              className="write-pdf-icon-button"
              title={t('writePdfZoomOut')}
              aria-label={t('writePdfZoomOut')}
              onClick={() => setScale((value) => Math.max(0.65, Number((value - 0.1).toFixed(2))))}
            >
              <Minus className="h-4 w-4" strokeWidth={1.9} />
            </button>
            <span className="min-w-[52px] text-center text-[12px] font-semibold text-ds-muted">
              {Math.round(scale * 100)}%
            </span>
            <button
              type="button"
              className="write-pdf-icon-button"
              title={t('writePdfZoomIn')}
              aria-label={t('writePdfZoomIn')}
              onClick={() => setScale((value) => Math.min(2.4, Number((value + 0.1).toFixed(2))))}
            >
              <Plus className="h-4 w-4" strokeWidth={1.9} />
            </button>
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-ds-border-muted bg-ds-surface-subtle p-1 dark:bg-white/6">
            <button
              type="button"
              className="write-pdf-icon-button"
              title={t('writePdfPrevPage')}
              aria-label={t('writePdfPrevPage')}
              onClick={() => scrollToPage(currentPage - 1)}
              disabled={currentPage <= 1}
            >
              <ChevronLeft className="h-4 w-4" strokeWidth={1.9} />
            </button>
            <form
              className="flex items-center gap-1"
              onSubmit={(event) => {
                event.preventDefault()
                scrollToPage(Number(pageInput))
              }}
            >
              <input
                className="write-pdf-page-input"
                value={pageInput}
                aria-label={t('writePdfPageInput')}
                onChange={(event) => setPageInput(event.target.value)}
              />
              <span className="text-[12px] text-ds-faint">/ {pageCount || '-'}</span>
            </form>
            <button
              type="button"
              className="write-pdf-icon-button"
              title={t('writePdfNextPage')}
              aria-label={t('writePdfNextPage')}
              onClick={() => scrollToPage(currentPage + 1)}
              disabled={!pageCount || currentPage >= pageCount}
            >
              <ChevronRight className="h-4 w-4" strokeWidth={1.9} />
            </button>
          </div>
          <div className="flex min-w-[180px] flex-1 items-center gap-1 rounded-lg border border-ds-border-muted bg-ds-surface-subtle px-2 py-1 dark:bg-white/6 sm:max-w-[260px]">
            <Search className="h-4 w-4 shrink-0 text-ds-faint" strokeWidth={1.9} />
            <input
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ds-ink outline-none placeholder:text-ds-faint"
              value={searchQuery}
              placeholder={t('writePdfSearchPlaceholder')}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
            <span className="shrink-0 text-[11px] text-ds-faint">
              {searchQuery.trim() ? `${searchMatches.length ? searchIndex + 1 : 0}/${searchMatches.length}` : ''}
            </span>
            <button
              type="button"
              className="write-pdf-icon-button"
              title={t('writePdfPrevMatch')}
              aria-label={t('writePdfPrevMatch')}
              disabled={searchMatches.length === 0}
              onClick={() => jumpSearch(-1)}
            >
              <ChevronLeft className="h-4 w-4" strokeWidth={1.9} />
            </button>
            <button
              type="button"
              className="write-pdf-icon-button"
              title={t('writePdfNextMatch')}
              aria-label={t('writePdfNextMatch')}
              disabled={searchMatches.length === 0}
              onClick={() => jumpSearch(1)}
            >
              <ChevronRight className="h-4 w-4" strokeWidth={1.9} />
            </button>
          </div>
        </div>
      </div>
      <div
        ref={scrollerRef}
        className="write-pdf-scroller min-h-0 flex-1 overflow-auto bg-ds-main/55 px-4 py-5 dark:bg-black/20"
        onPointerDown={beginPdfSelection}
        onPointerUp={syncSelectionSoon}
        onMouseUp={syncSelectionSoon}
        onKeyUp={syncSelectionSoon}
        onScroll={schedulePageSync}
      >
        {loading ? (
          <div className="flex h-full min-h-[320px] items-center justify-center gap-2 text-[13px] text-ds-muted">
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.9} />
            {t('writePdfLoading')}
          </div>
        ) : error ? (
          <div className="flex h-full min-h-[320px] items-center justify-center text-[13px] text-red-600 dark:text-red-300">
            {t('writePdfLoadFailed', { message: error })}
          </div>
        ) : pdfDocument ? (
          <div className="mx-auto flex w-max max-w-full flex-col items-center gap-5">
            {allPageTextLoaded && !pdfHasText ? (
              <div className="max-w-[560px] rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] leading-5 text-amber-900 dark:border-amber-900/70 dark:bg-amber-950/36 dark:text-amber-100">
                {t('writePdfNoTextLayer')}
              </div>
            ) : null}
            {Array.from({ length: pdfDocument.numPages }, (_, index) => index + 1).map((pageNumber) => (
              <div
                key={pageNumber}
                ref={(node) => {
                  if (node) pageRefs.current.set(pageNumber, node)
                  else pageRefs.current.delete(pageNumber)
                }}
              >
                <WritePdfPage
                  document={pdfDocument}
                  pageNumber={pageNumber}
                  scale={scale}
                  selectionRects={committedRectsByPage.get(pageNumber) ?? []}
                  onPageText={updatePageText}
                />
                <div className="mt-1 select-none text-center text-[11px] text-ds-faint">
                  {t('writePdfPageLabel', { page: pageNumber })}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}
