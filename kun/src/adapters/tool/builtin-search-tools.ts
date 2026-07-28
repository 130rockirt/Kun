import { readFile, stat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { LocalToolHost, type LocalTool } from './local-tool-host.js'
import type { FindLocalToolOptions, GrepLocalToolOptions, GrepMatch, LsLocalToolOptions } from './builtin-tool-types.js'
import {
  DEFAULT_GREP_MAX_CONTEXT_LINES,
  DEFAULT_LIST_LIMIT,
  FD_EXECUTABLE_CANDIDATES,
  RG_EXECUTABLE_CANDIDATES
} from './builtin-tool-types.js'
import { defaultLsLocalToolOperations } from './builtin-tool-operations.js'
import {
  collectPaths,
  globToRegExp,
  isBinaryBuffer,
  listDirectoryWithOps,
  normalizeBoolean,
  normalizePositiveInteger,
  normalizeToolPath,
  resolveExecutable,
  resolveWorkspacePath,
  spawnCapture,
  withToolBoundary
} from './builtin-tool-utils.js'

const MAX_SOURCE_SCAN_ENTRIES = 1_000_000

export function createLsLocalTool(options: LsLocalToolOptions = {}): LocalTool {
  const statOp = options.operations?.stat ?? defaultLsLocalToolOperations.stat!
  const readdirOp = options.operations?.readdir ?? defaultLsLocalToolOperations.readdir!
  return LocalToolHost.defineTool({
    name: 'ls',
    description: 'List directory contents. Returns entries sorted alphabetically and marks directories.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        limit: { type: 'number' }
      },
      required: [],
      additionalProperties: false
    },
    policy: 'auto',
    execute: async (args, context) => withToolBoundary(async () => {
      const rawPath = typeof args.path === 'string' && args.path.trim() ? args.path : '.'
      const limit = normalizePositiveInteger(args.limit, options.defaultLimit ?? DEFAULT_LIST_LIMIT)
      const { workspaceRoot: root, absolutePath, relativePath } = await resolveWorkspacePath(rawPath, context)
      const targetStat = await statOp(absolutePath)
      if (!targetStat.isDirectory()) {
        return {
          output: {
            error: `not a directory: ${absolutePath}`,
            path: absolutePath
          },
          isError: true
        }
      }
      const entries = await listDirectoryWithOps(absolutePath, root, false, limit, statOp, readdirOp)
      return {
        output: {
          path: absolutePath,
          relative_path: relativePath,
          entries: entries.map((entry) => ({
            ...entry,
            display_name: entry.kind === 'directory' ? `${entry.name}/` : entry.name
          })),
          names: entries.map((entry) => (entry.kind === 'directory' ? `${entry.name}/` : entry.name)),
          truncated: entries.length >= limit,
          entry_limit_reached: entries.length >= limit ? limit : null
        }
      }
    })
  })
}

export const createLsTool = createLsLocalTool
export const createLsToolDefinition = createLsLocalTool

export function createGlobLocalTool(options: FindLocalToolOptions = {}): LocalTool {
  return createFileGlobLocalTool('glob', options, true)
}

/** Legacy direct-call compatibility. The model sees `glob`, not this alias. */
export function createFindLocalTool(options: FindLocalToolOptions = {}): LocalTool {
  return createFileGlobLocalTool('find', options, false)
}

