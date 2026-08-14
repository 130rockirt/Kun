import { open as openFile, readdir, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { WriteInlineCompletionRequest } from '../../shared/write-inline-completion'
import type {
  WriteRetrievalContext,
  WriteRetrievalRequest,
  WriteRetrievalSnippet,
  WriteRetrievalSnippetLocation
} from '../../shared/write-retrieval'
import { isWritePdfFileExtension, isWriteTextFileExtension } from '../../shared/write-text-file'
import { expandHomePath } from './workspace-service'
import { readWritePdfText, type WritePdfTextPage } from './write-pdf-text-service'

export const INDEX_CACHE_TTL_MS = 30_000

export const INDEX_CACHE_MAX_ENTRIES = 8

export const MAX_INDEX_BUILD_MS = 250

export const MAX_ASSISTANT_INDEX_BUILD_MS = 2_500

const MAX_FRESH_INDEX_BUILD_ATTEMPTS = 3

const MAX_STABLE_FILE_READ_ATTEMPTS = 2

export const MAX_SCAN_ENTRIES = 8_000

export const MAX_INDEX_FILES = 160

export const MAX_FILE_BYTES = 600_000

export const MAX_INDEX_CHUNKS = 720

export const MAX_CHUNK_CHARS = 900

export const MIN_CHUNK_CHARS = 48

export const MAX_TOKENS_PER_CHUNK = 1_200

export const MAX_QUERY_TERMS = 36

export const DEFAULT_MAX_SNIPPETS = 3

export const MAX_SNIPPET_CHARS = 520

export const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'out',
  'build',
  '.next',
  'coverage',
  '.cache',
  '.idea',
  '.pnpm-store',
  '.turbo',
  '.venv',
  '.vscode',
  '.yarn',
  '.yarn-cache',
  '.parcel-cache',
  'log',
  'logs',
  'target',
  'temp',
  'tmp',
  'vendor',
  'venv'
])

export const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'from',
  'into',
  'about',
  'there',
  'their',
  'will',
  'would',
  'could',
  'should',
  'have',
  'has',
  'are',
  'was',
  'were',
  'been',
  'not',
  'but',
  'you',
  'your',
  'our',
  'can',
  'then',
  'when',
  'what',
  'how'
])

export type {
  WriteRetrievalContext,
  WriteRetrievalRequest,
  WriteRetrievalSnippet,
  WriteRetrievalSnippetLocation
} from '../../shared/write-retrieval'

export type IndexedChunk = {
  path: string
  relativePath: string
  title: string
  text: string
  lowerText: string
  tokens: string[]
  termFrequency: Map<string, number>
  titleTokens: Set<string>
  pathTokens: Set<string>
  location: WriteRetrievalSnippetLocation
}

export type WorkspaceIndex = {
  workspaceRoot: string
  builtAt: number
  files: number
  /** Filesystem identity captured with the chunks so active-file saves invalidate cached text. */
  fileSignatures: Map<string, string>
  chunks: IndexedChunk[]
  averageLength: number
  documentFrequency: Map<string, number>
}

export type QueryModel = {
  text: string
  terms: string[]
  weights: Map<string, number>
  phrases: string[]
}

export const indexCache = new Map<string, WorkspaceIndex>()

export const inFlightIndexCache = new Map<string, Promise<WorkspaceIndex>>()

type WriteRetrievalIndexTestHooks = {
  afterFileRead?: (path: string) => void | Promise<void>
  beforeIndexBuild?: (workspaceRoot: string) => void | Promise<void>
  beforeIndexReturn?: (workspaceRoot: string) => void | Promise<void>
}

let testHooks: WriteRetrievalIndexTestHooks = {}

export function setWriteRetrievalIndexTestHooks(hooks: WriteRetrievalIndexTestHooks): void {
  testHooks = hooks
}

export const indexBuildGenerations = new Map<string, number>()

function currentIndexBuildGeneration(cacheKey: string): number {
  return indexBuildGenerations.get(cacheKey) ?? 0
}

function invalidateInFlightIndexBuild(cacheKey: string): void {
  indexBuildGenerations.set(cacheKey, currentIndexBuildGeneration(cacheKey) + 1)
}

export function pruneIndexCache(now: number): void {
  for (const [key, index] of indexCache) {
    if (now - index.builtAt > INDEX_CACHE_TTL_MS) indexCache.delete(key)
  }
  while (indexCache.size > INDEX_CACHE_MAX_ENTRIES) {
    const oldest = indexCache.keys().next().value
    if (oldest === undefined) break
    indexCache.delete(oldest)
  }
}

export type WorkspaceIndexOptions = {
  includePdf: boolean
  buildMs: number
  /** Paths whose cached chunks must still match the live file before reuse. */
  freshPaths?: string[]
}

