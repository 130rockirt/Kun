import { normalizeDevPreviewUrlInput } from '@shared/dev-preview-url'
import type { BrowserStorageLike } from './browser-storage'
import { browserStorage } from './browser-storage'
import { workspaceRootScopeKey } from './workspace-path'

export const DEV_PREVIEW_STATE_STORAGE_KEY = 'kun.devPreview.workspaceState.v2'
export const LEGACY_DEV_PREVIEW_URL_STORAGE_KEY = 'kun.devPreview.url'
export const LEGACY_DEV_PREVIEW_AUTO_FOLLOW_STORAGE_KEY = 'kun.devPreview.autoFollow'
export const MAX_DEV_PREVIEW_RECENT_URLS = 6

export type DevPreviewViewportPreset = 'fit' | 'phone' | 'tablet' | 'desktop'

export type DevPreviewWorkspaceState = {
  url: string | null
  autoFollow: boolean
  viewport: DevPreviewViewportPreset
  recentUrls: string[]
}

type DevPreviewStateRegistry = {
  version: 2
  legacyMigrated: boolean
  workspaces: Record<string, DevPreviewWorkspaceState>
}

const DEFAULT_STATE: DevPreviewWorkspaceState = {
  url: null,
  autoFollow: true,
  viewport: 'fit',
  recentUrls: []
}

function workspaceKey(workspaceRoot?: string | null): string {
  return workspaceRootScopeKey(workspaceRoot ?? undefined) || '__default__'
}

function isViewportPreset(value: unknown): value is DevPreviewViewportPreset {
  return value === 'fit' || value === 'phone' || value === 'tablet' || value === 'desktop'
}

function normalizedPageUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = normalizeDevPreviewUrlInput(value)
  if (!normalized) return null
  try {
    const path = decodeURIComponent(new URL(normalized).pathname).toLowerCase()
    if (/^\/(?:health|metrics|readyz?|livez?|v\d+)(?:\/|$)/.test(path)) return null
    if (/\/(?:health|metrics|readyz?|livez?)(?:\/|$)/.test(path)) return null
  } catch {
    return null
  }
  return normalized
}

function normalizeRecentUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const urls: string[] = []
  for (const candidate of value) {
    const normalized = normalizedPageUrl(candidate)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    urls.push(normalized)
    if (urls.length >= MAX_DEV_PREVIEW_RECENT_URLS) break
  }
  return urls
}

function normalizeWorkspaceState(value: unknown): DevPreviewWorkspaceState {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    url: normalizedPageUrl(record.url),
    autoFollow: typeof record.autoFollow === 'boolean' ? record.autoFollow : true,
    viewport: isViewportPreset(record.viewport) ? record.viewport : 'fit',
    recentUrls: normalizeRecentUrls(record.recentUrls)
  }
}

function emptyRegistry(): DevPreviewStateRegistry {
  return { version: 2, legacyMigrated: false, workspaces: {} }
}

function readRegistry(storage: BrowserStorageLike | null): DevPreviewStateRegistry {
  if (!storage) return emptyRegistry()
  try {
    const raw = storage.getItem(DEV_PREVIEW_STATE_STORAGE_KEY)
    if (!raw) return emptyRegistry()
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (parsed.version !== 2 || !parsed.workspaces || typeof parsed.workspaces !== 'object') {
      return emptyRegistry()
    }
    const workspaces: Record<string, DevPreviewWorkspaceState> = {}
    for (const [key, state] of Object.entries(parsed.workspaces as Record<string, unknown>)) {
      workspaces[key] = normalizeWorkspaceState(state)
    }
    return {
      version: 2,
      legacyMigrated: parsed.legacyMigrated === true,
      workspaces
    }
  } catch {
    return emptyRegistry()
  }
}

function writeRegistry(storage: BrowserStorageLike | null, registry: DevPreviewStateRegistry): void {
  try {
    storage?.setItem(DEV_PREVIEW_STATE_STORAGE_KEY, JSON.stringify(registry))
  } catch {
    /* preview preferences are best-effort */
  }
}

export function readDevPreviewWorkspaceState(
  workspaceRoot?: string | null,
  storage: BrowserStorageLike | null = browserStorage()
): DevPreviewWorkspaceState {
  const key = workspaceKey(workspaceRoot)
  const registry = readRegistry(storage)
  const existing = registry.workspaces[key]
  if (existing) return { ...existing, recentUrls: [...existing.recentUrls] }

  let migrated = DEFAULT_STATE
  if (!registry.legacyMigrated && storage) {
    const legacyUrl = normalizedPageUrl(storage.getItem(LEGACY_DEV_PREVIEW_URL_STORAGE_KEY))
    const rawAutoFollow = storage.getItem(LEGACY_DEV_PREVIEW_AUTO_FOLLOW_STORAGE_KEY)
    migrated = {
      ...DEFAULT_STATE,
      url: legacyUrl,
      autoFollow: rawAutoFollow == null ? true : rawAutoFollow === 'true',
      recentUrls: legacyUrl ? [legacyUrl] : []
    }
  }

  registry.legacyMigrated = true
  registry.workspaces[key] = migrated
  writeRegistry(storage, registry)
  return { ...migrated, recentUrls: [...migrated.recentUrls] }
}

export function writeDevPreviewWorkspaceState(
  workspaceRoot: string | null | undefined,
  next: DevPreviewWorkspaceState,
  storage: BrowserStorageLike | null = browserStorage()
): void {
  const registry = readRegistry(storage)
  registry.legacyMigrated = true
  registry.workspaces[workspaceKey(workspaceRoot)] = normalizeWorkspaceState(next)
  writeRegistry(storage, registry)
}

export function rememberDevPreviewUrl(
  state: DevPreviewWorkspaceState,
  value: string | null
): DevPreviewWorkspaceState {
  const url = normalizedPageUrl(value)
  if (!url) return { ...state, url: null }
  return {
    ...state,
    url,
    recentUrls: [url, ...state.recentUrls.filter((candidate) => candidate !== url)]
      .slice(0, MAX_DEV_PREVIEW_RECENT_URLS)
  }
}

export function resolveInitialDevPreviewUrl(input: {
  preferredUrl?: string | null
  workspaceUrl?: string | null
  detectedUrl?: string | null
}): string | null {
  return normalizedPageUrl(input.preferredUrl)
    ?? normalizedPageUrl(input.workspaceUrl)
    ?? normalizedPageUrl(input.detectedUrl)
}

export const DEV_PREVIEW_VIEWPORTS: Record<
  Exclude<DevPreviewViewportPreset, 'fit'>,
  { width: number; height: number }
> = {
  phone: { width: 390, height: 844 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 720 }
}

export function devPreviewViewportScale(input: {
  availableWidth: number
  availableHeight: number
  viewportWidth: number
  viewportHeight: number
}): number {
  const values = [input.availableWidth, input.availableHeight, input.viewportWidth, input.viewportHeight]
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) return 1
  return Math.min(1, input.availableWidth / input.viewportWidth, input.availableHeight / input.viewportHeight)
}

