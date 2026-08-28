import {
  filterRemovedCodeWorkspaceRoots,
  isCodeWorkspaceRemoved,
  rememberRemovedCodeWorkspace,
  restoreRemovedCodeWorkspace,
  type RemovedCodeWorkspacesRegistry
} from '../lib/removed-code-workspaces'
import { normalizeWorkspaceRoot, workspaceRootIdentityKey } from '../lib/workspace-path'
import { workspaceLabelFromPath } from '../lib/workspace-label'
import { rendererRuntimeClient } from '../agent/runtime-client'
import { formatRuntimeError } from '../lib/format-runtime-error'
import type { NormalizedThread } from '../agent/types'
import type { ChatState, ChatStoreGet, ChatStoreSet } from './chat-store-types'
import {
  forgetCodeWorkspaceRoot,
  rememberCodeWorkspaceRoots,
  saveCodeWorkspaceRoots
} from './chat-store-helpers'
import { clearedThreadSelection } from './chat-store-runtime-helpers'
import { resolveProjectWorkspacePath } from '../lib/worktree-project-path'

/**
 * Sidebar project identity for a workspace path, resolved with the same
 * worktree→project mapping the sidebar uses for display. Worktree threads show
 * under their primary project, so hiding/removing a project must operate on
 * that project identity, not the raw thread workspace.
 */
export function resolvedProjectKeyForWorkspacePath(
  workspacePath: string,
  resolveToProject: (path: string) => string
): string {
  const normalized = normalizeWorkspaceRoot(workspacePath)
  if (!normalized) return ''
  const resolved = resolveToProject(normalized) || normalized
  return workspaceRootIdentityKey(resolved)
}

/** Raw workspace roots of threads whose resolved project key matches. */
export function threadWorkspaceAliasesForProject(options: {
  projectKey: string
  threads: readonly NormalizedThread[]
  resolveToProject: (path: string) => string
}): string[] {
  if (!options.projectKey) return []
  const aliases = new Set<string>()
  for (const thread of options.threads) {
    const workspace = normalizeWorkspaceRoot(thread.workspace ?? '')
    if (!workspace) continue
    if (resolvedProjectKeyForWorkspacePath(workspace, options.resolveToProject) === options.projectKey) {
      aliases.add(workspace)
    }
  }
  return [...aliases]
}

/** True when a thread's workspace resolves into the given project identity. */
export function threadAliasesContain(
  threadWorkspace: string | undefined,
  projectKey: string
): boolean {
  if (!projectKey) return false
  return resolvedProjectKeyForWorkspacePath(
    threadWorkspace ?? '',
    (path) => resolveProjectPathWithRegistry(path)
  ) === projectKey
}

/**
 * Registry-backed resolver shared by removal flows. It maps Kun worktree paths
 * to their primary project through the sidebar worktree registry and keeps any
 * other path as-is (the sidebar treats unknown paths as their own project).
 */
let sharedResolver: ((path: string) => string) | null = null

export function setSharedProjectResolver(
  resolve: (path: string) => string
): void {
  sharedResolver = resolve
}

export function resolveProjectPathWithRegistry(path: string): string {
  return sharedResolver ? sharedResolver(path) : path
}

/**
 * Resolve the project identity a removal targets. The sidebar passes the
 * display path; any thread/remembered-root alias that resolves to the same
 * identity must end up hidden together with it.
 */
export function resolveRemovedProjectKey(options: {
  projectPath: string
  relatedPaths: readonly string[]
  workspaceRoot: string
  workspaceRoots: readonly string[]
  threads: readonly NormalizedThread[]
}): string {
  const direct = resolvedProjectKeyForWorkspacePath(options.projectPath, resolveProjectPathWithRegistry)
  if (direct) return direct
  for (const candidate of [...options.relatedPaths, options.workspaceRoot, ...options.workspaceRoots]) {
    const key = resolvedProjectKeyForWorkspacePath(candidate, resolveProjectPathWithRegistry)
    if (key) return key
  }
  return ''
}

/**
 * Collect every stored/display alias of the project being removed: explicit
 * related paths from the sidebar, thread workspaces and remembered roots that
 * resolve to the same project identity.
 */
export function collectRemovedProjectAliases(options: {
  projectPath: string
  relatedPaths: readonly string[]
  workspaceRoot: string
  workspaceRoots: readonly string[]
  threads: readonly NormalizedThread[]
  projectKey: string
}): string[] {
  const aliases = new Set<string>()
  const addAlias = (value: string | undefined | null): void => {
    const normalized = normalizeWorkspaceRoot(value ?? '')
    if (!normalized) return
    if (resolvedProjectKeyForWorkspacePath(normalized, resolveProjectPathWithRegistry) !== options.projectKey) return
    aliases.add(normalized)
  }
  addAlias(options.projectPath)
  for (const path of options.relatedPaths) addAlias(path)
  for (const path of options.workspaceRoots) addAlias(path)
  addAlias(options.workspaceRoot)
  for (const thread of options.threads) addAlias(thread.workspace)
  return [...aliases]
}

export function removedRegistryAfterRemove(
  options: { projectPath: string; aliases: readonly (string | undefined | null)[] },
  registry: RemovedCodeWorkspacesRegistry
): RemovedCodeWorkspacesRegistry {
  return rememberRemovedCodeWorkspace(options, registry)
}