async function fileSignature(path: string): Promise<string> {
  try {
    const info = await stat(path)
    return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':')
  } catch {
    return 'missing'
  }
}

async function cachedIndexMatchesFreshPaths(
  index: WorkspaceIndex,
  paths: readonly string[]
): Promise<boolean> {
  const candidates = [...new Set(paths.map(resolveComparablePath).filter(Boolean))]
  for (const path of candidates) {
    const captured = index.fileSignatures.get(path)
    const live = await fileSignature(path)
    if (captured === undefined ? live !== 'missing' : captured !== live) return false
  }
  return true
}

async function captureFileSignatures(paths: readonly string[]): Promise<Map<string, string>> {
  return new Map(await Promise.all(paths.map(async (path) => [path, await fileSignature(path)] as const)))
}

function fileSignaturesMatch(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>
): boolean {
  return left.size === right.size && [...left].every(([path, signature]) => right.get(path) === signature)
}

export function deadlineExceeded(deadline: number): boolean {
  return Date.now() > deadline
}

export function compactText(text = ''): string {
  return String(text || '').replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim()
}

export function normalizeRelativePath(value: string): string {
  return value.replaceAll('\\', '/')
}

export function clipTail(text = '', maxChars = 0): string {
  const source = String(text || '')
  if (!maxChars || source.length <= maxChars) return source
  return source.slice(source.length - maxChars)
}

export function normalizeLower(text = ''): string {
  return String(text || '').normalize('NFKC').toLowerCase()
}

export function tokenAllowed(token: string): boolean {
  if (!token || STOP_WORDS.has(token)) return false
  if (/^\d+$/.test(token)) return false
  return token.length >= 2
}

export function tokenizeWriteRetrievalText(text = ''): string[] {
  const source = normalizeLower(text)
  const tokens: string[] = []

  const latinTerms = source.match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? []
  for (const term of latinTerms) {
    if (tokenAllowed(term)) tokens.push(term)
  }

  const hanSegments = source.match(/\p{Script=Han}+/gu) ?? []
  for (const segment of hanSegments) {
    const chars = [...segment].slice(0, 120)
    if (chars.length === 1) {
      tokens.push(chars[0])
      continue
    }
    for (let size = 2; size <= Math.min(4, chars.length); size += 1) {
      for (let index = 0; index <= chars.length - size; index += 1) {
        tokens.push(chars.slice(index, index + size).join(''))
      }
    }
  }

  return tokens
}

export function termFrequency(tokens: string[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const token of tokens) {
    map.set(token, (map.get(token) ?? 0) + 1)
  }
  return map
}

export function isWithinWorkspace(workspaceRoot: string, targetPath: string): boolean {
  const rel = relative(workspaceRoot, targetPath)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function resolveWorkspaceRoot(raw: string | undefined): string {
  const value = raw?.trim()
  if (!value) return ''
  return resolve(expandHomePath(value))
}

export function resolveComparablePath(raw: string | undefined): string {
  const value = raw?.trim()
  if (!value) return ''
  return resolve(expandHomePath(value))
}

export function isIndexedFile(path: string, includePdf: boolean): boolean {
  const ext = extname(path).toLowerCase()
  return isWriteTextFileExtension(ext) || (includePdf && isWritePdfFileExtension(ext))
}

export async function scanWorkspaceFiles(
  workspaceRoot: string,
  deadline: number,
  includePdf: boolean
): Promise<string[]> {
  const files: string[] = []
  const stack = [workspaceRoot]
  let scanned = 0

  while (
    stack.length > 0 &&
    scanned < MAX_SCAN_ENTRIES &&
    files.length < MAX_INDEX_FILES &&
    !deadlineExceeded(deadline)
  ) {
    const current = stack.pop()!
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }

    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    for (const entry of entries) {
      if (deadlineExceeded(deadline)) break
      scanned += 1
      if (scanned >= MAX_SCAN_ENTRIES || files.length >= MAX_INDEX_FILES) break
      if (entry.name === '.DS_Store') continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(path)
        continue
      }
      if (entry.isFile() && isIndexedFile(path, includePdf)) files.push(path)
    }
  }

  return files
}

