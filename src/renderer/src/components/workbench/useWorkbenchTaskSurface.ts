import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { NormalizedThread } from '../../agent/types'
import type { DesignTaskProfile } from '../../agent/design-task-profile'
import type { ChatState } from '../../store/chat-store-types'
import { useChatStore } from '../../store/chat-store'
import {
  type ComposerTaskSurface,
  type DesignTaskComposerProfile
} from '../chat/FloatingComposerTaskProfile'
import { useDesignWorkspaceStore } from '../../design/design-workspace-store'
import { designContextFromTaskProfile } from '../../design/design-task-profile-input'
import { useCodeCanvasDesignSurface } from '../../design/code-canvas-design-surface'
import { requestCodeCanvasPanelOpen } from '../../lib/code-canvas-panel-event'
import { normalizeWorkspaceRoot } from '../../lib/workspace-path'
import { isDesignThreadId, readDesignThreadRegistry } from '../../design/design-thread-registry'
import {
  useWorkbenchTaskIntent,
  hasWorkbenchTaskIntent,
  workbenchTaskIntentScope,
  writeWorkbenchTaskIntent,
  type WorkbenchTaskIntentDraft
} from './workbench-task-intent'

type ThreadWithDesignProfile = NormalizedThread & { designProfile?: DesignTaskProfile }

export function workbenchDesignProfileIsLocked(
  thread: Pick<NormalizedThread, 'designProfile'> | null
): boolean {
  return Boolean(thread?.designProfile)
}

export function workbenchTaskSurfaceIsLocked(
  thread: Pick<
    NormalizedThread,
    'agentSurface' | 'designProfile' | 'latestTurnId' | 'lockedTaskSurface'
  > | null
): boolean {
  return Boolean(
    thread?.lockedTaskSurface ||
    thread?.latestTurnId ||
    thread?.designProfile ||
    thread?.agentSurface === 'design'
  )
}

