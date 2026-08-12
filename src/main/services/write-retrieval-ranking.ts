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

import {
  DEFAULT_MAX_SNIPPETS,
  IndexedChunk,
  MAX_ASSISTANT_INDEX_BUILD_MS,
  MAX_INDEX_BUILD_MS,
  MAX_QUERY_TERMS,
  MAX_SNIPPET_CHARS,
  QueryModel,
  WorkspaceIndex,
  clipTail,
  compactText,
  inFlightIndexCache,
  indexBuildGenerations,
  indexCache,
  isWithinWorkspace,
  loadWorkspaceIndex,
  normalizeLower,
  resolveComparablePath,
  resolveWorkspaceRoot,
  termFrequency,
  tokenizeWriteRetrievalText
} from './write-retrieval-index'

export function addWeightedTerms(weights: Map<string, number>, text: string, weight: number): void {
  for (const token of tokenizeWriteRetrievalText(text)) {
    weights.set(token, (weights.get(token) ?? 0) + weight)
  }
}

export function extractPhrases(request: WriteInlineCompletionRequest): string[] {
  const candidates = [
    request.context.currentLinePrefix,
    request.context.previousNonEmptyLine,
    request.context.previousLine,
    request.editCandidate?.original,
    ...(request.recentEdits ?? []).flatMap((edit) => [edit.deletedText, edit.insertedText])
  ]
  const phrases: string[] = []
  for (const candidate of candidates) {
    const compact = compactText(candidate)
    if (compact.length >= 8) phrases.push(normalizeLower(clipTail(compact, 80)))
  }
  return [...new Set(phrases)].slice(0, 4)
}

export function buildQueryModel(request: WriteInlineCompletionRequest): QueryModel {
  const weights = new Map<string, number>()
  addWeightedTerms(weights, request.context.currentLinePrefix, 3)
  addWeightedTerms(weights, request.context.previousNonEmptyLine, 2)
  addWeightedTerms(weights, request.context.previousLine, 1.4)
  addWeightedTerms(weights, request.editCandidate?.original ?? '', 1.8)
  addWeightedTerms(weights, request.preview.documentTail, 1)
  for (const edit of request.recentEdits ?? []) {
    addWeightedTerms(weights, edit.deletedText, 1.6)
    addWeightedTerms(weights, edit.insertedText, 1.8)
  }
  addWeightedTerms(weights, clipTail(request.prefix, 700), 0.7)

  const ranked = [...weights.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))
    .slice(0, MAX_QUERY_TERMS)
  const terms = ranked.map(([term]) => term)
  const queryText = compactText([
    request.context.currentLinePrefix,
    request.context.previousNonEmptyLine,
    request.editCandidate?.original ?? '',
    ...(request.recentEdits ?? []).flatMap((edit) => [edit.deletedText, edit.insertedText]),
    request.preview.documentTail
  ].join(' ')).slice(0, 240)
  return {
    text: queryText,
    terms,
    weights: new Map(ranked),
    phrases: extractPhrases(request)
  }
}

export function buildQueryModelFromText(text: string): QueryModel {
  const weights = new Map<string, number>()
  addWeightedTerms(weights, text, 2)
  const compact = compactText(text)
  const ranked = [...weights.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))
    .slice(0, MAX_QUERY_TERMS)
  return {
    text: compact.slice(0, 240),
    terms: ranked.map(([term]) => term),
    weights: new Map(ranked),
    phrases: compact.length >= 8 ? [normalizeLower(clipTail(compact, 80))] : []
  }
}

export function bm25Score(chunk: IndexedChunk, index: WorkspaceIndex, query: QueryModel): number {
  const totalDocs = Math.max(1, index.chunks.length)
  const averageLength = Math.max(1, index.averageLength)
  const k1 = 1.2
  const b = 0.72
  let score = 0

  for (const term of query.terms) {
    const tf = chunk.termFrequency.get(term) ?? 0
    if (!tf) continue
    const df = index.documentFrequency.get(term) ?? 0
    const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5))
    const normalized = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (chunk.tokens.length / averageLength)))
    const weight = query.weights.get(term) ?? 1
    score += weight * idf * normalized
  }

  return score
}

export function keywordScore(chunk: IndexedChunk, query: QueryModel): { score: number; keywords: string[] } {
  const keywords: string[] = []
  let score = 0
  for (const term of query.terms) {
    if (!chunk.termFrequency.has(term)) continue
    keywords.push(term)
    const weight = query.weights.get(term) ?? 1
    if (chunk.titleTokens.has(term)) score += 0.35 * weight
    if (chunk.pathTokens.has(term)) score += 0.18 * weight
  }
  if (keywords.length > 0) score += Math.sqrt(keywords.length) * 0.18

  for (const phrase of query.phrases) {
    if (phrase.length >= 8 && chunk.lowerText.includes(phrase)) score += 0.9
  }

  return { score, keywords: keywords.slice(0, 8) }
}

