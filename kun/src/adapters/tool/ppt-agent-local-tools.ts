import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import * as yauzl from 'yauzl'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { LocalToolHost, type LocalTool } from './local-tool-host.js'
import { resolveWorkspacePath, withToolBoundary } from './builtin-tool-utils.js'
import { withFileMutationQueue } from './file-mutation-queue.js'
import { assertCanWritePath } from './sandbox-policy.js'

export const PPT_EXPORT_TOOL_NAME = 'ppt_export'
export const PPT_READ_GUIDE_TOOL_NAME = 'ppt_read_guide'

const execFileAsync = promisify(execFile)
const runtimeRequire = createRequire(import.meta.url)
const MAX_EXPORT_OUTPUT_CHARS = 16_000
const MAX_PPTX_BYTES = 500 * 1024 * 1024
const MAX_SLIDE_XML_BYTES = 8 * 1024 * 1024
const MAX_GUIDE_BYTES = 512 * 1024
const DEFAULT_GUIDE_LINES = 180
const MAX_GUIDE_LINES = 400

type PptAgentLocalToolOptions = {
  enabled?: () => boolean
  toolchainDirectory?: () => string | undefined
}

/**
 * Safe, first-party PPT helpers used by the Lab-gated PPT agent. They expose
 * only bundled reference Markdown and one fixed offline WASM exporter; unlike
 * a shell call, neither tool can execute an arbitrary command or escape the
 * active workspace for input/output files.
 */
export function buildPptAgentLocalTools(options: PptAgentLocalToolOptions = {}): LocalTool[] {
  const shouldAdvertise = (_context: ToolHostContext): boolean => options.enabled?.() !== false
  return [
    createPptReadGuideTool(options, shouldAdvertise),
    createPptExportTool(options, shouldAdvertise)
  ]
}

function createPptReadGuideTool(
  options: PptAgentLocalToolOptions,
  shouldAdvertise: (context: ToolHostContext) => boolean
): LocalTool {
  return LocalToolHost.defineTool({
    name: PPT_READ_GUIDE_TOOL_NAME,
    description: 'Read a bounded section of Kun\'s bundled PPTD format or slide-design guide. Paths are relative to the trusted reference directory, for example pptd.md, slides_categories.md, or slides_categories/product.md.',
    toolKind: 'tool_call',
    policy: 'auto',
    sideEffect: 'read-only',
    shouldAdvertise,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative Markdown path inside the bundled PPT reference directory.'
        },
        start_line: {
          type: 'integer',
          minimum: 1,
          description: 'One-based first line. Defaults to 1.'
        },
        max_lines: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_GUIDE_LINES,
          description: `Maximum lines to return. Defaults to ${DEFAULT_GUIDE_LINES}.`
        }
      },
      required: ['path'],
      additionalProperties: false
    },
    execute: async (args) => withToolBoundary(async () => {
      if (options.enabled?.() === false) {
        return { output: { error: 'PPT Agent is disabled in Lab settings' }, isError: true }
      }
      const requested = stringArg(args.path)
      if (!requested || isAbsolute(requested) || extname(requested).toLowerCase() !== '.md') {
        return { output: { error: 'path must be a relative .md file inside the PPT reference directory' }, isError: true }
      }
      const toolchain = await requireToolchainDirectory(options)
      const referenceRoot = resolve(toolchain, 'reference')
      const target = resolve(referenceRoot, requested)
      if (!isInside(referenceRoot, target)) {
        return { output: { error: 'path escapes the PPT reference directory' }, isError: true }
      }
      const info = await stat(target)
      if (!info.isFile() || info.size > MAX_GUIDE_BYTES) {
        return { output: { error: `guide must be a file no larger than ${MAX_GUIDE_BYTES} bytes` }, isError: true }
      }
      const content = await readFile(target, 'utf8')
      const lines = content.split(/\r?\n/)
      const startLine = integerArg(args.start_line, 1, Number.MAX_SAFE_INTEGER, 1)
      const maxLines = integerArg(args.max_lines, 1, MAX_GUIDE_LINES, DEFAULT_GUIDE_LINES)
      const startIndex = Math.min(startLine - 1, lines.length)
      const selected = lines.slice(startIndex, startIndex + maxLines)
      const truncated = startIndex + selected.length < lines.length
      return {
        output: {
          path: requested.replaceAll('\\', '/'),
          start_line: startIndex + 1,
          end_line: startIndex + selected.length,
          total_lines: lines.length,
          content: selected.join('\n'),
          truncated,
          ...(truncated ? { next_line: startIndex + selected.length + 1 } : {})
        }
      }
    })
  })
}

