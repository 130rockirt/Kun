import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import type { AppSettingsV1 } from '@shared/app-settings'
import { DEFAULT_GIT_BRANCH_PREFIX } from '@shared/app-settings'
import type { ChatBlock } from '../agent/types'
import { getProvider } from '../agent/registry'
import { rendererRuntimeClient } from '../agent/runtime-client'
import { useChatStore } from '../store/chat-store'
import type { SendMessageOverrides } from '../store/chat-store-types'
import { normalizeWorkspaceRoot } from '../lib/workspace-path'
import { emitRendererSettingsChanged } from '../lib/keyboard-shortcut-settings'
import { AutoPlanBuildDialog } from '../components/plan/AutoPlanBuildDialog'
import { GUI_PLAN_RELATIVE_DIR } from './plan-path'
import { buildDraftGuiPlanTurnOverrides } from '../components/workbench-plan-controller'
import { createGuiPlanArtifact, type GuiPlanArtifact } from './plan-store'
import { extractPlanMetadataFromBlock, type GuiPlanToolMeta } from './plan-tool'
import { preparePlanBuild } from './prepare-plan-build'
import { usePlanWorktreePreferenceStore } from './plan-worktree-preference-store'
import { useAutoPlanBuildSettingsState } from './use-auto-plan-build-settings'
import {
  activeAutoPlanBuildIntent,
  clearAutoPlanBuildIntents,
  createAutoPlanBuildIntent,
  listAutoPlanBuildIntents,
  patchAutoPlanBuildIntent,
  removeAutoPlanBuildIntent,
  saveAutoPlanBuildIntent,
  type AutoPlanBuildIntentV1,
  type AutoPlanBuildSelection
} from './auto-plan-build-intents'

type AutoPlanTurnOverrides = Pick<
  SendMessageOverrides,
  | 'attachmentIds'
  | 'agentSurface'
  | 'attachments'
  | 'displayText'
  | 'fileReferences'
  | 'model'
  | 'providerId'
  | 'reasoningEffort'
  | 'serviceTier'
> & { workspaceRoot?: string }

type PendingDialog = {
  text: string
  overrides?: AutoPlanTurnOverrides
  onStarted: () => void
  settings: AppSettingsV1
}

export type AutoPlanBuildRequestResult = 'started' | 'dialog' | 'rejected'
export type RequestAutoPlanBuild = (input: {
  text: string
  overrides?: AutoPlanTurnOverrides
  onStarted: () => void
}) => Promise<AutoPlanBuildRequestResult>

const dispatchingIntentIds = new Set<string>()

function normalizedPath(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+/g, '/').toLowerCase()
}

function planMetaMatchesIntent(meta: GuiPlanToolMeta, intent: AutoPlanBuildIntentV1): boolean {
  return normalizeWorkspaceRoot(meta.workspaceRoot) === normalizeWorkspaceRoot(intent.workspaceRoot) &&
    normalizedPath(meta.relativePath) === normalizedPath(intent.relativePath) &&
    meta.planId.trim().toLowerCase() === intent.planId.trim().toLowerCase()
}

function matchingSuccessfulPlan(
  blocks: readonly ChatBlock[],
  intent: AutoPlanBuildIntentV1
): GuiPlanToolMeta | null {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]
    if (block.kind !== 'tool' || block.status !== 'success') continue
    const meta = extractPlanMetadataFromBlock(block)
    if (meta && planMetaMatchesIntent(meta, intent)) return meta
  }
  return null
}

function pendingUserInput(blocks: readonly ChatBlock[]): boolean {
  return blocks.some((block) => block.kind === 'user_input' && block.status === 'pending')
}

async function existingPlanPaths(workspaceRoot: string): Promise<string[]> {
  try {
    const result = await window.kunGui.listWorkspaceDirectory({
      workspaceRoot,
      path: GUI_PLAN_RELATIVE_DIR
    })
    if (!result.ok) return []
    return result.entries
      .filter((entry) => entry.type === 'file' && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => `${GUI_PLAN_RELATIVE_DIR}/${entry.name}`)
  } catch {
    return []
  }
}

