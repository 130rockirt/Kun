import {
  PALETTE_SOURCE_PRIORITY,
  type PaletteEntry,
  type PaletteRecentIdentity,
  type PaletteSourceKind
} from './palette-model'

export type PaletteQueryScope = 'all' | 'commands' | 'conversations' | 'settings' | 'slash'

export type ParsedPaletteQuery = {
  scope: PaletteQueryScope
  /** The scope prefix character when one was recognized, otherwise null. */
  prefix: string | null
  /** Normalized (lower-cased) query text with any scope prefix stripped. */
  query: string
}

const SCOPE_PREFIXES: Record<string, PaletteQueryScope> = {
  '>': 'commands',
  '@': 'conversations',
  '#': 'settings',
  '/': 'slash'
}

const SCOPE_SOURCES: Record<Exclude<PaletteQueryScope, 'all'>, readonly PaletteSourceKind[]> = {
  commands: ['shortcut-command', 'slash-command'],
  conversations: ['thread'],
  settings: ['settings'],
  slash: ['slash-command']
}

/**
 * Splits a raw input value into a scope and a normalized query.
 * Recognized leading prefixes are stripped before matching; any other
 * leading character keeps the full text in the mixed 'all' scope.
 */
export function parsePaletteQuery(raw: string): ParsedPaletteQuery {
  const trimmed = raw.trim()
  if (!trimmed) return { scope: 'all', prefix: null, query: '' }
  const prefix = trimmed[0]
  const scope = SCOPE_PREFIXES[prefix]
  if (!scope) return { scope: 'all', prefix: null, query: trimmed.toLowerCase() }
  return { scope, prefix, query: trimmed.slice(1).trim().toLowerCase() }
}

const WORD_SPLIT = /[^\p{L}\p{N}]+/u

/**
 * Word splitting is per-entry work that does not depend on the query, and
 * matching runs over the whole catalog on every keystroke. Entries are
 * immutable snapshots rebuilt by the source aggregators, so caching on the
 * object identity stays correct and lets a stale snapshot be collected.
 */
const WORD_PARTS_CACHE = new WeakMap<PaletteEntry, string[]>()

function wordParts(entry: PaletteEntry): string[] {
  const cached = WORD_PARTS_CACHE.get(entry)
  if (cached) return cached
  const parts: string[] = []
  for (const value of [entry.title, ...entry.keywords]) {
    for (const word of value.toLowerCase().split(WORD_SPLIT)) {
      if (word) parts.push(word)
    }
  }
  WORD_PARTS_CACHE.set(entry, parts)
  return parts
}

function isSubsequence(query: string, value: string): boolean {
  const haystack = value.toLowerCase()
  let cursor = 0
  for (const char of query) {
    cursor = haystack.indexOf(char, cursor)
    if (cursor < 0) return false
    cursor += 1
  }
  return true
}

/**
 * The initials of each word in a title, e.g. "Keyboard shortcuts" -> "ks".
 * Typing initials is how people reach a known destination fastest, so it
 * gets its own tier rather than falling through to loose subsequence.
 */
export function acronymOf(text: string): string {
  return text
    .toLowerCase()
    .split(WORD_SPLIT)
    .filter(Boolean)
    .map((word) => word[0] ?? '')
    .join('')
}

/**
 * Matching tiers, lowest first: 0 exact title, 1 title prefix,
 * 2 word-boundary on title or keywords, 3 title acronym, 4 subsequence on
 * title or keywords, -1 no match. Purely deterministic over the query and
 * entry.
 */
export function paletteMatchTier(query: string, entry: PaletteEntry): number {
  const normalized = query.toLowerCase()
  if (!normalized) return 0
  const title = entry.title.toLowerCase()
  if (title === normalized) return 0
  if (title.startsWith(normalized)) return 1
  if (wordParts(entry).some((word) => word.startsWith(normalized))) return 2
  // Only multi-word titles have a meaningful acronym; for a single word the
  // initial is already covered by the prefix tier.
  const acronym = acronymOf(entry.title)
  if (acronym.length > 1 && isSubsequence(normalized, acronym)) return 3
  if (
    isSubsequence(normalized, title) ||
    entry.keywords.some((keyword) => isSubsequence(normalized, keyword))
  ) {
    return 4
  }
  return -1
}

/**
 * Filters to the parsed scope and orders matches by tier, then source
 * priority, then per-workspace recency, then stable entry identity.
 * An empty query ranks every in-scope entry without matching.
 */
export function rankPaletteEntries(
  entries: readonly PaletteEntry[],
  parsed: ParsedPaletteQuery,
  recents: readonly PaletteRecentIdentity[] = []
): PaletteEntry[] {
  const allowedSources = parsed.scope === 'all' ? null : new Set<string>(SCOPE_SOURCES[parsed.scope])
  const recencyRank = new Map<string, number>()
  recents.forEach((recent, index) => recencyRank.set(recent.id, index))

  const scored: Array<{ entry: PaletteEntry; tier: number }> = []
  for (const entry of entries) {
    if (allowedSources && !allowedSources.has(entry.source)) continue
    const tier = parsed.query ? paletteMatchTier(parsed.query, entry) : 0
    if (tier < 0) continue
    scored.push({ entry, tier })
  }

  scored.sort((left, right) =>
    left.tier - right.tier ||
    PALETTE_SOURCE_PRIORITY[left.entry.source] - PALETTE_SOURCE_PRIORITY[right.entry.source] ||
    (recencyRank.get(left.entry.id) ?? Number.POSITIVE_INFINITY) -
      (recencyRank.get(right.entry.id) ?? Number.POSITIVE_INFINITY) ||
    left.entry.id.localeCompare(right.entry.id)
  )

  return scored.map((scored) => scored.entry)
}