export function removedRegistryAfterRestore(
  projectPath: string,
  registry: RemovedCodeWorkspacesRegistry
): RemovedCodeWorkspacesRegistry {
  return restoreRemovedCodeWorkspace(projectPath, registry)
}

/** Remove every remembered root that now belongs to a removed project. */
export function codeRootsAfterRemoval(
  currentRoots: readonly string[],
  registry: RemovedCodeWorkspacesRegistry | null | undefined
): string[] {
  if (!registry) return [...currentRoots]
  return filterRemovedCodeWorkspaceRoots(currentRoots, registry)
}

/**
 * Preserved roots handed to `reconcileCodeWorkspaceRoots`. The currently
 * selected root keeps its normal protection unless the user removed that
 * project — otherwise the reconcile pass would re-add it on every refresh.
 */
export function preservedRootsForReconcile(
  state: { workspaceRoot: string },
  registry: RemovedCodeWorkspacesRegistry | null | undefined
): string[] {
  const current = normalizeWorkspaceRoot(state.workspaceRoot)
  if (!current) return []
  if (isCodeWorkspaceRemoved(current, registry)) return []
  return [current]
}

/**
 * Forget a single remembered root and persist. Used by removal bookkeeping so
 * `codeWorkspaceRoots` immediately reflects the removal.
 */
export function forgetRootForRemoval(
  currentRoots: readonly string[],
  workspacePath: string
): string[] {
  return forgetCodeWorkspaceRoot(currentRoots, workspacePath)
}

/** Restore a project into remembered roots and persist the merged list. */
export function rememberRootForRestore(
  currentRoots: readonly string[],
  workspacePath: string
): string[] {
  return rememberCodeWorkspaceRoots(currentRoots, [workspacePath])
}

export { isCodeWorkspaceRemoved, saveCodeWorkspaceRoots }

type RemoveActionDeps = {
  set: ChatStoreSet
  get: ChatStoreGet
  sseAbortRef: { current: AbortController | null }
  clearBusyWatchdog: () => void
}

/**
 * The store's `removeWorkspace` action. Hiding a project is local-only
 * bookkeeping (no runtime/threads deletion), so it also works while the
 * runtime is offline; only the optional settings sync needs the bridge.
 */
export function createRemoveWorkspaceAction(
  { set, get, sseAbortRef, clearBusyWatchdog }: RemoveActionDeps
): ChatState['removeWorkspace'] {
  return async (workspacePath, relatedPaths = []) => {
    const normalizedPath = normalizeWorkspaceRoot(workspacePath)
    if (!normalizedPath) return
    const state = get()
    // Resolve alias identity with the same mapping the sidebar uses: kun
    // worktree paths map to their primary project via the known candidates.
    const candidates = [state.workspaceRoot, ...state.codeWorkspaceRoots, ...relatedPaths]
      .map((path) => normalizeWorkspaceRoot(path ?? ''))
      .filter(Boolean)
    setSharedProjectResolver((path) =>
      resolveProjectWorkspacePath(path, { candidateProjectPaths: candidates })
    )
    const projectKey = resolveRemovedProjectKey({
      workspaceRoot: state.workspaceRoot,
      workspaceRoots: state.codeWorkspaceRoots,
      threads: state.threads,
      projectPath: normalizedPath,
      relatedPaths
    })
    const aliases = collectRemovedProjectAliases({
      projectPath: normalizedPath,
      relatedPaths,
      threads: state.threads,
      workspaceRoot: state.workspaceRoot,
      workspaceRoots: state.codeWorkspaceRoots,
      projectKey
    })
    const removedRegistry = removedRegistryAfterRemove(
      { projectPath: normalizedPath, aliases },
      state.removedCodeWorkspaces ?? { version: 1, removed: [] }
    )
    const activeThreadId = state.activeThreadId
    const activeThread = activeThreadId != null
      ? state.threads.find((thread) => thread.id === activeThreadId) ?? null
      : null
    const removingActiveProject =
      workspaceRootIdentityKey(normalizeWorkspaceRoot(state.workspaceRoot)) === projectKey ||
      (activeThread != null && threadAliasesContain(activeThread.workspace, projectKey))
    if (removingActiveProject) {
      sseAbortRef.current?.abort()
      sseAbortRef.current = null
      clearBusyWatchdog()
    }
    // Persist the durable hidden marker before any await: a failed settings
    // sync must still leave the project hidden instead of resurrecting it.
    const codeWorkspaceRoots = codeRootsAfterRemoval(state.codeWorkspaceRoots, removedRegistry)
    saveCodeWorkspaceRoots(codeWorkspaceRoots)
    set((s) => ({
      removedCodeWorkspaces: removedRegistry,
      codeWorkspaceRoots,
      ...(removingActiveProject ? clearedThreadSelection() : {}),
      error: null
    }))
    if (removingActiveProject && normalizeWorkspaceRoot(get().workspaceRoot)) {
      try {
        if (typeof window.kunGui?.setSettings === 'function') {
          const next = await rendererRuntimeClient.setSettings({ workspaceRoot: '' })
          set({
            workspaceRoot: normalizeWorkspaceRoot(next.workspaceRoot),
            workspaceLabel: workspaceLabelFromPath('')
          })
        }
      } catch (e) {
        // The local removal already persisted; surface the sync failure so the
        // stale persisted root is visible instead of silently re-adding it.
        set({ error: formatRuntimeError(e) })
      }
    }
  }
}
