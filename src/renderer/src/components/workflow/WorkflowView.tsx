import type { ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, Download, Pencil, Play, Plus, Power, Square, Trash2, Upload, Workflow as WorkflowIcon, Zap } from 'lucide-react'
import {
  mergeWorkflowSettings,
  normalizeWorkflowSettings,
  type AppSettingsV1,
  type WorkflowCustomModuleV1,
  type WorkflowHookTriggerV1,
  type WorkflowNodePresetV1,
  type WorkflowNodeRunResultV1,
  type WorkflowNodeV1,
  type WorkflowRuntimeStatus,
  type WorkflowV1
} from '@shared/app-settings'
import { rendererRuntimeClient } from '../../agent/runtime-client'
import { confirmDialog } from '../../lib/confirm-dialog'
import { SidebarTitlebarToggleButton } from '../sidebar/SidebarPrimitives'
import { parseWorkflowDsl, serializeWorkflowDsl } from '@shared/workflow-dsl'
import { WorkflowEditorView } from './WorkflowEditorView'
import { WorkflowHookTriggers } from './WorkflowHookTriggers'
import { createWorkflow } from './workflow-types'
import { RunInputDialog, WorkflowToggle } from './WorkflowViewDialogs'

type Props = {
  leftSidebarCollapsed: boolean
  onToggleLeftSidebar: () => void
  onOpenThread?: (threadId: string) => void
}

const EMPTY_WORKFLOWS: WorkflowV1[] = []
const EMPTY_PRESETS: WorkflowNodePresetV1[] = []
const EMPTY_MODULES: WorkflowCustomModuleV1[] = []

function statusTone(status: WorkflowV1['lastStatus']): string {
  if (status === 'running') return 'bg-amber-500/15 text-amber-900 dark:text-amber-100'
  if (status === 'success') return 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-100'
  if (status === 'error') return 'bg-red-500/15 text-red-700 dark:text-red-100'
  return 'bg-ds-subtle text-ds-muted'
}

function formatDateTime(value: string, fallback: string): string {
  if (!value.trim()) return fallback
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : fallback
}

