import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  Check,
  Clipboard,
  Code2,
  Copy,
  Loader2,
  Maximize2,
  Monitor,
  MoreHorizontal,
  MoveVertical,
  RefreshCw,
  Smartphone,
  TriangleAlert
} from 'lucide-react'
import type { ComponentPrototypeMetadata, ToolBlock } from '../../agent/types'
import { useChatStore } from '../../store/chat-store'
import { importComponentPrototypeToDesignCanvas } from '../../design/component-prototype-canvas-import'
import { previewWorkspaceFile } from '../../lib/workspace-file-preview'
import { DesignHtmlPreviewHost } from '../design/DesignHtmlPreviewHost'

type ComponentPrototypeCardProps = {
  block: ToolBlock
  workspaceRoot: string
  onPrompt?: (prompt: string) => void
}

type PreviewMode = 'desktop' | 'mobile'
type PreviewSize = { width: number; height: number }

const MIN_PREVIEW_WIDTH = 280
const MAX_PREVIEW_WIDTH = 1_200
const MIN_PREVIEW_HEIGHT = 240
const MAX_PREVIEW_HEIGHT = 900
const PREVIEW_SIZE_STEP = 32
const PREVIEW_SIZE_STORAGE_PREFIX = 'kun-component-prototype-size:'
const LEGACY_PREVIEW_HEIGHT_STORAGE_PREFIX = 'kun-component-prototype-height:'

export function componentPrototypeFromBlock(block: ToolBlock): ComponentPrototypeMetadata | null {
  const value = block.meta?.componentPrototype
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (raw.version !== 1) return null
  const profile = raw.profile === 'component-designer' ? 'component-designer' : undefined
  const producer = raw.producer === 'main-agent' || raw.producer === 'component-designer'
    ? raw.producer
    : profile === 'component-designer'
      ? 'component-designer'
      : undefined
  if (!producer || (producer === 'main-agent' && profile)) return null
  if (raw.status !== 'preparing' && raw.status !== 'running' && raw.status !== 'completed' && raw.status !== 'failed') {
    return null
  }
  const artifactId = typeof raw.artifactId === 'string' ? raw.artifactId.trim() : ''
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  const relativePath = typeof raw.relativePath === 'string' ? raw.relativePath.trim().replaceAll('\\', '/') : ''
  const viewport = raw.viewport && typeof raw.viewport === 'object' && !Array.isArray(raw.viewport)
    ? raw.viewport as Record<string, unknown>
    : null
  if (!artifactId || !title || !relativePath || !viewport) return null
  if (
    !/^\.kun-design\/component-prototypes\/[^/]+\/prototype\.html$/i.test(relativePath)
    || relativePath.split('/').includes('..')
  ) return null
  if (
    typeof viewport.width !== 'number'
    || !Number.isInteger(viewport.width)
    || viewport.width < 280
    || viewport.width > 1_200
    || typeof viewport.height !== 'number'
    || !Number.isInteger(viewport.height)
    || viewport.height < 240
    || viewport.height > 900
  ) return null
  return {
    version: 1,
    status: raw.status,
    artifactId,
    title,
    relativePath,
    viewport: { width: viewport.width, height: viewport.height },
    producer,
    ...(producer === 'component-designer' ? { profile: 'component-designer' as const } : {}),
    ...(typeof raw.childId === 'string' && raw.childId.trim() ? { childId: raw.childId.trim() } : {}),
    ...(typeof raw.byteSize === 'number' && Number.isInteger(raw.byteSize) && raw.byteSize >= 0
      ? { byteSize: raw.byteSize }
      : {}),
    ...(typeof raw.contentHash === 'string' && /^[a-f0-9]{64}$/i.test(raw.contentHash)
      ? { contentHash: raw.contentHash.toLowerCase() }
      : {}),
    ...(typeof raw.summary === 'string' && raw.summary.trim() ? { summary: raw.summary.trim() } : {}),
    ...(typeof raw.error === 'string' && raw.error.trim() ? { error: raw.error.trim() } : {})
  }
}

