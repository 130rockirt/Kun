import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Globe2,
  Hand,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Square,
  Trash2,
  X
} from 'lucide-react'
import type { BrowserUseViewState } from '@shared/browser-use'
import { AgentBrowserPanel } from './AgentBrowserPanel'

function emptyState(): BrowserUseViewState {
  return {
    contractVersion: 1,
    capabilityStatus: 'disabled',
    lifecycle: 'closed',
    controlOwner: 'agent',
    visible: false,
    mounted: false,
    mode: 'public',
    tabs: [],
    updatedAt: new Date(0).toISOString()
  }
}

export function isBrowserUseSessionActive(
  state: BrowserUseViewState,
  activeThreadId: string | null
): boolean {
  return Boolean(
    activeThreadId &&
    state.threadId === activeThreadId &&
    state.sessionId &&
    state.lifecycle !== 'closed'
  )
}

export function shouldAutoOpenBrowserUsePreview(
  state: BrowserUseViewState,
  activeThreadId: string | null
): boolean {
  return isBrowserUseSessionActive(state, activeThreadId) && Boolean(
    state.lifecycle === 'mount-required' ||
    state.pendingOriginConsent ||
    state.pendingActionConsent
  )
}

export function AgentBrowserFloatingPreview({
  activeThreadId
}: {
  activeThreadId: string | null
}): ReactElement | null {
  const { t } = useTranslation('common')
  const [state, setState] = useState<BrowserUseViewState>(emptyState)
  const [previewOpen, setPreviewOpen] = useState(false)
  const sessionIdRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    setState(emptyState())
    setPreviewOpen(false)
    sessionIdRef.current = undefined
    if (!activeThreadId) return

    let live = true
    const accept = (next: BrowserUseViewState): void => {
      if (!live || next.threadId !== activeThreadId) return
      const sessionChanged = next.sessionId !== sessionIdRef.current
      sessionIdRef.current = next.sessionId
      setState(next)
      if (!isBrowserUseSessionActive(next, activeThreadId)) {
        setPreviewOpen(false)
      } else if (shouldAutoOpenBrowserUsePreview(next, activeThreadId)) {
        setPreviewOpen(true)
      } else if (sessionChanged) {
        setPreviewOpen(false)
      }
    }

    let receivedLiveState = false
    const unsubscribe = window.kunGui.onBrowserUseState((next) => {
      if (next.threadId !== activeThreadId) return
      receivedLiveState = true
      accept(next)
    })
    void window.kunGui.getBrowserUseState(activeThreadId)
      .then((next) => {
        if (!receivedLiveState) accept(next)
      })
      .catch(() => undefined)
    return () => {
      live = false
      unsubscribe()
    }
  }, [activeThreadId])

  if (!isBrowserUseSessionActive(state, activeThreadId)) return null
  if (!activeThreadId) return null
  const threadId = activeThreadId

  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0]
  const needsAttention = shouldAutoOpenBrowserUsePreview(state, threadId)
  const loading = state.lifecycle === 'loading' || activeTab?.loading
  const run = async (
    operation: () => Promise<BrowserUseViewState>
  ): Promise<void> => {
    try {
      setState(await operation())
    } catch {
      // Main publishes bounded error state; do not expose raw host errors in the compact rail.
    }
  }
  const navigate = (command: 'back' | 'forward' | 'reload'): void => {
    void run(() => window.kunGui.navigateBrowserUse({
      threadId,
      command
    }))
  }
  const toggleControl = (): void => {
    void run(() => window.kunGui.setBrowserUseControl({
      threadId,
      controlOwner: state.controlOwner === 'agent' ? 'manual' : 'agent'
    }))
  }

  if (!previewOpen) {
    return (
      <button
        type="button"
        onClick={() => setPreviewOpen(true)}
        aria-label={t('browserUseShowPreview')}
        className={`ds-no-drag fixed bottom-6 right-4 z-[80] flex max-w-[min(360px,calc(100vw-32px))] items-center gap-2 rounded-full border bg-ds-card/95 px-3 py-2 text-left shadow-[0_16px_42px_rgba(15,23,42,0.22)] backdrop-blur-xl transition hover:-translate-y-0.5 hover:border-accent/45 sm:right-16 ${
          needsAttention
            ? 'border-amber-400/70'
            : 'border-ds-border'
        }`}
      >
        <span className={`relative grid h-7 w-7 shrink-0 place-items-center rounded-full ${
          needsAttention ? 'bg-amber-500/12 text-amber-600' : 'bg-accent/10 text-accent'
        }`}>
          {loading
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : needsAttention
              ? <ShieldAlert className="h-3.5 w-3.5" />
              : <Globe2 className="h-3.5 w-3.5" />}
          {!loading && !needsAttention ? (
            <span className="absolute right-0 top-0 h-2 w-2 rounded-full border border-ds-card bg-emerald-500" />
          ) : null}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[11px] font-semibold text-ds-ink">
            {needsAttention ? t('browserUseNeedsAttention') : t('browserUseBackgroundRunning')}
          </span>
          <span className="block truncate text-[10px] text-ds-faint">
            {activeTab?.title || activeTab?.origin || t('browserUseTemporaryAnonymous')}
          </span>
        </span>
      </button>
    )
  }

  return (
    <section
      aria-label={t('browserUseFloatingTitle')}
      className={`ds-no-drag group fixed bottom-[5.5rem] right-4 z-[80] flex aspect-video max-h-[calc(100vh-11rem)] w-[min(680px,calc(100vw-32px))] min-w-0 overflow-hidden rounded-[20px] border bg-ds-card/95 shadow-[0_28px_80px_rgba(15,23,42,0.3)] backdrop-blur-xl sm:right-16 ${
        needsAttention ? 'border-amber-400/70' : 'border-ds-border'
      }`}
    >
      <div
        className={`relative z-10 flex w-12 shrink-0 flex-col items-center gap-1 border-r px-1.5 py-2 backdrop-blur-xl ${
          needsAttention
            ? 'border-amber-400/35 bg-amber-50/95 dark:bg-amber-950/70'
            : 'border-ds-border-muted bg-ds-card/95'
        }`}
      >
        <button
          type="button"
          onClick={() => setPreviewOpen(false)}
          aria-label={t('browserUseClosePreview')}
          title={t('browserUseClosePreview')}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-xl text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
        >
          <X className="h-4 w-4" />
        </button>

        <button
          type="button"
          onClick={toggleControl}
          aria-label={state.controlOwner === 'agent'
            ? t('browserUseTakeControl')
            : t('browserUseReturnControl')}
          title={state.controlOwner === 'agent'
            ? t('browserUseTakeControl')
            : t('browserUseReturnControl')}
          className={`grid h-8 w-8 shrink-0 place-items-center rounded-xl transition ${
            state.controlOwner === 'manual'
              ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
              : 'text-ds-muted hover:bg-ds-hover hover:text-ds-ink'
          }`}
        >
          {state.controlOwner === 'agent'
            ? <Hand className="h-4 w-4" />
            : <Bot className="h-4 w-4" />}
        </button>

        <div className={`flex min-h-0 flex-col items-center gap-1 overflow-hidden transition-all duration-200 ${
          needsAttention
            ? 'max-h-64 opacity-100'
            : 'max-h-0 opacity-0 group-hover:max-h-64 group-hover:opacity-100 group-focus-within:max-h-64 group-focus-within:opacity-100'
        }`}>
          <span className="my-0.5 h-px w-5 shrink-0 bg-ds-border-muted" />
          <button
            type="button"
            onClick={() => navigate('back')}
            disabled={!activeTab?.canGoBack}
            aria-label={t('browserBack')}
            title={t('browserBack')}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink disabled:opacity-25"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => navigate('forward')}
            disabled={!activeTab?.canGoForward}
            aria-label={t('browserForward')}
            title={t('browserForward')}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink disabled:opacity-25"
          >
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => navigate('reload')}
            disabled={!activeTab}
            aria-label={t('browserReload')}
            title={t('browserReload')}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink disabled:opacity-25"
          >
            {loading
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <RefreshCw className="h-3.5 w-3.5" />}
          </button>
          <span className="my-0.5 h-px w-5 shrink-0 bg-ds-border-muted" />
          <button
            type="button"
            onClick={() => void run(() => window.kunGui.stopBrowserUse(threadId))}
            aria-label={t('browserUseStop')}
            title={t('browserUseStop')}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-red-600 transition hover:bg-red-500/10"
          >
            <Square className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => void run(() => window.kunGui.clearBrowserUse(threadId))}
            aria-label={t('browserUseClear')}
            title={t('browserUseClear')}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-ds-faint transition hover:bg-red-500/10 hover:text-red-600"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>

        <span
          aria-hidden="true"
          className={`mt-auto h-2 w-2 shrink-0 rounded-full ${
            loading
              ? 'animate-pulse bg-accent'
              : needsAttention
                ? 'bg-amber-500'
                : state.controlOwner === 'manual'
                  ? 'bg-amber-500'
                  : 'bg-emerald-500'
          }`}
        />
      </div>

      <div className="min-h-0 min-w-0 flex-1">
        <AgentBrowserPanel threadId={threadId} active variant="pip" />
      </div>
    </section>
  )
}
