import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { AlertTriangle, ArrowLeft, CheckCircle2, ExternalLink, Layers3, Play, Sparkles, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  defaultFrameSizeForDesignTarget,
  normalizeDesignTarget,
  type DesignTarget
} from '../../../design/design-context'
import {
  buildPrototypeNavigationCaptureScript,
  extractPrototypeHashRouteHref,
  extractPrototypeNavigationHref,
  prototypeBackNavigationSteps,
  prototypeArtifactRelativePath,
  prototypeMissingScreenPromptValues,
  prototypePlayerGoBack,
  prototypePlayerNavigateTo,
  resolveInitialPrototypeArtifactId,
  resolvePrototypeNavigationTarget,
  resolvePrototypeLinks,
  resolvePrototypeScreens,
  resolvePrototypeViewportFrame,
  shouldInitializePrototypePlayerCurrentId
} from '../../../design/prototype-player'
import type { DesignArtifact } from '../../../design/design-types'
import { DesignTargetToggle } from '../DesignTargetToggle'
import { useDesignHtmlPreview } from '../DesignHtmlPreviewHost'

type WebviewNavigateEvent = Event & {
  url?: string
  preventDefault?: () => void
}

type Props = {
  open: boolean
  workspaceRoot: string
  artifacts: readonly DesignArtifact[]
  initialArtifactId?: string | null
  designTarget?: unknown
  onClose: () => void
  onRequestMissingScreen?: (promptSeed: string) => void
}

export function shouldInjectPrototypeNavigationCapture({
  open,
  webviewUrl,
  webviewReady,
  hasExecuteJavaScript
}: {
  open: boolean
  webviewUrl: string
  webviewReady: boolean
  hasExecuteJavaScript: boolean
}): boolean {
  return open && Boolean(webviewUrl) && webviewReady && hasExecuteJavaScript
}

export function shouldSyncPrototypePlayerToInitialId({
  open,
  initialCurrentId,
  lastInitialCurrentId,
  currentId
}: {
  open: boolean
  initialCurrentId: string | null
  lastInitialCurrentId: string | null
  currentId: string | null
}): boolean {
  return open && Boolean(initialCurrentId) && initialCurrentId !== lastInitialCurrentId && currentId !== initialCurrentId
}

export function buildPrototypeViewportModeScript(target: DesignTarget): string {
  return `
(() => {
  try {
    const target = ${JSON.stringify(target)};
    const styleId = '__kunPrototypeViewportModeStyle';
    document.documentElement.dataset.kunPrototypeViewport = target;
    let style = document.getElementById(styleId);
    if (!style) {
      style = document.createElement('style');
      style.id = styleId;
      document.head.appendChild(style);
    }
    style.textContent = \`
html[data-kun-prototype-viewport="app"],
html[data-kun-prototype-viewport="app"] body {
  scrollbar-width: none !important;
  -ms-overflow-style: none !important;
}
html[data-kun-prototype-viewport="app"]::-webkit-scrollbar,
html[data-kun-prototype-viewport="app"] body::-webkit-scrollbar,
html[data-kun-prototype-viewport="app"] *::-webkit-scrollbar {
  width: 0 !important;
  height: 0 !important;
  background: transparent !important;
}
    \`;
  } catch {}
})();
  `.trim()
}

export function prototypeViewportFitScale(
  availableWidth: number,
  availableHeight: number,
  viewportWidth: number,
  viewportHeight: number
): number {
  if (
    !Number.isFinite(availableWidth) ||
    !Number.isFinite(availableHeight) ||
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(viewportHeight) ||
    availableWidth <= 0 ||
    availableHeight <= 0 ||
    viewportWidth <= 0 ||
    viewportHeight <= 0
  ) {
    return 1
  }
  return Math.min(1, availableWidth / viewportWidth, availableHeight / viewportHeight)
}