export function bestSnippetText(chunk: IndexedChunk, keywords: string[]): string {
  const compact = chunk.text.replace(/\r\n?/g, '\n').trim()
  if (compact.length <= MAX_SNIPPET_CHARS) return compact

  const lower = normalizeLower(compact)
  let bestIndex = -1
  for (const keyword of keywords) {
    const index = lower.indexOf(keyword)
    if (index >= 0 && (bestIndex < 0 || index < bestIndex)) bestIndex = index
  }
  const center = bestIndex >= 0 ? bestIndex : Math.floor(compact.length / 2)
  const start = Math.max(0, center - Math.floor(MAX_SNIPPET_CHARS / 2))
  const end = Math.min(compact.length, start + MAX_SNIPPET_CHARS)
  const prefix = start > 0 ? '...' : ''
  const suffix = end < compact.length ? '...' : ''
  return `${prefix}${compact.slice(start, end).trim()}${suffix}`
}

export function rankChunks(
  index: WorkspaceIndex,
  query: QueryModel,
  currentFilePath: string,
  maxSnippets: number,
  includeCurrentFile: boolean
): WriteRetrievalSnippet[] {
  const ranked = index.chunks
    .filter((chunk) => includeCurrentFile || !currentFilePath || resolveComparablePath(chunk.path) !== currentFilePath)
    .map((chunk) => {
      const keyword = keywordScore(chunk, query)
      const score = bm25Score(chunk, index, query) + keyword.score
      return {
        chunk,
        score,
        keywords: keyword.keywords
      }
    })
    .filter((item) => item.score >= 0.25 && item.keywords.length > 0)
    .sort((a, b) => b.score - a.score)

  const snippets: WriteRetrievalSnippet[] = []
  const perFile = new Map<string, number>()
  const seenText = new Set<string>()
  for (const item of ranked) {
    if (snippets.length >= maxSnippets) break
    const used = perFile.get(item.chunk.path) ?? 0
    if (used >= 2) continue
    const snippetText = bestSnippetText(item.chunk, item.keywords)
    const signature = compactText(snippetText).slice(0, 120)
    if (!signature || seenText.has(signature)) continue
    seenText.add(signature)
    perFile.set(item.chunk.path, used + 1)
    snippets.push({
      path: item.chunk.relativePath,
      title: item.chunk.title,
      text: snippetText,
      score: Number(item.score.toFixed(3)),
      keywords: item.keywords,
      location: item.chunk.location,
      ...(item.chunk.location.kind === 'text'
        ? { lineStart: item.chunk.location.lineStart, lineEnd: item.chunk.location.lineEnd }
        : { pageStart: item.chunk.location.pageStart, pageEnd: item.chunk.location.pageEnd })
    })
  }
  return snippets
}

export async function retrieveWriteInlineCompletionContext(
  request: WriteInlineCompletionRequest,
  options: { maxSnippets?: number } = {}
): Promise<WriteRetrievalContext | null> {
  const workspaceRoot = resolveWorkspaceRoot(request.workspaceRoot)
  if (!workspaceRoot) return null
  const currentFilePath = resolveComparablePath(request.currentFilePath)
  if (currentFilePath && !isWithinWorkspace(workspaceRoot, currentFilePath)) return null

  const index = await loadWorkspaceIndex(workspaceRoot, {
    includePdf: false,
    buildMs: MAX_INDEX_BUILD_MS
  })
  if (index.chunks.length === 0) return null

  const query = buildQueryModel(request)
  if (query.terms.length === 0) return null

  const snippets = rankChunks(
    index,
    query,
    currentFilePath,
    Math.max(1, Math.min(6, Math.round(options.maxSnippets ?? DEFAULT_MAX_SNIPPETS))),
    false
  )
  if (snippets.length === 0) return null

  return {
    source: 'bm25-keyword',
    query: query.text,
    keywords: query.terms.slice(0, 12),
    snippets,
    indexedFiles: index.files,
    indexedChunks: index.chunks.length
  }
}

export async function retrieveWriteContext(
  request: WriteRetrievalRequest
): Promise<WriteRetrievalContext | null> {
  const workspaceRoot = resolveWorkspaceRoot(request.workspaceRoot)
  if (!workspaceRoot) return null
  const currentFilePath = resolveComparablePath(request.currentFilePath)
  if (currentFilePath && !isWithinWorkspace(workspaceRoot, currentFilePath)) return null

  const index = await loadWorkspaceIndex(workspaceRoot, {
    includePdf: true,
    buildMs: MAX_ASSISTANT_INDEX_BUILD_MS,
    ...(request.includeCurrentFile !== false && currentFilePath
      ? { freshPaths: [currentFilePath] }
      : {})
  })
  if (index.chunks.length === 0) return null

  const query = buildQueryModelFromText(request.query)
  if (query.terms.length === 0) return null

  const snippets = rankChunks(
    index,
    query,
    currentFilePath,
    Math.max(1, Math.min(8, Math.round(request.maxSnippets ?? DEFAULT_MAX_SNIPPETS))),
    request.includeCurrentFile !== false
  )
  if (snippets.length === 0) return null

  return {
    source: 'bm25-keyword',
    query: query.text,
    keywords: query.terms.slice(0, 12),
    snippets,
    indexedFiles: index.files,
    indexedChunks: index.chunks.length
  }
}

export function clearWriteRetrievalCache(): void {
  indexCache.clear()
  inFlightIndexCache.clear()
  indexBuildGenerations.clear()
}
