import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement
} from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import {
  ArrowDownToLine,
  ChevronDown,
  MessageCircleMore,
  Minus,
  MoreHorizontal,
  Plus,
  Trash2,
  X
} from 'lucide-react'
import { useChatStore } from '../../store/chat-store'
import type { SideConversation } from '../../store/chat-store-types'
import { threadHasPendingRuntimeWork } from '../../store/chat-store-runtime-helpers'
import { ConversationTurn } from './MessageTimeline'
import { FloatingComposer } from './FloatingComposer'
import { groupTurns, stableTurnKey } from './message-timeline-turns'
import { InjectedMemoryLookupProvider } from './injected-memory-lookup'
import { TimelineFilePreviewWorkspaceProvider } from './timeline-file-preview-workspace'

type Props = {
  className?: string
  rightOffset?: number
  variant?: 'floating' | 'docked'
  onRequestClose?: () => void
  onTitleChange?: (title: string) => void
}

type SideConversationTimelineProps = {
  side: SideConversation
  workspaceRoot: string
}

const EMPTY_QUEUED_MESSAGES: [] = []
const noop = (): void => undefined

function formatInheritedTime(value: string, locale: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    day: 'numeric'
  }).format(date)
}

function overlayStyle(rightOffset = 24): CSSProperties {
  const offset = Math.max(12, Math.round(rightOffset))
  return {
    right: `min(${offset}px, calc(12px + max(0px, 100vw - 760px)))`
  }
}

export function activeSideConversationOrdinal(
  sides: readonly SideConversation[],
  activeSideId: string | null
): number {
  const index = activeSideId
    ? sides.findIndex((side) => side.threadId === activeSideId)
    : -1
  return index >= 0 ? index + 1 : sides.length + 1
}

function SideConversationTimeline({
  side,
  workspaceRoot
}: SideConversationTimelineProps): ReactElement {
  const { t } = useTranslation('common')
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const endRef = useRef<HTMLDivElement | null>(null)
  const turns = useMemo(() => groupTurns(side.blocks), [side.blocks])
  const scrollKey = [
    side.blocks.length,
    side.liveReasoning.length,
    side.liveAssistant.length,
    side.busy ? 'busy' : 'idle'
  ].join(':')

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    viewport.scrollTop = viewport.scrollHeight
  }, [scrollKey])

  const hasContent =
    side.blocks.length > 0 || Boolean(side.liveReasoning.trim() || side.liveAssistant.trim())

  return (
    <TimelineFilePreviewWorkspaceProvider workspaceRoot={workspaceRoot}>
      <InjectedMemoryLookupProvider workspaceRoot={workspaceRoot}>
        <div
          ref={viewportRef}
          className="ds-no-drag min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-ds-main"
          data-testid="side-conversation-timeline"
        >
          <div className="mx-auto flex w-full min-w-0 flex-col gap-8 px-5 pb-10 pt-6 sm:px-6">
            {!hasContent ? (
              <div className="flex min-h-[180px] flex-col items-center justify-center gap-2 text-center text-[12.5px] leading-5 text-ds-faint">
                <MessageCircleMore className="h-5 w-5 opacity-65" strokeWidth={1.7} />
                <p>{t('sidePanelEmpty')}</p>
              </div>
            ) : null}

            {turns.map((turn, index) => {
              const isLatest = index === turns.length - 1
              const turnPending = threadHasPendingRuntimeWork(turn.blocks)
              const hasLiveStream =
                isLatest && Boolean(side.liveReasoning.trim() || side.liveAssistant.trim())
              const isProcessing = (side.busy && isLatest) || turnPending || hasLiveStream
              return (
                <ConversationTurn
                  key={stableTurnKey(turn, index)}
                  turn={turn}
                  isProcessing={isProcessing}
                  liveReasoning={isLatest ? side.liveReasoning : ''}
                  live={isLatest ? side.liveAssistant : ''}
                  filePreviewWorkspaceRoot={workspaceRoot}
                  viewportRef={viewportRef}
                  compactCards
                  allowMainThreadActions={false}
                />
              )
            })}

            {turns.length === 0 && (side.liveReasoning || side.liveAssistant) ? (
              <ConversationTurn
                turn={{ blocks: [] }}
                isProcessing={side.busy}
                liveReasoning={side.liveReasoning}
                live={side.liveAssistant}
                filePreviewWorkspaceRoot={workspaceRoot}
                viewportRef={viewportRef}
                compactCards
                allowMainThreadActions={false}
              />
            ) : null}

            {side.error ? (
              <div
                role="alert"
                className="rounded-[12px] border border-red-300/70 bg-red-500/10 px-3 py-2 text-[12px] text-red-700 dark:border-red-800/60 dark:bg-red-950/35 dark:text-red-200"
              >
                {side.error}
              </div>
            ) : null}
            <div ref={endRef} aria-hidden className="h-px w-full shrink-0" />
          </div>
        </div>
      </InjectedMemoryLookupProvider>
    </TimelineFilePreviewWorkspaceProvider>
  )
}

