import { describe, expect, it } from 'vitest'
import { highlightSegments } from './palette-highlight'

function rendered(text: string, term: string): string {
  return highlightSegments(text, term)
    .map((segment) => (segment.match ? `[${segment.text}]` : segment.text))
    .join('')
}

describe('highlightSegments', () => {
  it('marks every occurrence and preserves the original text', () => {
    expect(rendered('checkout the checkout flow', 'checkout'))
      .toBe('[checkout] the [checkout] flow')
  })

  it('matches case-insensitively while keeping the original casing', () => {
    expect(rendered('Checkout and CHECKOUT', 'checkout')).toBe('[Checkout] and [CHECKOUT]')
  })

  it('returns one plain segment when the term is absent or empty', () => {
    expect(highlightSegments('nothing here', 'absent')).toEqual([
      { text: 'nothing here', match: false }
    ])
    expect(highlightSegments('nothing here', '   ')).toEqual([
      { text: 'nothing here', match: false }
    ])
  })

  it('treats the term literally so regex metacharacters do not throw or over-match', () => {
    expect(rendered('a.b and axb', '.')).toBe('a[.]b and axb')
    expect(rendered('cost is $5 (approx)', '$5')).toBe('cost is [$5] (approx)')
    expect(rendered('files a+b', 'a+b')).toBe('files [a+b]')
  })

  it('handles a match at the very start and end', () => {
    expect(rendered('kun runs kun', 'kun')).toBe('[kun] runs [kun]')
  })

  it('never loses characters, whatever the term', () => {
    const text = 'the palette highlights the matched term'
    for (const term of ['the', 'a', 'palette', 'zzz', '']) {
      const joined = highlightSegments(text, term).map((segment) => segment.text).join('')
      expect(joined).toBe(text)
    }
  })

  it('marks the scattered characters of an acronym or subsequence match', () => {
    // Nothing literal to mark, so the row would otherwise render with no
    // emphasis at all and read as a false positive.
    expect(rendered('Keyboard shortcuts', 'ks')).toBe('[K]eyboard [s]hortcuts')
    expect(rendered('Compose', 'cmps')).toBe('[C]o[mp]o[s]e')
  })

  it('prefers a literal run over scattered characters', () => {
    expect(rendered('Media generation', 'media')).toBe('[Media] generation')
  })

  it('ignores spaces when falling back to scattered matching', () => {
    // Earliest-match semantics: the 'h' lands inside "chat", not on "history".
    expect(rendered('New chat history', 'n c h')).toBe('[N]ew [ch]at history')
    expect(rendered('New chat history', 'nch')).toBe('[N]ew [ch]at history')
  })

  it('marks nothing when the characters are not present in order', () => {
    expect(highlightSegments('Compose', 'zx')).toEqual([{ text: 'Compose', match: false }])
    expect(highlightSegments('Compose', 'esopmoc')).toEqual([
      { text: 'Compose', match: false }
    ])
  })

  it('returns nothing for empty text', () => {
    expect(highlightSegments('', 'anything')).toEqual([])
  })
})
