import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SIDEBAR_COLLAPSE_STORAGE_KEY,
  emptySidebarCollapseRegistry,
  isSidebarFolderCollapsed,
  isSidebarWorkspaceCollapsed,
  normalizeSidebarCollapseRegistry,
  readSidebarCollapseRegistry,
  removeSidebarFolderCollapse,
  saveSidebarCollapseRegistry,
  setSidebarFolderCollapsed,
  setSidebarWorkspaceCollapsed,
  setSidebarWorkspacesCollapsed
} from './sidebar-collapse'

function createMemoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => items.delete(key),
    setItem: (key, value) => items.set(key, value)
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sidebar collapse registry', () => {
  it('falls back to an empty registry for missing, malformed, or unsupported storage', () => {
    const storage = createMemoryStorage()
    vi.stubGlobal('localStorage', storage)

    expect(readSidebarCollapseRegistry()).toEqual(emptySidebarCollapseRegistry())
    storage.setItem(SIDEBAR_COLLAPSE_STORAGE_KEY, '{not-json')
    expect(readSidebarCollapseRegistry()).toEqual(emptySidebarCollapseRegistry())
    expect(normalizeSidebarCollapseRegistry({
      version: 2,
      collapsedWorkspaceScopes: ['/tmp/app']
    })).toEqual(emptySidebarCollapseRegistry())
  })

  it('persists workspace collapse and removes the marker when expanded', () => {
    const storage = createMemoryStorage()
    vi.stubGlobal('localStorage', storage)

    let registry = setSidebarWorkspaceCollapsed(readSidebarCollapseRegistry(), '/Users/zxy/App/', true)
    saveSidebarCollapseRegistry(registry)

    expect(isSidebarWorkspaceCollapsed(readSidebarCollapseRegistry(), '/users/zxy/app')).toBe(true)

    registry = setSidebarWorkspaceCollapsed(readSidebarCollapseRegistry(), '/Users/zxy/App', false)
    saveSidebarCollapseRegistry(registry)

    expect(isSidebarWorkspaceCollapsed(readSidebarCollapseRegistry(), '/users/zxy/app')).toBe(false)
    expect(JSON.parse(storage.getItem(SIDEBAR_COLLAPSE_STORAGE_KEY) ?? '{}'))
      .toMatchObject({ collapsedWorkspaceScopes: [] })
  })

  it('normalizes and deduplicates workspace scopes', () => {
    expect(normalizeSidebarCollapseRegistry({
      version: 1,
      collapsedWorkspaceScopes: [
        '/Users/zxy/App/',
        '/users/zxy/app',
        '~/.deepseekgui/default_workspace',
        '/Users/zxy/.kun/default_workspace'
      ],
      collapsedFolderIdsByScope: {}
    }).collapsedWorkspaceScopes).toEqual([
      '/users/zxy/app',
      '~/.kun/default_workspace'
    ])
  })

  it('isolates collapsed folders by workspace and supports expand and cleanup', () => {
    let registry = setSidebarFolderCollapsed(
      emptySidebarCollapseRegistry(),
      '/Users/zxy/project-a',
      'shared-folder-id',
      true
    )

    expect(isSidebarFolderCollapsed(registry, '/Users/zxy/project-a', 'shared-folder-id')).toBe(true)
    expect(isSidebarFolderCollapsed(registry, '/Users/zxy/project-b', 'shared-folder-id')).toBe(false)

    registry = setSidebarFolderCollapsed(registry, '/Users/zxy/project-b', 'shared-folder-id', true)
    registry = setSidebarFolderCollapsed(registry, '/Users/zxy/project-a', 'shared-folder-id', false)
    expect(isSidebarFolderCollapsed(registry, '/Users/zxy/project-a', 'shared-folder-id')).toBe(false)
    expect(isSidebarFolderCollapsed(registry, '/Users/zxy/project-b', 'shared-folder-id')).toBe(true)

    registry = removeSidebarFolderCollapse(registry, '/Users/zxy/project-b', 'shared-folder-id')
    expect(registry.collapsedFolderIdsByScope).toEqual({})
  })

  it('batch updates only the supplied workspaces', () => {
    let registry = setSidebarWorkspacesCollapsed(
      emptySidebarCollapseRegistry(),
      ['/Users/zxy/project-a', '/Users/zxy/project-b'],
      true
    )
    registry = setSidebarWorkspaceCollapsed(registry, '/Users/zxy/hidden', true)
    registry = setSidebarWorkspacesCollapsed(
      registry,
      ['/Users/zxy/project-a', '/Users/zxy/project-b'],
      false
    )

    expect(isSidebarWorkspaceCollapsed(registry, '/Users/zxy/project-a')).toBe(false)
    expect(isSidebarWorkspaceCollapsed(registry, '/Users/zxy/project-b')).toBe(false)
    expect(isSidebarWorkspaceCollapsed(registry, '/Users/zxy/hidden')).toBe(true)
  })
})
