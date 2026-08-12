import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import {
  BookOpen,
  Check,
  ExternalLink,
  FolderPlus,
  Loader2,
  RefreshCw
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { KnowledgeBaseIndexStatus, KnowledgeBaseMount } from '../../agent/types'
import { rendererRuntimeClient } from '../../agent/runtime-client'
import { workspaceLabelFromPath } from '../../lib/workspace-label'
import { normalizeWorkspaceRoot, workspaceRootIdentityKey } from '../../lib/workspace-path'
import { useChatStore } from '../../store/chat-store'
import { useWriteWorkspaceStore } from '../../write/write-workspace-store'

export function knowledgeBaseIdForRoot(root: string): string {
  const value = workspaceRootIdentityKey(normalizeWorkspaceRoot(root))
  let left = 0x811c9dc5
  let right = 0x9e3779b9
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    left = Math.imul(left ^ code, 0x01000193)
    right = Math.imul(right ^ code, 0x85ebca6b)
  }
  return `kb_${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0).toString(16).padStart(8, '0')}`
}

export function buildKnowledgeBaseMount(root: string): KnowledgeBaseMount {
  const normalizedRoot = normalizeWorkspaceRoot(root)
  const normalized = normalizedRoot.length > 1
    ? normalizedRoot.replace(/[/\\]+$/, '')
    : normalizedRoot
  return {
    id: knowledgeBaseIdForRoot(normalized),
    root: normalized,
    name: workspaceLabelFromPath(normalized),
    source: 'write-workspace',
    access: 'read-only'
  }
}