export async function openPrototypeHtmlInBrowser(
  openPrototype: ((payload: { path: string; workspaceRoot: string }) => Promise<{
    ok: boolean
    message?: string
  }>) | undefined,
  workspaceRoot: string,
  relativePath: string
): Promise<{ ok: boolean; message?: string }> {
  if (!openPrototype || !workspaceRoot.trim() || !relativePath.trim()) {
    return { ok: false, message: 'Prototype browser opening is unavailable.' }
  }
  try {
    return await openPrototype({ path: relativePath, workspaceRoot })
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

function PrototypePlayerOverlayInner({
  open,
  workspaceRoot,
  artifacts,
  initialArtifactId,
  designTarget,
  onClose,
  onRequestMissingScreen
}: Props) {
  const { t } = useTranslation('common')
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [history, setHistory] = useState<string[]>([])
  const [missingHref, setMissingHref] = useState('')
  const [browserOpenError, setBrowserOpenError] = useState('')
  const [previewTarget, setPreviewTarget] = useState<DesignTarget>(() => normalizeDesignTarget(designTarget))
  const [viewportScale, setViewportScale] = useState(1)
  const viewportHostRef = useRef<HTMLDivElement | null>(null)
  const wasOpenRef = useRef(false)
  const lastInitialCurrentIdRef = useRef<string | null>(null)

  const initialCurrentId = useMemo(
    () => (open ? resolveInitialPrototypeArtifactId(artifacts, initialArtifactId) : null),
    [artifacts, initialArtifactId, open]
  )
  const currentIdMatchesHtmlArtifact = useMemo(
    () => Boolean(currentId && artifacts.some((artifact) => artifact.id === currentId && artifact.kind === 'html')),
    [artifacts, currentId]
  )
  const activeCurrentId = open && wasOpenRef.current && currentIdMatchesHtmlArtifact ? currentId : initialCurrentId
  const currentArtifact = useMemo(
    () => artifacts.find((artifact) => artifact.id === activeCurrentId && artifact.kind === 'html') ?? null,
    [activeCurrentId, artifacts]
  )
  const currentArtifactPath = currentArtifact ? prototypeArtifactRelativePath(currentArtifact) : ''
  const htmlArtifacts = useMemo(
    () => resolvePrototypeScreens(artifacts),
    [artifacts]
  )
  const links = useMemo(
    () => resolvePrototypeLinks(currentArtifact, artifacts),
    [artifacts, currentArtifact]
  )
  const viewportFrame = useMemo(
    () => resolvePrototypeViewportFrame(currentArtifact, previewTarget),
    [currentArtifact, previewTarget]
  )
  const viewportVisualStyle = useMemo<CSSProperties>(
    () => ({
      width: viewportFrame.width * viewportScale,
      height: viewportFrame.height * viewportScale
    }),
    [viewportFrame.height, viewportFrame.width, viewportScale]
  )
  const viewportFrameStyle = useMemo<CSSProperties>(
    () => ({
      width: viewportFrame.width,
      height: viewportFrame.height,
      transform: `scale(${viewportScale})`,
      transformOrigin: 'top left'
    }),
    [viewportFrame.height, viewportFrame.width, viewportScale]
  )
  const webSize = defaultFrameSizeForDesignTarget('web')
  const appSize = defaultFrameSizeForDesignTarget('app')
  const previewTargetLabel = previewTarget === 'app'
    ? t('designTargetApp', 'App')
    : t('designTargetWeb', 'Web')
  const viewportLabel = `${previewTargetLabel} ${viewportFrame.width} x ${viewportFrame.height}`
  const preview = useDesignHtmlPreview({
    workspaceRoot,
    relativePath: currentArtifactPath,
    enabled: Boolean(open && workspaceRoot && currentArtifact),
    partition: 'kun-proto'
  })

  useEffect(() => {
    const host = viewportHostRef.current
    if (!open || !host) return
    const updateScale = (): void => {
      const bounds = host.getBoundingClientRect()
      const next = prototypeViewportFitScale(
        bounds.width,
        bounds.height,
        viewportFrame.width,
        viewportFrame.height
      )
      setViewportScale((current) => Math.abs(current - next) < 0.001 ? current : next)
    }
    updateScale()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(updateScale) : null
    observer?.observe(host)
    window.addEventListener('resize', updateScale)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', updateScale)
    }
  }, [open, viewportFrame.height, viewportFrame.width])

  useEffect(() => {
    if (!open || wasOpenRef.current) return
    setPreviewTarget(normalizeDesignTarget(designTarget))
  }, [designTarget, open])

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false
      lastInitialCurrentIdRef.current = null
      setBrowserOpenError('')
      return
    }
    if (!shouldInitializePrototypePlayerCurrentId({ open, wasOpen: wasOpenRef.current, currentId })) return
    setCurrentId(initialCurrentId)
    setHistory([])
    setMissingHref('')
    wasOpenRef.current = true
  }, [currentId, initialCurrentId, open])

  useEffect(() => {
    if (!open) return
    const lastInitialCurrentId = lastInitialCurrentIdRef.current
    lastInitialCurrentIdRef.current = initialCurrentId
    if (!shouldSyncPrototypePlayerToInitialId({
      open,
      initialCurrentId,
      lastInitialCurrentId,
      currentId
    })) {
      return
    }
    setCurrentId(initialCurrentId)
    setHistory([])
    setMissingHref('')
  }, [currentId, initialCurrentId, open])

  useEffect(() => {
    if (!open) return
    if (!currentId || artifacts.some((artifact) => artifact.id === currentId && artifact.kind === 'html')) return
    setCurrentId(initialCurrentId)
    setHistory([])
    setMissingHref('')
  }, [artifacts, currentId, initialCurrentId, open])

  const goTo = useCallback(
    (artifactId: string): void => {
      const state = { currentId: activeCurrentId, history, missingHref }
      const next = prototypePlayerNavigateTo(state, artifactId)
      if (next === state) return
      setHistory([...next.history])
      setMissingHref(next.missingHref)
      setCurrentId(next.currentId)
    },
    [activeCurrentId, history, missingHref]
  )

  const goBack = useCallback((steps = 1): void => {
    const next = prototypePlayerGoBack({ currentId: activeCurrentId, history, missingHref }, steps)
    setHistory([...next.history])
    setMissingHref(next.missingHref)
    setCurrentId(next.currentId)
  }, [activeCurrentId, history, missingHref])

  useEffect(() => {
    const webview = preview.webview
    const webviewUrl = preview.state.webviewUrl
    const fileUrl = preview.state.fileUrl
    if (!open || !webviewUrl || !fileUrl || !webview) return

    const injectNavigationCapture = (ready = preview.state.ready): void => {
      const executeJavaScript =
        typeof webview.executeJavaScript === 'function'
          ? webview.executeJavaScript.bind(webview)
          : null
      if (
        !shouldInjectPrototypeNavigationCapture({
          open,
          webviewUrl,
          webviewReady: ready,
          hasExecuteJavaScript: Boolean(executeJavaScript)
        })
      ) {
        return
      }
      void executeJavaScript?.(buildPrototypeNavigationCaptureScript(links)).catch(() => {
        /* Best-effort: explicit side-rail links still work if a guest blocks injection. */
      })
      void executeJavaScript?.(buildPrototypeViewportModeScript(previewTarget)).catch(() => undefined)
    }

    const markWebviewReady = (): void => {
      injectNavigationCapture(true)
    }

    const handleNavigate: EventListener = (event): void => {
      const navigationUrl = (event as WebviewNavigateEvent).url
      if (!navigationUrl) return
      const backSteps = prototypeBackNavigationSteps(navigationUrl)
      if (backSteps !== null) {
        ;(event as WebviewNavigateEvent).preventDefault?.()
        goBack(backSteps)
        return
      }
      const target = resolvePrototypeNavigationTarget(navigationUrl, fileUrl, links)
      const capturedHref = extractPrototypeNavigationHref(navigationUrl) ?? extractPrototypeHashRouteHref(navigationUrl)
      if (!target && !capturedHref) return
      ;(event as WebviewNavigateEvent).preventDefault?.()
      if (target) {
        goTo(target.targetArtifactId)
        return
      }
      if (capturedHref) setMissingHref(capturedHref)
    }

    webview.addEventListener('dom-ready', markWebviewReady)
    webview.addEventListener('did-finish-load', markWebviewReady)
    webview.addEventListener('will-navigate', handleNavigate)
    webview.addEventListener('did-navigate-in-page', handleNavigate)
    injectNavigationCapture()

    return () => {
      webview.removeEventListener('dom-ready', markWebviewReady)
      webview.removeEventListener('did-finish-load', markWebviewReady)
      webview.removeEventListener('will-navigate', handleNavigate)
      webview.removeEventListener('did-navigate-in-page', handleNavigate)
    }
  }, [
    goBack,
    goTo,
    links,
    open,
    previewTarget,
    preview.state.fileUrl,
    preview.state.ready,
    preview.state.webviewUrl,
    preview.webview,
    preview.webviewMountNonce
  ])

  const requestMissingScreen = useCallback((): void => {
    const promptValues = prototypeMissingScreenPromptValues(currentArtifact, missingHref)
    if (!promptValues) return
    onRequestMissingScreen?.(t('designPrototypeCreateMissingPrompt', promptValues))
    onClose()
  }, [currentArtifact, missingHref, onClose, onRequestMissingScreen, t])

  const openInBrowser = useCallback((): void => {
    setBrowserOpenError('')
    void openPrototypeHtmlInBrowser(
      typeof window.kunGui?.openWritePrototype === 'function'
        ? window.kunGui.openWritePrototype
        : undefined,
      workspaceRoot,
      currentArtifactPath
    ).then((result) => {
      if (!result.ok) {
        setBrowserOpenError(result.message || t('designPrototypeOpenBrowserFailed', 'Could not open the prototype in a browser.'))
      }
    })
  }, [currentArtifactPath, t, workspaceRoot])

  if (!open) return null

  return (
    <div className="ds-no-drag pointer-events-auto fixed inset-0 z-[200] flex items-center justify-center bg-[#111827]/42 p-2 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('designPrototypePlay', 'Play prototype')}
        className="flex h-full w-full overflow-hidden rounded-[10px] border border-ds-border bg-white text-ds-ink shadow-[0_30px_90px_rgba(15,23,42,0.32)] dark:bg-ds-canvas"
      >
        <main className="flex min-w-0 flex-1 flex-col bg-[#f6f8fb] dark:bg-[#111318]">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-ds-border bg-white/82 px-3 dark:bg-ds-card/85">
            <button
              type="button"
              onClick={() => goBack()}
              disabled={history.length === 0}
              className="flex h-8 w-8 items-center justify-center rounded-[8px] text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink disabled:cursor-not-allowed disabled:opacity-35"
              title={t('designPrototypeBack', 'Back')}
              aria-label={t('designPrototypeBack', 'Back')}
            >
              <ArrowLeft className="h-4 w-4" strokeWidth={1.9} />
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <Play className="h-4 w-4 shrink-0 text-accent" strokeWidth={1.9} />
                <span className="truncate text-[13px] font-semibold">
                  {currentArtifact?.title ?? t('designPrototypePlay', 'Play prototype')}
                </span>
              </div>
              {currentArtifact ? (
                <div className="truncate text-[10.5px] text-ds-faint">
                  {currentArtifactPath} - {viewportLabel}
                </div>
              ) : null}
            </div>
            <DesignTargetToggle
              designTarget={previewTarget}
              hint={t('designPrototypeViewportMode', 'Prototype viewport')}
              webDetail={t('designPrototypeViewportWebDetail', {
                width: webSize.width,
                height: webSize.height,
                defaultValue: `${webSize.width} x ${webSize.height} web prototype`
              })}
              appDetail={t('designPrototypeViewportAppDetail', {
                width: appSize.width,
                height: appSize.height,
                defaultValue: `${appSize.width} x ${appSize.height} phone prototype`
              })}
              onChange={setPreviewTarget}
            />
            <button
              type="button"
              onClick={openInBrowser}
              disabled={!currentArtifactPath}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-[8px] px-2.5 text-[12px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink disabled:cursor-not-allowed disabled:opacity-40"
              title={t('designPrototypeOpenBrowser', 'Open in browser')}
              aria-label={t('designPrototypeOpenBrowser', 'Open in browser')}
            >
              <ExternalLink className="h-4 w-4" strokeWidth={1.9} />
              <span>{t('designPrototypeOpenBrowser', 'Open in browser')}</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-[8px] text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
              title={t('designPrototypeClose', 'Close prototype')}
              aria-label={t('designPrototypeClose', 'Close prototype')}
            >
              <X className="h-4 w-4" strokeWidth={1.9} />
            </button>
          </header>
          <div className="min-h-0 flex-1 p-3">
            <div
              ref={viewportHostRef}
              className="flex h-full w-full items-center justify-center overflow-hidden rounded-[8px] bg-[#e7ebf1] dark:bg-[#0c0f14]"
            >
              <div className="relative shrink-0" style={viewportVisualStyle}>
                <div
                  className={[
                    'absolute left-0 top-0 overflow-hidden bg-white shadow-[0_12px_40px_rgba(15,23,42,0.12)] ring-1 ring-inset',
                    previewTarget === 'app'
                      ? 'rounded-[30px] shadow-[0_18px_46px_rgba(15,23,42,0.2)] ring-[#1f2937]/25 dark:ring-white/12'
                      : 'rounded-[8px] ring-ds-border'
                  ].join(' ')}
                  style={viewportFrameStyle}
                >
                  {preview.state.webviewUrl ? (
                    preview.renderWebview({ className: 'h-full w-full border-0' })
                  ) : (
                    <div className="flex h-full items-center justify-center text-[13px] text-ds-faint">
                      {preview.state.error || t('designCanvasLoading')}
                    </div>
                  )}
                  {(browserOpenError || preview.state.error) && preview.state.webviewUrl ? (
                    <div className="absolute inset-x-3 top-3 rounded-[8px] border border-red-200 bg-white/92 px-3 py-2 text-[12px] text-red-700 shadow-sm backdrop-blur dark:border-red-400/35 dark:bg-red-950/85 dark:text-red-200">
                      {browserOpenError || preview.state.error}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </main>
        <aside className="flex w-[270px] shrink-0 flex-col border-l border-ds-border bg-white/90 p-3 dark:bg-ds-card/88">
          <div className="mb-2 flex items-center gap-1.5 px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-ds-faint">
            <Layers3 className="h-3.5 w-3.5" strokeWidth={1.8} />
            <span>{t('designPrototypeAllScreens', 'All screens')}</span>
            <span className="ml-auto rounded-full bg-ds-hover px-1.5 py-0.5 text-[10px] tracking-normal text-ds-muted">
              {htmlArtifacts.length}
            </span>
          </div>
          <div className="mb-3 flex max-h-48 min-h-0 flex-col gap-1 overflow-y-auto border-b border-ds-border pb-3">
            {htmlArtifacts.map((artifact) => {
              const active = artifact.id === activeCurrentId
              return (
                <button
                  key={artifact.id}
                  type="button"
                  onClick={() => goTo(artifact.id)}
                  aria-current={active ? 'page' : undefined}
                  className={[
                    'group flex min-h-10 w-full items-center gap-2 rounded-[8px] px-2.5 py-2 text-left text-[12px] transition',
                    active
                      ? 'bg-accent/12 text-ds-ink ring-1 ring-accent/25'
                      : 'text-ds-muted hover:bg-ds-hover hover:text-ds-ink'
                  ].join(' ')}
                  title={artifact.relativePath}
                >
                  {active ? (
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-accent" strokeWidth={1.9} />
                  ) : (
                    <Play className="h-3.5 w-3.5 shrink-0 text-ds-faint group-hover:text-accent" strokeWidth={1.8} />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{artifact.title}</span>
                    <span className="block truncate text-[10.5px] text-ds-faint">{artifact.relativePath}</span>
                  </span>
                </button>
              )
            })}
          </div>
          <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-ds-faint">
            {t('designPrototypeNextScreens', 'Next screens')}
          </div>
          {missingHref ? (
            <div className="mb-3 rounded-[8px] border border-amber-300/70 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 shadow-sm dark:border-amber-400/30 dark:bg-amber-400/12 dark:text-amber-100">
              <div className="flex items-center gap-1.5 font-semibold">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" strokeWidth={1.9} />
                <span>{t('designPrototypeMissingTarget', 'Missing screen target')}</span>
              </div>
              <div className="mt-1 truncate font-mono text-[10.5px] opacity-80" title={missingHref}>
                {missingHref}
              </div>
              <button
                type="button"
                onClick={requestMissingScreen}
                disabled={!onRequestMissingScreen}
                className="mt-2 flex h-8 w-full items-center justify-center gap-1.5 rounded-[8px] bg-amber-500 px-2 text-[11.5px] font-semibold text-white transition hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Sparkles className="h-3.5 w-3.5" strokeWidth={1.9} />
                {t('designPrototypeCreateMissingScreen', 'Create with AI')}
              </button>
            </div>
          ) : null}
          <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
            {links.length > 0 ? (
              links.map((link) => (
                <button
                  key={`${link.targetArtifactId}:${link.label ?? ''}`}
                  type="button"
                  onClick={() => goTo(link.targetArtifactId)}
                  className="group flex min-h-11 w-full items-center gap-2 rounded-[8px] px-2.5 py-2 text-left text-[12px] text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
                  title={link.href || link.targetTitle}
                >
                  <ExternalLink className="h-3.5 w-3.5 shrink-0 text-accent" strokeWidth={1.8} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-ds-ink">{link.label || link.targetTitle}</span>
                    <span className="block truncate text-[10.5px] text-ds-faint">{link.targetTitle}</span>
                  </span>
                </button>
              ))
            ) : (
              <div className="rounded-[8px] bg-ds-hover/45 px-3 py-2 text-[12px] leading-5 text-ds-faint">
                {t('designPrototypeNoLinks', 'No outgoing links from this screen yet.')}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}

export const PrototypePlayerOverlay = memo(PrototypePlayerOverlayInner)