function createFileGlobLocalTool(name: 'glob' | 'find', options: FindLocalToolOptions, advertised: boolean): LocalTool {
  return LocalToolHost.defineTool({
    name,
    description: 'Find workspace files by glob pattern. Returns stable cursor pages when more matches exist.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
        limit: { type: 'number', description: 'Optional maximum entries for this page.' },
        cursor: { type: 'string', description: 'Opaque cursor from a previous result for the same pattern and path.' }
      },
      required: ['pattern'],
      additionalProperties: false
    },
    policy: 'auto',
    ...(advertised ? {} : { modelAdvertised: false }),
    execute: async (args, context) => withToolBoundary(async () => {
      const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : ''
      if (!pattern) return { output: { error: 'pattern is required' }, isError: true }
      const rawPath = typeof args.path === 'string' && args.path.trim() ? args.path : '.'
      const limit = normalizePositiveInteger(args.limit, options.defaultLimit ?? defaultSourcePageLimit(context))
      const query = `${pattern}\u0000${rawPath}`
      const cursor = parseCursor(args.cursor, query)
      if (cursor instanceof Error) return { output: { code: 'invalid_cursor', error: cursor.message }, isError: true }
      const { workspaceRoot: root, absolutePath, relativePath } = await resolveWorkspacePath(rawPath, context)
      const matcher = globToRegExp(pattern.includes('/') ? pattern : `**/${pattern}`)
      if (options.operations?.glob) {
        const matches = await options.operations.glob({
          pattern,
          path: absolutePath,
          limit: sourceScanLimit(cursor, limit)
        })
        return {
          output: {
            path: absolutePath,
            relative_path: relativePath,
            pattern,
            ...pageSourceEntries(matches, cursor, limit, context, query),
            backend: 'custom'
          }
        }
      }
      const fd = resolveExecutable(options.fdExecutableCandidates ?? FD_EXECUTABLE_CANDIDATES)
      const rg = resolveExecutable(options.rgExecutableCandidates ?? RG_EXECUTABLE_CANDIDATES)
      let matches: Array<{ path: string; relative_path: string }>
      if (fd) {
        const args = [
          '--glob',
          '--color=never',
          '--hidden',
          '--no-require-git',
          '--max-results',
          String(sourceScanLimit(cursor, limit)),
          '--',
          pattern,
          absolutePath
        ]
        const result = await spawnCapture(fd, args, { cwd: root, signal: context.abortSignal, maxOutputBytes: sourceCaptureBytes(context) })
        const candidates = result.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
        matches = candidates
          .map((path) => ({
            path: resolve(path),
            relative_path: normalizeToolPath(relative(root, resolve(path)) || '.')
          }))
          .slice(0, sourceScanLimit(cursor, limit))
      } else if (rg) {
        const result = await spawnCapture(
          rg,
          ['--files', '--hidden', '--sort', 'path', '-g', pattern, absolutePath],
          { cwd: root, signal: context.abortSignal, maxOutputBytes: sourceCaptureBytes(context) }
        )
        const candidates = result.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
        matches = candidates
          .map((path) => ({
            path: resolve(path),
            relative_path: normalizeToolPath(relative(root, resolve(path)) || '.')
          }))
          .slice(0, sourceScanLimit(cursor, limit))
      } else {
        const paths = await collectPaths(absolutePath, { includeDirectories: false, limit: Number.MAX_SAFE_INTEGER })
        matches = paths
          .map((path) => ({ path, relative_path: normalizeToolPath(relative(root, path) || '.') }))
          .filter((entry) => matcher.test(entry.relative_path))
          .slice(0, sourceScanLimit(cursor, limit))
      }
      return {
        output: {
          path: absolutePath,
          relative_path: relativePath,
          pattern,
          ...pageSourceEntries(matches, cursor, limit, context, query),
          backend: fd ? 'fd' : rg ? 'rg' : 'scan',
          result_limit_reached: null
        }
      }
    })
  })
}

export const createFindTool = createFindLocalTool
export const createFindToolDefinition = createFindLocalTool
export const createGlobTool = createGlobLocalTool
export const createGlobToolDefinition = createGlobLocalTool

type CursorPayload = { query: string; index: number }

function parseCursor(value: unknown, query: string): number | Error {
  if (value === undefined || value === null || value === '') return 0
  if (typeof value !== 'string') return new Error('cursor must be a string')
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as CursorPayload
    if (parsed.query !== query || !Number.isSafeInteger(parsed.index) || parsed.index < 0) {
      return new Error('cursor does not belong to this query')
    }
    return parsed.index
  } catch {
    return new Error('cursor is invalid')
  }
}

function makeCursor(query: string, index: number): string {
  return Buffer.from(JSON.stringify({ query, index } satisfies CursorPayload), 'utf8').toString('base64url')
}

function sourceCaptureBytes(context: { sourceResultBudgetTokens?: number }): number {
  return Math.max(2 * 1024 * 1024, Math.floor((context.sourceResultBudgetTokens ?? 128_000) * 24))
}

function defaultSourcePageLimit(context: { sourceResultBudgetTokens?: number }): number {
  return Math.max(1, Math.min(
    MAX_SOURCE_SCAN_ENTRIES,
    Math.floor((context.sourceResultBudgetTokens ?? 128_000) * 1.5)
  ))
}

function sourceScanLimit(cursor: number, pageLimit: number): number {
  return Math.min(MAX_SOURCE_SCAN_ENTRIES, Math.max(pageLimit + 1, cursor + pageLimit + 1))
}