function createPptExportTool(
  options: PptAgentLocalToolOptions,
  shouldAdvertise: (context: ToolHostContext) => boolean
): LocalTool {
  return LocalToolHost.defineTool({
    name: PPT_EXPORT_TOOL_NAME,
    description: [
      'Export a workspace PPTD project to an editable .pptx with Kun\'s bundled offline WASM exporter.',
      'The tool performs a ZIP/OpenXML structure check, counts slides, and verifies the requested fade transition before publishing the output.',
      'It requires no Python, browser, cookie, network access, or arbitrary shell command.'
    ].join(' '),
    toolKind: 'file_change',
    policy: 'auto',
    sideEffect: 'unknown',
    effects: {
      network: false,
      externalWrite: false,
      processExecution: true,
      guiAutomation: false
    },
    shouldAdvertise,
    inputSchema: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'Workspace-relative deck.pptd path or PPTD project directory.'
        },
        output: {
          type: 'string',
          description: 'Workspace-relative .pptx destination.'
        },
        transition: {
          type: 'string',
          enum: ['fade', 'none'],
          description: 'Per-slide transition. Defaults to fade.'
        },
        force: {
          type: 'boolean',
          description: 'Replace an existing output file. Defaults to false.'
        }
      },
      required: ['input', 'output'],
      additionalProperties: false
    },
    execute: async (args, context) => withToolBoundary(async () => {
      if (options.enabled?.() === false) {
        return { output: { error: 'PPT Agent is disabled in Lab settings' }, isError: true }
      }
      const inputArg = stringArg(args.input)
      const outputArg = stringArg(args.output)
      if (!inputArg || !outputArg) {
        return { output: { error: 'input and output are required' }, isError: true }
      }
      if (extname(outputArg).toLowerCase() !== '.pptx') {
        return { output: { error: 'output must end in .pptx' }, isError: true }
      }

      const input = await resolveWorkspacePath(inputArg, context, { enforceWorkspaceBoundary: true })
      const output = await resolveWorkspacePath(outputArg, context, { enforceWorkspaceBoundary: true })
      assertCanWritePath(output.absolutePath, context)
      const inputInfo = await stat(input.absolutePath)
      const canonicalInput = await realpath(input.absolutePath)
      const workspaceRoot = await realpath(input.workspaceRoot)
      if (!isInside(workspaceRoot, canonicalInput)) {
        return { output: { error: 'input resolves outside the active workspace' }, isError: true }
      }
      if (!inputInfo.isDirectory() && extname(input.absolutePath).toLowerCase() !== '.pptd') {
        return { output: { error: 'input must be a PPTD project directory or .pptd manifest' }, isError: true }
      }

      return withFileMutationQueue(output.absolutePath, async () => {
        if (context.abortSignal.aborted) throw new Error('PPT export aborted before start')
        if (args.force !== true) {
          try {
            await access(output.absolutePath)
            return { output: { error: 'output already exists; pass force=true to replace it' }, isError: true }
          } catch {
            // Expected for a new output path.
          }
        }

        const toolchain = await requireToolchainDirectory(options)
      const exporter = resolve(toolchain, 'scripts', 'local-export', 'export-pptd.mjs')
      const wasm = resolve(toolchain, 'scripts', 'local-export', 'pptd_wasm_bg.wasm')
      await Promise.all([access(exporter), access(wasm)])
      await mkdir(dirname(output.absolutePath), { recursive: true })
      const temporaryOutput = join(
        dirname(output.absolutePath),
        `.${randomUUID()}.${output.absolutePath.split(/[\\/]/).pop()}.tmp.pptx`
      )
      assertCanWritePath(temporaryOutput, context)
      const transition = args.transition === 'none' ? 'none' : 'fade'

      try {
        const result = await execFileAsync(
          process.execPath,
          [
            exporter,
            input.absolutePath,
            '--output',
            temporaryOutput,
            '--no-sign',
            '--local-images-only',
            '--transition',
            transition,
            '--wasm',
            wasm
          ],
          {
            cwd: inputInfo.isDirectory() ? input.absolutePath : dirname(input.absolutePath),
            env: {
              ...process.env,
              ELECTRON_RUN_AS_NODE: '1',
              KIMI_COOKIE: '',
              KIMI_ORIGIN: 'http://127.0.0.1',
              KUN_PPT_YAML_MODULE: runtimeRequire.resolve('yaml')
            },
            timeout: 5 * 60 * 1_000,
            maxBuffer: MAX_EXPORT_OUTPUT_CHARS * 4,
            signal: context.abortSignal
          }
        )
        const validation = await validatePptx(temporaryOutput, transition)
        if (args.force === true) await rm(output.absolutePath, { force: true })
        await rename(temporaryOutput, output.absolutePath)
        return {
          output: {
            output: output.relativePath,
            absolutePath: output.absolutePath,
            exporter: 'local-wasm-patched',
            slides: validation.slides,
            fadeTransitions: validation.fadeTransitions,
            bytes: validation.bytes,
            transition,
            validated: true,
            log: truncate(`${result.stdout ?? ''}${result.stderr ?? ''}`)
          }
        }
        } finally {
          await rm(temporaryOutput, { force: true }).catch(() => undefined)
        }
      })
    })
  })
}

