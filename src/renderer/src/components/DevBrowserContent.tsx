import type {
  Dispatch,
  FormEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  RefObject,
  SetStateAction
} from 'react'
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
import { MAX_DEV_PREVIEW_ELEMENTS, type DevPreviewIssue, type DevPreviewRect } from '@shared/dev-preview-context'
import { DEV_PREVIEW_PARTITION } from '@shared/dev-preview-capture'
import { formatDevPreviewUrlLabel } from '../lib/dev-preview-detection'
import {
  DEV_PREVIEW_VIEWPORTS,
  type DevPreviewWorkspaceState
} from '../lib/dev-preview-state'
import type { DevWebviewTag } from './dev-browser-types'
import { iconButtonClass, viewportLabel } from './dev-browser-support'

type Translate = (key: string, values?: Record<string, unknown>) => string

type DevBrowserContentProps = {
  rootRef: RefObject<HTMLElement | null>
  compact: boolean
  className?: string
  embedded: boolean
  onCollapse: () => void
  t: Translate
  goBack: () => void
  goForward: () => void
  canNavigateBack: boolean
  canNavigateForward: boolean
  reload: () => void
  activeUrl: string | null
  loading: boolean
  addressMenuOpen: boolean
  setAddressMenuOpen: Dispatch<SetStateAction<boolean>>
  draftUrl: string
  setDraftUrl: Dispatch<SetStateAction<string>>
  submitUrl: (event: FormEvent<HTMLFormElement>) => void
  selectionMode: boolean
  setSelectionMode: Dispatch<SetStateAction<boolean>>
  setHoverRect: Dispatch<SetStateAction<DevPreviewRect | null>>
  agentFeaturesAvailable: boolean
  selectedElementCount: number
  viewportMenuOpen: boolean
  setViewportMenuOpen: Dispatch<SetStateAction<boolean>>
  workspaceState: DevPreviewWorkspaceState
  issuesOpen: boolean
  setIssuesOpen: Dispatch<SetStateAction<boolean>>
  useElectronWebview: boolean
  issues: DevPreviewIssue[]
  moreMenuOpen: boolean
  setMoreMenuOpen: Dispatch<SetStateAction<boolean>>
  suggestions: string[]
  loadUrl: (value: string) => void
  detectedUrls: string[]
  updateWorkspaceState: (
    updater: (current: DevPreviewWorkspaceState) => DevPreviewWorkspaceState
  ) => void
  openExternal: () => void
  clearPreview: () => void
  canvasRef: RefObject<HTMLDivElement | null>
  fixedViewport: { width: number; height: number } | null
  viewportShellRef: RefObject<HTMLDivElement | null>
  viewportScale: number
  previewInstanceNonce: number
  webviewRef: RefObject<DevWebviewTag | null>
  iframeReloadNonce: number
  iframeLoadedUrlRef: RefObject<string | null>
  setLoading: Dispatch<SetStateAction<boolean>>
  setLoadError: Dispatch<SetStateAction<string | null>>
  handleSelectionMove: (event: ReactPointerEvent<HTMLDivElement>) => void
  handleSelectionLeave: () => void
  handleSelectionClick: (event: ReactPointerEvent<HTMLDivElement>) => Promise<void>
  hoverRect: DevPreviewRect | null
  loadError: string | null
  setIssues: Dispatch<SetStateAction<DevPreviewIssue[]>>
  attachIssue: (issue: DevPreviewIssue) => void
}

export function DevBrowserContent({
  rootRef,
  compact,
  className,
  embedded,
  onCollapse,
  t,
  goBack,
  goForward,
  canNavigateBack,
  canNavigateForward,
  reload,
  activeUrl,
  loading,
  addressMenuOpen,
  setAddressMenuOpen,
  draftUrl,
  setDraftUrl,
  submitUrl,
  selectionMode,
  setSelectionMode,
  setHoverRect,
  agentFeaturesAvailable,
  selectedElementCount,
  viewportMenuOpen,
  setViewportMenuOpen,
  workspaceState,
  issuesOpen,
  setIssuesOpen,
  useElectronWebview,
  issues,
  moreMenuOpen,
  setMoreMenuOpen,
  suggestions,
  loadUrl,
  detectedUrls,
  updateWorkspaceState,
  openExternal,
  clearPreview,
  canvasRef,
  fixedViewport,
  viewportShellRef,
  viewportScale,
  previewInstanceNonce,
  webviewRef,
  iframeReloadNonce,
  iframeLoadedUrlRef,
  setLoading,
  setLoadError,
  handleSelectionMove,
  handleSelectionLeave,
  handleSelectionClick,
  hoverRect,
  loadError,
  setIssues,
  attachIssue
}: DevBrowserContentProps): ReactElement {
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
