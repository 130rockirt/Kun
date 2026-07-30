import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { LocalToolHost, type LocalTool } from './local-tool-host.js'
import { formatSize } from './truncate.js'
import { DEFAULT_READ_MAX_FILE_BYTES, type ReadLocalToolOptions } from './builtin-tool-types.js'
import { defaultReadLocalToolOperations } from './builtin-tool-operations.js'
import {
  formatDimensionNote,
  getReadClassification,
  isBinaryBuffer,
  normalizePositiveInteger,
  resolveWorkspacePath,
  withToolBoundary
} from './builtin-tool-utils.js'

export function createReadLocalTool(options: ReadLocalToolOptions = {}): LocalTool {
  const statOp = options.operations?.stat ?? defaultReadLocalToolOperations.stat!
  const readFileOp = options.operations?.readFile ?? defaultReadLocalToolOperations.readFile!
  const detectImageMimeTypeOp =
    options.operations?.detectImageMimeType ?? defaultReadLocalToolOperations.detectImageMimeType!
  const resizeImageOp = options.operations?.resizeImage
  const autoResizeImages = options.autoResizeImages ?? true
  // An explicit option remains a host-side safety policy. The built-in default
  // deliberately does not reject large text files: result paging is governed
  // by the model-visible dispatch budget instead.
  const maxFileBytes = options.maxFileBytes === undefined
    ? undefined
    : normalizePositiveInteger(options.maxFileBytes, options.maxFileBytes)
  return LocalToolHost.defineTool({
    name: 'read',
    description: 'Read a workspace file. Returns the largest contiguous line range that fits the current context; use next_offset to continue.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: { type: 'number' },
        limit: { type: 'number', description: 'Optional maximum number of lines for this page.' },
        expected_revision: { type: 'string', description: 'Revision returned by a previous page; prevents combining changed file versions.' }
      },
      required: ['path'],
      additionalProperties: false
    },
    policy: 'auto',
    toolKind: 'tool_call',
    sideEffect: 'read-only',
    execute: async (args, context) => withToolBoundary(async () => {
      const rawPath = typeof args.path === 'string' ? args.path : ''
      if (!rawPath.trim()) {
        return {
          output: {
            code: 'missing_path',
            error: 'path is required',
            hint: 'Pass a workspace-relative file path to read. If the target file is unknown, use ls, glob, or grep first.',
            expected_argument: { path: 'relative/path/from/workspace' },
            examples: [
              { path: 'README.md' },
              { path: 'src/main.ts' }
            ]
          },
          isError: true
        }
      }
      const { absolutePath, relativePath } = await resolveWorkspacePath(rawPath, context)
      const fileStat = await statOp(absolutePath)
      const fileSize = typeof fileStat.size === 'bigint' ? Number(fileStat.size) : fileStat.size
      const revision = `${String(fileStat.size)}:${String(fileStat.mtimeMs)}`
      const expectedRevision = typeof args.expected_revision === 'string' ? args.expected_revision : undefined
      if (expectedRevision && expectedRevision !== revision) {
        return {
          output: {
            code: 'file_revision_mismatch',
            error: 'file changed since the previous page; restart the read without expected_revision',
            path: absolutePath,
            relative_path: relativePath,
            expected_revision: expectedRevision,
            revision
          },
          isError: true
        }
      }
      if (maxFileBytes !== undefined && typeof fileStat.size === 'number' && fileStat.size > maxFileBytes) {
        return {
          output: {
            code: 'file_too_large',
            error: `refusing to read ${formatSize(fileStat.size)} file (maximum ${formatSize(maxFileBytes)})`,
            path: absolutePath,
            relative_path: relativePath,
            byte_size: fileStat.size,
            max_file_bytes: maxFileBytes,
            hint: 'Use grep, a narrower file, or a byte-limited command after explicit approval.'
          },
          isError: true
        }
      }
      if (!options.operations?.readFile && fileSize > DEFAULT_READ_MAX_FILE_BYTES) {
        return readLargeTextPage({ absolutePath, relativePath, classification: getReadClassification(absolutePath, context.workspace), args, context, revision, byteSize: fileSize, maxLines: options.maxLines, maxBytes: options.maxBytes })
      }
      const fileBuffer = await readFileOp(absolutePath)
      // A file can grow between stat() and readFile(). Never continue to
      // transform or base64-encode an unexpectedly large buffer.
      if (maxFileBytes !== undefined && fileBuffer.length > maxFileBytes) {
        return {
          output: {
            code: 'file_too_large',
            error: `refusing to read ${formatSize(fileBuffer.length)} file (maximum ${formatSize(maxFileBytes)})`,
            path: absolutePath,
            relative_path: relativePath,
            byte_size: fileBuffer.length,
            max_file_bytes: maxFileBytes,
            hint: 'Use grep, a narrower file, or a byte-limited command after explicit approval.'
          },
          isError: true
        }
      }
      const classification = getReadClassification(absolutePath, context.workspace)
      const image = detectImageMimeTypeOp(fileBuffer)
      if (image) {
        if (autoResizeImages && resizeImageOp) {
          const resized = await resizeImageOp(fileBuffer, image.mimeType)
          if (!resized) {
            return {
              output: {
                path: absolutePath,
                relative_path: relativePath,
                kind: 'image',
                mime_type: image.mimeType,
                width: image.width ?? null,
                height: image.height ?? null,
                byte_size: fileBuffer.length,
                note: `Read image file [${image.mimeType}]\n[Image omitted: could not be resized below the inline image size limit.]`,
                classification: classification ?? null
              }
            }
          }
          const dimensionNote = formatDimensionNote(resized)
          return {
            output: {
              path: absolutePath,
              relative_path: relativePath,
              kind: 'image',
              mime_type: resized.mimeType,
              width: resized.width,
              height: resized.height,
              byte_size: fileBuffer.length,
              data_base64: resized.dataBase64,
              note: dimensionNote
                ? `Read image file [${resized.mimeType}]\n${dimensionNote}`
                : `Read image file [${resized.mimeType}]`,
              classification: classification ?? null,
              resized: resized.wasResized === true
            }
          }
        }
        return {
          output: {
            path: absolutePath,
            relative_path: relativePath,
            kind: 'image',
            mime_type: image.mimeType,
            width: image.width ?? null,
            height: image.height ?? null,
            byte_size: fileBuffer.length,
            data_base64: fileBuffer.toString('base64'),
            note: `Read image file [${image.mimeType}]`,
            classification: classification ?? null
          }
        }
      }
      if (isBinaryBuffer(fileBuffer)) {
        return { output: { error: 'read only supports text files in Kun serve mode', path: absolutePath }, isError: true }
      }
      const text = fileBuffer.toString('utf8').replace(/\r\n/g, '\n')
      const allLines = text.split('\n')
      const offset = Math.max(1, normalizePositiveInteger(args.offset, 1))
      const requestedLimit = typeof args.limit === 'number' && Number.isFinite(args.limit)
        ? Math.max(1, Math.floor(args.limit))
        : Number.MAX_SAFE_INTEGER
      const lineLimit = Math.min(requestedLimit, options.maxLines ?? Number.MAX_SAFE_INTEGER)
      const byteBudget = Math.max(
        512,
        Math.min(
          options.maxBytes ?? Number.MAX_SAFE_INTEGER,
          Math.floor((context.sourceResultBudgetTokens ?? 128_000) * 3)
        )
      )
      const lines: string[] = []
      let shownBytes = 0
      let firstLineExceedsLimit = false
      for (let index = offset - 1; index < allLines.length && lines.length < lineLimit; index += 1) {
        const line = allLines[index] ?? ''
        const nextBytes = Buffer.byteLength(line, 'utf8') + (lines.length > 0 ? 1 : 0)
        if (shownBytes + nextBytes > byteBudget) {
          firstLineExceedsLimit = lines.length === 0
          break
        }
        lines.push(line)
        shownBytes += nextBytes
      }
      const shownLines = lines.length
      const endLine = shownLines > 0 ? offset + shownLines - 1 : firstLineExceedsLimit ? offset : offset - 1
      const hasMore = endLine < allLines.length
      const truncated = firstLineExceedsLimit || hasMore
      const truncationBy = truncated
        ? (shownLines >= lineLimit ? 'requested_limit' : 'context_budget')
        : null
      const content = firstLineExceedsLimit
        ? `[first line exceeds the ${formatSize(byteBudget)} context budget at line ${offset}; the line was omitted. Use grep or an approved byte-limited command to inspect it.]`
        : lines.join('\n')
      return {
        output: {
          path: absolutePath,
          relative_path: relativePath,
          content,
          classification: classification ?? null,
          start_line: offset,
          end_line: endLine,
          total_lines: allLines.length,
          byte_size: fileBuffer.length,
          revision,
          truncated,
          has_more: hasMore,
          next_offset: hasMore ? endLine + 1 : null,
          truncation_by: truncationBy,
          first_line_exceeds_limit: firstLineExceedsLimit
        }
      }
    })
  })
}