export function cleanHeading(text: string): string {
  return text
    .replace(/^#{1,6}\s+/, '')
    .replace(/\s+#+\s*$/, '')
    .trim()
}

export function headingFromLine(text: string): string | null {
  const match = text.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/)
  return match ? cleanHeading(match[0]) : null
}

export function buildChunk(
  path: string,
  relativePath: string,
  title: string,
  lines: string[],
  location: WriteRetrievalSnippetLocation
): IndexedChunk | null {
  const raw = lines.join('\n').trim()
  const text = raw.length > MAX_CHUNK_CHARS + 160 ? `${raw.slice(0, MAX_CHUNK_CHARS).trimEnd()}...` : raw
  if (compactText(text).length < MIN_CHUNK_CHARS) return null

  const tokens = tokenizeWriteRetrievalText(`${title}\n${text}`).slice(0, MAX_TOKENS_PER_CHUNK)
  if (tokens.length === 0) return null
  return {
    path,
    relativePath,
    title,
    text,
    lowerText: normalizeLower(text),
    tokens,
    termFrequency: termFrequency(tokens),
    titleTokens: new Set(tokenizeWriteRetrievalText(title)),
    pathTokens: new Set(tokenizeWriteRetrievalText(relativePath.replace(/[\\/._-]+/g, ' '))),
    location
  }
}

export function chunkMarkdown(path: string, relativePath: string, content: string): IndexedChunk[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  const chunks: IndexedChunk[] = []
  let currentTitle = basename(path)
  let buffer: string[] = []
  let lineStart = 1
  let charCount = 0

  const flush = (): void => {
    const chunk = buildChunk(path, relativePath, currentTitle, buffer, {
      kind: 'text',
      lineStart,
      lineEnd: lineStart + buffer.length - 1
    })
    if (chunk) chunks.push(chunk)
    buffer = []
    charCount = 0
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const heading = headingFromLine(line)
    if (heading) {
      if (buffer.length > 0) flush()
      currentTitle = heading
      lineStart = index + 1
    } else if (buffer.length === 0) {
      lineStart = index + 1
    }

    buffer.push(line)
    charCount += line.length + 1
    const paragraphBreak = !line.trim() && charCount >= 360
    if (paragraphBreak || charCount >= MAX_CHUNK_CHARS) flush()
  }

  if (buffer.length > 0) flush()
  return chunks
}

export function chunkPdfPage(
  path: string,
  relativePath: string,
  page: WritePdfTextPage
): IndexedChunk[] {
  const paragraphs = page.text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}|(?<=[。.!?！？])\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
  const chunks: IndexedChunk[] = []
  let buffer: string[] = []
  let charCount = 0

  const flush = (): void => {
    const chunk = buildChunk(path, relativePath, `Page ${page.page}`, buffer, {
      kind: 'pdf',
      pageStart: page.page,
      pageEnd: page.page
    })
    if (chunk) chunks.push(chunk)
    buffer = []
    charCount = 0
  }

  for (const paragraph of paragraphs.length > 0 ? paragraphs : [page.text]) {
    buffer.push(paragraph)
    charCount += paragraph.length + 1
    if (charCount >= MAX_CHUNK_CHARS) flush()
  }
  if (buffer.length > 0) flush()
  return chunks
}

export async function chunkPdf(
  path: string,
  workspaceRoot: string,
  relativePath: string
): Promise<IndexedChunk[]> {
  const result = await readWritePdfText({ path, workspaceRoot })
  if (!result.ok || !result.hasText) return []
  const chunks: IndexedChunk[] = []
  for (const page of result.pages) {
    if (chunks.length >= MAX_INDEX_CHUNKS) break
    chunks.push(...chunkPdfPage(path, relativePath, page))
  }
  return chunks
}

export async function readIndexableFile(path: string, deadline: number): Promise<string> {
  if (deadlineExceeded(deadline)) return ''
  const info = await stat(path)
  if (!info.isFile() || info.size <= 0) return ''
  const maxBytes = Math.min(info.size, MAX_FILE_BYTES)
  const handle = await openFile(path, 'r')
  try {
      const buffer = Buffer.alloc(maxBytes)
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
      const bytes = buffer.subarray(0, bytesRead)
      if (bytes.includes(0)) return ''
      if (deadlineExceeded(deadline)) return ''
      const text = bytes.toString('utf8')
      await testHooks.afterFileRead?.(path)
      return text
  } finally {
    await handle.close()
  }
}

export function workspaceIndexCacheKey(workspaceRoot: string, includePdf: boolean): string {
  return `${workspaceRoot}::${includePdf ? 'pdf' : 'text'}`
}

