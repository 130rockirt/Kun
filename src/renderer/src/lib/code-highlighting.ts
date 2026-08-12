import type { ThemeRegistration } from 'shiki'

const CODEX_CODE_THEME = {
  name: 'codex',
  displayName: 'Codex',
  type: 'dark',
  fg: '#ffffff',
  bg: '#181818',
  colors: {
    'editor.background': '#181818',
    'editor.foreground': '#ffffff',
    'editor.selectionBackground': '#6fb0e844',
    'editor.inactiveSelectionBackground': '#6fb0e822',
    'editor.lineHighlightBackground': '#ffffff08',
    'editorCursor.foreground': '#ffffff',
    'editorGutter.addedBackground': '#40c977',
    'editorGutter.deletedBackground': '#fa423e',
    'editorGutter.modifiedBackground': '#6fb0e8',
    'diffEditor.insertedTextBackground': '#40c97724',
    'diffEditor.removedTextBackground': '#fa423e24',
    'terminal.ansiGreen': '#40c977',
    'terminal.ansiRed': '#fa423e',
    'terminal.ansiBlue': '#6fb0e8',
    'terminal.ansiMagenta': '#ad7bf9'
  },
  settings: [
    {
      settings: {
        foreground: '#ffffff',
        background: '#181818'
      }
    },
    {
      scope: ['comment', 'punctuation.definition.comment', 'string.comment'],
      settings: {
        foreground: '#858585',
        fontStyle: 'italic'
      }
    },
    {
      scope: ['keyword', 'storage', 'storage.type', 'storage.modifier'],
      settings: {
        foreground: '#fa423e'
      }
    },
    {
      scope: ['string', 'punctuation.definition.string'],
      settings: {
        foreground: '#40c977'
      }
    },
    {
      scope: ['constant', 'constant.numeric', 'variable.language', 'support.constant'],
      settings: {
        foreground: '#7bbcff'
      }
    },
    {
      scope: [
        'entity.name.function',
        'support.function',
        'meta.function-call',
        'entity.name.type',
        'entity.other.inherited-class'
      ],
      settings: {
        foreground: '#ad7bf9'
      }
    },
    {
      scope: ['variable.parameter', 'variable.other', 'meta.property-name', 'support.type.property-name'],
      settings: {
        foreground: '#c7c7c7'
      }
    },
    {
      scope: ['entity.name.tag', 'entity.other.attribute-name'],
      settings: {
        foreground: '#6fb0e8'
      }
    },
    {
      scope: ['punctuation', 'meta.brace'],
      settings: {
        foreground: '#c7c7c7'
      }
    },
    {
      scope: ['markup.inserted', 'meta.diff.header.to-file', 'punctuation.definition.inserted'],
      settings: {
        foreground: '#40c977',
        background: '#173222'
      }
    },
    {
      scope: ['markup.deleted', 'meta.diff.header.from-file', 'punctuation.definition.deleted'],
      settings: {
        foreground: '#fa423e',
        background: '#351b1b'
      }
    },
    {
      scope: ['markup.changed', 'punctuation.definition.changed', 'meta.diff.range'],
      settings: {
        foreground: '#6fb0e8'
      }
    }
  ]
} satisfies ThemeRegistration

const SHIKI_THEMES = {
  light: 'github-light',
  dark: CODEX_CODE_THEME
} as const

const LANGUAGE_ALIASES: Record<string, string> = {
  csharp: 'cs',
  docker: 'dockerfile',
  javascriptreact: 'jsx',
  plaintext: '',
  shellscript: 'shell',
  text: '',
  typescriptreact: 'tsx'
}

const FILE_EXTENSION_LANGUAGES: Record<string, string> = {
  astro: 'astro',
  bash: 'bash',
  c: 'c',
  cc: 'cpp',
  cjs: 'js',
  cpp: 'cpp',
  cs: 'cs',
  css: 'css',
  cts: 'ts',
  csv: 'csv',
  cxx: 'cpp',
  dart: 'dart',
  diff: 'diff',
  env: 'dotenv',
  fish: 'fish',
  go: 'go',
  h: 'c',
  hh: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  htm: 'html',
  html: 'html',
  ini: 'ini',
  java: 'java',
  js: 'js',
  json: 'json',
  jsonc: 'jsonc',
  jsx: 'jsx',
  kt: 'kotlin',
  kts: 'kotlin',
  less: 'less',
  log: 'log',
  lua: 'lua',
  md: 'md',
  mjs: 'js',
  mts: 'ts',
  patch: 'diff',
  php: 'php',
  ps1: 'powershell',
  psd1: 'powershell',
  psm1: 'powershell',
  py: 'python',
  pyi: 'python',
  rb: 'ruby',
  rs: 'rust',
  sass: 'sass',
  scss: 'scss',
  sh: 'shell',
  sql: 'sql',
  svelte: 'svelte',
  swift: 'swift',
  svg: 'xml',
  toml: 'toml',
  ts: 'ts',
  tsx: 'tsx',
  vue: 'vue',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'shell'
}