export function SideConversationPanel({
  className,
  rightOffset = 24,
  variant = 'floating',
  onRequestClose,
  onTitleChange
}: Props): ReactElement | null {
  const { t, i18n } = useTranslation('common')
  const [draftInput, setDraftInput] = useState('')
  const [draftModel, setDraftModel] = useState('')
  const [draftProviderId, setDraftProviderId] = useState('')
  const [draftReasoningEffort, setDraftReasoningEffort] = useState('max')
  const [minimized, setMinimized] = useState(false)
  const [switchMenuOpen, setSwitchMenuOpen] = useState(false)
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const switchMenuRef = useRef<HTMLDivElement | null>(null)
  const moreMenuRef = useRef<HTMLDivElement | null>(null)
  const previousParentRef = useRef<string | null>(null)
  const previousActiveRef = useRef<string | null | undefined>(undefined)

  const sideData = useChatStore(
    useShallow((s) => ({
      sides: s.sideConversations,
      panel: s.sidePanel,
      parentThreadId: s.activeThreadId,
      threads: s.threads,
      workspaceRoot: s.workspaceRoot,
      runtimeConnection: s.runtimeConnection,
      composerModel: s.composerModel,
      composerProviderId: s.composerProviderId,
      composerPickList: s.composerPickList,
      composerModelGroups: s.composerModelGroups,
      composerReasoningEffort: s.composerReasoningEffort,
      spawnSideConversation: s.spawnSideConversation,
      sendSideMessage: s.sendSideMessage,
      interruptSide: s.interruptSide,
      resolveSideUserInput: s.resolveSideUserInput,
      setSideInput: s.setSideInput,
      setSideModel: s.setSideModel,
      setSideReasoningEffort: s.setSideReasoningEffort,
      selectSideConversation: s.selectSideConversation,
      setSidePanelOpen: s.setSidePanelOpen,
      openSideConversationDraft: s.openSideConversationDraft,
      discardSideConversation: s.discardSideConversation,
      promoteSideConversation: s.promoteSideConversation
    }))
  )

  const currentSides = useMemo(
    () =>
      Object.values(sideData.sides)
        .filter((side) => side.parentThreadId === sideData.parentThreadId)
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
    [sideData.parentThreadId, sideData.sides]
  )
  const sideIds = currentSides.map((side) => side.threadId)
  const activeId =
    sideData.panel.activeSideId && sideIds.includes(sideData.panel.activeSideId)
      ? sideData.panel.activeSideId
      : null
  const activeSide = activeId ? sideData.sides[activeId] : null
  const canSwitchSide = activeSide ? currentSides.length > 1 : currentSides.length > 0
  const parentThread = sideData.parentThreadId
    ? sideData.threads.find((thread) => thread.id === sideData.parentThreadId) ?? null
    : null
  const docked = variant === 'docked'
  const shouldRender = Boolean(sideData.parentThreadId && (docked || sideData.panel.open))
  const showDraft = shouldRender && !activeSide
  const ordinal = activeSideConversationOrdinal(currentSides, activeId)
  const reportedTitle = activeSide
    ? t('sidePanelTabTitle', { index: ordinal })
    : t('sidePanelNewTabTitle')
  const effectiveDraftModel = draftModel || sideData.composerModel
  const effectiveDraftProviderId = draftModel
    ? draftProviderId
    : sideData.composerProviderId
  const effectiveDraftReasoningEffort =
    draftReasoningEffort || sideData.composerReasoningEffort || 'max'

  useEffect(() => {
    if (previousParentRef.current === sideData.parentThreadId) return
    previousParentRef.current = sideData.parentThreadId
    setDraftInput('')
    setDraftModel(sideData.composerModel)
    setDraftProviderId(sideData.composerProviderId)
    setDraftReasoningEffort(sideData.composerReasoningEffort || 'max')
  }, [
    sideData.composerModel,
    sideData.composerProviderId,
    sideData.composerReasoningEffort,
    sideData.parentThreadId
  ])

  useEffect(() => {
    const previous = previousActiveRef.current
    previousActiveRef.current = activeId
    if (!showDraft || previous === undefined || previous === null) return
    setDraftInput('')
    setDraftModel(sideData.composerModel)
    setDraftProviderId(sideData.composerProviderId)
    setDraftReasoningEffort(sideData.composerReasoningEffort || 'max')
  }, [
    activeId,
    showDraft,
    sideData.composerModel,
    sideData.composerProviderId,
    sideData.composerReasoningEffort
  ])

  useEffect(() => {
    onTitleChange?.(reportedTitle)
  }, [onTitleChange, reportedTitle])

  useEffect(() => {
    if (!shouldRender) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setSwitchMenuOpen(false)
      setMoreMenuOpen(false)
      if (!docked) setMinimized(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [docked, shouldRender])

  useEffect(() => {
    if (!switchMenuOpen && !moreMenuOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (
        target instanceof Node &&
        (switchMenuRef.current?.contains(target) || moreMenuRef.current?.contains(target))
      ) {
        return
      }
      setSwitchMenuOpen(false)
      setMoreMenuOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [switchMenuOpen, moreMenuOpen])

  if (!shouldRender) return null

  const rightStyle = overlayStyle(rightOffset)
  const parentTitle = parentThread?.title?.trim() || t('sidePanelParentMissing')
  const originLabel = activeSide
    ? t('sidePanelOriginMeta', {
        title: parentTitle,
        time: formatInheritedTime(activeSide.inheritedAt, i18n.language)
      })
    : t('sidePanelDraftOrigin', { title: parentTitle })

  const closeWindow = (): void => {
    setMinimized(false)
    setSwitchMenuOpen(false)
    setMoreMenuOpen(false)
    sideData.setSidePanelOpen(false)
    onRequestClose?.()
  }

  const sendDraft = (): void => {
    const text = draftInput.trim()
    if (!text) return
    setDraftInput('')
    void sideData.spawnSideConversation(text, {
      model: effectiveDraftModel,
      providerId: effectiveDraftProviderId,
      reasoningEffort: effectiveDraftReasoningEffort
    })
  }

  const sendActiveSide = (): void => {
    if (!activeSide) return
    void sideData.sendSideMessage(activeSide.threadId, activeSide.input)
  }

  const discardActiveSide = (): void => {
    if (!activeSide) return
    setMoreMenuOpen(false)
    void sideData.discardSideConversation(activeSide.threadId)
  }

  const promoteActiveSide = (): void => {
    if (!activeSide) return
    setMoreMenuOpen(false)
    void sideData.promoteSideConversation(activeSide.threadId)
  }

  if (minimized && !docked) {
    return (
      <button
        type="button"
        onClick={() => setMinimized(false)}
        className={`ds-side-chat-mini ds-no-drag fixed bottom-[112px] z-40 flex h-11 items-center gap-2 rounded-full border border-ds-border-muted bg-ds-card/94 px-3 text-ds-muted shadow-[0_16px_42px_rgba(20,47,95,0.18)] backdrop-blur-xl transition hover:bg-ds-card hover:text-ds-ink ${className ?? ''}`}
        style={rightStyle}
        aria-label={t('sidePanelExpand')}
        title={t('sidePanelExpand')}
      >
        <MessageCircleMore className="h-4 w-4" strokeWidth={1.85} />
        <span className="text-[12px] font-semibold">{Math.max(sideIds.length, 1)}</span>
      </button>
    )
  }

  const composerInput = activeSide?.input ?? draftInput
  const composerModel = activeSide?.model ?? effectiveDraftModel
  const composerProviderId = activeSide?.providerId ?? effectiveDraftProviderId
  const composerReasoningEffort =
    activeSide?.reasoningEffort ?? effectiveDraftReasoningEffort
  const runtimeReady = sideData.runtimeConnection === 'ready'

  return (
    <aside
      className={`ds-side-chat ds-no-drag flex flex-col overflow-hidden bg-ds-main text-ds-ink ${
        docked
          ? 'h-full min-h-0 w-full'
          : 'fixed bottom-[112px] z-40 max-h-[min(680px,calc(100vh-156px))] w-[min(520px,calc(100vw-24px))] rounded-[16px] border border-ds-border shadow-[0_22px_64px_rgba(20,47,95,0.2)] dark:shadow-[0_24px_72px_rgba(0,0,0,0.46)]'
      } ${className ?? ''}`}
      style={docked ? undefined : rightStyle}
      aria-label={t('sidePanelTitle')}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-ds-border-muted bg-ds-surface-subtle/55 px-3">
        <div ref={switchMenuRef} className="relative min-w-0 flex-1">
          <button
            type="button"
            onClick={() => canSwitchSide && setSwitchMenuOpen((open) => !open)}
            disabled={!canSwitchSide}
            className="flex max-w-full items-center gap-1.5 rounded-md text-left text-[11.5px] text-ds-faint transition enabled:hover:text-ds-ink"
            aria-label={t('sidePanelSwitch')}
            aria-expanded={switchMenuOpen}
            title={originLabel}
          >
            <span className="min-w-0 truncate">{originLabel}</span>
            {canSwitchSide ? (
              <ChevronDown className="h-3 w-3 shrink-0" strokeWidth={1.9} />
            ) : null}
          </button>

          {switchMenuOpen ? (
            <div className="absolute left-0 top-full z-50 mt-2 w-72 overflow-hidden rounded-[12px] border border-ds-border bg-ds-card/98 p-1 shadow-[0_18px_46px_rgba(20,47,95,0.18)] backdrop-blur-xl">
              {currentSides.map((side, index) => {
                const selected = side.threadId === activeSide?.threadId
                return (
                  <button
                    key={side.threadId}
                    type="button"
                    onClick={() => {
                      sideData.selectSideConversation(side.threadId)
                      setSwitchMenuOpen(false)
                    }}
                    className={`flex min-h-[38px] w-full items-center gap-2 rounded-lg px-2 text-left transition ${
                      selected
                        ? 'bg-ds-hover text-ds-ink'
                        : 'text-ds-muted hover:bg-ds-hover hover:text-ds-ink'
                    }`}
                  >
                    <MessageCircleMore className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium">
                        {t('sidePanelTabTitle', { index: index + 1 })}
                      </span>
                      <span className="block truncate text-[10.5px] text-ds-faint" title={side.title}>
                        {side.title}
                      </span>
                    </span>
                    {side.busy ? (
                      <span
                        className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500"
                        aria-label={t('sidePanelRunningDot')}
                      />
                    ) : null}
                  </button>
                )
              })}
            </div>
          ) : null}
        </div>

        {!docked ? (
          <button
            type="button"
            onClick={() => sideData.openSideConversationDraft()}
            className="flex h-7 w-7 items-center justify-center rounded-md text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
            aria-label={t('sidePanelNew')}
            title={t('sidePanelNew')}
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.9} />
          </button>
        ) : null}

        <div ref={moreMenuRef} className="relative">
          <button
            type="button"
            onClick={() => setMoreMenuOpen((open) => !open)}
            disabled={!activeSide}
            className="flex h-7 w-7 items-center justify-center rounded-md text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink disabled:cursor-not-allowed disabled:opacity-35"
            aria-label={t('sidePanelMore')}
            title={t('sidePanelMore')}
            aria-expanded={moreMenuOpen}
          >
            <MoreHorizontal className="h-3.5 w-3.5" strokeWidth={1.9} />
          </button>
          {moreMenuOpen && activeSide ? (
            <div className="absolute right-0 top-full z-50 mt-2 w-48 overflow-hidden rounded-[12px] border border-ds-border bg-ds-card/98 p-1 text-[12.5px] shadow-[0_18px_46px_rgba(20,47,95,0.18)] backdrop-blur-xl">
              <button
                type="button"
                onClick={promoteActiveSide}
                className="flex min-h-[34px] w-full items-center gap-2 rounded-lg px-2 text-left text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
              >
                <ArrowDownToLine className="h-3.5 w-3.5" strokeWidth={1.8} />
                <span className="min-w-0 flex-1 truncate">{t('sidePanelPromote')}</span>
              </button>
              <button
                type="button"
                onClick={discardActiveSide}
                className="flex min-h-[34px] w-full items-center gap-2 rounded-lg px-2 text-left text-red-600 transition hover:bg-red-500/10 dark:text-red-300"
              >
                <Trash2 className="h-3.5 w-3.5" strokeWidth={1.8} />
                <span className="min-w-0 flex-1 truncate">{t('sidePanelDiscard')}</span>
              </button>
            </div>
          ) : null}
        </div>

        {!docked ? (
          <>
            <button
              type="button"
              onClick={() => setMinimized(true)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
              aria-label={t('sidePanelMinimize')}
              title={t('sidePanelMinimize')}
            >
              <Minus className="h-3.5 w-3.5" strokeWidth={1.9} />
            </button>
            <button
              type="button"
              onClick={closeWindow}
              className="flex h-7 w-7 items-center justify-center rounded-md text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
              aria-label={t('sidePanelHide')}
              title={t('sidePanelHide')}
            >
              <X className="h-3.5 w-3.5" strokeWidth={1.9} />
            </button>
          </>
        ) : null}
      </div>

      {activeSide ? (
        <SideConversationTimeline side={activeSide} workspaceRoot={sideData.workspaceRoot} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 bg-ds-main px-8 text-center text-[12.5px] leading-5 text-ds-faint">
          <MessageCircleMore className="h-5 w-5 opacity-65" strokeWidth={1.7} />
          <p>{t('sidePanelDraftEmpty')}</p>
        </div>
      )}

      <footer className="shrink-0 bg-gradient-to-t from-ds-main via-ds-main to-transparent px-3 pb-3 pt-2">
        <FloatingComposer
          variant="side"
          workspaceRootOverride={sideData.workspaceRoot}
          activeThreadIdOverride={activeSide?.threadId ?? null}
          userInputBlocksOverride={activeSide?.blocks ?? []}
          onResolveUserInput={async (blockId, action) => {
            if (!activeSide) return
            await sideData.resolveSideUserInput(activeSide.threadId, blockId, action)
          }}
          input={composerInput}
          setInput={(value) => {
            if (activeSide) sideData.setSideInput(activeSide.threadId, value)
            else setDraftInput(value)
          }}
          mode="agent"
          setMode={noop}
          busy={activeSide?.busy ?? false}
          runtimeReady={runtimeReady}
          hasActiveThread={Boolean(sideData.parentThreadId)}
          composerModel={composerModel}
          composerProviderId={composerProviderId}
          composerPickList={sideData.composerPickList}
          composerModelGroups={sideData.composerModelGroups}
          composerReasoningEffort={composerReasoningEffort}
          modelControlVariant="split"
          onComposerModelChange={(model, providerId) => {
            if (activeSide) {
              sideData.setSideModel(activeSide.threadId, model, providerId)
            } else {
              setDraftModel(model)
              setDraftProviderId(providerId?.trim() ?? '')
            }
          }}
          onComposerReasoningEffortChange={(effort) => {
            if (activeSide) sideData.setSideReasoningEffort(activeSide.threadId, effort)
            else setDraftReasoningEffort(effort)
          }}
          queuedMessages={EMPTY_QUEUED_MESSAGES}
          onRemoveQueuedMessage={noop}
          onSend={activeSide ? sendActiveSide : sendDraft}
          onInterrupt={() => {
            if (activeSide) void sideData.interruptSide(activeSide.threadId)
          }}
          hideBtwCommand
        />
      </footer>
    </aside>
  )
}