export async function buildWorkspaceIndex(
  workspaceRoot: string,
  options: WorkspaceIndexOptions
): Promise<WorkspaceIndex> {
  await testHooks.beforeIndexBuild?.(workspaceRoot)
  const deadline = Date.now() + options.buildMs
  const scannedFiles = await scanWorkspaceFiles(workspaceRoot, deadline, options.includePdf)
  const prioritizedFreshPaths = (options.freshPaths ?? [])
    .map(resolveComparablePath)
    .filter((path) => (
      path && isWithinWorkspace(workspaceRoot, path) && isIndexedFile(path, options.includePdf)
    ))
  const files = [...new Set([...prioritizedFreshPaths, ...scannedFiles])].slice(0, MAX_INDEX_FILES)
  const chunks: IndexedChunk[] = []
  const fileSignatures = new Map<string, string>()
  let indexedFiles = 0

  for (const path of files) {
    if (chunks.length >= MAX_INDEX_CHUNKS || deadlineExceeded(deadline)) break
    try {
      const relativePath = normalizeRelativePath(relative(workspaceRoot, path) || basename(path))
      const ext = extname(path).toLowerCase()
      for (let attempt = 0; attempt < MAX_STABLE_FILE_READ_ATTEMPTS; attempt += 1) {
        const signatureBefore = await fileSignature(path)
        const fileChunks = isWritePdfFileExtension(ext)
          ? await chunkPdf(path, workspaceRoot, relativePath)
          : chunkMarkdown(path, relativePath, await readIndexableFile(path, deadline))
        const signatureAfter = await fileSignature(path)
        if (signatureBefore !== signatureAfter) continue
        fileSignatures.set(resolveComparablePath(path), signatureAfter)
        if (fileChunks.length > 0) indexedFiles += 1
        chunks.push(...fileChunks.slice(0, Math.max(0, MAX_INDEX_CHUNKS - chunks.length)))
        break
      }
    } catch {
      /* Ignore unreadable files and keep completion responsive. */
    }
  }

  const documentFrequency = new Map<string, number>()
  let tokenCount = 0
  for (const chunk of chunks) {
    tokenCount += chunk.tokens.length
    for (const token of new Set(chunk.tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
    }
  }

  const index = {
    workspaceRoot,
    builtAt: Date.now(),
    files: indexedFiles,
    fileSignatures,
    chunks,
    averageLength: chunks.length > 0 ? tokenCount / chunks.length : 1,
    documentFrequency
  }
  await testHooks.beforeIndexReturn?.(workspaceRoot)
  return index
}

async function buildWorkspaceIndexWithFreshPaths(
  workspaceRoot: string,
  options: WorkspaceIndexOptions,
  freshPaths: readonly string[]
): Promise<WorkspaceIndex> {
  if (freshPaths.length === 0) return buildWorkspaceIndex(workspaceRoot, options)
  for (let attempt = 0; attempt < MAX_FRESH_INDEX_BUILD_ATTEMPTS; attempt += 1) {
    const before = await captureFileSignatures(freshPaths)
    const index = await buildWorkspaceIndex(workspaceRoot, options)
    const after = await captureFileSignatures(freshPaths)
    if (
      fileSignaturesMatch(before, after) &&
      await cachedIndexMatchesFreshPaths(index, freshPaths)
    ) return index
  }
  throw new Error('The current file changed while Work retrieval was indexing it. Please retry.')
}

export async function loadWorkspaceIndex(
  workspaceRoot: string,
  options: WorkspaceIndexOptions
): Promise<WorkspaceIndex> {
  const cacheKey = workspaceIndexCacheKey(workspaceRoot, options.includePdf)
  const freshPaths = [...new Set(
    (options.freshPaths ?? [])
      .map(resolveComparablePath)
      .filter((path) => path && isIndexedFile(path, options.includePdf))
  )]
  pruneIndexCache(Date.now())
  const cached = indexCache.get(cacheKey)
  if (cached && await cachedIndexMatchesFreshPaths(cached, freshPaths)) {
    indexCache.delete(cacheKey)
    indexCache.set(cacheKey, cached)
    return cached
  }
  if (cached) indexCache.delete(cacheKey)
  const existing = inFlightIndexCache.get(cacheKey)
  if (existing) {
    const index = await existing
    if (await cachedIndexMatchesFreshPaths(index, freshPaths)) return index
    if (indexCache.get(cacheKey) === index) indexCache.delete(cacheKey)
    if (inFlightIndexCache.get(cacheKey) === existing) {
      inFlightIndexCache.delete(cacheKey)
      invalidateInFlightIndexBuild(cacheKey)
    }
    return loadWorkspaceIndex(workspaceRoot, options)
  }

  const buildGeneration = currentIndexBuildGeneration(cacheKey)
  const build = buildWorkspaceIndexWithFreshPaths(workspaceRoot, options, freshPaths)
    .then((index) => {
      if (currentIndexBuildGeneration(cacheKey) === buildGeneration) {
        indexCache.delete(cacheKey)
        indexCache.set(cacheKey, index)
        pruneIndexCache(Date.now())
      }
      return index
    })
    .finally(() => {
      if (inFlightIndexCache.get(cacheKey) === build) inFlightIndexCache.delete(cacheKey)
    })

  inFlightIndexCache.set(cacheKey, build)
  return build
}