export function useWorkbenchTaskSurface(input: {
  activeThreadId: string | null
  threads: NormalizedThread[]
  workspaceRoot: string
  activeSkillWorkspace: string
  createThread: ChatState['createThread']
  deleteThread: ChatState['deleteThread']
  setComposerMode: ChatState['setComposerMode']
  setComposerOrchestration: ChatState['setComposerOrchestration']
  composerMode?: ChatState['composerMode']
  composerOrchestration?: ChatState['composerOrchestration']
  imageGenerationEnabled?: boolean
}) {
  const draftWorkspace = normalizeWorkspaceRoot(input.activeSkillWorkspace || input.workspaceRoot)
  const provisionalDesignThreadIdsRef = useRef(new Set<string>())
  const ensuredDesignTaskIdRef = useRef<string | null>(null)
  const restoreGenerationRef = useRef(0)
  const activeThread = useMemo<ThreadWithDesignProfile | null>(() => (
    input.activeThreadId
      ? (input.threads.find((thread) => thread.id === input.activeThreadId) as ThreadWithDesignProfile | undefined) ?? null
      : null
  ), [input.activeThreadId, input.threads])
  const lockedProfile = activeThread?.designProfile
  const taskSurfaceLocked = workbenchTaskSurfaceIsLocked(activeThread)
  const draftScope = workbenchTaskIntentScope(activeThread?.id ?? null, draftWorkspace)
  const draft = useWorkbenchTaskIntent(draftScope, draftWorkspace)
  const draftNeedsImageFallback =
    !taskSurfaceLocked &&
    !lockedProfile &&
    input.imageGenerationEnabled === false &&
    draft.profile.outputMedium === 'image'
  const effectiveDraft = useMemo<WorkbenchTaskIntentDraft>(() => (
    draftNeedsImageFallback
      ? { ...draft, profile: { ...draft.profile, outputMedium: 'html' } }
      : draft
  ), [draft, draftNeedsImageFallback])
  const hasPersistedDraft = hasWorkbenchTaskIntent(draftScope)
  const legacyDesignThread = Boolean(activeThread && (
    activeThread.agentSurface === 'design' ||
    isDesignThreadId(activeThread.id, readDesignThreadRegistry())
  ))
  const taskSurface: ComposerTaskSurface = legacyDesignThread
    ? 'design'
    : activeThread?.lockedTaskSurface === 'design'
      ? 'design'
      : activeThread?.lockedTaskSurface === 'code'
        ? 'code'
        : lockedProfile
          ? 'design'
          : activeThread?.latestTurnId
            ? 'code'
            : hasPersistedDraft
              ? effectiveDraft.surface
              : 'code'
  const profile: DesignTaskComposerProfile = lockedProfile
      ? {
        outputMedium: lockedProfile.outputMedium,
        target: lockedProfile.target,
        preset: lockedProfile.preset,
        ...(lockedProfile.presetSource ? { presetSource: lockedProfile.presetSource } : {}),
        ...(lockedProfile.styleSnapshot
          ? {
              styleSourceName: lockedProfile.styleSnapshot.sourceName,
              styleSourceHash: lockedProfile.styleSnapshot.sourceHash
            }
          : {})
      }
    : effectiveDraft.profile
  const designProfileLocked = workbenchDesignProfileIsLocked(activeThread)
  const lockedProfileRef = useRef(lockedProfile)
  lockedProfileRef.current = lockedProfile
  const restoreDesignDocumentId = lockedProfile?.documentTarget.documentId ?? ''
  const restoreDesignTaskId = !legacyDesignThread && restoreDesignDocumentId
    ? activeThread?.id ?? ''
    : ''
  const restoreDesignWorkspace = normalizeWorkspaceRoot(activeThread?.workspace || input.workspaceRoot)

  useEffect(() => {
    if (taskSurface === 'code') useDesignWorkspaceStore.getState().cancelDrawingCreation()
  }, [taskSurface])

  useEffect(() => {
    if (taskSurface !== 'design' || !restoreDesignTaskId || !restoreDesignDocumentId) return
    const surface = useCodeCanvasDesignSurface.getState().surface
    if (
      surface?.threadId === restoreDesignTaskId &&
      surface.documentId === restoreDesignDocumentId &&
      surface.readOnly !== true
    ) return
    useCodeCanvasDesignSurface.getState().showDesignDocument(
      restoreDesignTaskId,
      restoreDesignWorkspace,
      restoreDesignDocumentId
    )
  }, [restoreDesignDocumentId, restoreDesignTaskId, restoreDesignWorkspace, taskSurface])

  useEffect(() => {
    const generation = ++restoreGenerationRef.current
    const targetIsCurrent = (): boolean => generation === restoreGenerationRef.current
    const profileToRestore = lockedProfileRef.current
    if (!restoreDesignTaskId || !restoreDesignDocumentId || !profileToRestore) {
      if (!legacyDesignThread) ensuredDesignTaskIdRef.current = null
      return
    }
    provisionalDesignThreadIdsRef.current.delete(restoreDesignTaskId)
    if (ensuredDesignTaskIdRef.current === restoreDesignTaskId) return
    ensuredDesignTaskIdRef.current = restoreDesignTaskId
    const workspace = restoreDesignWorkspace
    if (!workspace) return
    useCodeCanvasDesignSurface.getState().showDesignDocument(
      restoreDesignTaskId,
      workspace,
      restoreDesignDocumentId
    )
    const store = useDesignWorkspaceStore.getState()
    const restoreProfileExecutionContext = (): void => {
      if (!targetIsCurrent()) return
      const restored = useDesignWorkspaceStore.getState()
      restored.updateDesignContext(designContextFromTaskProfile(profileToRestore))
      if (restored.documents.some(
        (document) => document.id === restoreDesignDocumentId
      )) {
        restored.switchActiveDocument(restoreDesignDocumentId)
      }
    }
    restoreProfileExecutionContext()
    if (normalizeWorkspaceRoot(store.workspaceRoot) !== workspace) {
      store.setWorkspaceRoot(workspace)
      restoreProfileExecutionContext()
      void useDesignWorkspaceStore.getState().loadDesignSettings().then(
        () => { if (targetIsCurrent()) restoreProfileExecutionContext() }
      )
    } else if (store.documents.some((document) => document.id === restoreDesignDocumentId)) {
      restoreProfileExecutionContext()
    } else {
      void store.rehydrateArtifacts().then(() => {
        if (targetIsCurrent()) restoreProfileExecutionContext()
      })
    }
    requestCodeCanvasPanelOpen()
  }, [
    legacyDesignThread,
    restoreDesignDocumentId,
    restoreDesignTaskId,
    restoreDesignWorkspace
  ])

  const updateDraft = useCallback((next: WorkbenchTaskIntentDraft): void => {
    writeWorkbenchTaskIntent(draftScope, next)
  }, [draftScope])

  useEffect(() => {
    if (draftNeedsImageFallback) updateDraft(effectiveDraft)
  }, [draftNeedsImageFallback, effectiveDraft, updateDraft])

  const onSurfaceChange = useCallback((surface: ComposerTaskSurface): void => {
    if (taskSurfaceLocked || surface === taskSurface) return
    const next = surface === 'design'
      ? {
          ...effectiveDraft,
          surface,
          codeExecution: effectiveDraft.codeExecution ?? {
            mode: input.composerMode ?? 'agent',
            orchestration: input.composerOrchestration ?? 'direct'
          }
        }
      : { ...effectiveDraft, surface }
    updateDraft(next)
    if (surface === 'design') {
      input.setComposerMode('agent')
      input.setComposerOrchestration('direct')
      const workspace = normalizeWorkspaceRoot(draftWorkspace)
      if (!workspace) return
      const store = useDesignWorkspaceStore.getState()
      if (normalizeWorkspaceRoot(store.workspaceRoot) !== workspace) store.setWorkspaceRoot(workspace)
      void useDesignWorkspaceStore.getState().loadDesignSettings().then(() => {
        useDesignWorkspaceStore.getState().updateDesignContext({
          designTarget: next.profile.target,
          designSystemPreset: next.profile.preset
        })
      })
    } else {
      const codeExecution = next.codeExecution
      if (codeExecution?.mode && codeExecution.orchestration) {
        input.setComposerMode(codeExecution.mode)
        input.setComposerOrchestration(codeExecution.orchestration)
      }
      useDesignWorkspaceStore.getState().cancelDrawingCreation()
    }
  }, [draftWorkspace, effectiveDraft, input, taskSurface, taskSurfaceLocked, updateDraft])

  const onProfileChange = useCallback((patch: Partial<DesignTaskComposerProfile>): void => {
    if (taskSurfaceLocked) return
    const nextProfile = { ...effectiveDraft.profile, ...patch }
    updateDraft({ ...effectiveDraft, profile: nextProfile })
    useDesignWorkspaceStore.getState().updateDesignContext({
      designTarget: nextProfile.target,
      designSystemPreset: nextProfile.preset
    })
  }, [effectiveDraft, taskSurfaceLocked, updateDraft])

  const ensureDesignThread = useCallback(async (
    workspaceRoot: string,
    documentId: string
  ): Promise<string | null> => {
    const stateThreadId = input.activeThreadId
    const stateThread = stateThreadId
      ? input.threads.find((thread) => thread.id === stateThreadId)
      : null
    const stateThreadIsLegacyDesign = Boolean(stateThread && (
      stateThread.agentSurface === 'design' ||
      isDesignThreadId(stateThread.id, readDesignThreadRegistry())
    ))
    let threadId =
      stateThread && !stateThreadIsLegacyDesign && stateThread.agentSurface !== 'write' &&
      normalizeWorkspaceRoot(stateThread.workspace) === normalizeWorkspaceRoot(workspaceRoot)
        ? stateThread.id
        : null
    if (!threadId) {
      threadId = await input.createThread({
        workspaceRoot,
        forceNew: true,
        agentSurface: 'code'
      })
      if (threadId) {
        provisionalDesignThreadIdsRef.current.add(threadId)
        writeWorkbenchTaskIntent(workbenchTaskIntentScope(threadId, workspaceRoot), {
          surface: 'design',
          profile: effectiveDraft.profile
        })
      }
    }
    if (!threadId) return null
    const shouldOpenPanel = ensuredDesignTaskIdRef.current !== threadId
    ensuredDesignTaskIdRef.current = threadId
    useCodeCanvasDesignSurface.getState().showDesignDocument(threadId, workspaceRoot, documentId)
    if (shouldOpenPanel) requestCodeCanvasPanelOpen()
    return threadId
  }, [effectiveDraft.profile, input])

  const rollbackProvisionalThread = useCallback(async (threadId: string): Promise<boolean> => {
    if (!provisionalDesignThreadIdsRef.current.has(threadId)) return true
    const thread = useChatStore.getState().threads.find((candidate) => candidate.id === threadId) ??
      input.threads.find((candidate) => candidate.id === threadId)
    if (thread?.latestTurnId || thread?.designProfile) {
      provisionalDesignThreadIdsRef.current.delete(threadId)
      return false
    }
    try {
      await input.deleteThread(threadId)
      provisionalDesignThreadIdsRef.current.delete(threadId)
      return true
    } catch {
      return false
    }
  }, [input])

  return {
    taskSurface,
    taskSurfaceTransitioning: legacyDesignThread,
    taskSurfaceLocked,
    designProfileLocked,
    designTaskProfile: profile,
    lockedDesignProfile: lockedProfile,
    onTaskSurfaceChange: onSurfaceChange,
    onDesignTaskProfileChange: onProfileChange,
    ensureDesignThread,
    rollbackProvisionalThread
  }
}
