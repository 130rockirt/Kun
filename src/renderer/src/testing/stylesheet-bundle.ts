const IMPORT_PATTERN = /@import\s+['"]([^'"]+)['"]\s*;/gu

export async function readStylesheetBundle(entry: URL): Promise<string> {
  return expandStylesheet(entry, new Set<string>())
}

async function expandStylesheet(url: URL, active: Set<string>): Promise<string> {
  if (active.has(url.href)) throw new Error(`Circular stylesheet import: ${url.href}`)
  const nodeFs = 'node:fs/promises'
  const { readFile } = await import(/* @vite-ignore */ nodeFs)
  const source = await readFile(url, 'utf8')
  const imports = [...source.matchAll(IMPORT_PATTERN)]
  if (imports.length === 0) return source

  const nextActive = new Set(active).add(url.href)
  let expanded = ''
  let cursor = 0
  for (const match of imports) {
    expanded += source.slice(cursor, match.index)
    expanded += await expandStylesheet(new URL(match[1]!, url), nextActive)
    cursor = match.index! + match[0].length
  }
  return expanded + source.slice(cursor)
}
