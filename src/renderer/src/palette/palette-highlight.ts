export type HighlightSegment = {
  text: string
  /** True when this segment is a literal occurrence of the search term. */
  match: boolean
}

/** Occurrences beyond this are left unhighlighted; rows are one line anyway. */
const MAX_HIGHLIGHTS = 24

/**
 * Splits `text` into alternating plain and matched segments for the literal,
 * case-insensitive `term`.
 *
 * Matching is literal rather than regex so a query containing regex
 * metacharacters highlights what the user typed instead of throwing or
 * silently matching something else. Returns a single unmatched segment when
 * there is nothing to highlight, so callers can render one code path.
 */
export function highlightSegments(text: string, term: string): HighlightSegment[] {
  const needle = term.trim().toLowerCase()
  if (!text) return []
  if (!needle) return [{ text, match: false }]

  const haystack = text.toLowerCase()
  const segments: HighlightSegment[] = []
  let cursor = 0
  let found = 0

  while (found < MAX_HIGHLIGHTS) {
    const index = haystack.indexOf(needle, cursor)
    if (index < 0) break
    if (index > cursor) segments.push({ text: text.slice(cursor, index), match: false })
    segments.push({ text: text.slice(index, index + needle.length), match: true })
    cursor = index + needle.length
    found += 1
  }

  if (segments.length === 0) return subsequenceSegments(text, needle)
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false })
  return segments
}

/**
 * Fallback for matches the literal pass cannot show: acronym and loose
 * subsequence hits, where the matched characters are scattered. Without this
 * such a row renders with no emphasis at all and looks like a false positive,
 * because nothing on screen explains why it matched.
 */
function subsequenceSegments(text: string, lowerCaseNeedle: string): HighlightSegment[] {
  const haystack = text.toLowerCase()
  const matched: number[] = []
  let cursor = 0
  for (const char of lowerCaseNeedle) {
    if (char === ' ') continue
    const index = haystack.indexOf(char, cursor)
    if (index < 0) return [{ text, match: false }]
    matched.push(index)
    cursor = index + 1
  }
  if (matched.length === 0) return [{ text, match: false }]

  const marked = new Set(matched)
  const segments: HighlightSegment[] = []
  let run = ''
  let runMatch = marked.has(0)
  for (let index = 0; index < text.length; index += 1) {
    const isMatch = marked.has(index)
    if (isMatch !== runMatch && run) {
      segments.push({ text: run, match: runMatch })
      run = ''
    }
    runMatch = isMatch
    run += text[index]
  }
  if (run) segments.push({ text: run, match: runMatch })
  return segments
}