export function componentPrototypeFrameSize(
  prototype: ComponentPrototypeMetadata,
  mode: PreviewMode
): PreviewSize {
  return {
    width: mode === 'mobile'
      ? Math.min(360, clampComponentPrototypeWidth(prototype.viewport.width))
      : clampComponentPrototypeWidth(prototype.viewport.width),
    height: clampComponentPrototypeHeight(prototype.viewport.height)
  }
}

export function clampComponentPrototypeWidth(width: number): number {
  if (!Number.isFinite(width)) return 760
  return Math.min(MAX_PREVIEW_WIDTH, Math.max(MIN_PREVIEW_WIDTH, Math.round(width)))
}

export function clampComponentPrototypeHeight(height: number): number {
  if (!Number.isFinite(height)) return 460
  return Math.min(MAX_PREVIEW_HEIGHT, Math.max(MIN_PREVIEW_HEIGHT, Math.round(height)))
}

function storedComponentPrototypeSize(
  artifactId: string,
  mode: PreviewMode,
  fallback: PreviewSize
): PreviewSize {
  if (!artifactId) return fallback
  try {
    const raw = window.sessionStorage?.getItem(`${PREVIEW_SIZE_STORAGE_PREFIX}${artifactId}:${mode}`)
    if (raw) {
      const value = JSON.parse(raw) as Partial<PreviewSize>
      if (Number.isFinite(value.width) && Number.isFinite(value.height)) {
        return {
          width: clampComponentPrototypeWidth(value.width!),
          height: clampComponentPrototypeHeight(value.height!)
        }
      }
    }
    // Migrate the legacy per-artifact height-only preference.
    const legacyHeight = Number(window.sessionStorage?.getItem(`${LEGACY_PREVIEW_HEIGHT_STORAGE_PREFIX}${artifactId}`))
    return Number.isFinite(legacyHeight) && legacyHeight > 0
      ? { ...fallback, height: clampComponentPrototypeHeight(legacyHeight) }
      : fallback
  } catch {
    return fallback
  }
}

export function componentPrototypeFollowUpPrompt(
  prototype: ComponentPrototypeMetadata,
  action: 'adopt' | 'iterate',
  language = 'zh'
): string {
  if (!language.toLowerCase().startsWith('zh')) {
    if (action === 'adopt') {
      return `Adopt the “${prototype.title}” interaction prototype from this conversation (${prototype.relativePath}) and apply its confirmed interaction and visual states to the existing component. Check the current component boundary first and preserve the project's design language.`
    }
    return `Continue adjusting the “${prototype.title}” interaction prototype from this conversation (${prototype.relativePath}). I want to change: `
  }
  if (action === 'adopt') {
    return `请采纳会话中的「${prototype.title}」交互稿（${prototype.relativePath}），把确认后的交互和视觉状态应用到现有组件代码。实现前先核对现有组件边界，并保留项目当前设计语言。`
  }
  return `请继续调整会话中的「${prototype.title}」交互稿（${prototype.relativePath}）。我希望修改：`
}

function componentPrototypePartition(blockId: string): string {
  const safe = blockId.replace(/[^a-z0-9_-]/gi, '-').slice(0, 80) || 'prototype'
  return `kun-component-prototype-${safe}`
}

