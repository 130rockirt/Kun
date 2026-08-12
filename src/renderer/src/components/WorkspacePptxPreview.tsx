import {
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Minimize2
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement
} from 'react'
import type { WorkspaceOfficePreviewSuccess, WorkspaceOfficeSelection } from '@shared/office-document'
import { WorkspaceOfficePreviewToolbar } from './WorkspaceOfficePreviewToolbar'
import {
  WorkspacePptxThumbnailRail,
  type PptxPreviewer,
  type PptxThumbnailSession
} from './WorkspacePptxThumbnailRail'
import {
  openWorkspaceOfficeExternalLink,
  secureWorkspaceOfficeLinks
} from './workspace-office-external-link'
import {
  emptyWorkspaceOfficeSelection,
  selectionFromOfficeDom
} from './workspace-office-selection'
import { subscribeKnowledgeSourceNavigation } from '../lib/knowledge-source-navigation'

const PPTX_WIDTH = 960
const PPTX_HEIGHT = 540
const THUMBNAIL_WIDTH = 160
const THUMBNAIL_HEIGHT = 90
const FULLSCREEN_CONTROLS_TIMEOUT_MS = 2_000

export function WorkspacePptxPreview({
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
  const rootRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const thumbnailEngineHostRef = useRef<HTMLDivElement>(null)
  const previewerRef = useRef<PptxPreviewer | null>(null)
  const thumbnailSessionRef = useRef<PptxThumbnailSession | null>(null)
  const renderIdRef = useRef(0)
  const controlsTimerRef = useRef<number | null>(null)
  const [thumbnailSession, setThumbnailSession] = useState<PptxThumbnailSession | null>(null)
  const [slide, setSlide] = useState(1)
  const [slideCount, setSlideCount] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [renderError, setRenderError] = useState<string | null>(null)
  const [interactionError, setInteractionError] = useState<string | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [fullscreenScale, setFullscreenScale] = useState(1)

  useEffect(() => {
    const host = hostRef.current
    const thumbnailHost = thumbnailEngineHostRef.current
    if (!host || !thumbnailHost) return
    previewerRef.current?.destroy()
    thumbnailSessionRef.current?.previewer.destroy()
    previewerRef.current = null
    thumbnailSessionRef.current = null
    setThumbnailSession(null)
    host.replaceChildren()
    thumbnailHost.replaceChildren()
    const renderId = ++renderIdRef.current
    const staging = document.createElement('div')
    const thumbnailStaging = document.createElement('div')
    staging.className = 'workspace-pptx-stage'
    staging.style.visibility = 'hidden'
    thumbnailStaging.className = 'workspace-pptx-thumbnail-stage'
    thumbnailStaging.style.visibility = 'hidden'
    host.append(staging)
    thumbnailHost.append(thumbnailStaging)
    let stagedPreviewer: PptxPreviewer | null = null
    let stagedThumbnailPreviewer: PptxPreviewer | null = null

    void import('pptx-preview')
      .then(async ({ init }) => {
        stagedPreviewer = init(staging, {
          width: PPTX_WIDTH,
          height: PPTX_HEIGHT,
          mode: 'slide'
        })
        stagedThumbnailPreviewer = init(thumbnailStaging, {
          width: THUMBNAIL_WIDTH,
          height: THUMBNAIL_HEIGHT,
          mode: 'slide'
        })
        const data = asArrayBuffer(result.data)
        await stagedPreviewer.preview(data)
        await stagedThumbnailPreviewer.preview(data)
        if (renderId !== renderIdRef.current) {
          disposeStagedPreview(stagedPreviewer, staging)
          disposeStagedPreview(stagedThumbnailPreviewer, thumbnailStaging)
          stagedPreviewer = null
          stagedThumbnailPreviewer = null
          return
        }

        secureWorkspaceOfficeLinks(staging)
        secureWorkspaceOfficeLinks(thumbnailStaging)
        removeOtherChildren(host, staging)
        removeOtherChildren(thumbnailHost, thumbnailStaging)
        staging.style.visibility = 'visible'
        previewerRef.current = stagedPreviewer
        const nextThumbnailSession = {
          previewer: stagedThumbnailPreviewer,
          host: thumbnailStaging,
          sourceKey: `${result.sourceSha256}:${renderId}`
        }
        thumbnailSessionRef.current = nextThumbnailSession
        setThumbnailSession(nextThumbnailSession)
        const count = Math.max(1, stagedPreviewer.slideCount)
        setSlideCount(count)
        setSlide(1)
        setRenderError(null)
      })
      .catch((cause) => {
        disposeStagedPreview(stagedPreviewer, staging)
        disposeStagedPreview(stagedThumbnailPreviewer, thumbnailStaging)
        stagedPreviewer = null
        stagedThumbnailPreviewer = null
        if (renderId === renderIdRef.current) setRenderError(errorMessage(cause))
      })

    return () => {
      renderIdRef.current += 1
      if (stagedPreviewer !== previewerRef.current) {
        disposeStagedPreview(stagedPreviewer, staging)
      }
      if (stagedThumbnailPreviewer !== thumbnailSessionRef.current?.previewer) {
        disposeStagedPreview(stagedThumbnailPreviewer, thumbnailStaging)
      }
    }
  }, [result.data, result.sourceSha256])

  useEffect(() => () => {
    renderIdRef.current += 1
    clearControlsTimer(controlsTimerRef)
    previewerRef.current?.destroy()
    thumbnailSessionRef.current?.previewer.destroy()
    previewerRef.current = null
    thumbnailSessionRef.current = null
    hostRef.current?.replaceChildren()
    thumbnailEngineHostRef.current?.replaceChildren()
  }, [])

  useEffect(() => {
    if (!onSelectionChange) return
    const empty = (): void => onSelectionChange(
      emptyWorkspaceOfficeSelection('presentation', result.sourceFormat)
    )
    const sync = (): void => {
      const host = hostRef.current
      const selection = window.getSelection()
      if (!host || !selection?.anchorNode || !host.contains(selection.anchorNode)) return
      onSelectionChange(selectionFromOfficeDom(
        host,
        'presentation',
        result.sourceFormat,
        () => ({ slide })
      ))
    }
    empty()
    document.addEventListener('selectionchange', sync)
    return () => {
      document.removeEventListener('selectionchange', sync)
      empty()
    }
  }, [onSelectionChange, result.sourceFormat, result.sourceSha256, slide, zoom])

  const goToSlide = useCallback((next: number): void => {
    const safeSlide = Math.min(slideCount, Math.max(1, next))
    try {
      previewerRef.current?.renderSingleSlide(safeSlide - 1)
      if (hostRef.current) secureWorkspaceOfficeLinks(hostRef.current)
      setSlide(safeSlide)
      onSelectionChange?.(emptyWorkspaceOfficeSelection('presentation', result.sourceFormat))
      window.getSelection()?.removeAllRanges()
      setRenderError(null)
    } catch (cause) {
      setRenderError(errorMessage(cause))
    }
  }, [onSelectionChange, result.sourceFormat, slideCount])

  useEffect(() => subscribeKnowledgeSourceNavigation(result.path, (location) => {
    if (location.kind !== 'presentation' || !previewerRef.current) return false
    goToSlide(location.slideStart)
    return true
  }), [goToSlide, result.path, slideCount])

  const scheduleControlsHide = useCallback((): void => {
    clearControlsTimer(controlsTimerRef)
    controlsTimerRef.current = window.setTimeout(() => {
      setControlsVisible(false)
      controlsTimerRef.current = null
    }, FULLSCREEN_CONTROLS_TIMEOUT_MS)
  }, [])

  const revealFullscreenControls = useCallback((): void => {
    if (!isFullscreen) return
    setControlsVisible(true)
    scheduleControlsHide()
  }, [isFullscreen, scheduleControlsHide])

  useEffect(() => {
    const handleFullscreenChange = (): void => {
      const active = document.fullscreenElement === rootRef.current
      setIsFullscreen(active)
      setControlsVisible(true)
      clearControlsTimer(controlsTimerRef)
      if (active) scheduleControlsHide()
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [scheduleControlsHide])

  useEffect(() => {
    if (!isFullscreen) return
    const updateScale = (): void => {
      const width = rootRef.current?.clientWidth || window.innerWidth
      const height = rootRef.current?.clientHeight || window.innerHeight
      setFullscreenScale(Math.max(0.1, Math.min(width / PPTX_WIDTH, height / PPTX_HEIGHT)))
    }
    updateScale()
    window.addEventListener('resize', updateScale)
    return () => window.removeEventListener('resize', updateScale)
  }, [isFullscreen])

  const toggleFullscreen = useCallback(async (): Promise<void> => {
    const root = rootRef.current
    if (!root) return
    try {
      if (document.fullscreenElement === root) {
        if (typeof document.exitFullscreen !== 'function') throw new Error('Fullscreen is not supported.')
        await document.exitFullscreen()
      } else {
        if (typeof root.requestFullscreen !== 'function') throw new Error('Fullscreen is not supported.')
        await root.requestFullscreen()
      }
      setInteractionError(null)
    } catch (cause) {
      setInteractionError(errorMessage(cause))
    }
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      if (isEditableKeyboardTarget(event.target)) return
      let nextSlide: number | null = null
      if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key)) nextSlide = slide - 1
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Spacebar'].includes(event.key)) nextSlide = slide + 1
      if (event.key === 'Home') nextSlide = 1
      if (event.key === 'End') nextSlide = slideCount
      if (nextSlide !== null) {
        event.preventDefault()
        goToSlide(nextSlide)
        return
      }
      if (event.key.toLowerCase() === 'f' && !event.repeat) {
        event.preventDefault()
        void toggleFullscreen()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [goToSlide, slide, slideCount, toggleFullscreen])

  const scale = isFullscreen ? fullscreenScale : zoom
  const viewerError = renderError || interactionError

  return (
    <div
      ref={rootRef}
      data-pptx-fullscreen={isFullscreen ? 'true' : 'false'}
      onPointerMove={revealFullscreenControls}
      className={`relative flex min-h-0 flex-1 flex-col ${isFullscreen ? 'bg-black' : 'bg-ds-surface-subtle'}`}
    >
      {!isFullscreen ? (
        <WorkspaceOfficePreviewToolbar
          result={result}
          loading={loading}
          refreshError={refreshError}
          viewerError={viewerError}
          zoom={zoom}
          onZoomChange={setZoom}
        >
          <PptxSlideControls
            slide={slide}
            slideCount={slideCount}
            onSelectSlide={goToSlide}
          />
          <button
            type="button"
            aria-label="Enter fullscreen"
            className="rounded p-1 hover:bg-ds-hover"
            onClick={() => void toggleFullscreen()}
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        </WorkspaceOfficePreviewToolbar>
      ) : null}
      <div className="flex min-h-0 flex-1">
        {!isFullscreen ? (
          <WorkspacePptxThumbnailRail
            session={thumbnailSession}
            slideCount={slideCount}
            currentSlide={slide}
            onSelectSlide={goToSlide}
          />
        ) : null}
        <div className={`min-h-0 min-w-0 flex-1 ${isFullscreen ? 'flex items-center justify-center overflow-hidden' : 'overflow-auto p-4'}`}>
          <div
            className="mx-auto shrink-0"
            style={{ width: `${PPTX_WIDTH * scale}px`, height: `${PPTX_HEIGHT * scale}px` }}
          >
            <div
              className="origin-top-left"
              style={{
                width: `${PPTX_WIDTH}px`,
                minHeight: `${PPTX_HEIGHT}px`,
                transform: `scale(${scale})`
              }}
            >
              <div
                ref={hostRef}
                onClick={openWorkspaceOfficeExternalLink}
                className="workspace-pptx-preview [&_.pptx-preview-wrapper-next]:hidden [&_.pptx-preview-wrapper-pagination]:hidden [&_.pptx-preview-wrapper-pre]:hidden"
              />
            </div>
          </div>
        </div>
      </div>
      {isFullscreen ? (
        <div
          data-pptx-fullscreen-controls={controlsVisible ? 'visible' : 'hidden'}
          className={`absolute inset-x-0 bottom-5 z-20 flex justify-center transition-opacity ${controlsVisible ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
        >
          <div className="flex items-center gap-3 rounded-full bg-black/75 px-4 py-2 text-xs text-white shadow-xl backdrop-blur">
            <PptxSlideControls
              slide={slide}
              slideCount={slideCount}
              onSelectSlide={goToSlide}
              dark
            />
            {viewerError ? <span className="max-w-80 truncate text-red-200">{viewerError}</span> : null}
            <button
              type="button"
              aria-label="Exit fullscreen"
              className="rounded p-1 hover:bg-white/15"
              onClick={() => void toggleFullscreen()}
            >
              <Minimize2 className="h-4 w-4" />
            </button>
          </div>
        </div>
      ) : null}
      <div
        ref={thumbnailEngineHostRef}
        aria-hidden="true"
        className="pointer-events-none fixed -left-[10000px] top-0 overflow-hidden"
        style={{ width: `${THUMBNAIL_WIDTH}px`, height: `${THUMBNAIL_HEIGHT}px` }}
      />
    </div>
  )
}

function PptxSlideControls({
  slide,
  slideCount,
  onSelectSlide,
  dark = false
}: {
  slide: number
  slideCount: number
  onSelectSlide: (slide: number) => void
  dark?: boolean
}): ReactElement {
  const hoverClass = dark ? 'hover:bg-white/15' : 'hover:bg-ds-hover'
  return (
    <div className={`flex items-center gap-1 rounded border px-1 py-0.5 ${dark ? 'border-white/20' : 'border-ds-border-muted'}`}>
      <button
        type="button"
        aria-label="Previous slide"
        disabled={slide <= 1}
        className={`rounded p-0.5 disabled:opacity-40 ${hoverClass}`}
        onClick={() => onSelectSlide(slide - 1)}
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>
      <span aria-label={`Slide ${slide} of ${slideCount}`}>Slide {slide} / {slideCount}</span>
      <button
        type="button"
        aria-label="Next slide"
        disabled={slide >= slideCount}
        className={`rounded p-0.5 disabled:opacity-40 ${hoverClass}`}
        onClick={() => onSelectSlide(slide + 1)}
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

function asArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
}

function removeOtherChildren(host: HTMLElement, current: HTMLElement): void {
  for (const child of Array.from(host.children)) {
    if (child !== current) child.remove()
  }
}

function disposeStagedPreview(previewer: PptxPreviewer | null, host: HTMLElement): void {
  previewer?.destroy()
  host.remove()
}

function clearControlsTimer(timerRef: { current: number | null }): void {
  if (timerRef.current !== null) window.clearTimeout(timerRef.current)
  timerRef.current = null
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest('input, textarea, select')) return true
  const editable = target.closest<HTMLElement>('[contenteditable]')
  return Boolean(editable && editable.getAttribute('contenteditable')?.toLowerCase() !== 'false')
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message || 'This PowerPoint presentation could not be rendered.'
}