export function WorkflowView({ leftSidebarCollapsed, onToggleLeftSidebar }: Props): ReactElement {
  const { t } = useTranslation('common')
  const [settings, setSettings] = useState<AppSettingsV1 | null>(null)
  const [status, setStatus] = useState<WorkflowRuntimeStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [runInputTarget, setRunInputTarget] = useState<WorkflowV1 | null>(null)

  const refreshStatus = useCallback(async (): Promise<void> => {
    if (typeof window.kunGui?.getWorkflowStatus !== 'function') return
    try {
      setStatus(await window.kunGui.getWorkflowStatus())
    } catch {
      /* ignore transient status errors */
    }
  }, [])

  const load = useCallback(async (): Promise<void> => {
    try {
      const [nextSettings, nextStatus] = await Promise.all([
        rendererRuntimeClient.getSettings({ forceRefresh: true }),
        typeof window.kunGui?.getWorkflowStatus === 'function'
          ? window.kunGui.getWorkflowStatus()
          : Promise.resolve(null)
      ])
      setSettings(nextSettings)
      setStatus(nextStatus)
      setError(null)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }, [])

  // Poll fast (1.2s) while something is running so the run log streams, slow (5s) when idle.
  const runningRef = useRef(false)
  useEffect(() => {
    runningRef.current = (status?.runningWorkflowIds.length ?? 0) > 0
  }, [status])
  useEffect(() => {
    void load()
    let cancelled = false
    let timer = 0
    const tick = async (): Promise<void> => {
      await refreshStatus()
      if (cancelled) return
      timer = window.setTimeout(() => void tick(), runningRef.current ? 1_200 : 5_000)
    }
    timer = window.setTimeout(() => void tick(), 5_000)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [load, refreshStatus])

  const workflowSettings = settings ? normalizeWorkflowSettings(settings.workflow) : null
  const workflows = workflowSettings?.workflows ?? EMPTY_WORKFLOWS
  const presets = workflowSettings?.presets ?? EMPTY_PRESETS
  const modules = workflowSettings?.modules ?? EMPTY_MODULES
  const runningIds = useMemo(() => new Set(status?.runningWorkflowIds ?? []), [status])

  // When a run finishes, reload settings so the editor's persisted last-run results refresh.
  const prevRunningCount = useRef(0)
  useEffect(() => {
    const count = runningIds.size
    if (count < prevRunningCount.current) void load()
    prevRunningCount.current = count
  }, [runningIds, load])

  const persistPresets = useCallback(
    async (nextPresets: WorkflowNodePresetV1[]): Promise<void> => {
      if (!settings) return
      const nextWorkflow = mergeWorkflowSettings(settings.workflow, { presets: nextPresets })
      setSettings({ ...settings, workflow: nextWorkflow })
      const saved = await rendererRuntimeClient.setSettings({ workflow: nextWorkflow })
      setSettings(saved)
    },
    [settings]
  )

  const handleSavePreset = useCallback(
    (preset: WorkflowNodePresetV1): Promise<void> => persistPresets([...presets, preset]),
    [persistPresets, presets]
  )

  const handleDeletePreset = useCallback(
    (presetId: string): Promise<void> => persistPresets(presets.filter((preset) => preset.id !== presetId)),
    [persistPresets, presets]
  )

  const handleSaveModules = useCallback(
    async (nextModules: WorkflowCustomModuleV1[]): Promise<void> => {
      if (!settings) return
      const nextWorkflow = mergeWorkflowSettings(settings.workflow, { modules: nextModules })
      setSettings({ ...settings, workflow: nextWorkflow })
      const saved = await rendererRuntimeClient.setSettings({ workflow: nextWorkflow })
      setSettings(saved)
    },
    [settings]
  )

  const persist = useCallback(
    async (nextWorkflows: WorkflowV1[]): Promise<void> => {
      if (!settings) return
      const nextWorkflow = mergeWorkflowSettings(settings.workflow, { enabled: true, workflows: nextWorkflows })
      setSettings({ ...settings, workflow: nextWorkflow })
      const saved = await rendererRuntimeClient.setSettings({ workflow: nextWorkflow })
      setSettings(saved)
      void refreshStatus()
    },
    [refreshStatus, settings]
  )

  const [showHooks, setShowHooks] = useState(false)
  const persistHookTriggers = useCallback(
    async (next: WorkflowHookTriggerV1[]): Promise<void> => {
      if (!settings) return
      const nextWorkflow = mergeWorkflowSettings(settings.workflow, { hookTriggers: next })
      setSettings({ ...settings, workflow: nextWorkflow })
      const saved = await rendererRuntimeClient.setSettings({ workflow: nextWorkflow })
      setSettings(saved)
    },
    [settings]
  )

  const handleCreate = useCallback(async (): Promise<void> => {
    const created = createWorkflow(t('workflowUntitled'))
    await persist([...workflows, created])
    setEditingId(created.id)
  }, [persist, t, workflows])

  const importInputRef = useRef<HTMLInputElement | null>(null)

  const handleExport = useCallback((workflow: WorkflowV1): void => {
    const text = serializeWorkflowDsl(workflow, 'deepseek-gui', new Date().toISOString())
    const blob = new Blob([text], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${(workflow.name || 'workflow').replace(/[^\w.-]+/g, '_') || 'workflow'}.loop.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }, [])

  const handleImportFile = useCallback(
    async (file: File): Promise<void> => {
      const result = parseWorkflowDsl(await file.text(), new Date().toISOString())
      if (!result.ok) {
        setError(t(`workflowImportError_${result.error}`))
        return
      }
      const existing = new Set(workflows.map((workflow) => workflow.name))
      let name = result.workflow.name || t('workflowUntitled')
      if (existing.has(name)) {
        let suffix = 2
        while (existing.has(`${name} (${suffix})`)) suffix += 1
        name = `${name} (${suffix})`
      }
      const oldId = result.workflow.id
      const newId = `workflow-${crypto.randomUUID()}`
      // Re-point any self-referencing loop / subworkflow node from the old id to the new one.
      const nodes = result.workflow.nodes.map((node): WorkflowNodeV1 => {
        if (node.type === 'subworkflow' && node.config.workflowId === oldId) {
          return { ...node, config: { ...node.config, workflowId: newId } }
        }
        if (node.type === 'loop' && node.config.workflowId === oldId) {
          return { ...node, config: { ...node.config, workflowId: newId } }
        }
        return node
      })
      const imported: WorkflowV1 = { ...result.workflow, id: newId, name, nodes }
      setError(null)
      await persist([...workflows, imported])
      setEditingId(imported.id)
    },
    [persist, t, workflows]
  )

  const handleDelete = useCallback(
    async (id: string): Promise<void> => {
      if (!(await confirmDialog(t('workflowDeleteConfirm')))) return
      await persist(workflows.filter((workflow) => workflow.id !== id))
    },
    [persist, t, workflows]
  )

  const handleToggleEnabled = useCallback(
    async (id: string, enabled: boolean): Promise<void> => {
      await persist(
        workflows.map((workflow) =>
          workflow.id === id ? { ...workflow, enabled, updatedAt: new Date().toISOString() } : workflow
        )
      )
    },
    [persist, workflows]
  )

  const handleToggleCallable = useCallback(
    async (id: string, callableByAgent: boolean): Promise<void> => {
      await persist(
        workflows.map((workflow) =>
          workflow.id === id ? { ...workflow, callableByAgent, updatedAt: new Date().toISOString() } : workflow
        )
      )
    },
    [persist, workflows]
  )

  const handleRun = useCallback(
    async (id: string, input?: Record<string, unknown>): Promise<void> => {
      if (typeof window.kunGui?.runWorkflow !== 'function') return
      const result = await window.kunGui.runWorkflow(id, input)
      if (!result.ok) {
        setError(result.message)
        return
      }
      setError(null)
      void refreshStatus()
    },
    [refreshStatus]
  )

  // When a workflow's manual trigger defines a typed input schema, collect values first.
  const requestRun = useCallback(
    (workflow: WorkflowV1): void => {
      const trigger = workflow.nodes.find((node) => node.type === 'manual-trigger')
      const schema = trigger && trigger.type === 'manual-trigger' ? trigger.config.inputSchema ?? [] : []
      if (schema.length > 0) setRunInputTarget(workflow)
      else void handleRun(workflow.id)
    },
    [handleRun]
  )

  const handleStop = useCallback(
    async (id: string): Promise<void> => {
      if (typeof window.kunGui?.stopWorkflow !== 'function') return
      await window.kunGui.stopWorkflow(id)
      void refreshStatus()
    },
    [refreshStatus]
  )

  const handleRunNode = useCallback(
    async (workflowId: string, nodeId: string): Promise<void> => {
      if (typeof window.kunGui?.runWorkflowNode !== 'function') return
      const result = await window.kunGui.runWorkflowNode(workflowId, nodeId)
      if (!result.ok) {
        setError(result.message)
        return
      }
      setError(null)
      void refreshStatus()
    },
    [refreshStatus]
  )

  const handleEditorPersist = useCallback(
    async (patch: {
      name: string
      enabled: boolean
      env: WorkflowV1['env']
      nodes: WorkflowNodeV1[]
      connections: WorkflowV1['connections']
    }): Promise<void> => {
      if (!editingId) return
      await persist(
        workflows.map((workflow) =>
          workflow.id === editingId
            ? { ...workflow, ...patch, updatedAt: new Date().toISOString() }
            : workflow
        )
      )
    },
    [editingId, persist, workflows]
  )

  const editingWorkflow = editingId ? workflows.find((workflow) => workflow.id === editingId) ?? null : null

  if (editingWorkflow && settings) {
    const lastRun = editingWorkflow.runs[editingWorkflow.runs.length - 1]
    const lastResults: Record<string, WorkflowNodeRunResultV1> = {}
    if (lastRun) {
      for (const result of lastRun.nodeResults) lastResults[result.nodeId] = result
    }
    return (
      <>
        <WorkflowEditorView
          key={editingWorkflow.id}
          workflow={editingWorkflow}
          settings={settings}
          runStatus={status?.nodeStatus?.[editingWorkflow.id] ?? {}}
          lastResults={lastResults}
          liveResults={status?.nodeResults?.[editingWorkflow.id] ?? {}}
          running={runningIds.has(editingWorkflow.id)}
          onPersist={handleEditorPersist}
          onRun={() => requestRun(editingWorkflow)}
          onRunNode={(nodeId) => handleRunNode(editingWorkflow.id, nodeId)}
          onStop={() => handleStop(editingWorkflow.id)}
          onBack={() => setEditingId(null)}
          presets={presets}
          onSavePreset={handleSavePreset}
          onDeletePreset={handleDeletePreset}
          modules={modules}
          onSaveModules={handleSaveModules}
        />
        {runInputTarget ? (
          <RunInputDialog
            workflow={runInputTarget}
            onClose={() => setRunInputTarget(null)}
            onRun={(input) => {
              const id = runInputTarget.id
              setRunInputTarget(null)
              void handleRun(id, input)
            }}
          />
        ) : null}
      </>
    )
  }

  return (
    <div className="ds-drag flex h-full min-h-0 flex-col bg-ds-main">
      <div className="ds-stage-inset shrink-0">
        <header className="ds-topbar-surface relative z-10 mt-3 flex min-h-[46px] w-full items-stretch overflow-visible rounded-[24px]">
          <div className="grid w-full min-w-0 items-center gap-2.5 px-3 py-2 sm:px-4 md:pl-5 md:pr-2">
            <div
              className={`flex min-w-0 items-center gap-2.5 ${
                leftSidebarCollapsed ? 'ds-window-controls-collapsed-titlebar-inset' : ''
              }`}
            >
              <SidebarTitlebarToggleButton
                onClick={onToggleLeftSidebar}
                title={leftSidebarCollapsed ? t('sidebarExpand') : t('sidebarCollapse')}
                ariaLabel={leftSidebarCollapsed ? t('sidebarExpand') : t('sidebarCollapse')}
              />
              <h1 className="min-w-0 flex-1 truncate text-[15px] font-medium text-ds-muted">
                {t('workflow')}
              </h1>
            </div>
          </div>
        </header>
      </div>

      <main className="ds-no-drag min-h-0 flex-1 overflow-y-auto px-6 pb-8 pt-8">
        <div className="mx-auto flex w-full max-w-[880px] flex-col gap-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[14px] leading-6 text-ds-faint">{t('workflowSubtitle')}</p>
            <div className="flex items-center gap-2">
              <input
                ref={importInputRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (file) void handleImportFile(file)
                }}
              />
              <button
                type="button"
                onClick={() => setShowHooks(true)}
                className="inline-flex items-center gap-2 rounded-xl border border-ds-border bg-ds-card px-3.5 py-2 text-[13px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
              >
                <Zap className="h-4 w-4" strokeWidth={1.8} />
                {t('workflowHooks')}
              </button>
              <button
                type="button"
                onClick={() => importInputRef.current?.click()}
                className="inline-flex items-center gap-2 rounded-xl border border-ds-border bg-ds-card px-3.5 py-2 text-[13px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
              >
                <Upload className="h-4 w-4" strokeWidth={1.8} />
                {t('workflowImport')}
              </button>
              <button
                type="button"
                onClick={() => void handleCreate()}
                className="inline-flex items-center gap-2 rounded-xl bg-ds-userbubble px-4 py-2 text-[13px] font-semibold text-ds-userbubbleFg shadow-sm transition hover:opacity-90"
              >
                <Plus className="h-4 w-4" strokeWidth={2} />
                {t('workflowNew')}
              </button>
            </div>
          </div>

          {error ? (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-[13px] text-red-700 dark:text-red-200">
              {error}
            </div>
          ) : null}

          {loading ? (
            <p className="text-[13px] text-ds-faint">{t('loading')}</p>
          ) : workflows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-ds-border px-6 py-16 text-center">
              <WorkflowIcon className="h-8 w-8 text-ds-faint" strokeWidth={1.5} />
              <p className="text-[14px] font-medium text-ds-ink">{t('workflowEmpty')}</p>
              <p className="max-w-[360px] text-[13px] text-ds-faint">{t('workflowEmptyHint')}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {workflows.map((workflow) => {
                const running = runningIds.has(workflow.id)
                const lastStatus: WorkflowV1['lastStatus'] = running ? 'running' : workflow.lastStatus
                return (
                  <div
                    key={workflow.id}
                    className="flex flex-col gap-3 rounded-2xl border border-ds-border bg-ds-card px-4 py-3.5 shadow-sm"
                  >
                    {/* Title + status + the row's real actions (run / export / edit / delete). */}
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                            <WorkflowIcon className="h-4 w-4" strokeWidth={1.9} />
                          </span>
                          <h3 className="truncate text-[15px] font-semibold text-ds-ink">
                            {workflow.name || t('workflowUntitled')}
                          </h3>
                          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${statusTone(lastStatus)}`}>
                            {t(`workflowStatus_${lastStatus}`)}
                          </span>
                        </div>
                        <p className="mt-1 pl-9 text-[12px] text-ds-faint">
                          {t('workflowNodeCount', { count: workflow.nodes.length })} ·{' '}
                          {t('workflowLastRun')}: {formatDateTime(workflow.lastRunAt, t('workflowNeverRun'))}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={() => (running ? void handleStop(workflow.id) : requestRun(workflow))}
                          className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-semibold transition ${
                            running
                              ? 'bg-red-500/90 text-white hover:bg-red-500'
                              : 'bg-ds-userbubble text-ds-userbubbleFg shadow-sm hover:opacity-90'
                          }`}
                        >
                          {running ? <Square className="h-3.5 w-3.5" strokeWidth={2.2} /> : <Play className="h-3.5 w-3.5" strokeWidth={2} />}
                          {running ? t('workflowStop') : t('workflowRunNow')}
                        </button>
                        <span className="mx-0.5 h-5 w-px bg-ds-border" />
                        <button
                          type="button"
                          onClick={() => setEditingId(workflow.id)}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
                          title={t('workflowEdit')}
                          aria-label={t('workflowEdit')}
                        >
                          <Pencil className="h-4 w-4" strokeWidth={1.8} />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleExport(workflow)}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
                          title={t('workflowExport')}
                          aria-label={t('workflowExport')}
                        >
                          <Download className="h-4 w-4" strokeWidth={1.8} />
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDelete(workflow.id)}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ds-muted transition hover:bg-red-500/10 hover:text-red-600"
                          title={t('workflowDelete')}
                          aria-label={t('workflowDelete')}
                        >
                          <Trash2 className="h-4 w-4" strokeWidth={1.8} />
                        </button>
                      </div>
                    </div>

                    {workflow.lastMessage.trim() ? (
                      <p className="rounded-lg bg-ds-subtle px-3 py-2 text-[12.5px] text-ds-muted">
                        <span className="font-medium text-ds-faint">{t('workflowLastResult')}: </span>
                        {workflow.lastMessage.length > 240
                          ? `${workflow.lastMessage.slice(0, 240)}…`
                          : workflow.lastMessage}
                      </p>
                    ) : null}

                    {/* State switches — kept visually distinct from the actions above. */}
                    <div className="flex flex-wrap items-center gap-x-1 gap-y-1 border-t border-ds-border pt-2.5">
                      <WorkflowToggle
                        on={workflow.enabled}
                        onClick={() => void handleToggleEnabled(workflow.id, !workflow.enabled)}
                        label={t('workflowEnableShort')}
                        title={t('workflowEnableHint')}
                        icon={<Power className="h-3.5 w-3.5" strokeWidth={1.9} />}
                      />
                      <WorkflowToggle
                        on={workflow.callableByAgent}
                        disabled={!workflow.enabled}
                        onClick={() => void handleToggleCallable(workflow.id, !workflow.callableByAgent)}
                        label={t('workflowCallableShort')}
                        title={workflow.enabled ? t('workflowCallableHint') : t('workflowCallableNeedsEnable')}
                        icon={<Bot className="h-3.5 w-3.5" strokeWidth={1.9} />}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </main>

      {runInputTarget ? (
        <RunInputDialog
          workflow={runInputTarget}
          onClose={() => setRunInputTarget(null)}
          onRun={(input) => {
            const id = runInputTarget.id
            setRunInputTarget(null)
            void handleRun(id, input)
          }}
        />
      ) : null}

      {showHooks && settings ? (
        <WorkflowHookTriggers
          triggers={settings.workflow.hookTriggers}
          workflows={workflows}
          onChange={(next) => void persistHookTriggers(next)}
          onClose={() => setShowHooks(false)}
        />
      ) : null}
    </div>
  )
}

/** A labelled on/off switch for a workflow's state flags (enabled / AI-callable). */
