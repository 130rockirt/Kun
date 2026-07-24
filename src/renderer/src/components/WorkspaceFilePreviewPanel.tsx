import type {
  WorkspaceFileReadResult,
  WorkspaceFileTarget,
  WorkspaceImageReadResult
} from '@shared/workspace-file'
import {
  Check,
  ChevronRight,
  Code2,
  Copy,
  Eye,
  ExternalLink,
  FileCode2,
  Files,
  Loader2,
  Maximize2,
  Minimize2,
  PanelRightClose,
  Pin,
  Save,
  X
} from 'lucide-react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { harden } from 'rehype-harden'
import rehypeRaw from 'rehype-raw'
import type { PluggableList } from 'unified'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  type UIEvent as ReactUIEvent,
  type WheelEvent as ReactWheelEvent
} from 'react'
import { useTranslation } from 'react-i18next'
import { formatFilePathForDisplay } from '../lib/diff-stats'
import { openWorkspacePathInEditor } from '../lib/open-workspace-path'
import {
  highlightCodeHtml,
  languageFromFilePath,
  renderFallbackCodeHtml
} from '../lib/code-highlighting'
import {
  isWorkspaceRasterImagePreviewPath,
  isWorkspaceTextPreviewPath
} from '../lib/workspace-text-preview'
import { workspaceFileTargetKey } from '../lib/workspace-file-target-key'
import { readBrowserStorageItem, writeBrowserStorageItem } from '../lib/browser-storage'
import {
  initialWriteMarkdownImageSrc,
  loadWriteMarkdownImage
} from '../write/markdown-image'

type Props = {
  target: WorkspaceFileTarget | null
  openTargets?: WorkspaceFileTarget[]
  workspaceRoot: string
  className?: string
  onSelectTarget?: (target: WorkspaceFileTarget) => void
  onCloseTarget?: (target: WorkspaceFileTarget) => void
  pinnedTargetKeys?: string[]
  preserveAcrossThreads?: boolean
  onTogglePinnedTarget?: (target: WorkspaceFileTarget) => void
  onCloseOtherTargets?: (target: WorkspaceFileTarget) => void
  onTogglePreserveAcrossThreads?: () => void
  onClose: () => void
}

const COPY_RESET_MS = 1400
const MARKDOWN_DEFAULT_ORIGIN = 'https://kun.local'
export const PREVIEW_SCROLL_POSITIONS_KEY = 'kun.issue781.previewScrollPositions'
const MAX_PREVIEW_SCROLL_POSITIONS = 200
const markdownRehypePlugins = [
  rehypeRaw,
  [
    harden,
    {
      defaultOrigin: MARKDOWN_DEFAULT_ORIGIN,
      allowedLinkPrefixes: ['*'],
      allowedImagePrefixes: ['*']
    }
  ]
] as unknown as PluggableList

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function fileNameFromPath(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path
}

function splitPath(path: string): string[] {
  return path.split(/[/\\]/).filter(Boolean)
}

function relativePathSegments(path: string, workspaceRoot: string): string[] {
  const normalizedPath = path.replaceAll('\\', '/')
  const normalizedRoot = workspaceRoot.replaceAll('\\', '/').replace(/\/+$/, '')
  if (normalizedRoot && normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return splitPath(normalizedPath.slice(normalizedRoot.length + 1))
  }
  return [fileNameFromPath(path)]
}

function extensionBadge(path: string, language: string): string {
  const fileName = fileNameFromPath(path)
  const ext = fileName.includes('.') ? fileName.split('.').pop() ?? '' : ''
  const value = ext || language || 'txt'
  return value.slice(0, 3).toUpperCase()
}

export function targetKey(
  target: WorkspaceFileTarget | null | undefined,
  platform?: string
): string {
  return workspaceFileTargetKey(target, platform)
}

function isAbsolutePreviewPath(path: string): boolean {
  return path.startsWith('/') || /^[a-z]:[/\\]/i.test(path) || /^[/\\]{2}[^/\\]/.test(path)
}

export function resolvedPreviewPathMatchesTarget(
  resolvedPath: string,
  target: WorkspaceFileTarget,
  defaultWorkspaceRoot: string,
  platform?: string
): boolean {
  const workspaceRoot = target.workspaceRoot ?? defaultWorkspaceRoot
  const requestedPath = isAbsolutePreviewPath(target.path)
    ? target.path
    : `${workspaceRoot.replace(/[/\\]+$/, '')}/${target.path}`
  return targetKey({ path: resolvedPath, workspaceRoot }, platform) ===
    targetKey({ path: requestedPath, workspaceRoot }, platform)
}

