export const LIVE_OFFICE_PREVIEW_EVENT = 'kun:live-office-preview'

export type LiveOfficePreviewDetail = {
  path: string
  workspaceRoot: string
  turnId: string
  phase: 'editing' | 'committed' | 'failed'
  expectedSha256?: string
}

const MAX_RETAINED_LIVE_OFFICE_PREVIEWS = 100
const latestPreviews = new Map<string, LiveOfficePreviewDetail>()

function normalizePath(value: string): string {
  const slashed = value.trim().replaceAll('\\', '/')
  const prefix = slashed.startsWith('//') ? '//' : slashed.startsWith('/') ? '/' : ''
  const normalized = slashed
    .slice(prefix.length)
    .split('/')
    .filter((segment) => segment && segment !== '.')
    .join('/')
  return normalized ? `${prefix}${normalized}` : prefix
}

function isWindowsPath(value: string): boolean {
  return /^[a-z]:\//i.test(value) || /^\/\//.test(value)
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || isWindowsPath(value)
}

function usesCaseInsensitivePaths(path: string, workspaceRoot: string): boolean {
  return (typeof window !== 'undefined' && window.kunGui?.platform === 'win32') ||
    isWindowsPath(path) || isWindowsPath(workspaceRoot)
}

function comparablePath(value: string, caseInsensitive: boolean): string {
  return caseInsensitive ? value.toLowerCase() : value
}

/**
 * Canonicalize agent-reported paths to a safe workspace-relative identity.
 * Office tool calls can report a relative path while their completed result
 * reports an absolute one; without this, one physical file becomes two tabs.
 */
export function normalizeLiveOfficePreviewPath(path: string, workspaceRoot: string): string | null {
  const normalizedRoot = normalizePath(workspaceRoot)
  let normalizedPath = normalizePath(path)
  if (!normalizedRoot || !normalizedPath) return null
  const caseInsensitive = usesCaseInsensitivePaths(normalizedPath, normalizedRoot)
  if (isAbsolutePath(normalizedPath)) {
    const root = comparablePath(normalizedRoot, caseInsensitive)
    const candidate = comparablePath(normalizedPath, caseInsensitive)
    if (!candidate.startsWith(`${root}/`)) return null
    normalizedPath = normalizedPath.slice(normalizedRoot.length + 1)
  }
  normalizedPath = normalizedPath.replace(/^(?:\.\/)+/, '')
  if (!normalizedPath || normalizedPath.split('/').some((segment) => segment === '..' || !segment)) return null
  return normalizedPath
}

function previewKey(path: string, workspaceRoot: string): string | null {
  const normalizedPath = normalizeLiveOfficePreviewPath(path, workspaceRoot)
  if (!normalizedPath) return null
  const root = normalizePath(workspaceRoot)
  const caseInsensitive = usesCaseInsensitivePaths(normalizedPath, root)
  return `${comparablePath(root, caseInsensitive)}\n${comparablePath(normalizedPath, caseInsensitive)}`
}

export function isOfficePreviewPath(path: string | null | undefined): path is string {
  return Boolean(path?.trim() && /\.(?:docx?|xlsx?|pptx?)$/i.test(path.trim()))
}

/**
 * Lets a preview mounted immediately after its tool event inherit the current
 * editing/commit state instead of missing the synchronous DOM event.
 */
export function latestLiveOfficePreview(
  path: string,
  workspaceRoot: string
): LiveOfficePreviewDetail | undefined {
  const key = previewKey(path, workspaceRoot)
  return key ? latestPreviews.get(key) : undefined
}

export function publishLiveOfficePreview(detail: LiveOfficePreviewDetail): void {
  const key = previewKey(detail.path, detail.workspaceRoot)
  const path = normalizeLiveOfficePreviewPath(detail.path, detail.workspaceRoot)
  if (!key || !path) return
  const normalizedDetail = { ...detail, path }
  latestPreviews.delete(key)
  latestPreviews.set(key, normalizedDetail)
  while (latestPreviews.size > MAX_RETAINED_LIVE_OFFICE_PREVIEWS) {
    const oldest = latestPreviews.keys().next().value
    if (!oldest) break
    latestPreviews.delete(oldest)
  }
  if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return
  window.dispatchEvent(new CustomEvent<LiveOfficePreviewDetail>(LIVE_OFFICE_PREVIEW_EVENT, { detail: normalizedDetail }))
}
