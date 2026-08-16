import { readBrowserStorageItem, writeBrowserStorageItem } from '../lib/browser-storage'
import {
  PALETTE_SOURCE_KINDS,
  type PaletteRecentIdentity,
  type PaletteSourceKind
} from './palette-model'

export const PALETTE_RECENTS_STORAGE_KEY = 'kun.palette.recents.v1'
export const PALETTE_RECENTS_BOUND = 12
/**
 * Recents are bounded per workspace, but the number of workspaces a user
 * opens over time is not. Cap the scopes too, evicting the least recently
 * written, so the stored value cannot grow without limit.
 */
export const PALETTE_RECENTS_SCOPE_BOUND = 24

const PALETTE_RECENTS_VERSION = 2 as const
const LEGACY_PALETTE_RECENTS_VERSION = 1

/** Usage weight halves after this long, so old habits fade without vanishing. */
export const PALETTE_FRECENCY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000

export type PaletteRecentUsage = PaletteRecentIdentity & {
  /** How many times this entry has been activated in this workspace. */
  uses: number
  /** Epoch millis of the most recent activation. */
  lastUsedAt: number
}

export type StoredPaletteRecents = {
  version: typeof PALETTE_RECENTS_VERSION
  workspaces: Record<string, PaletteRecentUsage[]>
}

function emptyStoredPaletteRecents(): StoredPaletteRecents {
  return { version: PALETTE_RECENTS_VERSION, workspaces: {} }
}

const SOURCE_KINDS = new Set<string>(PALETTE_SOURCE_KINDS)

function isIdentityShape(value: unknown): value is PaletteRecentIdentity {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<PaletteRecentIdentity>
  return (
    typeof candidate.source === 'string' &&
    SOURCE_KINDS.has(candidate.source) &&
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    candidate.id.length <= 512
  )
}

function normalizeUsage(value: unknown, fallbackRank: number): PaletteRecentUsage | null {
  if (!isIdentityShape(value)) return null
  const candidate = value as Partial<PaletteRecentUsage> & PaletteRecentIdentity
  const uses = Number.isFinite(candidate.uses) && (candidate.uses as number) > 0
    ? Math.min(Math.floor(candidate.uses as number), 1_000_000)
    : 1
  // Legacy v1 entries carry only their array position. Preserve that order by
  // synthesizing decreasing timestamps so a migration cannot reshuffle a list
  // the user already recognizes.
  const lastUsedAt = Number.isFinite(candidate.lastUsedAt) && (candidate.lastUsedAt as number) > 0
    ? (candidate.lastUsedAt as number)
    : -fallbackRank
  return { source: candidate.source as PaletteSourceKind, id: candidate.id, uses, lastUsedAt }
}

/**
 * Absent, unparsable, or future-versioned values yield an empty registry.
 * Version 1 payloads migrate in place; invalid entries and duplicates beyond
 * the retention bound are dropped.
 */
export function normalizeStoredPaletteRecents(value: unknown): StoredPaletteRecents {
  if (!value || typeof value !== 'object') return emptyStoredPaletteRecents()
  const source = value as { version?: unknown; workspaces?: unknown }
  const version = source.version
  if (
    (version !== PALETTE_RECENTS_VERSION && version !== LEGACY_PALETTE_RECENTS_VERSION) ||
    !source.workspaces ||
    typeof source.workspaces !== 'object'
  ) {
    return emptyStoredPaletteRecents()
  }
  const workspaces: Record<string, PaletteRecentUsage[]> = {}
  for (const [scope, rawRecents] of Object.entries(
    source.workspaces as Record<string, unknown>
  )) {
    if (!scope || !Array.isArray(rawRecents)) continue
    const recents: PaletteRecentUsage[] = []
    for (const [rank, candidate] of rawRecents.entries()) {
      const usage = normalizeUsage(candidate, rank)
      if (!usage) continue
      if (recents.some((recent) => recent.id === usage.id)) continue
      recents.push(usage)
      if (recents.length >= PALETTE_RECENTS_BOUND) break
    }
    if (recents.length > 0) workspaces[scope] = recents
  }
  return { version: PALETTE_RECENTS_VERSION, workspaces: boundScopes(workspaces) }
}

