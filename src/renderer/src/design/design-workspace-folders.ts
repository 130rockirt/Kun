import type { DesignWorkspaceFolder } from './design-types'

const MAX_FOLDER_NAME_LENGTH = 120

function normalizedName(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_FOLDER_NAME_LENGTH) : ''
}

function normalizedId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function folderNamesEqual(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0
}

function hasParentCycle(
  id: string,
  parentId: string | null,
  foldersById: ReadonlyMap<string, DesignWorkspaceFolder>
): boolean {
  const visited = new Set<string>([id])
  let current = parentId
  while (current) {
    if (visited.has(current)) return true
    visited.add(current)
    current = foldersById.get(current)?.parentId ?? null
  }
  return false
}

/** Tolerantly parse and repair persisted logical folders. */
export function normalizeDesignWorkspaceFolders(value: unknown): DesignWorkspaceFolder[] {
  if (!Array.isArray(value)) return []
  const folders: DesignWorkspaceFolder[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const candidate = entry as Partial<DesignWorkspaceFolder>
    const id = normalizedId(candidate.id)
    const name = normalizedName(candidate.name)
    if (!id || !name || seen.has(id)) continue
    seen.add(id)
    folders.push({
      id,
      name,
      parentId: normalizedId(candidate.parentId) || null
    })
  }
  const foldersById = new Map(folders.map((folder) => [folder.id, folder] as const))
  return folders.map((folder) => {
    const parentId = folder.parentId && foldersById.has(folder.parentId) &&
      !hasParentCycle(folder.id, folder.parentId, foldersById)
      ? folder.parentId
      : null
    return parentId === folder.parentId ? folder : { ...folder, parentId }
  })
}

export function createDesignWorkspaceFolderId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().slice(0, 8)
  }
  return Math.random().toString(36).slice(2, 10)
}

export function designChildFolders(
  folders: readonly DesignWorkspaceFolder[],
  parentId: string | null
): DesignWorkspaceFolder[] {
  return folders.filter((folder) => folder.parentId === parentId)
}

export function designFolderNameExists(
  folders: readonly DesignWorkspaceFolder[],
  name: string,
  parentId: string | null,
  excludingFolderId?: string
): boolean {
  const target = normalizedName(name)
  if (!target) return false
  return folders.some((folder) =>
    folder.id !== excludingFolderId &&
    folder.parentId === parentId &&
    folderNamesEqual(folder.name, target)
  )
}

export function createDesignWorkspaceFolder(
  folders: readonly DesignWorkspaceFolder[],
  input: Pick<DesignWorkspaceFolder, 'id' | 'name'> & Partial<Pick<DesignWorkspaceFolder, 'parentId'>>
): DesignWorkspaceFolder[] {
  const normalized = normalizeDesignWorkspaceFolders(folders)
  const id = normalizedId(input.id)
  const name = normalizedName(input.name)
  const parentId = normalizedId(input.parentId) || null
  const safeParentId = parentId && normalized.some((folder) => folder.id === parentId) ? parentId : null
  if (!id || !name || normalized.some((folder) => folder.id === id) ||
    designFolderNameExists(normalized, name, safeParentId)) return normalized
  return [...normalized, { id, name, parentId: safeParentId }]
}

export function renameDesignWorkspaceFolder(
  folders: readonly DesignWorkspaceFolder[],
  folderId: string,
  name: string
): DesignWorkspaceFolder[] {
  const normalized = normalizeDesignWorkspaceFolders(folders)
  const id = normalizedId(folderId)
  const target = normalizedName(name)
  const current = normalized.find((folder) => folder.id === id)
  if (!current || !target || designFolderNameExists(normalized, target, current.parentId, id)) return normalized
  return normalized.map((folder) => folder.id === id ? { ...folder, name: target } : folder)
}

function uniqueSiblingName(
  name: string,
  parentId: string | null,
  folders: readonly DesignWorkspaceFolder[]
): string {
  if (!designFolderNameExists(folders, name, parentId)) return name
  let index = 2
  while (designFolderNameExists(folders, `${name} (${index})`, parentId)) index += 1
  return `${name} (${index})`
}

/**
 * Delete a logical folder without deleting work. Children move to its parent;
 * callers should move documents assigned to the deleted folder to `parentId`.
 */
export function deleteDesignWorkspaceFolder(
  folders: readonly DesignWorkspaceFolder[],
  folderId: string
): { folders: DesignWorkspaceFolder[]; parentId: string | null } {
  const normalized = normalizeDesignWorkspaceFolders(folders)
  const id = normalizedId(folderId)
  const deleting = normalized.find((folder) => folder.id === id)
  if (!deleting) return { folders: normalized, parentId: null }
  const next = normalized.filter((folder) => folder.id !== id)
  const promoted: DesignWorkspaceFolder[] = []
  return {
    parentId: deleting.parentId,
    folders: next.map((folder) => {
      if (folder.parentId !== id) return folder
      const siblings = [...next.filter((item) => item.id !== folder.id), ...promoted]
      const moved = {
        ...folder,
        name: uniqueSiblingName(folder.name, deleting.parentId, siblings),
        parentId: deleting.parentId
      }
      promoted.push(moved)
      return moved
    })
  }
}

export function designFolderDescendantIds(
  folders: readonly DesignWorkspaceFolder[],
  folderId: string
): Set<string> {
  const ids = new Set<string>([folderId])
  let changed = true
  while (changed) {
    changed = false
    for (const folder of folders) {
      if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id)
        changed = true
      }
    }
  }
  return ids
}