async function loadPlan(meta: GuiPlanToolMeta, threadId: string): Promise<{
  plan: GuiPlanArtifact
  content: string
}> {
  const result = await window.kunGui.readWorkspaceFile({
    workspaceRoot: meta.workspaceRoot,
    path: meta.relativePath
  })
  if (!result.ok) throw new Error(result.message)
  const base = createGuiPlanArtifact({
    workspaceRoot: meta.workspaceRoot,
    threadId,
    relativePath: meta.relativePath,
    absolutePath: meta.absolutePath ?? result.path,
    sourceRequest: meta.sourceRequest ?? ''
  })
  return {
    plan: meta.title?.trim() ? { ...base, featureName: meta.title.trim() } : base,
    content: result.content
  }
}

function scheduledTaskMatches(
  task: AppSettingsV1['schedule']['tasks'][number],
  intent: AutoPlanBuildIntentV1,
  prompt: string
): boolean {
  return Boolean(intent.scheduled) &&
    task.sourcePlanId === intent.planId &&
    task.sourceThreadId === intent.threadId &&
    task.schedule.kind === 'at' &&
    task.schedule.atTime === intent.scheduled?.schedule.atTime &&
    task.prompt === prompt
}

async function prepareIntentBuild(
  intent: AutoPlanBuildIntentV1,
  meta: GuiPlanToolMeta
): Promise<{ plan: GuiPlanArtifact; prompt: string; title: string; displayText: string }> {
  const loaded = await loadPlan(meta, intent.threadId)
  const preference = usePlanWorktreePreferenceStore.getState()
  preference.initializePlan(intent.planId, intent.useWorktree, DEFAULT_GIT_BRANCH_PREFIX)
  preference.setUsePromptWorktree(intent.planId, intent.useWorktree)
  const settings = await rendererRuntimeClient.getSettings()
  const prepared = await preparePlanBuild({
    plan: loaded.plan,
    content: loaded.content,
    orchestration: 'direct',
    graphEnabled: false,
    usePromptWorktree: intent.useWorktree,
    branchPrefix: settings.gitBranchPrefix || DEFAULT_GIT_BRANCH_PREFIX,
    activeThreadId: intent.threadId,
    save: async () => true,
    currentPlanId: () => loaded.plan.id,
    currentThreadId: () => intent.threadId,
    getGitBranches: window.kunGui.getGitBranches
  })
  return {
    plan: loaded.plan,
    prompt: prepared.prompt,
    title: prepared.title,
    displayText: prepared.prompt.includes('<prompt_managed_worktree_protocol>')
      ? `${loaded.plan.featureName} (${prepared.displayText.match(/\((.+)\)$/)?.[1] ?? ''})`
      : `Direct build: ${loaded.plan.relativePath}`
  }
}

async function dispatchIntent(
  intent: AutoPlanBuildIntentV1,
  meta: GuiPlanToolMeta
): Promise<void> {
  if (dispatchingIntentIds.has(intent.id)) return
  dispatchingIntentIds.add(intent.id)
  patchAutoPlanBuildIntent(intent.id, { status: 'dispatching', error: '' })
  try {
    if (intent.buildMode === 'scheduled') {
      const target = Date.parse(intent.scheduled?.schedule.atTime ?? '')
      if (!Number.isFinite(target) || target <= Date.now()) {
        throw new Error('The scheduled build time passed before planning finished. Choose a new time.')
      }
    }
    const prepared = await prepareIntentBuild(intent, meta)
    if (intent.buildMode === 'scheduled' && intent.scheduled) {
      const settings = await rendererRuntimeClient.getSettings({ forceRefresh: true })
      if (!settings.schedule.tasks.some((task) => scheduledTaskMatches(task, intent, prepared.prompt))) {
        const result = await window.kunGui.createScheduleTask({
          title: prepared.title,
          prompt: prepared.prompt,
          workspaceRoot: intent.workspaceRoot,
          sourcePlanId: intent.planId,
          sourceThreadId: intent.threadId,
          providerId: intent.scheduled.providerId,
          model: intent.scheduled.model,
          reasoningEffort: intent.scheduled.reasoningEffort,
          mode: 'agent',
          orchestration: 'direct',
          schedule: intent.scheduled.schedule
        })
        if (!result.ok) throw new Error(result.message)
      }
    } else {
      await getProvider().sendUserMessage(intent.threadId, prepared.prompt, {
        clientRequestId: intent.buildClientRequestId,
        mode: 'agent',
        orchestration: 'direct',
        displayText: prepared.displayText,
        agentSurface: 'code'
      })
    }
    removeAutoPlanBuildIntent(intent.id)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    patchAutoPlanBuildIntent(intent.id, { status: 'needs_attention', error: message })
    if (useChatStore.getState().activeThreadId === intent.threadId) {
      useChatStore.getState().setError(message)
    }
  } finally {
    dispatchingIntentIds.delete(intent.id)
  }
}