export const createReadTool = createReadLocalTool
export const createReadToolDefinition = createReadLocalTool

async function readLargeTextPage(input: {
  absolutePath: string
  relativePath: string
  classification: ReturnType<typeof getReadClassification>
  args: Record<string, unknown>
  context: { sourceResultBudgetTokens?: number; abortSignal: AbortSignal }
  revision: string
  byteSize: number
  maxLines?: number
  maxBytes?: number
}): Promise<{ output: unknown; isError?: boolean }> {
  const offset = Math.max(1, normalizePositiveInteger(input.args.offset, 1))
  const requestedLimit = typeof input.args.limit === 'number' && Number.isFinite(input.args.limit)
    ? Math.max(1, Math.floor(input.args.limit)) : Number.MAX_SAFE_INTEGER
  const lineLimit = Math.min(requestedLimit, input.maxLines ?? Number.MAX_SAFE_INTEGER)
  const byteBudget = Math.max(512, Math.min(input.maxBytes ?? Number.MAX_SAFE_INTEGER, Math.floor((input.context.sourceResultBudgetTokens ?? 128_000) * 3)))
  const lines: string[] = []
  let totalLines = 0
  let shownBytes = 0
  let binary = false
  let firstLineExceedsLimit = false
  let collecting = true
  const stream = createReadStream(input.absolutePath, { encoding: 'utf8' })
  const onAbort = () => stream.destroy(new Error('command aborted'))
  input.context.abortSignal.addEventListener('abort', onAbort, { once: true })
  try {
    const reader = createInterface({ input: stream, crlfDelay: Infinity })
    for await (const line of reader) {
      totalLines += 1
      if (line.includes('\u0000')) binary = true
      if (totalLines < offset || !collecting) continue
      if (lines.length >= lineLimit) {
        collecting = false
        continue
      }
      const bytes = Buffer.byteLength(line, 'utf8') + (lines.length > 0 ? 1 : 0)
      if (shownBytes + bytes > byteBudget) {
        firstLineExceedsLimit = lines.length === 0
        collecting = false
        continue
      }
      lines.push(line)
      shownBytes += bytes
    }
  } finally {
    input.context.abortSignal.removeEventListener('abort', onAbort)
  }
  if (binary) return { output: { error: 'read only supports text files in Kun serve mode', path: input.absolutePath }, isError: true }
  const endLine = lines.length > 0 ? offset + lines.length - 1 : firstLineExceedsLimit ? offset : offset - 1
  const hasMore = endLine < totalLines
  const truncated = firstLineExceedsLimit || hasMore
  const content = firstLineExceedsLimit
    ? `[first line exceeds the ${formatSize(byteBudget)} context budget at line ${offset}; the line was omitted. Use grep or an approved byte-limited command to inspect it.]`
    : lines.join('\n')
  return {
    output: {
      path: input.absolutePath,
      relative_path: input.relativePath,
      content,
      classification: input.classification ?? null,
      start_line: offset,
      end_line: endLine,
      total_lines: totalLines,
      byte_size: input.byteSize,
      revision: input.revision,
      truncated,
      has_more: hasMore,
      next_offset: hasMore ? endLine + 1 : null,
      truncation_by: truncated ? (lines.length >= lineLimit ? 'requested_limit' : 'context_budget') : null,
      first_line_exceeds_limit: firstLineExceedsLimit
    }
  }
}