export function KnowledgeBasePicker(): ReactElement {
  const { t } = useTranslation('common')
  const activeThreadId = useChatStore((state) => state.activeThreadId)
  const activeThread = useChatStore((state) =>
    state.threads.find((thread) => thread.id === state.activeThreadId)
  )
  const statuses = useChatStore((state) =>
    state.activeThreadId ? state.knowledgeBaseStatuses[state.activeThreadId] ?? [] : []
  )
  const busy = useChatStore((state) => state.busy)
  const runtimeReady = useChatStore((state) => state.runtimeConnection === 'ready')
  const setMounts = useChatStore((state) => state.setThreadKnowledgeBases)
  const refresh = useChatStore((state) => state.refreshThreadKnowledgeBases)
  const reindex = useChatStore((state) => state.reindexThreadKnowledgeBase)
  const openWrite = useChatStore((state) => state.openWrite)
  const [open, setOpen] = useState(false)
  const [roots, setRoots] = useState<string[]>([])
  const [actingId, setActingId] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const mounts = useMemo(() => activeThread?.knowledgeBases ?? [], [activeThread?.knowledgeBases])
  const statusById = useMemo(
    () => new Map(statuses.map((status) => [status.id, status])),
    [statuses]
  )
  const canChange = Boolean(
    activeThreadId && runtimeReady && !busy && activeThread?.status !== 'running'
  )

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && wrapRef.current?.contains(event.target)) return
      setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  useEffect(() => {
    if (!open) return
    void rendererRuntimeClient.getSettings({ forceRefresh: true }).then((settings) => {
      setRoots(compactRoots([
        settings.write.defaultWorkspaceRoot,
        settings.write.activeWorkspaceRoot,
        ...settings.write.workspaces
      ]))
    })
    void refresh()
  }, [activeThreadId, open, refresh])

  useEffect(() => {
    if (!open || mounts.length === 0) return
    setRoots((current) => compactRoots([...current, ...mounts.map((mount) => mount.root)]))
  }, [mounts, open])

  useEffect(() => {
    if (!open || !statuses.some((status) => ['pending', 'indexing', 'stale'].includes(status.state))) return
    const timer = window.setInterval(() => void refresh(), 1_500)
    return () => window.clearInterval(timer)
  }, [open, refresh, statuses])

  const toggleMount = async (root: string): Promise<void> => {
    if (!activeThreadId || !canChange) return
    const mount = buildKnowledgeBaseMount(root)
    setActingId(mount.id)
    try {
      const exists = mounts.some((candidate) => candidate.id === mount.id)
      await setMounts(
        activeThreadId,
        exists ? mounts.filter((candidate) => candidate.id !== mount.id) : [...mounts, mount]
      )
    } finally {
      setActingId(null)
    }
  }

  const addDirectory = async (): Promise<void> => {
    if (!activeThreadId || !canChange) return
    const picked = await window.kunGui.pickWorkspaceDirectory(activeThread?.workspace)
    if (picked.canceled || !picked.path) return
    setActingId('add')
    try {
      await useWriteWorkspaceStore.getState().addWriteWorkspace(picked.path)
      const normalized = normalizeWorkspaceRoot(picked.path)
      setRoots((current) => compactRoots([normalized, ...current]))
      if (!mounts.some((mount) => workspaceRootIdentityKey(mount.root) === workspaceRootIdentityKey(normalized))) {
        await setMounts(activeThreadId, [...mounts, buildKnowledgeBaseMount(normalized)])
      }
    } finally {
      setActingId(null)
    }
  }

  const openInWrite = async (root: string): Promise<void> => {
    await useWriteWorkspaceStore.getState().selectWriteWorkspace(root)
    setOpen(false)
    await openWrite()
  }

  return (
    <div ref={wrapRef} className="ds-no-drag relative">
      <button
        type="button"
        className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink disabled:opacity-45"
        onClick={() => setOpen((value) => !value)}
        disabled={!activeThreadId || !runtimeReady}
        title={t('knowledgeBaseTitle')}
      >
        <BookOpen className="h-4 w-4" strokeWidth={1.8} />
        <span>{t('knowledgeBaseShort')}</span>
        {mounts.length > 0 ? (
          <span className="rounded-full bg-accent/10 px-1.5 text-[11px] text-accent">{mounts.length}</span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute bottom-[calc(100%+8px)] left-0 z-50 w-[min(420px,calc(100vw-48px))] overflow-hidden rounded-xl border border-ds-border bg-ds-elevated shadow-[0_24px_70px_rgba(44,55,78,0.18)]">
          <div className="border-b border-ds-border-muted px-4 py-3">
            <div className="text-[14px] font-semibold text-ds-ink">{t('knowledgeBaseTitle')}</div>
            <div className="mt-1 text-[12px] leading-5 text-ds-faint">{t('knowledgeBaseDescription')}</div>
          </div>
          <div className="max-h-[340px] overflow-y-auto p-3">
            {roots.map((root) => {
              const mount = mounts.find((candidate) =>
                workspaceRootIdentityKey(candidate.root) === workspaceRootIdentityKey(root)
              )
              const status = mount ? statusById.get(mount.id) : undefined
              const isPrimary = workspaceRootIdentityKey(root) === workspaceRootIdentityKey(activeThread?.workspace ?? '')
              const acting = actingId === (mount?.id ?? knowledgeBaseIdForRoot(root))
              return (
                <div key={root} className="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-ds-hover">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-not-allowed disabled:opacity-45"
                    disabled={!canChange || isPrimary || Boolean(actingId)}
                    onClick={() => void toggleMount(root)}
                    title={isPrimary ? t('knowledgeBasePrimaryWorkspace') : root}
                  >
                    <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${mount ? 'border-accent bg-accent text-white' : 'border-ds-border'}`}>
                      {acting ? <Loader2 className="h-3 w-3 animate-spin" /> : mount ? <Check className="h-3.5 w-3.5" /> : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-medium text-ds-ink">{workspaceLabelFromPath(root)}</span>
                      <span className="block truncate text-[11px] text-ds-faint">{root}</span>
                      {status ? <StatusSummary status={status} /> : null}
                    </span>
                  </button>
                  {mount && status ? <StatusBadge status={status} /> : null}
                  {mount && status && ['stale', 'error', 'unavailable'].includes(status.state) ? (
                    <button
                      type="button"
                      className="rounded-md p-1.5 text-ds-faint hover:bg-ds-subtle hover:text-ds-ink disabled:opacity-40"
                      disabled={!canChange || Boolean(actingId)}
                      onClick={() => void reindex(activeThreadId!, mount.id)}
                      title={t('knowledgeBaseReindex')}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                  {mount ? (
                    <button
                      type="button"
                      className="rounded-md p-1.5 text-ds-faint hover:bg-ds-subtle hover:text-ds-ink"
                      onClick={() => void openInWrite(root)}
                      title={t('knowledgeBaseOpenWrite')}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
              )
            })}
            {roots.length === 0 ? (
              <div className="px-2 py-5 text-center text-[13px] text-ds-faint">{t('knowledgeBaseEmpty')}</div>
            ) : null}
          </div>
          <div className="border-t border-ds-border-muted p-3">
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-[13px] font-medium text-ds-ink hover:bg-ds-hover disabled:opacity-45"
              disabled={!canChange || Boolean(actingId)}
              onClick={() => void addDirectory()}
            >
              {actingId === 'add' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderPlus className="h-4 w-4" />}
              {t('knowledgeBaseAddDirectory')}
            </button>
            {!canChange ? <div className="px-2 pt-2 text-[11px] text-ds-faint">{t('knowledgeBaseIdleOnly')}</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function StatusSummary({ status }: { status: KnowledgeBaseIndexStatus }): ReactElement | null {
  const { t } = useTranslation('common')
  if (!status.availableDocumentCount && !status.unavailableDocumentCount) return null
  const officeFormats = Object.entries(status.formatCounts ?? {})
    .filter(([format, count]) => ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(format) && count > 0)
    .map(([format, count]) => `${format.toUpperCase()} ${count}`)
    .join(' · ')
  return (
    <span className="mt-0.5 block truncate text-[10px] text-ds-faint" title={status.diagnostics?.join('\n')}>
      {t('knowledgeBaseIndexSummary', {
        available: status.availableDocumentCount ?? 0,
        unavailable: status.unavailableDocumentCount ?? 0
      })}
      {status.truncatedDocumentCount ? ` · ${t('knowledgeBaseTruncatedCount', { count: status.truncatedDocumentCount })}` : ''}
      {officeFormats ? ` · ${officeFormats}` : ''}
    </span>
  )
}

function StatusBadge({ status }: { status: KnowledgeBaseIndexStatus }): ReactElement {
  const { t } = useTranslation('common')
  const busy = status.state === 'pending' || status.state === 'indexing'
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] ${
        status.state === 'ready' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' :
          status.state === 'error' || status.state === 'unavailable' ? 'bg-red-500/10 text-red-600 dark:text-red-300' :
            'bg-amber-500/10 text-amber-700 dark:text-amber-300'
      }`}
      title={status.error}
    >
      {busy ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : null}
      {t(`knowledgeBaseStatus_${status.state}`)}
    </span>
  )
}

function compactRoots(values: readonly string[]): string[] {
  const seen = new Set<string>()
  return values.flatMap((value) => {
    const root = normalizeWorkspaceRoot(value)
    const key = workspaceRootIdentityKey(root)
    if (!root || !key || seen.has(key)) return []
    seen.add(key)
    return [root]
  })
}