async function reconcileIntent(intent: AutoPlanBuildIntentV1): Promise<void> {
  if (!intent.threadId || dispatchingIntentIds.has(intent.id)) return
  const detail = await getProvider().getThreadDetail(intent.threadId)
  if (pendingUserInput(detail.blocks) || detail.latestTurnStatus === 'running' || detail.threadStatus === 'running') {
    return
  }
  const meta = matchingSuccessfulPlan(detail.blocks, intent)
  if (meta) {
    await dispatchIntent(intent, meta)
    return
  }
  if (intent.status === 'dispatching' || detail.latestTurnStatus) {
    const error = 'Automatic build recovery could not prove a matching successful plan result.'
    patchAutoPlanBuildIntent(intent.id, {
      status: 'needs_attention',
      error
    })
    if (useChatStore.getState().activeThreadId === intent.threadId) {
      useChatStore.getState().setError(error)
    }
  }
}

export function useAutoPlanBuildController({
  workspaceRoot,
  sendPlanTurn,
  setError
}: {
  workspaceRoot: string
  sendPlanTurn: (
    text: string,
    overrides?: AutoPlanTurnOverrides & {
      clientRequestId?: string
      guiPlan?: SendMessageOverrides['guiPlan']
      waitForRuntimeAdmission?: boolean
    }
  ) => Promise<boolean>
  setError: (message: string) => void
}): {
  requestAutoPlanBuild: RequestAutoPlanBuild
  dialog: ReactElement | null
  enabled: boolean
} {
  const autoSettingsState = useAutoPlanBuildSettingsState()
  const defaults = autoSettingsState.value
  const [pendingDialog, setPendingDialog] = useState<PendingDialog | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [dialogError, setDialogError] = useState('')
  const threadSignature = useChatStore((state) => state.threads
    .map((thread) => `${thread.id}:${thread.status ?? ''}:${thread.updatedAt}`)
    .join('|'))
  const activeBlocks = useChatStore((state) => state.blocks)
  const activeThreadId = useChatStore((state) => state.activeThreadId)
  const runtimeConnection = useChatStore((state) => state.runtimeConnection)

  useEffect(() => {
    if (!autoSettingsState.loaded || defaults.enabled) return
    clearAutoPlanBuildIntents()
    setPendingDialog(null)
    if (useChatStore.getState().composerMode === 'auto') {
      useChatStore.getState().setComposerMode('agent')
    }
  }, [autoSettingsState.loaded, defaults.enabled])

  useEffect(() => {
    if (!autoSettingsState.loaded || !defaults.enabled || runtimeConnection !== 'ready') return
    for (const intent of listAutoPlanBuildIntents()) {
      if (intent.status === 'needs_attention') continue
      void reconcileIntent(intent).catch((error) => {
        patchAutoPlanBuildIntent(intent.id, {
          status: 'needs_attention',
          error: error instanceof Error ? error.message : String(error)
        })
      })
    }
  }, [activeBlocks, autoSettingsState.loaded, defaults.enabled, runtimeConnection, threadSignature])

  useEffect(() => {
    if (!activeThreadId) return
    const attention = activeAutoPlanBuildIntent(activeThreadId)
    if (attention?.status === 'needs_attention' && attention.error) setError(attention.error)
  }, [activeBlocks, activeThreadId, setError, threadSignature])

  const start = useCallback(async (
    pending: Omit<PendingDialog, 'settings'>,
    selection: AutoPlanBuildSelection
  ): Promise<boolean> => {
    const state = useChatStore.getState()
    const targetWorkspace = normalizeWorkspaceRoot(
      pending.overrides?.workspaceRoot ||
      state.threads.find((thread) => thread.id === state.activeThreadId)?.workspace ||
      state.workspaceRoot ||
      workspaceRoot
    )
    if (!targetWorkspace) {
      setError('A workspace is required to start Automatic plan build.')
      return false
    }
    if (state.activeThreadId) {
      const existing = activeAutoPlanBuildIntent(state.activeThreadId)
      if (existing?.status === 'needs_attention') removeAutoPlanBuildIntent(existing.id)
      else if (existing) {
        setError('This task already has an Automatic plan build waiting to finish.')
        return false
      }
    }
    const draft = buildDraftGuiPlanTurnOverrides({
      request: pending.text,
      workspaceRoot: targetWorkspace,
      activeThreadId: state.activeThreadId,
      existingRelativePaths: await existingPlanPaths(targetWorkspace)
    })
    const intent = createAutoPlanBuildIntent({
      planId: draft.guiPlan.planId,
      relativePath: draft.guiPlan.relativePath,
      workspaceRoot: targetWorkspace,
      threadId: state.activeThreadId,
      selection
    })
    if (!saveAutoPlanBuildIntent(intent)) {
      setError('Automatic plan build could not persist its recovery intent.')
      return false
    }
    const sent = await sendPlanTurn(pending.text, {
      ...pending.overrides,
      workspaceRoot: targetWorkspace,
      guiPlan: draft.guiPlan,
      clientRequestId: intent.planClientRequestId,
      waitForRuntimeAdmission: true
    })
    if (!sent) {
      removeAutoPlanBuildIntent(intent.id)
      return false
    }
    const threadId = useChatStore.getState().activeThreadId?.trim() ?? ''
    if (!threadId) {
      patchAutoPlanBuildIntent(intent.id, {
        status: 'needs_attention',
        error: 'Automatic plan turn was accepted without a task identity.'
      })
      return false
    }
    patchAutoPlanBuildIntent(intent.id, { threadId, status: 'planning', error: '' })
    pending.onStarted()
    return true
  }, [sendPlanTurn, setError, workspaceRoot])

  const requestAutoPlanBuild = useCallback(async (input: {
    text: string
    overrides?: AutoPlanTurnOverrides
    onStarted: () => void
  }): Promise<AutoPlanBuildRequestResult> => {
    const settings = await rendererRuntimeClient.getSettings({ forceRefresh: true })
    const current = settings.agents.kun.lab.autoPlanBuild
    if (!current.enabled) {
      setError('Automatic plan build is disabled in Laboratory settings.')
      return 'rejected'
    }
    if (current.confirmation === 'defaults' && current.defaultBuildMode === 'direct') {
      return await start(input, {
        buildMode: 'direct',
        useWorktree: current.useWorktreeByDefault
      }) ? 'started' : 'rejected'
    }
    setDialogError('')
    setPendingDialog({ ...input, settings })
    return 'dialog'
  }, [setError, start])

  const submitDialog = useCallback(async (
    selection: AutoPlanBuildSelection,
    saveAsDefault: boolean
  ): Promise<void> => {
    if (!pendingDialog) return
    setSubmitting(true)
    setDialogError('')
    try {
      if (saveAsDefault) {
        const saved = await rendererRuntimeClient.setSettings({
          agents: {
            kun: {
              lab: {
                autoPlanBuild: {
                  confirmation: 'defaults',
                  defaultBuildMode: selection.buildMode,
                  useWorktreeByDefault: selection.useWorktree,
                  ...(selection.scheduled
                    ? {
                        scheduledDefaults: {
                          providerId: selection.scheduled.providerId,
                          model: selection.scheduled.model,
                          reasoningEffort: selection.scheduled.reasoningEffort,
                          timeZone: selection.scheduled.schedule.timeZone
                        }
                      }
                    : {})
                }
              }
            }
          }
        })
        emitRendererSettingsChanged(saved)
      }
      const started = await start(pendingDialog, selection)
      if (started) setPendingDialog(null)
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }, [pendingDialog, start])

  const dialog = useMemo(() => pendingDialog ? (
    <AutoPlanBuildDialog
      settings={pendingDialog.settings}
      defaults={pendingDialog.settings.agents.kun.lab.autoPlanBuild}
      submitting={submitting}
      error={dialogError}
      onClose={() => { if (!submitting) setPendingDialog(null) }}
      onSubmit={submitDialog}
    />
  ) : null, [dialogError, pendingDialog, submitDialog, submitting])

  return {
    requestAutoPlanBuild,
    dialog,
    enabled: autoSettingsState.loaded && defaults.enabled
  }
}

export const autoPlanBuildControllerTestApi = {
  dispatchIntent,
  matchingSuccessfulPlan,
  planMetaMatchesIntent,
  reconcileIntent,
  scheduledTaskMatches
}
