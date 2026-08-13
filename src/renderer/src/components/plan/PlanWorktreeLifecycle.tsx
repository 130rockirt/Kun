import { useEffect, useState, type ReactElement } from 'react'
import {
  ExternalLink,
  FolderOpen,
  Loader2,
  RotateCcw,
  TriangleAlert
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { PlanWorktreeRunRecord } from '@shared/plan-worktree'
import { confirmDialog } from '../../lib/confirm-dialog'
import { openWorkspacePathInEditor } from '../../lib/open-workspace-path'
import { useChatStore } from '../../store/chat-store'
import { usePlanWorktreeStore } from '../../plan/plan-worktree-store'
import { usePlanWorktreeCompletion } from '../../plan/use-plan-worktree-completion'

function statusTone(status: PlanWorktreeRunRecord['status']): string {
  if (status === 'completed') return 'border-emerald-400/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
  if (status === 'needs_attention' || status === 'cleanup_pending') {
    return 'border-amber-400/30 bg-amber-500/10 text-amber-800 dark:text-amber-200'
  }
  if (status === 'cancelled') return 'border-ds-border-muted bg-ds-main/60 text-ds-faint'
  return 'border-accent/25 bg-accent/10 text-accent'
}

function RecoveryButton({
  label,
  onClick,
  danger = false,
  disabled = false
}: {
  label: string
  onClick: () => void
  danger?: boolean
  disabled?: boolean
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-full border px-2.5 py-1 text-[11.5px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 disabled:opacity-45 ${
        danger
          ? 'border-red-400/30 text-red-600 hover:bg-red-500/10 dark:text-red-300'
          : 'border-ds-border-muted bg-ds-card text-ds-muted hover:bg-ds-hover hover:text-ds-ink'
      }`}
    >
      {label}
    </button>
  )
}

export function PlanWorktreeLifecycle({
  planId,
  runRecord,
  compact = false
}: {
  planId: string
  runRecord?: PlanWorktreeRunRecord
  compact?: boolean
}): ReactElement | null {
  const { t } = useTranslation('common')
  const storedRun = usePlanWorktreeStore((state) =>
    state.plans[planId]?.run ?? Object.values(state.plans)
      .find((entry) => entry.run?.runId === runRecord?.runId)?.run)
  const run = storedRun ?? runRecord
  const buildError = usePlanWorktreeStore((state) => state.plans[planId]?.buildError)
  const upsertRun = usePlanWorktreeStore((state) => state.upsertRun)
  const setUseWorktree = usePlanWorktreeStore((state) => state.setUseWorktree)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  usePlanWorktreeCompletion(run)

  useEffect(() => {
    if (!run || run.status === 'completed' || run.status === 'cancelled') return
    let cancelled = false
    const refresh = (): void => {
      void window.kunGui.planWorktree.get({ runId: run.runId }).then((latest) => {
        if (!cancelled && latest) upsertRun(latest)
      }).catch(() => undefined)
    }
    const timer = window.setInterval(refresh, 4_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [run, upsertRun])

  if (!run && !buildError) return null

  const act = async (
    name: string,
    action: () => Promise<PlanWorktreeRunRecord>
  ): Promise<void> => {
    if (busyAction) return
    setBusyAction(name)
    setError(null)
    try {
      upsertRun(await action())
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError))
    } finally {
      setBusyAction(null)
    }
  }

  const openThread = (): void => {
    if (!run?.executionThreadId) return
    void (async () => {
      await useChatStore.getState().openCode()
      await useChatStore.getState().selectThread(run.executionThreadId!)
    })()
  }

  const openSourceThread = (): void => {
    if (!run?.sourceThreadId) return
    void (async () => {
      await useChatStore.getState().openCode()
      await useChatStore.getState().selectThread(run.sourceThreadId)
    })()
  }

  const openWorktree = (): void => {
    if (!run) return
    void openWorkspacePathInEditor({ path: run.worktreePath }, run.worktreePath)
  }

  const discard = async (): Promise<void> => {
    if (!run) return
    const files = run.changedFiles?.files ?? []
    const confirmed = await confirmDialog(
      t('planWorktreeDiscardConfirm'),
      t('planWorktreeDiscardDetail', { count: files.length })
    )
    if (!confirmed) return
    await act('discard', () => window.kunGui.planWorktree.discard({
      runId: run.runId,
      confirmedDiscard: true
    }))
  }

  const buildInCurrentWorkspace = async (): Promise<PlanWorktreeRunRecord> => {
    if (!run?.executionPrompt) throw new Error('This plan build has no durable execution prompt.')
    await useChatStore.getState().openCode()
    await useChatStore.getState().selectThread(run.sourceThreadId)
    if (useChatStore.getState().activeThreadId !== run.sourceThreadId) {
      throw new Error('The source plan conversation could not be opened.')
    }
    const started = await useChatStore.getState().sendMessage(run.executionPrompt, 'agent', {
      displayText: run.executionDisplayText ?? t('planWorktreeCurrentWorkspaceWarning'),
      orchestration: run.orchestration
    })
    if (!started) throw new Error('The current-workspace plan execution could not be started.')
    setUseWorktree(planId, false)
    return run
  }

  return (
    <div
      data-plan-worktree-lifecycle
      className={`basis-full rounded-xl border px-3 py-2 ${
        run ? statusTone(run.status) : 'border-red-400/30 bg-red-500/10 text-red-700 dark:text-red-300'
      } ${compact ? 'max-w-[42rem]' : 'w-full'}`}
    >
      <div className="flex min-w-0 items-center gap-2 text-[12px] font-semibold">
        {busyAction || run?.status === 'preparing' || run?.status === 'integrating' ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" strokeWidth={2} />
        ) : run?.status === 'needs_attention' || run?.status === 'cleanup_pending' || buildError ? (
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
        ) : (
          <RotateCcw className="h-3.5 w-3.5 shrink-0" strokeWidth={1.9} />
        )}
        <span className="truncate">
          {run ? t(`planWorktreeStatus_${run.status}`) : t('planWorktreeStatus_needs_attention')}
        </span>
        {run?.targetBranch ? (
          <span className="min-w-0 truncate font-mono text-[11px] font-normal opacity-80">
            {run.targetBranch}
          </span>
        ) : null}
      </div>
      {run?.attentionMessage || buildError || error ? (
        <div className="mt-1 break-words text-[11.5px] leading-5 opacity-90">
          {error || run?.attentionMessage || buildError}
        </div>
      ) : null}
      {run ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <RecoveryButton label={t('planWorktreeOpenSourceThread')} onClick={openSourceThread} />
          {run.executionThreadId && run.executionTurnId ? (
            <RecoveryButton
              label={run.status === 'executing'
                ? t('planWorktreeContinueImplementation')
                : t('planWorktreeOpenThread')}
              onClick={openThread}
            />
          ) : null}
          {run.executionThreadId && !run.executionTurnId && (
            run.status === 'executing' || run.status === 'needs_attention'
          ) ? (
            <RecoveryButton
              label={t('planWorktreeResumeAdmission', { defaultValue: 'Resume execution' })}
              disabled={Boolean(busyAction)}
              onClick={() => void act('resume-admission', () =>
                window.kunGui.planWorktree.resumeAdmission({ runId: run.runId }))}
            />
          ) : null}
          {run.status !== 'completed' && run.status !== 'cancelled' ? (
            <RecoveryButton label={t('planWorktreeOpenWorktree')} onClick={openWorktree} />
          ) : null}
          {run.status === 'needs_attention' && run.completionVerifiedAt ? (
            <RecoveryButton
              label={t('planWorktreeRetryIntegration')}
              disabled={Boolean(busyAction)}
              onClick={() => void act('retry', () =>
                window.kunGui.planWorktree.retryIntegration({ runId: run.runId }))}
            />
          ) : null}
          {run.attentionReason === 'rebase_conflict' ? (
            <>
              <RecoveryButton
                label={t('planWorktreeContinueRebase')}
                disabled={Boolean(busyAction)}
                onClick={() => void act('continue-rebase', () =>
                  window.kunGui.planWorktree.continueRebase({ runId: run.runId }))}
              />
              <RecoveryButton
                label={t('planWorktreeAbortRebase')}
                disabled={Boolean(busyAction)}
                onClick={() => void act('abort-rebase', () =>
                  window.kunGui.planWorktree.abortRebase({ runId: run.runId }))}
              />
            </>
          ) : null}
          {run.status === 'cleanup_pending' ? (
            <RecoveryButton
              label={t('planWorktreeRetryCleanup')}
              disabled={Boolean(busyAction)}
              onClick={() => void act('cleanup', () =>
                window.kunGui.planWorktree.cleanup({ runId: run.runId }))}
            />
          ) : null}
          {run.status === 'needs_attention' || run.status === 'executing' ? (
            <RecoveryButton label={t('planWorktreeRetain')} onClick={openWorktree} />
          ) : null}
          {!run.executionThreadId && (run.status === 'executing' || run.status === 'needs_attention') ? (
            <>
              {run.executionPrompt ? (
                <RecoveryButton
                  label={t('planWorktreeCurrentWorkspaceWarning')}
                  disabled={Boolean(busyAction)}
                  onClick={() => void act('current-workspace', buildInCurrentWorkspace)}
                />
              ) : null}
              <RecoveryButton
                label={t('planWorktreeCancelSafely')}
                disabled={Boolean(busyAction)}
                onClick={() => void act('safe-cancel', () =>
                  window.kunGui.planWorktree.safeCancel({
                    runId: run.runId,
                    confirmedDiscard: false
                  }))}
              />
            </>
          ) : null}
          {run.status === 'needs_attention' ? (
            <RecoveryButton
              label={t('planWorktreeDiscard')}
              danger
              disabled={Boolean(busyAction)}
              onClick={() => void discard()}
            />
          ) : null}
        </div>
      ) : null}
      {run?.worktreePath ? (
        <div className="mt-1.5 flex min-w-0 items-center gap-1 font-mono text-[10.5px] opacity-70">
          <FolderOpen className="h-3 w-3 shrink-0" />
          <span className="truncate" title={run.worktreePath}>{run.worktreePath}</span>
          {run.executionThreadId ? <ExternalLink className="h-3 w-3 shrink-0" /> : null}
        </div>
      ) : null}
    </div>
  )
}