function pageSourceEntries<T>(
  unsorted: readonly T[],
  cursor: number,
  requestedLimit: number,
  context: { sourceResultBudgetTokens?: number },
  query: string
): { matches: T[]; truncated: boolean; has_more: boolean; next_cursor: string | null } {
  const entries = [...unsorted].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  const byteBudget = Math.max(512, Math.floor((context.sourceResultBudgetTokens ?? 128_000) * 3))
  const matches: T[] = []
  let used = 0
  for (let index = cursor; index < entries.length && matches.length < requestedLimit; index += 1) {
    const entry = entries[index]!
    const bytes = Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1
    if (matches.length > 0 && used + bytes > byteBudget) break
    matches.push(entry)
    used += bytes
  }
  const nextIndex = cursor + matches.length
  const hasMore = nextIndex < entries.length
  return { matches, truncated: hasMore, has_more: hasMore, next_cursor: hasMore ? makeCursor(query, nextIndex) : null }
}

export function createGrepLocalTool(options: GrepLocalToolOptions = {}): LocalTool {
  return LocalToolHost.defineTool({
    name: 'grep',
    description: 'Search file contents for a pattern and return matching lines with paths and line numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
        glob: { type: 'string' },
        ignoreCase: { type: 'boolean' },
        literal: { type: 'boolean' },
        context: { type: 'number' },
        limit: { type: 'number' },
        cursor: { type: 'string', description: 'Opaque cursor from a previous identical grep query.' }
      },
      required: ['pattern'],
      additionalProperties: false
    },
    policy: 'auto',
    execute: async (args, context) => withToolBoundary(async () => {
      const pattern = typeof args.pattern === 'string' ? args.pattern : ''
      if (!pattern.trim()) return { output: { error: 'pattern is required' }, isError: true }
      const literal = normalizeBoolean(args.literal)
      const ignoreCase = normalizeBoolean(args.ignoreCase)
      const contextLines = typeof args.context === 'number' && Number.isFinite(args.context) && args.context > 0
        ? Math.min(DEFAULT_GREP_MAX_CONTEXT_LINES, Math.floor(args.context))
        : 0
      const glob = typeof args.glob === 'string' && args.glob.trim() ? args.glob.trim() : null
      const limit = normalizePositiveInteger(args.limit, options.defaultLimit ?? defaultSourcePageLimit(context))
      const maxFileBytes = options.maxFileBytes
      const maxTotalBytes = options.maxTotalBytes
      const rawPath = typeof args.path === 'string' && args.path.trim() ? args.path : '.'
      const query = JSON.stringify({ pattern, rawPath, glob, ignoreCase, literal, context: contextLines })
      const cursor = parseCursor(args.cursor, query)
      if (cursor instanceof Error) return { output: { code: 'invalid_cursor', error: cursor.message }, isError: true }
      const scanLimit = sourceScanLimit(cursor, limit)
      const flags = ignoreCase ? 'i' : ''
      const effectiveMatcher = literal
        ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)
        : new RegExp(pattern, flags)
      const globMatcher = glob ? globToRegExp(glob.includes('/') ? glob : `**/${glob}`) : null
      const { workspaceRoot: root, absolutePath, relativePath } = await resolveWorkspacePath(rawPath, context)
      if (options.operations?.search) {
        const matches = await options.operations.search({
          pattern,
          path: absolutePath,
          glob,
          ignoreCase,
          literal,
          context: contextLines,
          limit: scanLimit
        })
        return {
          output: {
            path: absolutePath,
            relative_path: relativePath,
            pattern,
            glob,
            ignore_case: ignoreCase,
            literal,
            context: contextLines,
            backend: 'custom',
            ...pageSourceEntries(matches, cursor, limit, context, query),
            match_limit_reached: null
          }
        }
      }
      const matches: GrepMatch[] = []
      const linesByPath = new Map<string, string[] | null>()
      let scannedBytes = 0
      let skippedLargeFiles = 0
      let scanByteLimitReached = false
      let commandOutputTruncated = false
      const loadTextLines = async (candidatePath: string): Promise<string[] | null> => {
        if (linesByPath.has(candidatePath)) return linesByPath.get(candidatePath) ?? null
        try {
          const fileStat = await stat(candidatePath)
          const fileBytes = Math.max(0, fileStat.size)
          if (!fileStat.isFile() ||
            (maxFileBytes !== undefined && fileBytes > maxFileBytes) ||
            (maxTotalBytes !== undefined && scannedBytes + fileBytes > maxTotalBytes)) {
            if (fileStat.isFile() && maxFileBytes !== undefined && fileBytes > maxFileBytes) skippedLargeFiles += 1
            if (fileStat.isFile() && maxTotalBytes !== undefined && scannedBytes + fileBytes > maxTotalBytes) scanByteLimitReached = true
            linesByPath.set(candidatePath, null)
            return null
          }
          const buffer = await readFile(candidatePath)
          // Re-check after opening in case the file changed after stat().
          if ((maxFileBytes !== undefined && buffer.length > maxFileBytes) ||
            (maxTotalBytes !== undefined && scannedBytes + buffer.length > maxTotalBytes)) {
            if (maxFileBytes !== undefined && buffer.length > maxFileBytes) skippedLargeFiles += 1
            if (maxTotalBytes !== undefined && scannedBytes + buffer.length > maxTotalBytes) scanByteLimitReached = true
            linesByPath.set(candidatePath, null)
            return null
          }
          scannedBytes += buffer.length
          if (isBinaryBuffer(buffer)) {
            linesByPath.set(candidatePath, null)
            return null
          }
          const lines = buffer.toString('utf8').replace(/\r\n/g, '\n').split('\n')
          linesByPath.set(candidatePath, lines)
          return lines
        } catch {
          // Files can legitimately disappear while rg/scan is walking a live
          // workspace. Treat that one path as unavailable rather than failing
          // the entire bounded search.
          linesByPath.set(candidatePath, null)
          return null
        }
      }
      const rg = resolveExecutable(options.rgExecutableCandidates ?? RG_EXECUTABLE_CANDIDATES)
      if (rg) {
        const rgArgs = ['--hidden', '--line-number', '--with-filename', '--color', 'never', '--sort', 'path']
        if (ignoreCase) rgArgs.push('--ignore-case')
        if (literal) rgArgs.push('--fixed-strings')
        if (glob) rgArgs.push('-g', glob)
        rgArgs.push(pattern, absolutePath)
        const result = await spawnCapture(rg, rgArgs, {
          cwd: root,
          signal: context.abortSignal,
          maxOutputBytes: sourceCaptureBytes(context)
        })
        commandOutputTruncated = result.outputTruncated
        const rows = result.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
        for (const row of rows) {
          if (matches.length >= scanLimit) break
          const parsed = row.match(/^(.*?):(\d+):(.*)$/)
          if (!parsed) continue
          const candidatePath = resolve(parsed[1] ?? '')
          const lineNumber = Number(parsed[2] ?? '0')
          const lineText = parsed[3] ?? ''
          const candidateRelative = normalizeToolPath(relative(root, candidatePath) || '.')
          if (globMatcher && !globMatcher.test(candidateRelative)) continue
          const columnMatch = effectiveMatcher.exec(lineText)
          const lines = contextLines > 0 ? await loadTextLines(candidatePath) : null
          if (contextLines > 0 && !lines) continue
          matches.push({
            path: candidatePath,
            relative_path: candidateRelative,
            line: lineNumber,
            column: (columnMatch?.index ?? 0) + 1,
            text: lineText,
            ...(contextLines > 0
              ? {
                  context_before: lines!.slice(Math.max(0, lineNumber - 1 - contextLines), lineNumber - 1),
                  context_after: lines!.slice(lineNumber, lineNumber + contextLines)
                }
              : {})
          })
        }
      } else {
        const candidates = await collectPaths(absolutePath, { includeDirectories: false, limit: Number.MAX_SAFE_INTEGER })
        for (const candidatePath of candidates) {
          if (matches.length >= scanLimit) break
          const candidateRelative = normalizeToolPath(relative(root, candidatePath) || '.')
          if (globMatcher && !globMatcher.test(candidateRelative)) continue
          const lines = await loadTextLines(candidatePath)
          if (!lines) continue
          for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index] ?? ''
            const result = effectiveMatcher.exec(line)
            if (!result) continue
            matches.push({
              path: candidatePath,
              relative_path: candidateRelative,
              line: index + 1,
              column: (result.index ?? 0) + 1,
              text: line,
              ...(contextLines > 0
                ? {
                    context_before: lines.slice(Math.max(0, index - contextLines), index),
                    context_after: lines.slice(index + 1, index + 1 + contextLines)
                  }
                : {})
            })
            if (matches.length >= scanLimit) break
          }
        }
      }
      return {
        output: {
          path: absolutePath,
          relative_path: relativePath,
          pattern,
          glob,
          ignore_case: ignoreCase,
          literal,
          context: contextLines,
          backend: rg ? 'rg' : 'scan',
          ...pageSourceEntries(matches, cursor, limit, context, query),
          match_limit_reached: null,
          skipped_large_files: skippedLargeFiles,
          scan_byte_limit_reached: scanByteLimitReached,
          command_output_truncated: commandOutputTruncated
        }
      }
    })
  })
}

export const createGrepTool = createGrepLocalTool
export const createGrepToolDefinition = createGrepLocalTool