async function validatePptx(
  path: string,
  transition: 'fade' | 'none'
): Promise<{ slides: number; fadeTransitions: number; bytes: number }> {
  const info = await stat(path)
  if (!info.isFile() || info.size <= 0 || info.size > MAX_PPTX_BYTES) {
    throw new Error(`exported PPTX has an invalid size: ${info.size}`)
  }
  let archive: yauzl.ZipFile | undefined
  let hasContentTypes = false
  let hasPresentation = false
  let slides = 0
  let fadeTransitions = 0
  try {
    archive = await yauzl.openPromise(path, {
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true,
      autoClose: false
    })
    for await (const entry of archive.eachEntry()) {
      if (entry.fileName === '[Content_Types].xml') hasContentTypes = true
      if (entry.fileName === 'ppt/presentation.xml') hasPresentation = true
      if (!/^ppt\/slides\/slide\d+\.xml$/.test(entry.fileName)) continue
      slides += 1
      if (entry.uncompressedSize > MAX_SLIDE_XML_BYTES) {
        throw new Error(`slide XML is unexpectedly large: ${entry.fileName}`)
      }
      const stream = await archive.openReadStreamPromise(entry)
      const chunks: Buffer[] = []
      for await (const chunk of stream) chunks.push(Buffer.from(chunk))
      const xml = Buffer.concat(chunks).toString('utf8')
      if (/<p:transition\b[^>]*>[\s\S]*?<p:fade\b/.test(xml)) fadeTransitions += 1
    }
  } finally {
    archive?.close()
  }
  if (!hasContentTypes || !hasPresentation || slides === 0) {
    throw new Error('exported file is not a valid PPTX presentation package')
  }
  if (transition === 'fade' && fadeTransitions !== slides) {
    throw new Error(`fade transition verification failed: ${fadeTransitions}/${slides} slides`)
  }
  return { slides, fadeTransitions, bytes: info.size }
}

async function requireToolchainDirectory(options: PptAgentLocalToolOptions): Promise<string> {
  const candidates = [
    options.toolchainDirectory?.()?.trim(),
    process.env.KUN_PPT_TOOLCHAIN_DIR?.trim(),
    resolve(process.cwd(), 'resources', 'ppt-toolchain')
  ].filter((candidate): candidate is string => Boolean(candidate))
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate)
      if (info.isDirectory()) return resolve(candidate)
    } catch {
      // Try the next trusted runtime location.
    }
  }
  throw new Error('Kun PPT toolchain is unavailable; reinstall or repair the Kun application')
}

function isInside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

function stringArg(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function integerArg(
  value: unknown,
  min: number,
  max: number,
  fallback: number
): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback
}

function truncate(value: string): string {
  if (value.length <= MAX_EXPORT_OUTPUT_CHARS) return value
  return `${value.slice(0, MAX_EXPORT_OUTPUT_CHARS)}\n…[truncated]`
}
