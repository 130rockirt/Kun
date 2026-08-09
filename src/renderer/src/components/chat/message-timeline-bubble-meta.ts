import type { AttachmentReference, RuntimeDisclosureMetadata, UserFileReference } from '../../agent/types'

export function metaStringArray(meta: Record<string, unknown> | undefined, key: string): string[] {
  const value = meta?.[key]
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
}

export function metaInstructionSources(meta: Record<string, unknown> | undefined): Array<{ path: string; scope: string }> {
  const value = meta?.injectedInstructionSources
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null
      const raw = entry as Record<string, unknown>
      const path = typeof raw.path === 'string' && raw.path.trim() ? raw.path.trim() : ''
      const scope = typeof raw.scope === 'string' && raw.scope.trim() ? raw.scope.trim() : ''
      return path ? { path, scope } : null
    })
    .filter((entry): entry is { path: string; scope: string } => entry !== null)
}

export function metaString(meta: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = meta?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function metaAttachmentReferences(meta: RuntimeDisclosureMetadata | undefined): AttachmentReference[] {
  const value = meta?.attachments
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null
      const raw = entry as Record<string, unknown>
      const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : ''
      if (!id) return null
      const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : undefined
      const mimeType = typeof raw.mimeType === 'string' && raw.mimeType.trim() ? raw.mimeType.trim() : undefined
      const byteSize = typeof raw.byteSize === 'number' && Number.isFinite(raw.byteSize) ? raw.byteSize : undefined
      const previewUrl = typeof raw.previewUrl === 'string' && raw.previewUrl.trim() ? raw.previewUrl.trim() : undefined
      const width = typeof raw.width === 'number' && Number.isFinite(raw.width) ? raw.width : undefined
      const height = typeof raw.height === 'number' && Number.isFinite(raw.height) ? raw.height : undefined
      return {
        id,
        ...(name ? { name } : {}),
        ...(mimeType ? { mimeType } : {}),
        ...(byteSize ? { byteSize } : {}),
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
        ...(previewUrl ? { previewUrl } : {})
      }
    })
    .filter((entry): entry is AttachmentReference => entry !== null)
}

export function metaUserFileReferences(meta: RuntimeDisclosureMetadata | undefined): UserFileReference[] {
  const value = meta?.fileReferences
  if (!Array.isArray(value)) return []
  return value
    .map((entry): UserFileReference | null => {
      if (!entry || typeof entry !== 'object') return null
      const raw = entry as Record<string, unknown>
      const path = typeof raw.path === 'string' && raw.path.trim() ? raw.path.trim() : ''
      const relativePath =
        typeof raw.relativePath === 'string' && raw.relativePath.trim() ? raw.relativePath.trim() : ''
      const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : ''
      const kind = raw.kind === 'directory' ? 'directory' : 'file'
      if (!path || !relativePath || !name) return null
      return { path, relativePath, name, kind }
    })
    .filter((entry): entry is UserFileReference => entry !== null)
}
