import { describe, expect, it } from 'vitest'
import {
  createDesignWorkspaceFolder,
  deleteDesignWorkspaceFolder,
  designFolderDescendantIds,
  designFolderNameExists,
  normalizeDesignWorkspaceFolders,
  renameDesignWorkspaceFolder
} from './design-workspace-folders'

describe('design workspace folders', () => {
  it('supports nested folders and rejects a duplicate sibling name', () => {
    const root = createDesignWorkspaceFolder([], { id: 'root', name: 'Website' })
    const nested = createDesignWorkspaceFolder(root, { id: 'nested', name: 'Mobile', parentId: 'root' })

    expect(designFolderNameExists(nested, 'mobile', 'root')).toBe(true)
    expect(createDesignWorkspaceFolder(nested, { id: 'duplicate', name: 'Mobile', parentId: 'root' }))
      .toEqual(nested)
    expect(renameDesignWorkspaceFolder(nested, 'nested', 'Desktop')).toMatchObject([
      { id: 'root', name: 'Website', parentId: null },
      { id: 'nested', name: 'Desktop', parentId: 'root' }
    ])
  })

  it('promotes child folders to the deleted folder parent and makes sibling names unique', () => {
    const folders = [
      { id: 'parent', name: 'Product', parentId: null },
      { id: 'deleted', name: 'Landing', parentId: 'parent' },
      { id: 'child', name: 'Screens', parentId: 'deleted' },
      { id: 'existing', name: 'Screens', parentId: 'parent' }
    ]
    const deleted = deleteDesignWorkspaceFolder(folders, 'deleted')

    expect(deleted.parentId).toBe('parent')
    expect(deleted.folders).toContainEqual({ id: 'child', name: 'Screens (2)', parentId: 'parent' })
    expect(designFolderDescendantIds(folders, 'deleted')).toEqual(new Set(['deleted', 'child']))
  })

  it('repairs missing parents and cycles from a persisted index', () => {
    expect(normalizeDesignWorkspaceFolders([
      { id: 'a', name: 'A', parentId: 'b' },
      { id: 'b', name: 'B', parentId: 'a' },
      { id: 'lost', name: 'Lost', parentId: 'missing' }
    ])).toEqual([
      { id: 'a', name: 'A', parentId: null },
      { id: 'b', name: 'B', parentId: null },
      { id: 'lost', name: 'Lost', parentId: null }
    ])
  })
})