export function ComponentPrototypeCard({
  block,
  workspaceRoot,
  onPrompt
}: ComponentPrototypeCardProps): ReactElement | null {
  const { t, i18n } = useTranslation('common')
  const prototype = useMemo(() => componentPrototypeFromBlock(block), [block])
  const [mode, setMode] = useState<PreviewMode>('desktop')
  const [mountNonce, setMountNonce] = useState(0)
  const defaultSize = useMemo(
    () => prototype ? componentPrototypeFrameSize(prototype, mode) : { width: 760, height: 460 },
    [mode, prototype]
  )
  const [previewSize, setPreviewSize] = useState(() =>
    storedComponentPrototypeSize(prototype?.artifactId ?? '', mode, defaultSize)
  )
  const [previewFailed, setPreviewFailed] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  const [menuOpen, setMenuOpen] = useState(false)
  const [openingCanvas, setOpeningCanvas] = useState(false)
  const menuRootRef = useRef<HTMLDivElement | null>(null)
  const resizeStartRef = useRef<{
    pointerId: number
    x: number
    y: number
    size: PreviewSize
  } | null>(null)

  useEffect(() => {
    if (!prototype) return
    setPreviewSize(storedComponentPrototypeSize(prototype.artifactId, mode, defaultSize))
  }, [defaultSize, mode, prototype])

  useEffect(() => {
    if (!prototype || previewFailed) return
    try {
      window.sessionStorage?.setItem(
        `${PREVIEW_SIZE_STORAGE_PREFIX}${prototype.artifactId}:${mode}`,
        JSON.stringify(previewSize)
      )
    } catch {
      // Session persistence is best-effort; resizing remains functional.
    }
  }, [mode, previewFailed, previewSize, prototype])

  useEffect(() => {
    if (!menuOpen || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Node && !menuRootRef.current?.contains(target)) setMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  const running = prototype?.status === 'preparing' || prototype?.status === 'running'
  // While generating, errors are expected (file still streaming); keep the
  // placeholder. A completed prototype that cannot be authorized/loaded is
  // hidden entirely instead of surfacing the raw host error.
  const handlePreviewError = useCallback((_message: string): void => {
    if (running) return
    setPreviewFailed(true)
  }, [running])

  const failed = prototype?.status === 'failed' || block.status === 'error'
  // Failed prototypes are not shown at all: the conversation tool result itself
  // already reports the failure without leaking local paths into the timeline.
  if (!prototype || failed || previewFailed) return null

  const resizePreview = (patch: Partial<PreviewSize>): void => {
    setPreviewSize((current) => ({
      width: clampComponentPrototypeWidth(patch.width ?? current.width),
      height: clampComponentPrototypeHeight(patch.height ?? current.height)
    }))
  }
  const onResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    resizeStartRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      size: previewSize
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    event.preventDefault()
  }
  const onResizePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = resizeStartRef.current
    if (!start || start.pointerId !== event.pointerId) return
    resizePreview({
      width: start.size.width + event.clientX - start.x,
      height: start.size.height + event.clientY - start.y
    })
  }
  const onResizePointerEnd = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (resizeStartRef.current?.pointerId !== event.pointerId) return
    resizeStartRef.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }
  const onResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const delta = PREVIEW_SIZE_STEP
    if (event.key === 'ArrowUp') resizePreview({ height: previewSize.height - delta })
    else if (event.key === 'ArrowDown') resizePreview({ height: previewSize.height + delta })
    else if (event.key === 'ArrowLeft') resizePreview({ width: previewSize.width - delta })
    else if (event.key === 'ArrowRight') resizePreview({ width: previewSize.width + delta })
    else return
    event.preventDefault()
  }
  const producerLabel = prototype.producer === 'main-agent'
    ? t('componentPrototypeMainAgent')
    : t('componentPrototypeSubagent')
  const producerSummary = prototype.producer === 'main-agent'
    ? t('componentPrototypeGeneratedByMainAgent')
    : t('componentPrototypeGeneratedBy')
  const statusLabel = running
    ? t('componentPrototypeDesigning')
    : t('componentPrototypeInteractive')
  const prompt = (action: 'adopt' | 'iterate'): void => {
    setMenuOpen(false)
    onPrompt?.(componentPrototypeFollowUpPrompt(
      prototype,
      action,
      i18n.resolvedLanguage || i18n.language
    ))
  }
  const inspectCode = (): void => {
    setMenuOpen(false)
    previewWorkspaceFile({ path: prototype.relativePath, workspaceRoot })
  }
  const openInCanvas = (): void => {
    if (openingCanvas || !workspaceRoot) return
    setOpeningCanvas(true)
    void importComponentPrototypeToDesignCanvas({ workspaceRoot, prototype })
      .then((imported) => {
        if (imported) useChatStore.getState().openDesign()
      })
      .finally(() => setOpeningCanvas(false))
  }
  const copyCode = async (): Promise<void> => {
    setMenuOpen(false)
    if (typeof window.kunGui?.readWorkspaceFile !== 'function') {
      setCopyState('error')
      return
    }
    const result = await window.kunGui.readWorkspaceFile({ path: prototype.relativePath, workspaceRoot })
      .catch(() => ({ ok: false as const, message: 'read failed' }))
    if (!result.ok) {
      setCopyState('error')
      return
    }
    try {
      await navigator.clipboard.writeText(result.content)
      setCopyState('copied')
      window.setTimeout(() => setCopyState('idle'), 1_500)
    } catch {
      setCopyState('error')
    }
  }

  return (
    <article
      className="ds-component-prototype-card relative mx-auto min-w-0 max-w-full rounded-[11px] border border-ds-border bg-ds-card/95 shadow-[0_5px_18px_rgba(36,68,112,0.06)]"
      style={{ width: Math.min(MAX_PREVIEW_WIDTH + 16, previewSize.width + 16) }}
      data-component-prototype-id={prototype.artifactId}
    >
      <header className="flex h-8 items-center justify-between gap-2 rounded-t-[11px] border-b border-ds-border-muted px-3">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-[12.5px] font-semibold leading-none text-ds-ink">{prototype.title}</h3>
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              running ? 'bg-amber-500' : 'bg-emerald-500'
            }`}
            title={statusLabel}
            aria-label={statusLabel}
          />
        </div>
        <div ref={menuRootRef} className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink disabled:cursor-wait disabled:opacity-60"
            onClick={openInCanvas}
            disabled={openingCanvas || running || !workspaceRoot}
            title={t('componentPrototypeOpenCanvas')}
          >
            {openingCanvas
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <Maximize2 className="h-3.5 w-3.5" />}
            <span className="hidden sm:inline">{t('componentPrototypeOpenCanvas')}</span>
          </button>
          <div className="relative">
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
              onClick={() => setMenuOpen((open) => !open)}
              aria-label={t('browserMore')}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
            {menuOpen ? (
              <div
                className="absolute right-0 top-7 z-30 w-48 rounded-[10px] border border-ds-border bg-ds-card p-1.5 shadow-[0_14px_36px_rgba(27,45,76,0.16)]"
                role="menu"
                data-component-prototype-menu
              >
                <p className="truncate px-2 py-1 text-[10.5px] text-ds-faint" title={producerSummary}>{producerLabel}</p>
                <div className="my-1 h-px bg-ds-border-muted" />
                <PrototypeMenuButton
                  icon={<Monitor className="h-3.5 w-3.5" />}
                  label={t('componentPrototypeDesktop')}
                  active={mode === 'desktop'}
                  onClick={() => {
                    setMode('desktop')
                    setMenuOpen(false)
                  }}
                />
                <PrototypeMenuButton
                  icon={<Smartphone className="h-3.5 w-3.5" />}
                  label={t('componentPrototypeMobile')}
                  active={mode === 'mobile'}
                  onClick={() => {
                    setMode('mobile')
                    setMenuOpen(false)
                  }}
                />
                <PrototypeMenuButton
                  icon={<RefreshCw className="h-3.5 w-3.5" />}
                  label={t('componentPrototypeRefresh')}
                  onClick={() => {
                    setMountNonce((value) => value + 1)
                    setMenuOpen(false)
                  }}
                />
                <PrototypeMenuButton
                  icon={<MoveVertical className="h-3.5 w-3.5" />}
                  label={t('componentPrototypeResetSize')}
                  onClick={() => {
                    setPreviewSize(defaultSize)
                    setMenuOpen(false)
                  }}
                />
                <div className="my-1 h-px bg-ds-border-muted" />
                <PrototypeMenuButton
                  icon={<Code2 className="h-3.5 w-3.5" />}
                  label={t('componentPrototypeViewCode')}
                  onClick={inspectCode}
                />
                <PrototypeMenuButton
                  icon={copyState === 'copied'
                    ? <Check className="h-3.5 w-3.5 text-emerald-500" />
                    : copyState === 'error'
                      ? <TriangleAlert className="h-3.5 w-3.5 text-rose-500" />
                      : <Copy className="h-3.5 w-3.5" />}
                  label={t('componentPrototypeCopyCode')}
                  onClick={() => void copyCode()}
                />
                {onPrompt ? (
                  <>
                    <div className="my-1 h-px bg-ds-border-muted" />
                    <PrototypeMenuButton
                      icon={<Clipboard className="h-3.5 w-3.5" />}
                      label={t('componentPrototypeIterate')}
                      onClick={() => prompt('iterate')}
                      disabled={running}
                    />
                    <PrototypeMenuButton
                      icon={<Check className="h-3.5 w-3.5" />}
                      label={t('componentPrototypeAdopt')}
                      onClick={() => prompt('adopt')}
                      disabled={running}
                    />
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <div className="flex min-w-0 justify-center overflow-auto bg-ds-subtle/35 p-2 pb-1">
        <div
          className="min-w-0 overflow-auto bg-white"
          style={{ width: previewSize.width, height: previewSize.height, maxWidth: '100%' }}
        >
          <DesignHtmlPreviewHost
            key={`${block.id}:${mountNonce}`}
            workspaceRoot={workspaceRoot}
            relativePath={prototype.relativePath}
            enabled={Boolean(workspaceRoot)}
            partition={componentPrototypePartition(block.id)}
            retryMissingFile={running}
            mountWhileSkeleton
            onError={handlePreviewError}
          >
            {({ state, renderWebview }) => {
              if (!state.webviewUrl) {
                return (
                  <div className="flex h-full w-full items-center justify-center bg-[#f7f9fc] text-[11.5px] text-slate-500">
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin text-accent" />
                    {running ? t('componentPrototypeDesigning') : null}
                  </div>
                )
              }
              return renderWebview({
                className: 'h-full w-full border-0 bg-white',
                style: { height: '100%', width: '100%' },
                title: prototype.title
              })
            }}
          </DesignHtmlPreviewHost>
        </div>
      </div>
      <div className="flex h-7 items-center justify-end rounded-b-[11px] border-t border-ds-border-muted bg-ds-subtle/35 px-1.5">
        <div
          role="button"
          aria-label={t('componentPrototypeResize')}
          aria-valuetext={`${previewSize.width} × ${previewSize.height}`}
          tabIndex={0}
          data-component-prototype-resize-handle
          className="group flex h-5 w-6 touch-none cursor-nwse-resize items-center justify-center rounded outline-none hover:bg-ds-hover focus-visible:ring-2 focus-visible:ring-accent"
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerEnd}
          onPointerCancel={onResizePointerEnd}
          onKeyDown={onResizeKeyDown}
        >
          <Maximize2 className="h-3.5 w-3.5 text-ds-faint transition-colors group-hover:text-ds-muted group-focus-visible:text-accent" />
        </div>
      </div>
    </article>
  )
}

function PrototypeMenuButton({
  icon,
  label,
  active = false,
  disabled = false,
  onClick
}: {
  icon: ReactElement
  label: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
}): ReactElement {
  return (
    <button
      type="button"
      role="menuitem"
      className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[11.5px] transition disabled:cursor-not-allowed disabled:opacity-40 ${
        active ? 'bg-accent/10 text-accent' : 'text-ds-muted hover:bg-ds-hover hover:text-ds-ink'
      }`}
      onClick={onClick}
      disabled={disabled}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {active ? <Check className="h-3 w-3 shrink-0" /> : null}
    </button>
  )
}