const FILE_NAME_LANGUAGES: Record<string, string> = {
  '.editorconfig': 'properties',
  '.npmrc': 'properties',
  '.prettierrc': 'json',
  dockerfile: 'dockerfile',
  gemfile: 'ruby',
  justfile: 'just',
  makefile: 'makefile',
  procfile: 'shell',
  rakefile: 'ruby'
}

const DOWNLOAD_EXTENSIONS: Record<string, string> = {
  bash: 'sh',
  c: 'c',
  cpp: 'cpp',
  cs: 'cs',
  css: 'css',
  diff: 'diff',
  dockerfile: 'dockerfile',
  go: 'go',
  html: 'html',
  java: 'java',
  js: 'js',
  json: 'json',
  jsx: 'jsx',
  md: 'md',
  php: 'php',
  powershell: 'ps1',
  py: 'py',
  python: 'py',
  rb: 'rb',
  rs: 'rs',
  rust: 'rs',
  sh: 'sh',
  shell: 'sh',
  sql: 'sql',
  swift: 'swift',
  ts: 'ts',
  tsx: 'tsx',
  txt: 'txt',
  typescript: 'ts',
  xml: 'xml',
  yaml: 'yml',
  yml: 'yml'
}

const MAX_HIGHLIGHT_CHARS = 250_000
export const MAX_HIGHLIGHT_CACHE_ENTRIES = 120

let shikiPromise: Promise<typeof import('shiki')> | null = null
const highlightCache = new Map<string, string>()
const inflightHighlights = new Map<string, Promise<string>>()

function highlightCacheKey(code: string, language: string): string {
  const normalized = normalizeCodeLanguage(language)
  return `${normalized || 'plain'}\u0000${code}`
}

function readHighlightCache(cacheKey: string): string | undefined {
  const cached = highlightCache.get(cacheKey)
  if (cached === undefined) return undefined
  highlightCache.delete(cacheKey)
  highlightCache.set(cacheKey, cached)
  return cached
}

function writeHighlightCache(cacheKey: string, html: string): void {
  highlightCache.delete(cacheKey)
  highlightCache.set(cacheKey, html)
  while (highlightCache.size > MAX_HIGHLIGHT_CACHE_ENTRIES) {
    const oldestKey = highlightCache.keys().next().value
    if (!oldestKey) break
    highlightCache.delete(oldestKey)
  }
}

export function clearHighlightCodeCache(): void {
  highlightCache.clear()
  inflightHighlights.clear()
}

export function highlightCodeCacheSize(): number {
  return highlightCache.size
}

export function hasCachedHighlightCode(code: string, language: string): boolean {
  return highlightCache.has(highlightCacheKey(code, language))
}

function loadShiki(): Promise<typeof import('shiki')> {
  shikiPromise ??= import('shiki')
  return shikiPromise
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function renderFallbackCodeHtml(code: string): string {
  const lines = code.split('\n')
  return `<pre class="shiki shiki-themes"><code>${lines
    .map((line) => `<span class="line">${line ? escapeHtml(line) : ' '}</span>`)
    .join('')}</code></pre>`
}

export function normalizeCodeLanguage(language: string): string {
  const raw = language.trim().toLowerCase()
  return LANGUAGE_ALIASES[raw] ?? raw
}

export function extensionForLanguage(language: string): string {
  const normalized = normalizeCodeLanguage(language)
  if (!normalized) return 'txt'
  return DOWNLOAD_EXTENSIONS[normalized] ?? normalized
}

export function languageFromFilePath(path: string): string {
  const fileName = path.split(/[/\\]/).filter(Boolean).pop()?.toLowerCase() ?? ''
  const byName = FILE_NAME_LANGUAGES[fileName]
  if (byName) return byName
  if (fileName.startsWith('.env.')) return 'dotenv'
  if (fileName.startsWith('dockerfile.')) return 'dockerfile'

  const extension = fileName.includes('.') ? fileName.split('.').pop() ?? '' : ''
  return FILE_EXTENSION_LANGUAGES[extension] ?? ''
}

export async function highlightCodeHtml(code: string, language: string): Promise<string> {
  const normalized = normalizeCodeLanguage(language)
  const cacheKey = highlightCacheKey(code, normalized)
  const cached = readHighlightCache(cacheKey)
  if (cached !== undefined) return cached

  const inflight = inflightHighlights.get(cacheKey)
  if (inflight) return inflight

  const task = (async () => {
    if (!normalized || code.length > MAX_HIGHLIGHT_CHARS) {
      const fallback = renderFallbackCodeHtml(code)
      writeHighlightCache(cacheKey, fallback)
      return fallback
    }

    try {
      const { codeToHtml } = await loadShiki()
      const html = await codeToHtml(code, {
        lang: normalized,
        themes: SHIKI_THEMES
      })
      writeHighlightCache(cacheKey, html)
      return html
    } catch {
      const fallback = renderFallbackCodeHtml(code)
      writeHighlightCache(cacheKey, fallback)
      return fallback
    }
  })()

  inflightHighlights.set(cacheKey, task)
  try {
    return await task
  } finally {
    inflightHighlights.delete(cacheKey)
  }
}
