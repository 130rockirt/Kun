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

export type { DevBrowserPanelProps, DevPreviewContextDraft } from './dev-browser-types'
import type {
  DevBrowserPanelProps,
  DevPreviewContextDraft,
  DevWebviewTag,
  LoadOptions,
  WebviewConsoleEvent,
  WebviewFailLoadEvent,
  WebviewNavigateEvent,
  WebviewTitleEvent
} from './dev-browser-types'
import { contextTitle, formatAddressInput } from './dev-browser-support'
import { DevBrowserContent } from './DevBrowserContent'
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
    <DevBrowserContent
      rootRef={rootRef}
      compact={compact}
      className={className}
      embedded={embedded}
      onCollapse={onCollapse}
      t={t}
      goBack={goBack}
      goForward={goForward}
      canNavigateBack={canNavigateBack}
      canNavigateForward={canNavigateForward}
      reload={reload}
      activeUrl={activeUrl}
      loading={loading}
      addressMenuOpen={addressMenuOpen}
      setAddressMenuOpen={setAddressMenuOpen}
      draftUrl={draftUrl}
      setDraftUrl={setDraftUrl}
      submitUrl={submitUrl}
      selectionMode={selectionMode}
      setSelectionMode={setSelectionMode}
      setHoverRect={setHoverRect}
      agentFeaturesAvailable={agentFeaturesAvailable}
      selectedElementCount={selectedElementCount}
      viewportMenuOpen={viewportMenuOpen}
      setViewportMenuOpen={setViewportMenuOpen}
      workspaceState={workspaceState}
      issuesOpen={issuesOpen}
      setIssuesOpen={setIssuesOpen}
      useElectronWebview={useElectronWebview}
      issues={issues}
      moreMenuOpen={moreMenuOpen}
      setMoreMenuOpen={setMoreMenuOpen}
      suggestions={suggestions}
      loadUrl={loadUrl}
      detectedUrls={detectedUrls}
      updateWorkspaceState={updateWorkspaceState}
      openExternal={openExternal}
      clearPreview={clearPreview}
      canvasRef={canvasRef}
      fixedViewport={fixedViewport}
      viewportShellRef={viewportShellRef}
      viewportScale={viewportScale}
      previewInstanceNonce={previewInstanceNonce}
      webviewRef={webviewRef}
      iframeReloadNonce={iframeReloadNonce}
      iframeLoadedUrlRef={iframeLoadedUrlRef}
      setLoading={setLoading}
      setLoadError={setLoadError}
      handleSelectionMove={handleSelectionMove}
      handleSelectionLeave={handleSelectionLeave}
      handleSelectionClick={handleSelectionClick}
      hoverRect={hoverRect}
      loadError={loadError}
      setIssues={setIssues}
      attachIssue={attachIssue}
    />
  )
}
export default DevBrowserPanel
