import type { ReactElement } from 'react'
import type { QueuedComposerMessage } from './FloatingComposerQueuedMessages'
import type { FloatingComposerRenderContext } from './floating-composer-view-context'

export function FloatingComposerStackView({
  context
}: {
  context: FloatingComposerRenderContext
}): ReactElement {
  const {
    BackgroundShellOverlay, FileText, FloatingComposerAboveInputStack,
    FloatingComposerFileMentionMenu, FloatingComposerGraphProgress, FloatingComposerQueuedMessages,
    FloatingComposerSlashCommandMenu, FloatingComposerTodoProgress, FloatingComposerUserInputPanel,
    Folder, ImagePlus, ListTodo, Loader2, Paperclip, PauseCircle, Pencil, PlayCircle, Share2,
    Target, Trash2, X, activeThreadGoal, activeThreadId, activeThreadTodos, applySlashCommand,
    attachmentUploadBusy, attachmentUploadEnabled, busy, canOpenGoalPanel, canPickAttachment,
    canPickDesignReference, canPickFileReference, canPickLocalFileReference, canSetGoalPanelDraft,
    canToggleGraphMode, canTogglePlanMode, clearActiveThreadGoal, compact, composerMenuOpen,
    composerMenuPanelRef, currentTurnOrchestration, draft, fileMentions, fileReferenceEnabled,
    filteredSlashCommands, goalBannerLabel, goalElapsedLabel, goalMenuChecked, goalPanelOpen,
    goalPanelRef, graphEnabled, handleAttachmentMenuClick, handleDesignReferenceMenuClick,
    handleFileReferenceMenuClick, handleGoalMenuClick, handleGraphToolbarClick,
    handleLocalFileReferenceMenuClick, handlePlanToolbarClick, highlightedSlashCommand, mode,
    onGuideQueuedMessage, onOpenGraph, onOpenGraphChild, onPickAttachments, onRemoveQueuedMessage,
    orchestration, pendingUserInputBlock, queuedMessages, reorderQueuedMessage,
    returnQueuedMessageToComposer, runtimeReady, setActiveThreadGoalStatus, setGoalFromComposerInput,
    setGoalPanelOpen, setInput, showGoalFloater, showGoalMenuOption, showGraphMenuOption,
    showGraphProgress, showPlanMenuOption, showTodoProgress, slashCommandMenu, slashQuery, t, userInput
  } = context
  return (
    <>
      <FloatingComposerAboveInputStack
        floatingStatuses={(
          <>
            {showTodoProgress && activeThreadTodos ? (
              <FloatingComposerTodoProgress todos={activeThreadTodos} enabled={showGraphProgress} />
            ) : null}
            <FloatingComposerGraphProgress
              threadId={activeThreadId}
              enabled={showGraphProgress}
              onOpenGraph={onOpenGraph}
              onOpenChild={onOpenGraphChild}
            />
            {showGoalFloater && activeThreadGoal && !pendingUserInputBlock ? (
              <div
                data-composer-stack-item="goal"
                className="ds-composer-status-glass pointer-events-auto flex min-h-11 w-full max-w-[46rem] items-center gap-2 rounded-full border px-3 py-1.5 text-ds-muted"
              >
                <Target className="h-3.5 w-3.5 shrink-0 text-ds-faint" strokeWidth={1.9} />
                <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] leading-5">
                  <span className="shrink-0 font-semibold text-ds-ink">
                    {goalBannerLabel}
                  </span>
                  <span className="min-w-0 truncate text-ds-muted">
                    {activeThreadGoal.objective}
                  </span>
                  <span className="shrink-0 text-ds-faint">
                    · {goalElapsedLabel}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => {
                      setGoalPanelOpen(true)
                      draft.focusComposer()
                    }}
                    className="ds-no-drag flex h-7 w-7 items-center justify-center rounded-full text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
                    aria-label={t('goalActionEdit')}
                    title={t('goalActionEdit')}
                  >
                    <Pencil className="h-3.5 w-3.5" strokeWidth={1.9} />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void setActiveThreadGoalStatus(activeThreadGoal.status === 'active' ? 'paused' : 'active')
                    }}
                    className="ds-no-drag flex h-7 w-7 items-center justify-center rounded-full text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
                    aria-label={activeThreadGoal.status === 'active' ? t('goalActionPause') : t('goalActionResume')}
                    title={activeThreadGoal.status === 'active' ? t('goalActionPause') : t('goalActionResume')}
                  >
                    {activeThreadGoal.status === 'active' ? (
                      <PauseCircle className="h-3.5 w-3.5" strokeWidth={1.9} />
                    ) : (
                      <PlayCircle className="h-3.5 w-3.5" strokeWidth={1.9} />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void clearActiveThreadGoal()
                    }}
                    className="ds-no-drag flex h-7 w-7 items-center justify-center rounded-full text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
                    aria-label={t('goalActionClear')}
                    title={t('goalActionClear')}
                  >
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={1.9} />
                  </button>
                </div>
              </div>
            ) : null}
          </>
        )}
        flowPanels={(
          <>
            {runtimeReady ? <BackgroundShellOverlay threadId={activeThreadId} /> : null}
            <FloatingComposerQueuedMessages
              messages={queuedMessages}
              guidanceTarget={currentTurnOrchestration === 'graph' ? 'graph' : 'turn'}
              onRemove={onRemoveQueuedMessage}
              onGuide={onGuideQueuedMessage}
              onReorder={reorderQueuedMessage}
              onEdit={(message: QueuedComposerMessage) => {
                returnQueuedMessageToComposer(message, onRemoveQueuedMessage, setInput)
                draft.focusComposer()
              }}
            />
            {userInput.active ? (
              <FloatingComposerUserInputPanel
                controller={userInput}
                t={t}
                variant={compact ? 'compact' : 'main'}
              />
            ) : null}
          </>
        )}
      />

      {composerMenuOpen && slashQuery == null ? (
          <div
            ref={composerMenuPanelRef}
            className="absolute bottom-12 left-1 z-40 w-48 overflow-hidden rounded-[18px] border border-ds-border bg-white py-1.5 text-[13px] text-ds-muted shadow-[0_18px_48px_rgba(20,47,95,0.16)] dark:bg-ds-card"
          >
            {fileReferenceEnabled ? (
              <button
                type="button"
                disabled={!canPickLocalFileReference}
                onClick={handleLocalFileReferenceMenuClick}
                className="ds-no-drag flex h-8 w-full items-center gap-2 px-3 text-left transition hover:bg-ds-hover hover:text-ds-ink disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-ds-muted"
              >
                <FileText className="h-3.5 w-3.5 shrink-0" strokeWidth={1.9} />
                <span className="min-w-0 flex-1 truncate">{t('composerAddLocalFiles')}</span>
              </button>
            ) : null}
            {fileReferenceEnabled ? (
              <button
                type="button"
                disabled={!canPickFileReference}
                onClick={handleFileReferenceMenuClick}
                className="ds-no-drag flex h-8 w-full items-center gap-2 px-3 text-left transition hover:bg-ds-hover hover:text-ds-ink disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-ds-muted"
              >
                <Paperclip className="h-3.5 w-3.5 shrink-0" strokeWidth={1.9} />
                <span className="min-w-0 flex-1 truncate">{t('composerBrowseWorkspaceFiles')}</span>
              </button>
            ) : null}
            {fileReferenceEnabled ? (
              <button
                type="button"
                disabled={!canPickDesignReference}
                onClick={handleDesignReferenceMenuClick}
                className="ds-no-drag flex h-8 w-full items-center gap-2 px-3 text-left transition hover:bg-ds-hover hover:text-ds-ink disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-ds-muted"
              >
                <Folder className="h-3.5 w-3.5 shrink-0" strokeWidth={1.9} />
                <span className="min-w-0 flex-1 truncate">{t('composerBrowseDesignDocs')}</span>
              </button>
            ) : null}
            {attachmentUploadEnabled ? (
              <>
                {fileReferenceEnabled ? <div className="my-1 h-px bg-ds-border-muted/70" /> : null}
                <button
                  type="button"
                  disabled={!canPickAttachment || !onPickAttachments}
                  onClick={handleAttachmentMenuClick}
                  className="ds-no-drag flex h-8 w-full items-center gap-2 px-3 text-left transition hover:bg-ds-hover hover:text-ds-ink disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-ds-muted"
                >
                  {attachmentUploadBusy ? (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" strokeWidth={1.9} />
                  ) : (
                    <ImagePlus className="h-3.5 w-3.5 shrink-0" strokeWidth={1.9} />
                  )}
                  <span className="min-w-0 flex-1 truncate">{t('composerAddImage')}</span>
                </button>
                <div className="my-1 h-px bg-ds-border-muted/70" />
              </>
            ) : null}
            {showPlanMenuOption ? <button
              type="button"
              data-composer-plan-menu-item
              disabled={!canTogglePlanMode}
              onClick={handlePlanToolbarClick}
              className="ds-no-drag flex h-8 w-full items-center gap-2 px-3 text-left transition hover:bg-ds-hover hover:text-ds-ink disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-ds-muted"
            >
              <ListTodo className="h-3.5 w-3.5 shrink-0" strokeWidth={1.9} />
              <span className="min-w-0 flex-1 truncate">{t('composerMenuPlanMode')}</span>
              <span
                role="switch"
                aria-checked={mode === 'plan'}
                className={`relative h-5 w-9 shrink-0 rounded-full ring-1 transition ${
                  mode === 'plan'
                    ? 'bg-accent ring-accent/35 shadow-[inset_0_1px_0_rgba(255,255,255,0.24)]'
                    : 'bg-ds-border-muted ring-ds-border-muted'
                }`}
              >
                <span
                  className={`absolute top-0.5 h-4 w-4 rounded-full bg-white ring-1 ring-black/5 transition ${
                    mode === 'plan' ? 'translate-x-[17px]' : 'translate-x-0.5'
                  } shadow-[0_1px_4px_rgba(20,47,95,0.28)]`}
                />
              </span>
            </button> : null}
            {showGraphMenuOption ? (
              <button
                type="button"
                data-composer-graph-menu-item
                disabled={!canToggleGraphMode}
                onClick={handleGraphToolbarClick}
                aria-label={busy
                  ? t('graphModeNextTurnGraph', { defaultValue: 'Next turn: Graph' })
                  : t('graphModeGraph', { defaultValue: 'Graph' })}
                title={busy
                  ? t('graphModeNextTurnHint', {
                        defaultValue: 'Controls the next turn and cannot change the turn already running'
                      })
                  : !graphEnabled
                    ? t('graphModeDisabledHint', {
                        defaultValue: 'Enable experimental Graph Mode in Settings → Agents'
                      })
                    : t('graphModeGraphHint', {
                        defaultValue: 'Graph: plan, delegate, supervise, review, and synthesize'
                      })}
                className="ds-no-drag flex h-8 w-full items-center gap-2 px-3 text-left transition hover:bg-ds-hover hover:text-ds-ink disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-ds-muted"
              >
                <Share2 className="h-3.5 w-3.5 shrink-0" strokeWidth={1.9} />
                <span className="min-w-0 flex-1 truncate">
                  {busy
                    ? t('graphModeNextTurnGraph', { defaultValue: 'Next turn: Graph' })
                    : t('graphModeGraph', { defaultValue: 'Graph' })}
                </span>
                <span
                  role="switch"
                  aria-label={busy
                    ? t('graphModeNextTurnGraph', { defaultValue: 'Next turn: Graph' })
                    : t('graphModeGraph', { defaultValue: 'Graph' })}
                  aria-checked={mode === 'agent' && orchestration === 'graph'}
                  className={`relative h-5 w-9 shrink-0 rounded-full ring-1 transition ${
                    mode === 'agent' && orchestration === 'graph'
                      ? 'bg-accent ring-accent/35 shadow-[inset_0_1px_0_rgba(255,255,255,0.24)]'
                      : 'bg-ds-border-muted ring-ds-border-muted'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-4 w-4 rounded-full bg-white ring-1 ring-black/5 transition ${
                      mode === 'agent' && orchestration === 'graph'
                        ? 'translate-x-[17px]'
                        : 'translate-x-0.5'
                    } shadow-[0_1px_4px_rgba(20,47,95,0.28)]`}
                  />
                </span>
              </button>
            ) : null}
            {showGoalMenuOption ? <button
              type="button"
              data-composer-goal-menu-item
              disabled={!canOpenGoalPanel}
              onClick={handleGoalMenuClick}
              className="ds-no-drag flex h-8 w-full items-center gap-2 px-3 text-left transition hover:bg-ds-hover hover:text-ds-ink disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-ds-muted"
            >
              <Target className="h-3.5 w-3.5 shrink-0" strokeWidth={1.9} />
              <span className="min-w-0 flex-1 truncate">{t('composerMenuPursueGoal')}</span>
              <span
                role="switch"
                aria-checked={goalMenuChecked}
                className={`relative h-5 w-9 shrink-0 rounded-full ring-1 transition ${
                  goalMenuChecked
                    ? 'bg-accent ring-accent/35 shadow-[inset_0_1px_0_rgba(255,255,255,0.24)]'
                    : 'bg-ds-border-muted ring-ds-border-muted'
                }`}
              >
                <span
                  className={`absolute top-0.5 h-4 w-4 rounded-full bg-white ring-1 ring-black/5 transition ${
                    goalMenuChecked ? 'translate-x-[17px]' : 'translate-x-0.5'
                  } shadow-[0_1px_4px_rgba(20,47,95,0.28)]`}
                />
              </span>
            </button> : null}
          </div>
        ) : null}

        {slashQuery != null ? (
          <FloatingComposerSlashCommandMenu
            commands={filteredSlashCommands}
            highlighted={highlightedSlashCommand}
            selectedIndex={slashCommandMenu.selectedIndex}
            onSelect={applySlashCommand}
          />
        ) : null}

        {fileMentions.showMenu ? (
          <FloatingComposerFileMentionMenu
            suggestions={fileMentions.suggestions}
            loading={fileMentions.loading}
            selectedIndex={fileMentions.selectedIndex}
            highlighted={fileMentions.highlighted}
            hasMountedKnowledgeBases={fileMentions.hasMountedKnowledgeBases}
            onSelect={fileMentions.applySuggestion}
          />
        ) : null}

        {showGoalMenuOption && goalPanelOpen && slashQuery == null && !pendingUserInputBlock ? (
          <div
            ref={goalPanelRef}
            className="absolute inset-x-2 bottom-full z-30 mb-3 overflow-hidden rounded-[26px] border border-ds-border bg-white p-3 shadow-[0_18px_52px_rgba(20,47,95,0.14)] backdrop-blur-xl dark:bg-ds-card"
          >
            <div className="flex items-start gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-ds-border-muted text-ds-muted">
                <Target className="h-4 w-4" strokeWidth={1.9} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <div className="truncate text-[14px] font-semibold text-ds-ink">
                    {activeThreadGoal ? activeThreadGoal.objective : t('goalNoActiveTitle')}
                  </div>
                  {activeThreadGoal ? (
                    <span className="shrink-0 rounded-lg border border-ds-border-muted bg-ds-card px-2 py-0.5 text-[11px] font-semibold text-ds-muted">
                      {t(`goalStatusShort.${activeThreadGoal.status}`)}
                    </span>
                  ) : null}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {canSetGoalPanelDraft ? (
                    <button
                      type="button"
                      onClick={setGoalFromComposerInput}
                      className="rounded-full border border-ds-border bg-ds-card px-3 py-1.5 text-[12px] font-semibold text-ds-ink transition hover:bg-ds-hover"
                    >
                      {t('goalSetCurrentInput')}
                    </button>
                  ) : null}
                  {activeThreadGoal?.status === 'active' ? (
                    <button
                      type="button"
                      onClick={() => {
                        setGoalPanelOpen(false)
                        void setActiveThreadGoalStatus('paused')
                      }}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-ds-border bg-ds-card text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
                      aria-label={t('goalActionPause')}
                      title={t('goalActionPause')}
                    >
                      <PauseCircle className="h-4 w-4" strokeWidth={1.9} />
                    </button>
                  ) : activeThreadGoal ? (
                    <button
                      type="button"
                      onClick={() => {
                        setGoalPanelOpen(false)
                        void setActiveThreadGoalStatus('active')
                      }}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-ds-border bg-ds-card text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
                      aria-label={t('goalActionResume')}
                      title={t('goalActionResume')}
                    >
                      <PlayCircle className="h-4 w-4" strokeWidth={1.9} />
                    </button>
                  ) : null}
                  {activeThreadGoal ? (
                    <button
                      type="button"
                      onClick={() => {
                        setGoalPanelOpen(false)
                        void clearActiveThreadGoal()
                      }}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-ds-border bg-ds-card text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
                      aria-label={t('goalActionClear')}
                      title={t('goalActionClear')}
                    >
                      <Trash2 className="h-4 w-4" strokeWidth={1.9} />
                    </button>
                  ) : null}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setGoalPanelOpen(false)}
                className="rounded-lg p-1.5 text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
                aria-label={t('close')}
                title={t('close')}
              >
                <X className="h-4 w-4" strokeWidth={2} />
              </button>
            </div>
          </div>
        ) : null}

    </>
  )
}
