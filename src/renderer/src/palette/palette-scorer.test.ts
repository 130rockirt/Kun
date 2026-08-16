import { describe, expect, it } from 'vitest'
import type { PaletteEntry, PaletteSourceKind } from './palette-model'
import { paletteMatchTier, parsePaletteQuery, rankPaletteEntries } from './palette-scorer'

function makeEntry(
  id: string,
  source: PaletteSourceKind,
  title: string,
  overrides: Partial<PaletteEntry> = {}
): PaletteEntry {
  return {
    id,
    source,
    title,
    keywords: [],
    activation: { kind: 'route', route: 'chat' },
    ...overrides
  }
}

describe('parsePaletteQuery', () => {
  it('treats an empty query as the mixed scope', () => {
    expect(parsePaletteQuery('')).toEqual({ scope: 'all', prefix: null, query: '' })
    expect(parsePaletteQuery('   ')).toEqual({ scope: 'all', prefix: null, query: '' })
  })

  it('recognizes and strips the scope prefixes', () => {
    expect(parsePaletteQuery('>plan')).toEqual({ scope: 'commands', prefix: '>', query: 'plan' })
    expect(parsePaletteQuery('@  bug')).toEqual({ scope: 'conversations', prefix: '@', query: 'bug' })
    expect(parsePaletteQuery('#pro')).toEqual({ scope: 'settings', prefix: '#', query: 'pro' })
    expect(parsePaletteQuery('/skill')).toEqual({ scope: 'slash', prefix: '/', query: 'skill' })
  })

  it('keeps unprefixed text in the mixed scope and lower-cases it', () => {
    expect(parsePaletteQuery('Write')).toEqual({ scope: 'all', prefix: null, query: 'write' })
  })

  it('keeps a scoped query with no text as an empty scoped query', () => {
    expect(parsePaletteQuery('#')).toEqual({ scope: 'settings', prefix: '#', query: '' })
  })
})

describe('paletteMatchTier', () => {
  const exact = makeEntry('a', 'route', 'New chat')
  const prefix = makeEntry('b', 'route', 'New chat history')
  const keyword = makeEntry('c', 'route', 'Conversations', { keywords: ['new thread'] })
  const subsequence = makeEntry('d', 'route', 'Compose', { keywords: [] })

  it('ranks exact title above prefix', () => {
    expect(paletteMatchTier('new chat', exact)).toBe(0)
    expect(paletteMatchTier('new chat', prefix)).toBe(1)
  })

  it('matches keywords at the word-boundary tier', () => {
    expect(paletteMatchTier('thread', keyword)).toBe(2)
  })

  it('matches title initials at the acronym tier', () => {
    // "New chat history" -> initials "nch"; typing initials is the fastest
    // way to reach a destination you already know.
    expect(paletteMatchTier('nch', prefix)).toBe(3)
    expect(paletteMatchTier('nh', prefix)).toBe(3)
  })

  it('does not invent an acronym for a single-word title', () => {
    // "Compose" has one initial, already covered by the prefix tier, so a
    // one-letter query must not win the acronym tier over a real prefix.
    expect(paletteMatchTier('c', subsequence)).toBe(1)
  })

  it('matches via subsequence as the last tier', () => {
    expect(paletteMatchTier('cmps', subsequence)).toBe(4)
  })

  it('returns -1 when nothing matches', () => {
    expect(paletteMatchTier('zzz', subsequence)).toBe(-1)
  })

  it('returns tier 0 for an empty query', () => {
    expect(paletteMatchTier('', subsequence)).toBe(0)
  })

  it('matches CJK titles through the subsequence tier', () => {
    const entry = makeEntry('e', 'settings', '数据迁移', { keywords: ['迁移'] })
    expect(paletteMatchTier('数据', entry)).toBe(1)
    expect(paletteMatchTier('据迁', entry)).toBe(4)
  })
})

describe('rankPaletteEntries', () => {
  it('orders an exact match before a prefix match', () => {
    const exact = makeEntry('exact', 'route', 'plan')
    const prefix = makeEntry('prefix', 'route', 'planning')
    const ranked = rankPaletteEntries([prefix, exact], parsePaletteQuery('plan'))
    expect(ranked.map((entry) => entry.id)).toEqual(['exact', 'prefix'])
  })

  it('orders a keyword-only match below title matches', () => {
    const titlePrefix = makeEntry('title', 'route', 'Plan mode')
    const keywordOnly = makeEntry('keyword', 'route', 'Organize', { keywords: ['planning'] })
    const ranked = rankPaletteEntries([keywordOnly, titlePrefix], parsePaletteQuery('plan'))
    expect(ranked.map((entry) => entry.id)).toEqual(['title', 'keyword'])
  })

  it('breaks same-tier ties by source priority', () => {
    const command = makeEntry('cmd', 'shortcut-command', 'settings')
    const thread = makeEntry('thread', 'thread', 'settings')
    const ranked = rankPaletteEntries([thread, command], parsePaletteQuery('settings'))
    expect(ranked.map((entry) => entry.id)).toEqual(['cmd', 'thread'])
  })

  it('breaks same-source ties by recency then stable identity', () => {
    const older = makeEntry('z-older', 'route', 'chat')
    const newer = makeEntry('a-newer', 'route', 'chat')
    const ranked = rankPaletteEntries(
      [older, newer],
      parsePaletteQuery('chat'),
      [{ source: 'route', id: 'a-newer' }]
    )
    expect(ranked.map((entry) => entry.id)).toEqual(['a-newer', 'z-older'])
  })

  it('orders by stable identity when no recency applies', () => {
    const beta = makeEntry('b', 'settings', 'general')
    const alpha = makeEntry('a', 'settings', 'general')
    const ranked = rankPaletteEntries([beta, alpha], parsePaletteQuery('general'))
    expect(ranked.map((entry) => entry.id)).toEqual(['a', 'b'])
  })

  it('is deterministic across repeated evaluations', () => {
    const entries = [
      makeEntry('c', 'thread', 'plan'),
      makeEntry('a', 'settings', 'planning'),
      makeEntry('b', 'route', 'plan')
    ]
    const first = rankPaletteEntries(entries, parsePaletteQuery('plan'))
    const second = rankPaletteEntries(entries, parsePaletteQuery('plan'))
    expect(second.map((entry) => entry.id)).toEqual(first.map((entry) => entry.id))
  })

  it('restricts scoped queries to their sources', () => {
    const entries = [
      makeEntry('settings', 'settings', 'providers'),
      makeEntry('command', 'shortcut-command', 'providers'),
      makeEntry('slash', 'slash-command', 'providers'),
      makeEntry('thread', 'thread', 'providers')
    ]
    expect(rankPaletteEntries(entries, parsePaletteQuery('#providers')).map((e) => e.id))
      .toEqual(['settings'])
    expect(rankPaletteEntries(entries, parsePaletteQuery('/providers')).map((e) => e.id))
      .toEqual(['slash'])
    expect(rankPaletteEntries(entries, parsePaletteQuery('>providers')).map((e) => e.id).sort())
      .toEqual(['command', 'slash'])
    expect(rankPaletteEntries(entries, parsePaletteQuery('@providers')).map((e) => e.id))
      .toEqual(['thread'])
  })

  it('returns every in-scope entry for an empty scoped query', () => {
    const entries = [
      makeEntry('one', 'settings', 'general'),
      makeEntry('two', 'settings', 'providers')
    ]
    expect(rankPaletteEntries(entries, parsePaletteQuery('#')).map((e) => e.id))
      .toEqual(['one', 'two'])
  })
})
