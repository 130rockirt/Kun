import { readBrowserStorageItem, writeBrowserStorageItem } from '../../lib/browser-storage'
import {
  normalizeWorkspaceRoot,
  workspaceRootIdentityKey
} from '../../lib/workspace-path'

export const SIDEBAR_COLLAPSE_STORAGE_KEY = 'kun.sidebarCollapse.v1'

export type SidebarCollapseRegistry = {
  version: 1
  collapsedWorkspaceScopes: string[]
  collapsedFolderIdsByScope: Record<string, string[]>
}

export function emptySidebarCollapseRegistry(): SidebarCollapseRegistry {
  return {
    version: 1,
    collapsedWorkspaceScopes: [],
    collapsedFolderIdsByScope: {}
  }
}

function compactStrings(values: readonly unknown[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (typeof value !== 'string') continue
    const normalized = value.trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

export function sidebarCollapseWorkspaceScope(workspacePath: string): string {
  return workspaceRootIdentityKey(normalizeWorkspaceRoot(workspacePath))
}

function compactWorkspaceScopes(values: readonly unknown[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (typeof value !== 'string') continue
    const scope = sidebarCollapseWorkspaceScope(value)
    if (!scope || seen.has(scope)) continue
    seen.add(scope)
    result.push(scope)
  }
  return result
}

export function normalizeSidebarCollapseRegistry(value: unknown): SidebarCollapseRegistry {
  if (!value || typeof value !== 'object') return emptySidebarCollapseRegistry()
  const raw = value as Partial<SidebarCollapseRegistry>
  if (raw.version !== 1) return emptySidebarCollapseRegistry()

  const collapsedFolderIdsByScope: Record<string, string[]> = {}
  if (raw.collapsedFolderIdsByScope && typeof raw.collapsedFolderIdsByScope === 'object') {
    for (const [workspacePath, folderIds] of Object.entries(raw.collapsedFolderIdsByScope)) {
      const scope = sidebarCollapseWorkspaceScope(workspacePath)
      if (!scope || !Array.isArray(folderIds)) continue
      const compacted = compactStrings(folderIds)
      if (compacted.length === 0) continue
      collapsedFolderIdsByScope[scope] = compactStrings([
        ...(collapsedFolderIdsByScope[scope] ?? []),
        ...compacted
      ])
    }
  }

  return {
    version: 1,
    collapsedWorkspaceScopes: compactWorkspaceScopes(
      Array.isArray(raw.collapsedWorkspaceScopes) ? raw.collapsedWorkspaceScopes : []
    ),
    collapsedFolderIdsByScope
  }
}

export function readSidebarCollapseRegistry(): SidebarCollapseRegistry {
  try {
    const raw = readBrowserStorageItem(SIDEBAR_COLLAPSE_STORAGE_KEY)
    if (!raw) return emptySidebarCollapseRegistry()
    return normalizeSidebarCollapseRegistry(JSON.parse(raw))
  } catch {
    return emptySidebarCollapseRegistry()
  }
}

export function saveSidebarCollapseRegistry(registry: SidebarCollapseRegistry): void {
  writeBrowserStorageItem(
    SIDEBAR_COLLAPSE_STORAGE_KEY,
    JSON.stringify(normalizeSidebarCollapseRegistry(registry))
  )
}

export function isSidebarWorkspaceCollapsed(
  registry: SidebarCollapseRegistry,
  workspacePath: string
): boolean {
  const scope = sidebarCollapseWorkspaceScope(workspacePath)
  return Boolean(scope && normalizeSidebarCollapseRegistry(registry).collapsedWorkspaceScopes.includes(scope))
}

export function setSidebarWorkspaceCollapsed(
  registry: SidebarCollapseRegistry,
  workspacePath: string,
  collapsed: boolean
): SidebarCollapseRegistry {
  return setSidebarWorkspacesCollapsed(registry, [workspacePath], collapsed)
}

export function setSidebarWorkspacesCollapsed(
  registry: SidebarCollapseRegistry,
  workspacePaths: readonly string[],
  collapsed: boolean
): SidebarCollapseRegistry {
  const normalized = normalizeSidebarCollapseRegistry(registry)
  const targetScopes = new Set(compactWorkspaceScopes(workspacePaths))
  if (targetScopes.size === 0) return normalized

  const collapsedWorkspaceScopes = collapsed
    ? compactStrings([...normalized.collapsedWorkspaceScopes, ...targetScopes])
    : normalized.collapsedWorkspaceScopes.filter((scope) => !targetScopes.has(scope))
  return { ...normalized, collapsedWorkspaceScopes }
}

export function isSidebarFolderCollapsed(
  registry: SidebarCollapseRegistry,
  workspacePath: string,
  folderId: string
): boolean {
  const scope = sidebarCollapseWorkspaceScope(workspacePath)
  const normalizedId = folderId.trim()
  if (!scope || !normalizedId) return false
  return normalizeSidebarCollapseRegistry(registry)
    .collapsedFolderIdsByScope[scope]?.includes(normalizedId) === true
}

export function setSidebarFolderCollapsed(
  registry: SidebarCollapseRegistry,
  workspacePath: string,
  folderId: string,
  collapsed: boolean
): SidebarCollapseRegistry {
  const normalized = normalizeSidebarCollapseRegistry(registry)
  const scope = sidebarCollapseWorkspaceScope(workspacePath)
  const normalizedId = folderId.trim()
  if (!scope || !normalizedId) return normalized

  const collapsedFolderIdsByScope = { ...normalized.collapsedFolderIdsByScope }
  const currentIds = collapsedFolderIdsByScope[scope] ?? []
  const nextIds = collapsed
    ? compactStrings([...currentIds, normalizedId])
    : currentIds.filter((id) => id !== normalizedId)
  if (nextIds.length > 0) collapsedFolderIdsByScope[scope] = nextIds
  else delete collapsedFolderIdsByScope[scope]
  return { ...normalized, collapsedFolderIdsByScope }
}

export function removeSidebarFolderCollapse(
  registry: SidebarCollapseRegistry,
  workspacePath: string,
  folderId: string
): SidebarCollapseRegistry {
  return setSidebarFolderCollapsed(registry, workspacePath, folderId, false)
}