export function nextFilePreviewTargetForWheel(
  targets: WorkspaceFileTarget[],
  activeTarget: WorkspaceFileTarget | null,
  delta: number
): WorkspaceFileTarget | null {
  if (targets.length < 2 || delta === 0) return null
  const activeKey = targetKey(activeTarget)
  const activeIndex = targets.findIndex((item) => targetKey(item) === activeKey)
  const startIndex = activeIndex >= 0 ? activeIndex : 0
  return targets[(startIndex + (delta > 0 ? 1 : -1) + targets.length) % targets.length] ?? null
}

export function rememberPreviewScrollPosition(
  positions: Record<string, number>,
  key: string,
  scrollTop: number
): Record<string, number> {
  if (!key || !Number.isFinite(scrollTop)) return positions
  const next = { ...positions }
  delete next[key]
  next[key] = Math.max(0, scrollTop)
  return Object.fromEntries(Object.entries(next).slice(-MAX_PREVIEW_SCROLL_POSITIONS))
}

export function parsePreviewScrollPositions(raw: string | null, platform = ''): Record<string, number> {
  if (!raw) return {}
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const entries = Object.entries(value).flatMap(([key, scrollTop]): Array<[string, number]> => {
      if (typeof scrollTop !== 'number' || !Number.isFinite(scrollTop) || scrollTop < 0) return []
      const parts = key.replaceAll('\\', '/').split('\n')
      if (parts.length === 2 && parts[1]) {
        return [[workspaceFileTargetKey({ workspaceRoot: parts[0], path: parts[1] }, platform), scrollTop]]
      }
      if (platform === 'win32' && parts.length === 3 && parts[2]) {
        return [[workspaceFileTargetKey({ workspaceRoot: parts[1], path: parts[2] }, platform), scrollTop]]
      }
      return []
    })
    return Object.fromEntries(entries.slice(-MAX_PREVIEW_SCROLL_POSITIONS))
  } catch {
    return {}
  }
}

function readPreviewScrollPositions(): Record<string, number> {
  const platform = typeof window !== 'undefined' ? window.kunGui?.platform ?? '' : ''
  return parsePreviewScrollPositions(readBrowserStorageItem(PREVIEW_SCROLL_POSITIONS_KEY), platform)
}

function persistPreviewScrollPositions(positions: Record<string, number>): void {
  writeBrowserStorageItem(
    PREVIEW_SCROLL_POSITIONS_KEY,
    JSON.stringify(Object.fromEntries(Object.entries(positions).slice(-MAX_PREVIEW_SCROLL_POSITIONS)))
  )
}

function isMarkdownPreviewPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path)
}

function isSvgPreviewPath(path: string): boolean {
  return /\.svg$/i.test(path)
}

export function isJsonPreviewPath(path: string): boolean {
  return /\.json$/i.test(path)
}

