import { basename, extname } from 'node:path'
import { normalizeToolPath } from './builtin-tool-utils.js'

export const IMPORTANT_FILE_NAMES = new Set([
  'package.json',
  'tsconfig.json',
  'vite.config.ts',
  'electron.vite.config.ts',
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod'
])

export function tokenize(text: string): string[] {
  const tokens: string[] = []
  const normalized = text
    .normalize('NFKC')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
  for (const match of normalized.matchAll(/[a-z0-9][a-z0-9_-]{1,}/g)) {
    const token = match[0]
    for (const part of token.split(/[_-]+/)) {
      if (part.length >= 2 && !/^\d+$/.test(part)) tokens.push(part)
    }
    if (token.length >= 2 && !/^\d+$/.test(token)) tokens.push(token)
  }
  for (const segment of normalized.match(/\p{Script=Han}+/gu) ?? []) {
    const chars = [...segment]
    for (let size = 2; size <= Math.min(4, chars.length); size += 1) {
      for (let index = 0; index <= chars.length - size; index += 1) {
        tokens.push(chars.slice(index, index + size).join(''))
      }
    }
  }
  return tokens
}

export function countBy<T>(values: T[], keyFor: (value: T) => string): Map<string, number> {
  const out = new Map<string, number>()
  for (const value of values) {
    const key = keyFor(value)
    if (!key) continue
    out.set(key, (out.get(key) ?? 0) + 1)
  }
  return out
}

export function topEntries(map: Map<string, number>, limit: number): Array<{ name: string; count: number }> {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }))
}

export function firstDirectory(relativePath: string): string {
  const normalized = normalizeToolPath(relativePath)
  const slash = normalized.indexOf('/')
  return slash === -1 ? '.' : normalized.slice(0, slash)
}

export function languageForPath(filePath: string): string {
  const name = basename(filePath)
  if (IMPORTANT_FILE_NAMES.has(name)) return name
  const ext = extname(filePath).toLowerCase()
  switch (ext) {
    case '.ts':
    case '.tsx':
      return 'typescript'
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript'
    case '.py':
      return 'python'
    case '.rs':
      return 'rust'
    case '.go':
      return 'go'
    case '.md':
    case '.mdx':
      return 'markdown'
    case '.json':
      return 'json'
    case '.yaml':
    case '.yml':
      return 'yaml'
    default:
      return ext.replace(/^\./, '') || 'text'
  }
}

export function repoMapSuggestions(query: string, resultCount: number, truncated: boolean): string[] {
  const out = [
    resultCount > 0
      ? 'Read the highest-ranked files before editing; use grep/lsp for exact call sites.'
      : 'No source files matched the current scope; try a broader path or refresh=true.'
  ]
  if (!query) out.push('Pass query to rank files for the current task instead of returning only entrypoint/core-path scores.')
  if (truncated) out.push('The scan hit maxScanFiles; narrow path or increase maxScanFiles for a fuller map.')
  return out
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
