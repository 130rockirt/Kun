import type { FormEvent, PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  CircleAlert,
  Crosshair,
  ExternalLink,
  Globe2,
  Loader2,
  MonitorSmartphone,
  MoreHorizontal,
  PanelRightClose,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  X
} from 'lucide-react'
import type { JsonObject } from '@kun/extension-api'
import type { ChatBlock } from '../agent/types'
import { normalizeDevPreviewUrlInput } from '@shared/dev-preview-url'
import {
  appendDevPreviewIssue,
  createDevPreviewIssue,
  MAX_DEV_PREVIEW_ELEMENTS,
  normalizeDevPreviewElementContext,
  paddedDevPreviewCaptureRect,
  type DevPreviewElementContext,
  type DevPreviewIssue,
  type DevPreviewRect
} from '@shared/dev-preview-context'
import type { DevPreviewCaptureResult } from '@shared/dev-preview-capture'
import { DEV_PREVIEW_PARTITION } from '@shared/dev-preview-capture'
import {
  extractDetectedDevPreviewUrls,
  formatDevPreviewUrlLabel
} from '../lib/dev-preview-detection'
import {
  DEV_PREVIEW_VIEWPORTS,
  devPreviewViewportScale,
  readDevPreviewWorkspaceState,
  rememberDevPreviewUrl,
  writeDevPreviewWorkspaceState,
  type DevPreviewViewportPreset,
  type DevPreviewWorkspaceState
} from '../lib/dev-preview-state'
import {
  buildDevPreviewElementInspectionScript,
  canUseElectronWebviewEnvironment,
  mapPreviewPointerToViewport,
  resolveInitialDevBrowserUrl
} from '../lib/dev-preview-panel'
import { workspaceRootScopeKey } from '../lib/workspace-path'

type DevWebviewTag = HTMLElement & {
  canGoBack(): boolean
  canGoForward(): boolean
  executeJavaScript<T = unknown>(code: string, userGesture?: boolean): Promise<T>
  getURL(): string
  getWebContentsId(): number
  goBack(): void
  goForward(): void
  reloadIgnoringCache(): void
}

type WebviewNavigateEvent = Event & { url: string }
type WebviewFailLoadEvent = Event & {
  errorCode: number
  errorDescription: string
  isMainFrame: boolean
  validatedURL?: string
}
type WebviewTitleEvent = Event & { title: string }
type WebviewConsoleEvent = Event & {
  level: number | string
  message: string
  sourceId?: string
  line?: number
}

type LoadOptions = { keepAutoFollow?: boolean }

export type DevPreviewContextDraft = {
  kind: 'element' | 'issue'
  title: string
  summary: string
  reference: JsonObject
  screenshot?: DevPreviewCaptureResult
}

export type DevBrowserPanelProps = {
  blocks: ChatBlock[]
  preferredUrl?: string | null
  workspaceRoot?: string
  activeThreadId?: string | null
  selectedElementCount?: number
  supportsImageCapture?: boolean
  className?: string
  onCollapse: () => void
  embedded?: boolean
  onTitleChange?: (title: string) => void
  onAttachContext?: (draft: DevPreviewContextDraft) => void | Promise<void>
  onDocumentChange?: () => void
}

function formatAddressInput(url: string): string {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname === '/' ? '' : parsed.pathname
    return `${parsed.host}${path}${parsed.search}${parsed.hash}`
  } catch {
    return url
  }
}

function contextTitle(element: DevPreviewElementContext): string {
  const text = element.text.slice(0, 48)
  return text ? `${element.tag}: ${text}` : `${element.tag}: ${element.selector.slice(0, 64)}`
}

function viewportLabel(preset: DevPreviewViewportPreset): string {
  if (preset === 'fit') return 'Fit'
  const size = DEV_PREVIEW_VIEWPORTS[preset]
  return `${size.width}×${size.height}`
}

function iconButtonClass(active = false): string {
  return `inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition disabled:cursor-default disabled:opacity-30 ${
    active
      ? 'bg-accent/12 text-accent dark:bg-accent/20'
      : 'text-ds-faint hover:bg-ds-hover hover:text-ds-ink'
  }`
}

export function DevBrowserPanel(props: DevBrowserPanelProps): ReactElement {
  return <DevPreviewPanel {...props} />
}