export function svgPreviewDataUrl(content: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}`
}

function normalizePreviewImageSrc(src: string | undefined): string | undefined {
  if (!src?.startsWith(`${MARKDOWN_DEFAULT_ORIGIN}/`)) return src

  try {
    const url = new URL(src)
    if (url.origin !== MARKDOWN_DEFAULT_ORIGIN) return src
    return decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  } catch {
    return src
  }
}

type ResolvedPreviewImageProps = {
  src?: string
  alt?: string | null
  filePath?: string | null
} & Omit<ComponentPropsWithoutRef<'img'>, 'src' | 'alt'>

function ResolvedPreviewImage({
  src,
  alt,
  filePath,
  ...props
}: ResolvedPreviewImageProps): ReactElement {
  const normalizedSrc = normalizePreviewImageSrc(src)
  const [resolvedSrc, setResolvedSrc] = useState(() => initialWriteMarkdownImageSrc(normalizedSrc, filePath))
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoadError(null)
    setResolvedSrc(initialWriteMarkdownImageSrc(normalizedSrc, filePath))

    void loadWriteMarkdownImage(normalizedSrc, filePath).then((next) => {
      if (cancelled) return
      if (next.ok) {
        setResolvedSrc(next.src)
      } else {
        setLoadError(next.message)
      }
    })

    return () => {
      cancelled = true
    }
  }, [normalizedSrc, filePath])

  if (loadError) {
    return (
      <span
        className="inline-flex max-w-full items-center rounded-lg border border-red-200/70 bg-red-50/80 px-2 py-1 text-[12px] text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
        title={loadError}
      >
        {alt || src || 'Image could not be loaded'}
      </span>
    )
  }

  if (!resolvedSrc) {
    return (
      <span
        className="inline-flex max-w-full items-center rounded-lg border border-ds-border px-2 py-1 text-[12px] text-ds-muted"
        title={src}
      >
        {alt || src || 'Image'}
      </span>
    )
  }

  return <img {...props} src={resolvedSrc} alt={alt ?? ''} />
}

export function WorkspaceFilePreviewPanel({
  target,
  openTargets = target ? [target] : [],
  workspaceRoot,
  className,
  onSelectTarget,
  onCloseTarget,
  pinnedTargetKeys = [],
  preserveAcrossThreads = false,
  onTogglePinnedTarget,
  onCloseOtherTargets,
  onTogglePreserveAcrossThreads,
  onClose
}: Props): ReactElement {
  const { t } = useTranslation('common')
  const [result, setResult] = useState<WorkspaceFileReadResult | null>(null)
  const [imageResult, setImageResult] = useState<WorkspaceImageReadResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [markdownRendered, setMarkdownRendered] = useState(true)
  const [svgRendered, setSvgRendered] = useState(true)
  const [jsonDraft, setJsonDraft] = useState('')
  const [jsonSaveError, setJsonSaveError] = useState<string | null>(null)
  const [savingJson, setSavingJson] = useState(false)
  const [readingMode, setReadingMode] = useState(false)
  const [tabMenu, setTabMenu] = useState<{
    target: WorkspaceFileTarget
    x: number
    y: number
  } | null>(null)
  const [highlightHtml, setHighlightHtml] = useState(() => renderFallbackCodeHtml(''))
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollPositionsRef = useRef(readPreviewScrollPositions())
  const tabMenuRef = useRef<HTMLDivElement>(null)
  const tabMenuTriggerRef = useRef<HTMLElement | null>(null)
  const tabButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const copyResetRef = useRef<number | null>(null)
  const activeTargetKey = targetKey(target)
  const visibleTargets = openTargets.length ? openTargets : target ? [target] : []
  const visibleTargetKeySignature = visibleTargets.map((item) => targetKey(item)).join('\0')
  const pinnedTargetKeySet = useMemo(() => new Set(pinnedTargetKeys), [pinnedTargetKeys])
  const tabActionsEnabled = Boolean(onTogglePinnedTarget || onCloseOtherTargets)

  useEffect(() => {
    if (!target) {
      setResult(null)
      setImageResult(null)
      setLoading(false)
      return
    }

    let cancelled = false
    setSvgRendered(true)
    setJsonDraft('')
    setJsonSaveError(null)
    setSavingJson(false)
    setLoading(true)
    setResult(null)
    setImageResult(null)

    const readTarget = {
      ...target,
      workspaceRoot: target.workspaceRoot ?? workspaceRoot
    }

    if (isWorkspaceRasterImagePreviewPath(target.path)) {
      void window.kunGui
        .readWorkspaceImage(readTarget)
        .then((next) => {
          if (!cancelled) setImageResult(next)
        })
        .catch((error) => {
          if (!cancelled) {
            setImageResult({
              ok: false,
              message: error instanceof Error ? error.message : String(error)
            })
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })

      return () => {
        cancelled = true
      }
    }

    if (!isWorkspaceTextPreviewPath(target.path)) {
      setResult({
        ok: false,
        message: t('filePreviewUnsupported')
      })
      setLoading(false)
      return
    }

    void window.kunGui
      .readWorkspaceFile(readTarget)
      .then((next) => {
        if (!cancelled) {
          setResult(next)
          if (next.ok && isJsonPreviewPath(next.path)) setJsonDraft(next.content)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setResult({
            ok: false,
            message: error instanceof Error ? error.message : String(error)
          })
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [t, target, workspaceRoot])

  useEffect(() => {
    if (!result?.ok || !result.line) return
    const id = window.requestAnimationFrame(() => {
      const row = scrollRef.current?.querySelector(`[data-line="${result.line}"]`)
      row?.scrollIntoView({ block: 'center' })
    })
    return () => window.cancelAnimationFrame(id)
  }, [result])

  useEffect(
    () => () => {
      if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current)
    },
    []
  )

  useEffect(() => {
    if (!readingMode) return
    const exitReadingMode = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !tabMenu) setReadingMode(false)
    }
    document.addEventListener('keydown', exitReadingMode)
    return () => document.removeEventListener('keydown', exitReadingMode)
  }, [readingMode, tabMenu])

  useEffect(() => {
    if (!tabMenu) return
    const firstItem = tabMenuRef.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]')
    firstItem?.focus()
    const closeMenu = (event: PointerEvent): void => {
      if (typeof Node !== 'undefined' && event.target instanceof Node && tabMenuRef.current?.contains(event.target)) {
        return
      }
      setTabMenu(null)
    }
    const closeMenuWithKeyboard = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setTabMenu(null)
      tabMenuTriggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', closeMenu)
    document.addEventListener('keydown', closeMenuWithKeyboard)
    return () => {
      document.removeEventListener('pointerdown', closeMenu)
      document.removeEventListener('keydown', closeMenuWithKeyboard)
    }
  }, [tabMenu])

  useEffect(() => {
    if (!tabMenu) return
    const visibleKeys = new Set(visibleTargetKeySignature.split('\0').filter(Boolean))
    if (!visibleKeys.has(targetKey(tabMenu.target))) setTabMenu(null)
  }, [tabMenu, visibleTargetKeySignature])

  useEffect(() => {
    return () => persistPreviewScrollPositions(scrollPositionsRef.current)
  }, [activeTargetKey])

  useEffect(() => {
    if (!activeTargetKey || (!result?.ok && !imageResult?.ok)) return
    if (result?.ok && result.line) return
    const frame = window.requestAnimationFrame(() => {
      const stored = scrollPositionsRef.current[activeTargetKey]
      if (typeof stored === 'number' && scrollRef.current) scrollRef.current.scrollTop = stored
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activeTargetKey, imageResult, markdownRendered, result, svgRendered])

  const handlePreviewScroll = (event: ReactUIEvent<HTMLDivElement>): void => {
    if (!activeTargetKey) return
    scrollPositionsRef.current = rememberPreviewScrollPosition(
      scrollPositionsRef.current,
      activeTargetKey,
      event.currentTarget.scrollTop
    )
  }

  const handleTabWheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    const delta = event.deltaY || event.deltaX
    const nextTarget = nextFilePreviewTargetForWheel(visibleTargets, target, delta)
    if (!nextTarget || !onSelectTarget) return
    event.preventDefault()
    onSelectTarget(nextTarget)
  }

  const openTabMenu = (
    event: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLButtonElement>,
    item: WorkspaceFileTarget,
    position?: { x: number; y: number }
  ): void => {
    event.preventDefault()
    event.stopPropagation()
    tabMenuTriggerRef.current = event.currentTarget
    const rect = event.currentTarget.getBoundingClientRect()
    const requestedX = position?.x ?? ('clientX' in event ? event.clientX : rect.left)
    const requestedY = position?.y ?? ('clientY' in event ? event.clientY : rect.bottom)
    setTabMenu({
      target: item,
      x: Math.max(8, Math.min(requestedX, window.innerWidth - 200)),
      y: Math.max(8, Math.min(requestedY, window.innerHeight - 112))
    })
  }

  const handleTabKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    item: WorkspaceFileTarget,
    index: number
  ): void => {
    if (tabActionsEnabled && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
      const rect = event.currentTarget.getBoundingClientRect()
      openTabMenu(event, item, { x: rect.left, y: rect.bottom })
      return
    }
    let nextTarget: WorkspaceFileTarget | undefined
    if (event.key === 'ArrowRight') nextTarget = visibleTargets[(index + 1) % visibleTargets.length]
    if (event.key === 'ArrowLeft') nextTarget = visibleTargets[(index - 1 + visibleTargets.length) % visibleTargets.length]
    if (event.key === 'Home') nextTarget = visibleTargets[0]
    if (event.key === 'End') nextTarget = visibleTargets.at(-1)
    if (!nextTarget || !onSelectTarget) return
    event.preventDefault()
    onSelectTarget(nextTarget)
    window.requestAnimationFrame(() => tabButtonRefs.current.get(targetKey(nextTarget))?.focus())
  }

  const displayPath = useMemo(() => {
    const root = target?.workspaceRoot ?? workspaceRoot
    if (imageResult?.ok) return formatFilePathForDisplay(imageResult.path, root) ?? fileNameFromPath(imageResult.path)
    if (result?.ok) return formatFilePathForDisplay(result.path, root) ?? fileNameFromPath(result.path)
    return target?.path ? formatFilePathForDisplay(target.path, root) ?? fileNameFromPath(target.path) : ''
  }, [imageResult, result, target, workspaceRoot])
  const language = useMemo(() => {
    if (result?.ok) return languageFromFilePath(result.path)
    return target?.path ? languageFromFilePath(target.path) : ''
  }, [result, target])
  const isMarkdownFile = isMarkdownPreviewPath(result?.ok ? result.path : target?.path ?? '')
  const isSvgFile = isSvgPreviewPath(result?.ok ? result.path : target?.path ?? '')
  const isJsonFile = isJsonPreviewPath(result?.ok ? result.path : target?.path ?? '')
  const jsonDirty = Boolean(result?.ok && !result.truncated && isJsonFile && jsonDraft !== result.content)
  const svgDataUrl = useMemo(
    () => result?.ok && isSvgFile && !result.truncated ? svgPreviewDataUrl(result.content) : '',
    [isSvgFile, result]
  )
  const lines = useMemo(() => (result?.ok ? result.content.split('\n') : []), [result])
  const breadcrumbSegments = useMemo(() => {
    const path = result?.ok ? result.path : target?.path ?? ''
    if (!path) return []
    return relativePathSegments(path, target?.workspaceRoot ?? workspaceRoot)
  }, [result, target, workspaceRoot])
  const currentFileName = displayPath ? fileNameFromPath(displayPath) : t('filePreviewTitle')
  const badge = extensionBadge(result?.ok ? result.path : target?.path ?? '', language)
  const activeLine = result?.ok && result.line && result.line >= 1 && result.line <= lines.length
    ? result.line
    : null
  const codeSurfaceStyle = activeLine
    ? ({
        '--ds-file-preview-active-line': activeLine - 1
      } as CSSProperties)
    : undefined

  useEffect(() => {
    if (!result?.ok) {
      setHighlightHtml(renderFallbackCodeHtml(''))
      return
    }

    let cancelled = false
    const fallback = renderFallbackCodeHtml(result.content)
    setHighlightHtml(fallback)

    void highlightCodeHtml(result.content, language).then((html) => {
      if (!cancelled) setHighlightHtml(html)
    })

    return () => {
      cancelled = true
    }
  }, [result, language])

  const openTargetInEditor = (targetToOpen: WorkspaceFileTarget | null): void => {
    const isActive = targetKey(targetToOpen) === activeTargetKey
    const resultMatchesTarget = Boolean(
      targetToOpen &&
      isActive &&
      result?.ok &&
      resolvedPreviewPathMatchesTarget(result.path, targetToOpen, workspaceRoot)
    )
    const path = resultMatchesTarget && result?.ok ? result.path : targetToOpen?.path
    if (!path) return
    void openWorkspacePathInEditor(
      {
        path,
        line: resultMatchesTarget && result?.ok ? result.line : targetToOpen?.line,
        column: resultMatchesTarget && result?.ok ? result.column : targetToOpen?.column
      },
      targetToOpen?.workspaceRoot ?? workspaceRoot
    ).then((next) => {
      if (!next.ok) {
        void window.kunGui?.logError?.('editor-open', 'Failed to open previewed file', {
          message: next.message,
          target: targetToOpen
        })?.catch(() => undefined)
      }
    })
  }

  const openInEditor = (): void => openTargetInEditor(target)

  const copyContent = async (): Promise<void> => {
    if (!result?.ok || !navigator?.clipboard?.writeText) return
    try {
      await navigator.clipboard.writeText(isJsonFile ? jsonDraft : result.content)
      setCopied(true)
      if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current)
      copyResetRef.current = window.setTimeout(() => setCopied(false), COPY_RESET_MS)
    } catch {
      setCopied(false)
    }
  }

  const saveJson = async (): Promise<void> => {
    if (!target || !result?.ok || !isJsonFile || !jsonDirty || savingJson) return
    setSavingJson(true)
    setJsonSaveError(null)
    try {
      const next = await window.kunGui.writeWorkspaceFile({
        path: result.path,
        workspaceRoot: target.workspaceRoot ?? workspaceRoot,
        content: jsonDraft
      })
      if (!next.ok) {
        setJsonSaveError(next.message)
        return
      }
      setResult({ ...result, content: jsonDraft, size: new TextEncoder().encode(jsonDraft).byteLength })
    } catch (error) {
      setJsonSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setSavingJson(false)
    }
  }

  return (
    <>
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className={`ds-file-preview-reading-backdrop ${readingMode ? 'is-visible' : ''}`}
        onClick={() => setReadingMode(false)}
      />
      <aside
        data-kun-workspace-root={(target?.workspaceRoot ?? workspaceRoot).replaceAll('\\', '/')}
        data-reading-mode={readingMode ? 'true' : 'false'}
        className={`ds-no-drag ds-code-sidebar flex min-h-0 flex-col border-l border-ds-border-muted ${readingMode ? 'is-reading' : ''} ${className ?? ''}`}
      >
      <div className="ds-code-sidebar-topbar">
        <div
          className="ds-code-sidebar-tabs"
          role="tablist"
          aria-label={t('filePreviewOpenFiles')}
          onWheel={handleTabWheel}
        >
          {visibleTargets.map((item, index) => {
            const active = targetKey(item) === activeTargetKey
            const pinned = pinnedTargetKeySet.has(targetKey(item))
            const itemPath = item.path
            const itemRoot = item.workspaceRoot ?? workspaceRoot
            const itemLabel = fileNameFromPath(itemPath)
            const itemBadge = extensionBadge(itemPath, languageFromFilePath(itemPath))
            const itemTitle = formatFilePathForDisplay(itemPath, itemRoot) ?? itemPath
            return (
              <div
                key={targetKey(item)}
                data-kun-preview-key={targetKey(item)}
                role="presentation"
                className={`ds-code-sidebar-tab ${active ? 'is-active' : ''}`}
              >
                <button
                  ref={(element) => {
                    const key = targetKey(item)
                    if (element) tabButtonRefs.current.set(key, element)
                    else tabButtonRefs.current.delete(key)
                  }}
                  type="button"
                  role="tab"
                  tabIndex={active ? 0 : -1}
                  aria-selected={active}
                  aria-label={pinned ? t('filePreviewPinnedTab', { file: itemLabel }) : itemLabel}
                  className="ds-code-sidebar-tab-selector"
                  title={itemTitle}
                  onClick={() => onSelectTarget?.(item)}
                  onDoubleClick={() => openTargetInEditor(item)}
                  onContextMenu={tabActionsEnabled ? (event) => openTabMenu(event, item) : undefined}
                  onKeyDown={(event) => handleTabKeyDown(event, item, index)}
                >
                  {pinned ? (
                    <Pin
                      aria-hidden="true"
                      className="h-3 w-3 shrink-0"
                      style={{ color: 'var(--ds-accent)' }}
                      strokeWidth={1.8}
                    />
                  ) : null}
                  <span className="ds-code-sidebar-file-badge">{itemBadge}</span>
                  <span className="min-w-0 truncate">{itemLabel}</span>
                </button>
                {onCloseTarget ? (
                  <button
                    type="button"
                    aria-label={t('filePreviewCloseTab', { file: itemLabel })}
                    title={t('filePreviewCloseTab', { file: itemLabel })}
                    className="ds-code-sidebar-tab-close"
                    onClick={() => {
                      onCloseTarget(item)
                    }}
                  >
                    <X className="h-3 w-3" strokeWidth={2} />
                  </button>
                ) : null}
              </div>
            )
          })}
          {!visibleTargets.length ? (
            <div
              role="presentation"
              className="ds-code-sidebar-tab"
              title={t('filePreviewEmpty')}
            >
              <button type="button" role="tab" aria-selected="false" disabled className="ds-code-sidebar-tab-selector">
                <span className="ds-code-sidebar-file-badge">{badge}</span>
                <span className="truncate">{currentFileName}</span>
              </button>
            </div>
          ) : null}
        </div>

        <div className="ds-code-sidebar-actions">
          {onTogglePreserveAcrossThreads ? (
            <button
              type="button"
              onClick={onTogglePreserveAcrossThreads}
              className="ds-code-sidebar-icon-button"
              title={t('filePreviewPreserveAcrossThreads')}
              aria-label={t('filePreviewPreserveAcrossThreads')}
              aria-pressed={preserveAcrossThreads}
            >
              <Files
                className="h-4 w-4"
                style={preserveAcrossThreads ? { color: 'var(--ds-accent)' } : undefined}
                strokeWidth={1.75}
              />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setReadingMode((value) => !value)}
            className="ds-code-sidebar-icon-button"
            title={readingMode ? t('filePreviewExitReadingMode') : t('filePreviewEnterReadingMode')}
            aria-label={readingMode ? t('filePreviewExitReadingMode') : t('filePreviewEnterReadingMode')}
            aria-pressed={readingMode}
          >
            {readingMode ? (
              <Minimize2 className="h-4 w-4" strokeWidth={1.8} />
            ) : (
              <Maximize2 className="h-4 w-4" strokeWidth={1.8} />
            )}
          </button>
          {isMarkdownFile ? (
            <button
              type="button"
              onClick={() => setMarkdownRendered((value) => !value)}
              disabled={!result?.ok}
              className="ds-code-sidebar-icon-button"
              title={markdownRendered ? t('filePreviewShowSource') : t('filePreviewRenderMarkdown')}
              aria-label={markdownRendered ? t('filePreviewShowSource') : t('filePreviewRenderMarkdown')}
              aria-pressed={markdownRendered}
            >
              {markdownRendered ? (
                <Code2 className="h-4 w-4" strokeWidth={1.75} />
              ) : (
                <Eye className="h-4 w-4" strokeWidth={1.75} />
              )}
            </button>
          ) : null}
          {isSvgFile ? (
            <button
              type="button"
              onClick={() => setSvgRendered((value) => !value)}
              disabled={!result?.ok || result.truncated}
              className="ds-code-sidebar-icon-button"
              title={svgRendered ? t('filePreviewShowSvgSource') : t('filePreviewRenderSvg')}
              aria-label={svgRendered ? t('filePreviewShowSvgSource') : t('filePreviewRenderSvg')}
              aria-pressed={svgRendered}
            >
              {svgRendered ? (
                <Code2 className="h-4 w-4" strokeWidth={1.75} />
              ) : (
                <Eye className="h-4 w-4" strokeWidth={1.75} />
              )}
            </button>
          ) : null}
          {isJsonFile ? (
            <button
              type="button"
              onClick={() => void saveJson()}
              disabled={!jsonDirty || savingJson}
              className="ds-code-sidebar-icon-button"
              title={t('filePreviewSaveJson', { defaultValue: 'Save JSON' })}
              aria-label={t('filePreviewSaveJson', { defaultValue: 'Save JSON' })}
            >
              {savingJson ? (
                <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.8} />
              ) : (
                <Save className="h-4 w-4" strokeWidth={1.75} />
              )}
            </button>
          ) : null}
          <button
            type="button"
            onClick={openInEditor}
            disabled={!target}
            className="ds-code-sidebar-icon-button"
            title={t('filePreviewOpenEditor')}
            aria-label={t('filePreviewOpenEditor')}
          >
            <ExternalLink className="h-4 w-4" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={() => void copyContent()}
            disabled={!result?.ok}
            className="ds-code-sidebar-icon-button"
            title={copied ? t('copySuccess') : t('filePreviewCopyContent')}
            aria-label={copied ? t('copySuccess') : t('filePreviewCopyContent')}
          >
            {copied ? (
              <Check className="h-4 w-4 text-emerald-600" strokeWidth={2} />
            ) : (
              <Copy className="h-4 w-4" strokeWidth={1.75} />
            )}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="ds-code-sidebar-icon-button"
            title={t('rightPanelCollapse')}
            aria-label={t('rightPanelCollapse')}
          >
            <PanelRightClose className="h-4 w-4" strokeWidth={1.85} />
          </button>
        </div>
      </div>

      <div className="ds-code-sidebar-breadcrumbs">
        <div className="min-w-0 flex flex-1 items-center gap-1 overflow-hidden">
          {breadcrumbSegments.length ? breadcrumbSegments.map((segment, index) => (
            <span key={`${segment}-${index}`} className="contents">
              {index > 0 ? (
                <ChevronRight className="h-3 w-3 shrink-0 text-ds-faint/70" strokeWidth={1.8} />
              ) : null}
              <span
                className={[
                  'truncate',
                  index === breadcrumbSegments.length - 1 ? 'text-ds-ink' : 'text-ds-muted'
                ].join(' ')}
                title={segment}
              >
                {segment}
              </span>
            </span>
          )) : (
            <span className="truncate text-ds-muted">{t('filePreviewEmpty')}</span>
          )}
        </div>
        {result?.ok || imageResult?.ok ? (
          <span className="shrink-0 font-mono text-[10px] text-ds-faint">
            {formatBytes(result?.ok ? result.size : imageResult?.ok ? imageResult.size : 0)}
            {language ? ` · ${language}` : ''}
          </span>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {!target ? (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-[12px] leading-6 text-ds-muted">
            <div className="flex flex-col items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-ds-border-muted text-ds-faint">
                <FileCode2 className="h-5 w-5" strokeWidth={1.7} />
              </div>
              {t('filePreviewEmpty')}
            </div>
          </div>
        ) : loading ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-[12px] text-ds-muted">
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.8} />
            {t('filePreviewLoading')}
          </div>
        ) : imageResult?.ok ? (
          <div
            ref={scrollRef}
            onScroll={handlePreviewScroll}
            className="ds-file-preview-image min-h-0 flex-1 overflow-auto p-5"
          >
            <img
              src={imageResult.dataUrl}
              alt={currentFileName}
              className="block h-full min-h-[120px] w-full object-contain"
            />
          </div>
        ) : result?.ok ? (
          <div className="relative flex min-h-0 flex-1 flex-col">
            {result.truncated ? (
              <div className="shrink-0 border-b border-ds-border-muted/70 px-4 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                {t('filePreviewTruncated')}
              </div>
            ) : null}
            {jsonSaveError ? (
              <div className="shrink-0 border-b border-red-200/70 px-4 py-1.5 text-[11px] text-red-700 dark:border-red-900/60 dark:text-red-300">
                {jsonSaveError}
              </div>
            ) : null}
            {isJsonFile ? (
              <textarea
                value={jsonDraft}
                readOnly={result.truncated}
                spellCheck={false}
                aria-label={t('filePreviewEditJson', { defaultValue: 'Edit JSON' })}
                className="min-h-0 flex-1 resize-none border-0 bg-transparent p-4 font-mono text-[12px] leading-[22px] text-ds-ink outline-none"
                onChange={(event) => {
                  setJsonDraft(event.target.value)
                  setJsonSaveError(null)
                }}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                    event.preventDefault()
                    void saveJson()
                  }
                }}
              />
            ) : isSvgFile && svgRendered && !result.truncated ? (
              <div
                ref={scrollRef}
                onScroll={handlePreviewScroll}
                className="ds-file-preview-svg min-h-0 flex-1 overflow-auto p-5"
              >
                <img
                  src={svgDataUrl}
                  alt={currentFileName}
                  className="block h-full min-h-[120px] w-full object-contain"
                />
              </div>
            ) : isMarkdownFile && markdownRendered ? (
              <div
                ref={scrollRef}
                onScroll={handlePreviewScroll}
                className="ds-file-preview-markdown min-h-0 flex-1 overflow-auto px-5 py-4"
              >
                <div className="ds-markdown min-h-full text-ds-ink">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={markdownRehypePlugins}
                    components={{
                      a: ({ href, children, ...props }): ReactNode => (
                        <a
                          {...props}
                          href={href}
                          onClick={(event) => {
                            if (!href) return
                            event.preventDefault()
                            void window.kunGui?.openExternal?.(href)?.catch(() => undefined)
                          }}
                        >
                          {children}
                        </a>
                      ),
                      img: ({ src, alt, ...props }): ReactNode => (
                        <ResolvedPreviewImage
                          {...props}
                          src={src}
                          alt={alt}
                          filePath={result.path}
                        />
                      )
                    }}
                  >
                    {result.content}
                  </ReactMarkdown>
                </div>
              </div>
            ) : (
              <div
                ref={scrollRef}
                onScroll={handlePreviewScroll}
                className="ds-file-preview-scroll min-h-0 flex-1 overflow-auto font-mono text-[12px] leading-[22px] text-ds-ink"
              >
                <div
                  className="ds-file-preview-code-surface"
                  style={codeSurfaceStyle}
                >
                  {activeLine ? (
                    <div className="ds-file-preview-active-line" aria-hidden="true" />
                  ) : null}
                  <div className="ds-file-preview-gutter">
                    {lines.map((_, index) => {
                      const lineNo = index + 1
                      return (
                        <div
                          key={lineNo}
                          data-line={lineNo}
                          className={`ds-file-preview-line-number ${activeLine === lineNo ? 'is-active' : ''}`}
                        >
                          {lineNo}
                        </div>
                      )
                    })}
                  </div>
                  <div
                    className="ds-file-preview-code-html"
                    dangerouslySetInnerHTML={{ __html: highlightHtml }}
                  />
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-[12px] leading-6 text-red-700 dark:text-red-300">
            {imageResult?.message ?? result?.message ?? t('filePreviewFailed')}
          </div>
        )}
      </div>
      </aside>
      {tabMenu && typeof document !== 'undefined' ? createPortal(
        <div
          ref={tabMenuRef}
          role="menu"
          aria-label={t('filePreviewTabActions')}
          className="fixed z-[10000] min-w-[184px] rounded-lg border border-ds-border bg-ds-card p-1 shadow-xl"
          style={{ left: tabMenu.x, top: tabMenu.y }}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            event.preventDefault()
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')
            )
            if (items.length === 0) return
            const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement)
            const direction = event.key === 'ArrowDown' ? 1 : -1
            items[(currentIndex + direction + items.length) % items.length]?.focus()
          }}
        >
          {onTogglePinnedTarget ? (
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={pinnedTargetKeySet.has(targetKey(tabMenu.target))}
              className="block w-full rounded-md px-2.5 py-2 text-left text-[12px] text-ds-ink hover:bg-ds-hover"
              onClick={() => {
                onTogglePinnedTarget(tabMenu.target)
                setTabMenu(null)
                window.requestAnimationFrame(() => tabMenuTriggerRef.current?.focus())
              }}
            >
              {pinnedTargetKeySet.has(targetKey(tabMenu.target))
                ? t('filePreviewUnpinTab')
                : t('filePreviewPinTab')}
            </button>
          ) : null}
          {onCloseOtherTargets ? (
            <button
              type="button"
              role="menuitem"
              disabled={visibleTargets.length < 2}
              className="block w-full rounded-md px-2.5 py-2 text-left text-[12px] text-ds-ink hover:bg-ds-hover disabled:cursor-default disabled:opacity-45"
              onClick={() => {
                onCloseOtherTargets(tabMenu.target)
                setTabMenu(null)
                window.requestAnimationFrame(() => tabMenuTriggerRef.current?.focus())
              }}
            >
              {t('filePreviewCloseOtherTabs')}
            </button>
          ) : null}
        </div>,
        document.body
      ) : null}
    </>
  )
}