/**
 * Keeps the most recently written scopes. Insertion order is the recency
 * order because `recordPaletteRecent` re-inserts the active scope last.
 */
function boundScopes(
  workspaces: Record<string, PaletteRecentUsage[]>
): Record<string, PaletteRecentUsage[]> {
  const scopes = Object.keys(workspaces)
  if (scopes.length <= PALETTE_RECENTS_SCOPE_BOUND) return workspaces
  const kept: Record<string, PaletteRecentUsage[]> = {}
  for (const scope of scopes.slice(-PALETTE_RECENTS_SCOPE_BOUND)) {
    kept[scope] = workspaces[scope]!
  }
  return kept
}

/**
 * Frecency: repeated use raises an entry, elapsed time lowers it. Something
 * used ten times last week should outrank something used once this morning,
 * which pure recency gets backwards.
 */
export function paletteFrecencyScore(usage: PaletteRecentUsage, now: number): number {
  const ageMs = Math.max(0, now - usage.lastUsedAt)
  const decay = Math.pow(0.5, ageMs / PALETTE_FRECENCY_HALF_LIFE_MS)
  return usage.uses * decay
}

function readStoredPaletteRecents(): StoredPaletteRecents {
  const raw = readBrowserStorageItem(PALETTE_RECENTS_STORAGE_KEY)
  if (!raw) return emptyStoredPaletteRecents()
  try {
    return normalizeStoredPaletteRecents(JSON.parse(raw))
  } catch {
    return emptyStoredPaletteRecents()
  }
}

/** Workspace recents ordered by frecency, highest first. */
export function readPaletteRecents(
  scope: string,
  now: number = Date.now()
): PaletteRecentIdentity[] {
  if (!scope) return []
  return [...(readStoredPaletteRecents().workspaces[scope] ?? [])]
    .sort((left, right) =>
      paletteFrecencyScore(right, now) - paletteFrecencyScore(left, now) ||
      right.lastUsedAt - left.lastUsedAt ||
      left.id.localeCompare(right.id))
    .map(({ source, id }) => ({ source, id }))
}

/**
 * Records one activation, incrementing its use count, and returns the
 * updated frecency-ordered list so callers can render it without a re-read.
 */
export function recordPaletteRecent(
  scope: string,
  identity: PaletteRecentIdentity,
  now: number = Date.now()
): PaletteRecentIdentity[] {
  if (!scope || !isIdentityShape(identity)) return readPaletteRecents(scope, now)
  const stored = readStoredPaletteRecents()
  const previous = stored.workspaces[scope] ?? []
  const existing = previous.find((recent) => recent.id === identity.id)
  // Several activations can land in the same millisecond. Without a strictly
  // increasing stamp their frecency ties and the stable tiebreak decides the
  // order, which would show the wrong entry first.
  const stamp = Math.max(now, ...previous.map((recent) => recent.lastUsedAt + 1))
  const next: PaletteRecentUsage[] = [
    {
      source: identity.source,
      id: identity.id,
      uses: (existing?.uses ?? 0) + 1,
      lastUsedAt: stamp
    },
    ...previous.filter((recent) => recent.id !== identity.id)
  ]
    .sort((left, right) =>
      paletteFrecencyScore(right, stamp) - paletteFrecencyScore(left, stamp) ||
      right.lastUsedAt - left.lastUsedAt)
    .slice(0, PALETTE_RECENTS_BOUND)

  // Re-insert last so key order stays newest-scope-last for the scope bound.
  delete stored.workspaces[scope]
  stored.workspaces[scope] = next
  writeBrowserStorageItem(
    PALETTE_RECENTS_STORAGE_KEY,
    JSON.stringify({ ...stored, workspaces: boundScopes(stored.workspaces) })
  )
  return next.map(({ source, id }) => ({ source, id }))
}