function DevPreviewPanel({
  blocks,
  preferredUrl,
  workspaceRoot = '',
  activeThreadId = null,
  selectedElementCount = 0,
  supportsImageCapture = false,
  className,
  onCollapse,
  embedded = false,
  onTitleChange,
  onAttachContext,
  onDocumentChange
}: DevBrowserPanelProps): ReactElement {
  const { t } = useTranslation('common')
  const rootRef = useRef<HTMLElement | null>(null)
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const viewportShellRef = useRef<HTMLDivElement | null>(null)
  const webviewRef = useRef<DevWebviewTag | null>(null)
  const iframeLoadedUrlRef = useRef<string | null>(null)
  const detectedUrls = useMemo(() => extractDetectedDevPreviewUrls(blocks), [blocks])
  const latestDetectedUrl = detectedUrls[0] ?? null
  const normalizedPreferredUrl = useMemo(
    () => (preferredUrl ? normalizeDevPreviewUrlInput(preferredUrl) : null),
    [preferredUrl]
  )
  const workspaceScope = workspaceRootScopeKey(workspaceRoot) || '__default__'
  const initialWorkspaceState = useMemo(
    () => readDevPreviewWorkspaceState(workspaceRoot),
    // Scope identity is intentionally the dependency; path spelling is normalized.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaceScope]
  )
  const initialUrl = resolveInitialDevBrowserUrl({
    normalizedPreferredUrl,
    storedUrl: initialWorkspaceState.url,
    latestDetectedUrl
  })
  const useElectronWebview = canUseElectronWebviewEnvironment({
    openExternalAvailable: typeof window.kunGui?.openExternal === 'function',
    userAgent: window.navigator.userAgent
  })
  const agentFeaturesAvailable = useElectronWebview
  const captureAvailable = useElectronWebview &&
    typeof window.kunGui?.captureDevPreviewRegion === 'function'

  const [preferences, setPreferences] = useState<{
    scope: string
    value: DevPreviewWorkspaceState
  }>(() => ({
    scope: workspaceScope,
    value: normalizedPreferredUrl
      ? rememberDevPreviewUrl({ ...initialWorkspaceState, autoFollow: false }, normalizedPreferredUrl)
      : initialWorkspaceState
  }))
  const workspaceState = preferences.value
  const [activeUrl, setActiveUrl] = useState<string | null>(initialUrl)
  const [draftUrl, setDraftUrl] = useState(() => initialUrl ? formatAddressInput(initialUrl) : '')
  const [loading, setLoading] = useState(Boolean(initialUrl))
  const [loadError, setLoadError] = useState<string | null>(null)
  const [pageTitle, setPageTitle] = useState('')
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [iframeBackStack, setIframeBackStack] = useState<string[]>([])
  const [iframeForwardStack, setIframeForwardStack] = useState<string[]>([])
  const [iframeReloadNonce, setIframeReloadNonce] = useState(0)
  const [previewInstanceNonce, setPreviewInstanceNonce] = useState(0)
  const [panelWidth, setPanelWidth] = useState(560)
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 })
  const [addressMenuOpen, setAddressMenuOpen] = useState(false)
  const [viewportMenuOpen, setViewportMenuOpen] = useState(false)
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const [issuesOpen, setIssuesOpen] = useState(false)
  const [issues, setIssues] = useState<DevPreviewIssue[]>([])
  const [selectionMode, setSelectionMode] = useState(false)
  const [hoverRect, setHoverRect] = useState<DevPreviewRect | null>(null)
  const hoverFrameRef = useRef<number | null>(null)
  const hoverInspectionPendingRef = useRef(false)
  const latestHoverPointRef = useRef<{ clientX: number; clientY: number } | null>(null)
  const selectionPendingRef = useRef(false)
  const preferredUrlRef = useRef<string | null>(normalizedPreferredUrl)
  const contextScopeRef = useRef(`${workspaceScope}:${activeThreadId ?? ''}`)
  const compact = panelWidth < 420
  const canNavigateBack = useElectronWebview ? canGoBack : iframeBackStack.length > 0
  const canNavigateForward = useElectronWebview ? canGoForward : iframeForwardStack.length > 0

  useEffect(() => {
    const root = rootRef.current
    if (!root || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setPanelWidth(entry?.contentRect.width ?? 560))
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setCanvasSize({
      width: entry?.contentRect.width ?? 0,
      height: entry?.contentRect.height ?? 0
    }))
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [activeUrl])

  useEffect(() => {
    if (preferences.scope === workspaceScope) return
    const next = readDevPreviewWorkspaceState(workspaceRoot)
    const nextUrl = resolveInitialDevBrowserUrl({
      normalizedPreferredUrl,
      storedUrl: next.url,
      latestDetectedUrl
    })
    setPreferences({
      scope: workspaceScope,
      value: normalizedPreferredUrl
        ? rememberDevPreviewUrl({ ...next, autoFollow: false }, normalizedPreferredUrl)
        : next
    })
    setActiveUrl(nextUrl)
    setDraftUrl(nextUrl ? formatAddressInput(nextUrl) : '')
    setPageTitle('')
    setLoadError(null)
    setLoading(Boolean(nextUrl))
    setIssues([])
    setSelectionMode(false)
    setHoverRect(null)
    onDocumentChange?.()
  }, [latestDetectedUrl, normalizedPreferredUrl, onDocumentChange, preferences.scope, workspaceRoot, workspaceScope])

  useEffect(() => {
    const nextScope = `${workspaceScope}:${activeThreadId ?? ''}`
    if (contextScopeRef.current === nextScope) return
    contextScopeRef.current = nextScope
    setIssues([])
    setSelectionMode(false)
    setHoverRect(null)
    onDocumentChange?.()
  }, [activeThreadId, onDocumentChange, workspaceScope])

  useEffect(() => {
    if (preferences.scope !== workspaceScope) return
    writeDevPreviewWorkspaceState(workspaceRoot, preferences.value)
  }, [preferences, workspaceRoot, workspaceScope])

  const updateWorkspaceState = useCallback((
    updater: (current: DevPreviewWorkspaceState) => DevPreviewWorkspaceState
  ): void => {
    setPreferences((current) => current.scope === workspaceScope
      ? { ...current, value: updater(current.value) }
      : current)
  }, [workspaceScope])

  useEffect(() => {
    if (!normalizedPreferredUrl || preferredUrlRef.current === normalizedPreferredUrl) return
    preferredUrlRef.current = normalizedPreferredUrl
    setIssues([])
    setSelectionMode(false)
    setHoverRect(null)
    onDocumentChange?.()
    setActiveUrl(normalizedPreferredUrl)
    setDraftUrl(formatAddressInput(normalizedPreferredUrl))
    setPageTitle('')
    setLoading(true)
    setLoadError(null)
    updateWorkspaceState((current) => rememberDevPreviewUrl({ ...current, autoFollow: false }, normalizedPreferredUrl))
  }, [normalizedPreferredUrl, onDocumentChange, updateWorkspaceState])

  useEffect(() => {
    if (!workspaceState.autoFollow || !latestDetectedUrl || latestDetectedUrl === activeUrl) return
    setIssues([])
    setSelectionMode(false)
    setHoverRect(null)
    onDocumentChange?.()
    setActiveUrl(latestDetectedUrl)
    setDraftUrl(formatAddressInput(latestDetectedUrl))
    setPageTitle('')
    setLoading(true)
    setLoadError(null)
    updateWorkspaceState((current) => rememberDevPreviewUrl(current, latestDetectedUrl))
  }, [activeUrl, latestDetectedUrl, onDocumentChange, updateWorkspaceState, workspaceState.autoFollow])

  const addIssue = useCallback((issue: DevPreviewIssue | null): void => {
    setIssues((current) => appendDevPreviewIssue(current, issue))
  }, [])

  useEffect(() => {
    const webview = webviewRef.current
    if (!useElectronWebview || !activeUrl || !webview) return

    const syncNavigationState = (): void => {
      try {
        setCanGoBack(webview.canGoBack())
        setCanGoForward(webview.canGoForward())
        const currentUrl = normalizeDevPreviewUrlInput(webview.getURL())
        if (currentUrl) {
          setActiveUrl(currentUrl)
          setDraftUrl(formatAddressInput(currentUrl))
          updateWorkspaceState((current) => rememberDevPreviewUrl(current, currentUrl))
        }
      } catch {
        /* webview may not be attached yet */
      }
    }
    const handleStartLoading = (): void => {
      setLoading(true)
      setLoadError(null)
    }
    const handleStopLoading = (): void => {
      setLoading(false)
      syncNavigationState()
    }
    const handleNavigate: EventListener = (event): void => {
      const currentUrl = normalizeDevPreviewUrlInput((event as WebviewNavigateEvent).url)
      if (!currentUrl) return
      setIssues([])
      setHoverRect(null)
      onDocumentChange?.()
      setActiveUrl(currentUrl)
      setDraftUrl(formatAddressInput(currentUrl))
      setLoadError(null)
      updateWorkspaceState((current) => rememberDevPreviewUrl(current, currentUrl))
      syncNavigationState()
    }
    const handleInPageNavigate: EventListener = (event): void => {
      const currentUrl = normalizeDevPreviewUrlInput((event as WebviewNavigateEvent).url)
      if (!currentUrl) return
      setActiveUrl(currentUrl)
      setDraftUrl(formatAddressInput(currentUrl))
      updateWorkspaceState((current) => rememberDevPreviewUrl(current, currentUrl))
      syncNavigationState()
    }
    const handleFailLoad: EventListener = (event): void => {
      const failEvent = event as WebviewFailLoadEvent
      if (!failEvent.isMainFrame || failEvent.errorCode === -3) return
      const message = failEvent.errorDescription || t('browserLoadFailed')
      setLoading(false)
      setLoadError(message)
      addIssue(createDevPreviewIssue({
        kind: 'load',
        message: `${message} (${failEvent.errorCode})`,
        source: failEvent.validatedURL ?? activeUrl
      }))
      syncNavigationState()
    }
    const handleTitle: EventListener = (event): void => setPageTitle((event as WebviewTitleEvent).title)
    const handleConsole: EventListener = (event): void => {
      const consoleEvent = event as WebviewConsoleEvent
      if (consoleEvent.level !== 3 && consoleEvent.level !== 'error') return
      addIssue(createDevPreviewIssue({
        kind: 'console',
        message: consoleEvent.message,
        source: consoleEvent.sourceId,
        line: consoleEvent.line
      }))
    }

    webview.addEventListener('did-start-loading', handleStartLoading)
    webview.addEventListener('did-stop-loading', handleStopLoading)
    webview.addEventListener('did-navigate', handleNavigate)
    webview.addEventListener('did-navigate-in-page', handleInPageNavigate)
    webview.addEventListener('did-fail-load', handleFailLoad)
    webview.addEventListener('page-title-updated', handleTitle)
    webview.addEventListener('console-message', handleConsole)
    return () => {
      webview.removeEventListener('did-start-loading', handleStartLoading)
      webview.removeEventListener('did-stop-loading', handleStopLoading)
      webview.removeEventListener('did-navigate', handleNavigate)
      webview.removeEventListener('did-navigate-in-page', handleInPageNavigate)
      webview.removeEventListener('did-fail-load', handleFailLoad)
      webview.removeEventListener('page-title-updated', handleTitle)
      webview.removeEventListener('console-message', handleConsole)
    }
  }, [activeUrl, addIssue, onDocumentChange, previewInstanceNonce, t, updateWorkspaceState, useElectronWebview])

  useEffect(() => {
    if (useElectronWebview || !activeUrl) return
    iframeLoadedUrlRef.current = null
    setLoading(true)
    setLoadError(null)
    const timeout = window.setTimeout(() => {
      if (iframeLoadedUrlRef.current === activeUrl) return
      setLoading(false)
      setLoadError(t('browserLoadFailed'))
    }, 10_000)
    return () => window.clearTimeout(timeout)
  }, [activeUrl, iframeReloadNonce, t, useElectronWebview])

  useEffect(() => {
    if (!selectionMode) return
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setSelectionMode(false)
      setHoverRect(null)
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [selectionMode])

  useEffect(() => () => {
    latestHoverPointRef.current = null
    if (hoverFrameRef.current != null) window.cancelAnimationFrame(hoverFrameRef.current)
  }, [])

  const reload = useCallback((): void => {
    if (!activeUrl) return
    setLoading(true)
    setLoadError(null)
    if (!useElectronWebview) {
      iframeLoadedUrlRef.current = null
      setIframeReloadNonce((nonce) => nonce + 1)
      return
    }
    try {
      webviewRef.current?.reloadIgnoringCache()
    } catch {
      setPreviewInstanceNonce((nonce) => nonce + 1)
    }
  }, [activeUrl, useElectronWebview])

  const loadUrl = (value: string, options: LoadOptions = {}): void => {
    const normalized = normalizeDevPreviewUrlInput(value)
    if (!normalized) {
      setLoadError(t('browserInvalidUrl'))
      return
    }
    setAddressMenuOpen(false)
    setLoadError(null)
    setPageTitle('')
    setDraftUrl(formatAddressInput(normalized))
    if (!options.keepAutoFollow) {
      updateWorkspaceState((current) => ({ ...current, autoFollow: false }))
    }
    updateWorkspaceState((current) => rememberDevPreviewUrl(current, normalized))
    if (normalized === activeUrl) {
      reload()
      return
    }
    setIssues([])
    setSelectionMode(false)
    setHoverRect(null)
    onDocumentChange?.()
    if (!useElectronWebview && activeUrl) {
      setIframeBackStack((stack) => [...stack, activeUrl].slice(-30))
      setIframeForwardStack([])
    }
    setLoading(true)
    setActiveUrl(normalized)
  }

  const submitUrl = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    loadUrl(draftUrl)
  }

  const clearPreview = (): void => {
    setLoadError(null)
    setPageTitle('')
    setCanGoBack(false)
    setCanGoForward(false)
    setIframeBackStack([])
    setIframeForwardStack([])
    setDraftUrl('')
    setLoading(false)
    setActiveUrl(null)
    setIssues([])
    setSelectionMode(false)
    setHoverRect(null)
    updateWorkspaceState((current) => ({ ...current, url: null, autoFollow: false }))
    onDocumentChange?.()
    setMoreMenuOpen(false)
  }

  const openExternal = (): void => {
    const normalized = activeUrl ? normalizeDevPreviewUrlInput(activeUrl) : null
    if (!normalized) return
    if (typeof window.kunGui?.openExternal === 'function') {
      void window.kunGui.openExternal(normalized).catch(() => undefined)
    } else {
      window.open(normalized, '_blank', 'noopener,noreferrer')
    }
    setMoreMenuOpen(false)
  }

  const goBack = (): void => {
    if (!activeUrl) return
    if (!useElectronWebview) {
      const previousUrl = iframeBackStack.at(-1)
      if (!previousUrl) return
      setIframeBackStack((stack) => stack.slice(0, -1))
      setIframeForwardStack((stack) => [activeUrl, ...stack].slice(0, 30))
      setIssues([])
      setSelectionMode(false)
      setHoverRect(null)
      onDocumentChange?.()
      setActiveUrl(previousUrl)
      setDraftUrl(formatAddressInput(previousUrl))
      return
    }
    try {
      if (webviewRef.current?.canGoBack()) webviewRef.current.goBack()
    } catch { /* unavailable guest */ }
  }

  const goForward = (): void => {
    if (!activeUrl) return
    if (!useElectronWebview) {
      const nextUrl = iframeForwardStack[0]
      if (!nextUrl) return
      setIframeForwardStack((stack) => stack.slice(1))
      setIframeBackStack((stack) => [...stack, activeUrl].slice(-30))
      setIssues([])
      setSelectionMode(false)
      setHoverRect(null)
      onDocumentChange?.()
      setActiveUrl(nextUrl)
      setDraftUrl(formatAddressInput(nextUrl))
      return
    }
    try {
      if (webviewRef.current?.canGoForward()) webviewRef.current.goForward()
    } catch { /* unavailable guest */ }
  }

  const inspectAtPointer = useCallback(async (
    pointInput: { clientX: number; clientY: number }
  ): Promise<DevPreviewElementContext | null> => {
    const shell = viewportShellRef.current
    const webview = webviewRef.current
    if (!shell || !webview) return null
    const size = workspaceState.viewport === 'fit'
      ? { width: shell.clientWidth, height: shell.clientHeight }
      : DEV_PREVIEW_VIEWPORTS[workspaceState.viewport]
    const point = mapPreviewPointerToViewport({
      clientX: pointInput.clientX,
      clientY: pointInput.clientY,
      bounds: shell.getBoundingClientRect(),
      viewportWidth: size.width,
      viewportHeight: size.height
    })
    if (!point) return null
    try {
      const raw = await webview.executeJavaScript(
        buildDevPreviewElementInspectionScript(point.x, point.y),
        true
      )
      return normalizeDevPreviewElementContext(raw)
    } catch {
      return null
    }
  }, [workspaceState.viewport])

  const queueHoverInspection = useCallback((): void => {
    if (hoverInspectionPendingRef.current || hoverFrameRef.current != null) return
    const inspectLatest = (): void => {
      hoverFrameRef.current = null
      const snapshot = latestHoverPointRef.current
      if (!snapshot) return
      hoverInspectionPendingRef.current = true
      void inspectAtPointer(snapshot)
        .then((element) => {
          if (latestHoverPointRef.current === snapshot) setHoverRect(element?.rect ?? null)
        })
        .finally(() => {
          hoverInspectionPendingRef.current = false
          if (latestHoverPointRef.current && latestHoverPointRef.current !== snapshot) {
            hoverFrameRef.current = window.requestAnimationFrame(inspectLatest)
          }
        })
    }
    hoverFrameRef.current = window.requestAnimationFrame(inspectLatest)
  }, [inspectAtPointer])

  const handleSelectionMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    latestHoverPointRef.current = { clientX: event.clientX, clientY: event.clientY }
    queueHoverInspection()
  }

  const handleSelectionLeave = (): void => {
    latestHoverPointRef.current = null
    if (hoverFrameRef.current != null) {
      window.cancelAnimationFrame(hoverFrameRef.current)
      hoverFrameRef.current = null
    }
    setHoverRect(null)
  }

  const handleSelectionClick = async (event: ReactPointerEvent<HTMLDivElement>): Promise<void> => {
    event.preventDefault()
    event.stopPropagation()
    if (selectionPendingRef.current || selectedElementCount >= MAX_DEV_PREVIEW_ELEMENTS) return
    selectionPendingRef.current = true
    try {
      const element = await inspectAtPointer({ clientX: event.clientX, clientY: event.clientY })
      if (!element || !onAttachContext) return
      let screenshot: DevPreviewCaptureResult | undefined
      if (supportsImageCapture && captureAvailable && webviewRef.current && activeUrl) {
        try {
          screenshot = await window.kunGui.captureDevPreviewRegion({
            guestWebContentsId: webviewRef.current.getWebContentsId(),
            url: activeUrl,
            rect: paddedDevPreviewCaptureRect(element.rect, element.viewport)
          })
        } catch {
          screenshot = undefined
        }
      }
      await onAttachContext({
        kind: 'element',
        title: contextTitle(element),
        summary: [element.selector, element.text].filter(Boolean).join(' · ').slice(0, 1_024),
        reference: element as unknown as JsonObject,
        ...(screenshot ? { screenshot } : {})
      })
    } finally {
      selectionPendingRef.current = false
    }
  }

  const attachIssue = (issue: DevPreviewIssue): void => {
    if (!onAttachContext) return
    void onAttachContext({
      kind: 'issue',
      title: issue.kind === 'load' ? t('previewLoadIssue') : t('previewConsoleIssue'),
      summary: issue.message,
      reference: {
        kind: 'issue',
        issueKind: issue.kind,
        message: issue.message,
        ...(issue.source ? { source: issue.source } : {}),
        ...(issue.line != null ? { line: issue.line } : {}),
        count: issue.count,
        url: activeUrl ?? ''
      }
    })
  }

  const title = pageTitle || t('rightPanelBrowser')
  useEffect(() => onTitleChange?.(title), [onTitleChange, title])

  const fixedViewport = workspaceState.viewport === 'fit'
    ? null
    : DEV_PREVIEW_VIEWPORTS[workspaceState.viewport]
  const viewportScale = fixedViewport
    ? devPreviewViewportScale({
        availableWidth: Math.max(1, canvasSize.width - 24),
        availableHeight: Math.max(1, canvasSize.height - 24),
        viewportWidth: fixedViewport.width,
        viewportHeight: fixedViewport.height
      })
    : 1
  const suggestions = [...detectedUrls, ...workspaceState.recentUrls]
    .filter((url, index, all) => all.indexOf(url) === index)

  return (
    <aside
      ref={rootRef}
      data-preview-width={compact ? 'narrow' : 'wide'}
      className={`ds-sidebar-surface ds-no-drag relative flex min-h-0 flex-col border-l border-ds-border-muted backdrop-blur-xl ${className ?? ''}`}
    >
      {!embedded ? (
        <div className="ds-sidebar-surface-chrome flex h-10 shrink-0 items-center gap-2 border-b border-ds-border-muted px-3">
          <Globe2 className="h-4 w-4 text-ds-muted" strokeWidth={1.8} />
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-ds-ink">{t('rightPanelBrowser')}</span>
          <button type="button" onClick={onCollapse} className={iconButtonClass()} aria-label={t('rightPanelCollapse')}>
            <PanelRightClose className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </div>
      ) : null}

      <div className={`ds-sidebar-surface-chrome relative z-30 flex h-11 shrink-0 items-center border-b border-ds-border-muted ${compact ? 'gap-0.5 px-1' : 'gap-1 px-2'}`}>
        <button type="button" onClick={goBack} disabled={!canNavigateBack} className={iconButtonClass()} aria-label={t('browserBack')} title={t('browserBack')}>
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.8} />
        </button>
        <button type="button" onClick={goForward} disabled={!canNavigateForward} className={iconButtonClass()} aria-label={t('browserForward')} title={t('browserForward')}>
          <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.8} />
        </button>
        <button type="button" onClick={reload} disabled={!activeUrl} className={iconButtonClass()} aria-label={t('browserReload')} title={t('browserReload')}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.8} />}
        </button>

        {compact ? (
          <button
            type="button"
            onClick={() => setAddressMenuOpen((value) => !value)}
            className={iconButtonClass(addressMenuOpen)}
            aria-label={t('browserAddressPlaceholder')}
            title={activeUrl ?? t('browserAddressPlaceholder')}
          >
            <Globe2 className="h-4 w-4" strokeWidth={1.7} />
          </button>
        ) : (
          <form onSubmit={submitUrl} className="relative flex h-8 min-w-0 flex-1 items-center rounded-lg border border-ds-border-muted bg-ds-surface-subtle focus-within:border-ds-border-strong dark:bg-white/[0.07]">
            <Globe2 className="ml-2 h-3.5 w-3.5 shrink-0 text-ds-faint" strokeWidth={1.7} />
            <input
              value={draftUrl}
              onChange={(event) => setDraftUrl(event.target.value)}
              className="h-full min-w-0 flex-1 bg-transparent px-2 text-[12px] font-medium text-ds-ink outline-none"
              placeholder={t('browserAddressPlaceholder')}
              aria-label={t('browserAddressPlaceholder')}
              spellCheck={false}
            />
            <button type="button" onClick={() => setAddressMenuOpen((value) => !value)} className="mr-1 inline-flex h-6 w-6 items-center justify-center rounded-md text-ds-faint hover:bg-ds-hover" aria-label={t('previewDetectedAddresses')}>
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </form>
        )}

        <button
          type="button"
          onClick={() => {
            setSelectionMode((value) => !value)
            setHoverRect(null)
          }}
          disabled={!agentFeaturesAvailable || !activeUrl || selectedElementCount >= MAX_DEV_PREVIEW_ELEMENTS}
          className={iconButtonClass(selectionMode)}
          aria-label={t('previewSelectElement')}
          aria-pressed={selectionMode}
          title={agentFeaturesAvailable ? t('previewSelectElement') : t('previewAgentToolsUnavailable')}
        >
          <Crosshair className="h-4 w-4" strokeWidth={1.8} />
        </button>
        <button type="button" onClick={() => setViewportMenuOpen((value) => !value)} className={iconButtonClass(workspaceState.viewport !== 'fit')} aria-label={t('previewViewport')} title={compact ? viewportLabel(workspaceState.viewport) : t('previewViewport')}>
          <MonitorSmartphone className="h-4 w-4" strokeWidth={1.8} />
        </button>
        <button type="button" onClick={() => setIssuesOpen((value) => !value)} disabled={!useElectronWebview} className={iconButtonClass(issuesOpen || issues.length > 0)} aria-label={t('previewIssues')} title={t('previewIssues')}>
          <span className="relative">
            <CircleAlert className="h-4 w-4" strokeWidth={1.8} />
            {issues.length > 0 ? <span className="absolute -right-2 -top-2 min-w-3.5 rounded-full bg-red-500 px-0.5 text-center text-[8px] font-bold leading-3.5 text-white">{Math.min(issues.length, 99)}</span> : null}
          </span>
        </button>
        <button type="button" onClick={() => setMoreMenuOpen((value) => !value)} className={iconButtonClass(moreMenuOpen)} aria-label={t('previewMoreActions')} title={t('previewMoreActions')}>
          <MoreHorizontal className="h-4 w-4" strokeWidth={1.8} />
        </button>

        {addressMenuOpen ? (
          <div className="absolute left-2 right-2 top-10 z-50 max-h-64 overflow-y-auto rounded-xl border border-ds-border bg-ds-card p-2 shadow-xl">
            {compact ? (
              <form onSubmit={submitUrl} className="mb-2 flex gap-1.5 border-b border-ds-border-muted pb-2">
                <input
                  value={draftUrl}
                  onChange={(event) => setDraftUrl(event.target.value)}
                  className="h-8 min-w-0 flex-1 rounded-lg border border-ds-border-muted bg-ds-surface-subtle px-2.5 text-[12px] text-ds-ink outline-none focus:border-ds-border-strong"
                  placeholder={t('previewPortPlaceholder')}
                  aria-label={t('browserAddressPlaceholder')}
                  spellCheck={false}
                />
                <button type="submit" className="h-8 rounded-lg bg-accent px-2.5 text-[11px] font-semibold text-white">
                  {t('browserOpen')}
                </button>
              </form>
            ) : null}
            {suggestions.length === 0 ? <div className="px-2 py-3 text-[12px] text-ds-muted">{t('previewNoDetectedAddresses')}</div> : null}
            {suggestions.map((url) => (
              <button key={url} type="button" onClick={() => loadUrl(url)} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-ds-hover">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-semibold text-ds-ink">{formatDevPreviewUrlLabel(url)}</span>
                  {!compact ? <span className="block truncate text-[10.5px] text-ds-muted">{url}</span> : null}
                </span>
                <span className="text-[10px] text-ds-faint">{detectedUrls.includes(url) ? t('previewDetected') : t('previewRecent')}</span>
              </button>
            ))}
          </div>
        ) : null}

        {viewportMenuOpen ? (
          <div className="absolute right-12 top-10 z-50 w-44 rounded-xl border border-ds-border bg-ds-card p-1.5 shadow-xl">
            {(['fit', 'phone', 'tablet', 'desktop'] as const).map((preset) => (
              <button key={preset} type="button" onClick={() => {
                updateWorkspaceState((current) => ({ ...current, viewport: preset }))
                setViewportMenuOpen(false)
              }} className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-[12px] ${workspaceState.viewport === preset ? 'bg-accent/10 font-semibold text-accent' : 'text-ds-ink hover:bg-ds-hover'}`}>
                <span>{viewportLabel(preset)}</span>
                {preset !== 'fit' ? <span className="text-[10px] text-ds-faint">{t('previewSizeOnly')}</span> : null}
              </button>
            ))}
          </div>
        ) : null}

        {moreMenuOpen ? (
          <div className="absolute right-2 top-10 z-50 w-48 rounded-xl border border-ds-border bg-ds-card p-1.5 shadow-xl">
            <button type="button" onClick={() => updateWorkspaceState((current) => ({ ...current, autoFollow: !current.autoFollow }))} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[12px] text-ds-ink hover:bg-ds-hover">
              <Sparkles className={`h-4 w-4 ${workspaceState.autoFollow ? 'text-accent' : 'text-ds-faint'}`} />
              <span className="flex-1 text-left">{t('browserAutoFollow')}</span>
              <span className="text-[10px] text-ds-faint">{workspaceState.autoFollow ? t('on') : t('off')}</span>
            </button>
            <button type="button" onClick={openExternal} disabled={!activeUrl} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[12px] text-ds-ink hover:bg-ds-hover disabled:opacity-40">
              <ExternalLink className="h-4 w-4 text-ds-faint" />{t('browserOpenExternal')}
            </button>
            <button type="button" onClick={clearPreview} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[12px] text-red-500 hover:bg-red-500/10">
              <Trash2 className="h-4 w-4" />{t('previewClear')}
            </button>
          </div>
        ) : null}
      </div>

      <div ref={canvasRef} className="relative min-h-0 flex-1 overflow-hidden bg-slate-100/75 dark:bg-black/25">
        {!activeUrl ? (
          <div className="absolute inset-0 overflow-y-auto p-5">
            <div className="mx-auto flex min-h-full max-w-md flex-col justify-center">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-ds-card text-ds-muted shadow-sm"><Globe2 className="h-5 w-5" /></div>
              <h2 className="mt-4 text-[15px] font-semibold text-ds-ink">{t('previewEmptyTitle')}</h2>
              <p className="mt-1 text-[12.5px] leading-5 text-ds-muted">{t('previewEmptyDescription')}</p>
              <form onSubmit={submitUrl} className="mt-4 flex gap-2">
                <input value={draftUrl} onChange={(event) => setDraftUrl(event.target.value)} placeholder={t('previewPortPlaceholder')} className="h-9 min-w-0 flex-1 rounded-lg border border-ds-border bg-ds-card px-3 text-[12.5px] text-ds-ink outline-none focus:border-ds-border-strong" />
                <button type="submit" className="h-9 rounded-lg bg-accent px-3 text-[12px] font-semibold text-white">{t('browserOpen')}</button>
              </form>
              {suggestions.length > 0 ? (
                <div className="mt-5">
                  <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-wide text-ds-faint">{t('previewDetectedAddresses')}</div>
                  <div className="space-y-1.5">{suggestions.map((url) => (
                    <button key={url} type="button" onClick={() => loadUrl(url)} className="flex w-full items-center justify-between rounded-lg border border-ds-border-muted bg-ds-card px-3 py-2 text-left hover:border-ds-border-strong">
                      <span className="min-w-0 truncate text-[12px] font-medium text-ds-ink">{url}</span>
                      <ChevronDown className="h-3.5 w-3.5 -rotate-90 text-ds-faint" />
                    </button>
                  ))}</div>
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <div
            ref={viewportShellRef}
            className={`absolute overflow-hidden bg-white shadow-sm ${fixedViewport ? 'ring-1 ring-black/10 dark:ring-white/10' : 'inset-0'}`}
            style={fixedViewport ? {
              left: '50%',
              top: '50%',
              width: fixedViewport.width,
              height: fixedViewport.height,
              transform: `translate(-50%, -50%) scale(${viewportScale})`,
              transformOrigin: 'center center'
            } : undefined}
          >
            {useElectronWebview ? (
              <webview
                key={previewInstanceNonce}
                ref={webviewRef}
                src={activeUrl}
                partition={DEV_PREVIEW_PARTITION}
                allowpopups={false}
                className="h-full w-full bg-white"
              />
            ) : (
              <iframe
                key={`${activeUrl}:${iframeReloadNonce}`}
                src={activeUrl}
                title={t('rightPanelBrowser')}
                className="h-full w-full border-0 bg-white"
                onLoad={() => {
                  iframeLoadedUrlRef.current = activeUrl
                  setLoading(false)
                  setLoadError(null)
                }}
              />
            )}
            {selectionMode && agentFeaturesAvailable ? (
              <div className="absolute inset-0 z-20 cursor-crosshair" onPointerMove={handleSelectionMove} onPointerLeave={handleSelectionLeave} onPointerDown={(event) => void handleSelectionClick(event)}>
                {hoverRect ? <div className="pointer-events-none absolute border-2 border-accent bg-accent/10" style={{ left: hoverRect.x, top: hoverRect.y, width: hoverRect.width, height: hoverRect.height }} /> : null}
                <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-slate-950/80 px-3 py-1 text-[10px] font-medium text-white shadow-lg">{t('previewSelectionHint')}</div>
              </div>
            ) : null}
            {loadError ? (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-ds-card/95 p-6 backdrop-blur-sm">
                <div className="max-w-sm text-center">
                  <CircleAlert className="mx-auto h-7 w-7 text-amber-500" />
                  <h3 className="mt-3 text-[14px] font-semibold text-ds-ink">{t('previewLoadFailedTitle')}</h3>
                  <p className="mt-1 max-h-20 overflow-auto text-[11.5px] leading-5 text-ds-muted">{loadError}</p>
                  <div className="mt-4 flex flex-wrap justify-center gap-2">
                    <button type="button" onClick={reload} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-[11.5px] font-semibold text-white"><RotateCcw className="h-3.5 w-3.5" />{t('previewRetry')}</button>
                    <button type="button" onClick={openExternal} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-ds-border bg-ds-card px-3 text-[11.5px] font-semibold text-ds-ink"><ExternalLink className="h-3.5 w-3.5" />{t('browserOpenExternal')}</button>
                    <button type="button" onClick={() => setIssuesOpen(true)} className="inline-flex h-8 items-center rounded-lg px-3 text-[11.5px] font-semibold text-ds-muted hover:bg-ds-hover">{t('previewErrorDetails')}</button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        )}

        {fixedViewport && activeUrl ? (
          <div className="pointer-events-none absolute bottom-2 right-2 rounded-md bg-slate-950/70 px-2 py-1 text-[9.5px] font-medium text-white">{viewportLabel(workspaceState.viewport)} · {Math.round(viewportScale * 100)}%</div>
        ) : null}

        {issuesOpen ? (
          <div className="absolute inset-y-0 right-0 z-40 flex w-full max-w-sm flex-col border-l border-ds-border bg-ds-card/98 shadow-2xl backdrop-blur-xl">
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-ds-border-muted px-3">
              <CircleAlert className="h-4 w-4 text-ds-muted" />
              <span className="flex-1 text-[12.5px] font-semibold text-ds-ink">{t('previewIssues')}</span>
              {issues.length > 0 ? <button type="button" onClick={() => setIssues([])} className="text-[10.5px] font-medium text-ds-muted hover:text-ds-ink">{t('clear')}</button> : null}
              <button type="button" onClick={() => setIssuesOpen(false)} className={iconButtonClass()} aria-label={t('close')}><X className="h-4 w-4" /></button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {!useElectronWebview ? <div className="p-4 text-[12px] leading-5 text-ds-muted">{t('previewAgentToolsUnavailable')}</div> : null}
              {useElectronWebview && issues.length === 0 ? <div className="p-4 text-[12px] text-ds-muted">{t('previewNoIssues')}</div> : null}
              {issues.map((issue) => (
                <div key={issue.id} className="mb-2 rounded-xl border border-ds-border-muted bg-ds-surface-subtle p-3">
                  <div className="flex items-start gap-2">
                    <span className={`mt-0.5 rounded-md px-1.5 py-0.5 text-[9px] font-bold uppercase ${issue.kind === 'load' ? 'bg-amber-500/10 text-amber-600' : 'bg-red-500/10 text-red-500'}`}>{issue.kind}</span>
                    <p className="min-w-0 flex-1 break-words text-[11.5px] leading-4 text-ds-ink">{issue.message}</p>
                    {issue.count > 1 ? <span className="text-[9px] font-semibold text-ds-faint">×{issue.count}</span> : null}
                  </div>
                  {issue.source ? <div className="mt-1 truncate text-[9.5px] text-ds-faint">{issue.source}{issue.line != null ? `:${issue.line}` : ''}</div> : null}
                  <button type="button" onClick={() => attachIssue(issue)} className="mt-2 rounded-md bg-accent/10 px-2 py-1 text-[10.5px] font-semibold text-accent hover:bg-accent/15">{t('previewAddToContext')}</button>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </aside>
  )
}

export default DevBrowserPanel
