import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, dirname, join } from 'node:path'
import { createPptReviewManifest, readPptReviewManifest, reviewManifestPath, toPptReviewBundle, writePptReviewManifest } from '../../ppt/ppt-review-manifest.js'
import { promisify } from 'node:util'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { LocalToolHost, type LocalTool } from './local-tool-host.js'
import { resolveWorkspacePath, withToolBoundary } from './builtin-tool-utils.js'
import { withFileMutationQueue } from './file-mutation-queue.js'
import { assertCanWritePath } from './sandbox-policy.js'
import {
  MAX_EXPORT_OUTPUT_CHARS,
  integerArg,
  isInside,
  parsePreviewRendererOutput,
  parseReviewSlides,
  requireToolchainDirectory,
  reviewSlideRevision,
  stringArg,
  truncate,
  validatePptx,
  type PptAgentLocalToolOptions,
  type ReviewBundleSlideInput
} from './ppt-agent-local-tools-support.js'

export const PPT_EXPORT_TOOL_NAME = 'ppt_export'
export const PPT_READ_GUIDE_TOOL_NAME = 'ppt_read_guide'
export const PPT_GENERATE_PREVIEWS_TOOL_NAME = 'ppt_generate_previews'
export const PPT_CREATE_REVIEW_BUNDLE_TOOL_NAME = 'ppt_create_review_bundle'

const execFileAsync = promisify(execFile)
const runtimeRequire = createRequire(import.meta.url)
const MAX_GUIDE_BYTES = 512 * 1024
const DEFAULT_GUIDE_LINES = 180
const MAX_GUIDE_LINES = 400

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
    createPptExportTool(options, shouldAdvertise),
    createPptGeneratePreviewsTool(options, shouldAdvertise),
    createPptCreateReviewBundleTool(options, shouldAdvertise)
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
      'The tool performs ZIP/OpenXML structure and editability checks, rejects raster-only pages, counts slides, and verifies the requested fade transition before publishing the output.',
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
            editableSlides: validation.editableSlides,
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

function createPptGeneratePreviewsTool(
  options: PptAgentLocalToolOptions,
  shouldAdvertise: (context: ToolHostContext) => boolean
): LocalTool {
  return LocalToolHost.defineTool({
    name: PPT_GENERATE_PREVIEWS_TOOL_NAME,
    description: [
      'Render every page of a workspace PPTD project into a 16:9 review bundle for the parent whiteboard.',
      'The generated bundle is persisted with a stable manifest so failed or revised slides can be reviewed and retried independently.',
      'Use generate_image first for approved visual assets; this tool renders the composed, editable slide plan for review and never exports a final PPTX.'
    ].join(' '),
    toolKind: 'file_change',
    policy: 'auto',
    sideEffect: 'unknown',
    effects: { network: false, externalWrite: false, processExecution: true, guiAutomation: false },
    shouldAdvertise,
    inputSchema: {
      type: 'object',
      properties: {
        parentThreadId: { type: 'string', description: 'Owning parent chat thread id supplied by ppt_agent.' },
        input: { type: 'string', description: 'Workspace-relative deck.pptd path or PPTD project directory.' },
        output: { type: 'string', description: 'Optional workspace-relative preview directory. Defaults to <project>/.kun-ppt-review/previews.' },
        force: { type: 'boolean', description: 'Replace an existing preview directory. Defaults to true for a new review revision.' }
      },
      required: ['parentThreadId', 'input'],
      additionalProperties: false
    },
    execute: async (args, context) => withToolBoundary(async () => {
      if (options.enabled?.() === false) {
        return { output: { error: 'PPT Agent is disabled in Lab settings' }, isError: true }
      }
      const inputArg = stringArg(args.input)
      const parentThreadId = stringArg(args.parentThreadId)
      if (!parentThreadId || !inputArg) {
        return { output: { error: 'parentThreadId and input are required' }, isError: true }
      }
      const input = await resolveWorkspacePath(inputArg, context, { enforceWorkspaceBoundary: true })
      const inputInfo = await stat(input.absolutePath)
      const projectDir = inputInfo.isDirectory() ? input.absolutePath : dirname(input.absolutePath)
      const workspaceRoot = await realpath(input.workspaceRoot)
      const canonicalProject = await realpath(projectDir)
      if (!isInside(workspaceRoot, canonicalProject)) {
        return { output: { error: 'input resolves outside the active workspace' }, isError: true }
      }
      const requestedOutput = stringArg(args.output)
      const output = requestedOutput
        ? await resolveWorkspacePath(requestedOutput, context, { enforceWorkspaceBoundary: true })
        : await resolveWorkspacePath(
            `${relative(workspaceRoot, projectDir).replaceAll('\\\\', '/') || '.'}/.kun-ppt-review/previews`,
            context,
            { enforceWorkspaceBoundary: true }
          )
      assertCanWritePath(output.absolutePath, context)
      return withFileMutationQueue(output.absolutePath, async () => {
        const toolchain = await requireToolchainDirectory(options)
        const renderer = resolve(toolchain, 'scripts', 'export_images.py')
        await access(renderer)
        const result = await execFileAsync(
          'python3',
          [renderer, input.absolutePath, '--output', output.absolutePath, '--force'],
          {
            cwd: projectDir,
            timeout: 5 * 60 * 1_000,
            maxBuffer: MAX_EXPORT_OUTPUT_CHARS * 8,
            signal: context.abortSignal
          }
        )
        const rendered = parsePreviewRendererOutput(`${result.stdout ?? ''}`)
        const images = rendered.images
        if (images.length === 0) throw new Error('preview renderer produced no page images')
        const existingManifest = await readPptReviewManifest(projectDir)
        const manifest = createPptReviewManifest({
          ...(existingManifest ? { workflowId: existingManifest.workflowId } : {}),
          parentThreadId,
          childId: context.threadId,
          projectDir: relative(workspaceRoot, projectDir).replaceAll('\\\\', '/'),
          deckTitle: inputInfo.isDirectory() ? input.absolutePath.split(/[\\\\/]/).pop() || 'PPT review' : input.absolutePath.split(/[\\\\/]/).slice(-2, -1)[0] || 'PPT review',
          styleSpec: existingManifest?.styleSpec ?? {
            fonts: [],
            colorTokens: {},
            typeScale: {},
            spacingScale: [],
            backgroundLanguage: 'PPT visual-first review',
            imageTreatment: 'approved generated assets',
            chartTreatment: 'native editable PPT elements'
          },
          slides: images.map((image, index) => ({
            ...(existingManifest?.slides[index] ? { slideId: existingManifest.slides[index].slideId } : {}),
            title: existingManifest?.slides[index]?.title || `P${index + 1}`,
            layoutSpecPath: image.page ?? image.image,
            prompt: image.page ?? image.image
          }))
        })
        const nextManifest = {
          ...manifest,
          phase: 'awaiting_review' as const,
          slides: manifest.slides.map((slide, index) => ({
            ...slide,
            previewPath: relative(workspaceRoot, resolve(output.absolutePath, images[index].image)).replaceAll('\\\\', '/'),
            revision: (existingManifest?.slides[index]?.revision ?? 0) + 1,
            status: 'ready' as const,
            attempts: (existingManifest?.slides[index]?.attempts ?? 0) + 1
          }))
        }
        await writePptReviewManifest(projectDir, nextManifest)
        const manifestPath = relative(workspaceRoot, resolve(projectDir, '.kun-ppt-review/manifest.json')).replaceAll('\\\\', '/')
        return {
          output: {
            ...toPptReviewBundle(nextManifest, manifestPath),
            output: output.relativePath,
            overview: relative(workspaceRoot, rendered.overview).replaceAll('\\\\', '/'),
            renderer: rendered.exporter,
            reviewBundle: toPptReviewBundle(nextManifest, manifestPath)
          }
        }
      })
    })
  })
}

function createPptCreateReviewBundleTool(
  options: PptAgentLocalToolOptions,
  shouldAdvertise: (context: ToolHostContext) => boolean
): LocalTool {
  return LocalToolHost.defineTool({
    name: PPT_CREATE_REVIEW_BUNDLE_TOOL_NAME,
    description: [
      'Create or revise a PPT visual-review bundle from one generate_image result per slide.',
      'Initial calls must cover every planned slide; a slide may carry an error when image generation failed.',
      'Revision calls use stable slideId values and replace only the requested slides. This tool never creates PPTD or PPTX files.'
    ].join(' '),
    toolKind: 'file_change',
    policy: 'auto',
    sideEffect: 'unknown',
    effects: { network: false, externalWrite: false, processExecution: false, guiAutomation: false },
    shouldAdvertise,
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'Existing workflow id required when revising previews.' },
        parentThreadId: { type: 'string', description: 'Owning parent chat thread id supplied by ppt_agent.' },
        projectDir: { type: 'string', description: 'Workspace-relative directory reserved for this PPT project.' },
        deckTitle: { type: 'string', description: 'Deck title.' },
        pageCount: { type: 'integer', minimum: 1, maximum: 50, description: 'Total planned slide count.' },
        styleSummary: { type: 'string', description: 'Locked visual system shared by all generated slide images.' },
        slides: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'object',
            properties: {
              slideId: { type: 'string', description: 'Stable id required when revising an existing workflow.' },
              title: { type: 'string' },
              prompt: { type: 'string', description: 'Full 16:9 visual brief used for generate_image.' },
              imagePath: { type: 'string', description: 'Workspace-relative files[0].relativePath returned by generate_image.' },
              error: { type: 'string', description: 'Recoverable generation failure when no imagePath is available.' }
            },
            required: ['title', 'prompt'],
            additionalProperties: false
          }
        }
      },
      required: ['parentThreadId', 'projectDir', 'deckTitle', 'pageCount', 'slides'],
      additionalProperties: false
    },
    execute: async (args, context) => withToolBoundary(async () => {
      if (options.enabled?.() === false) {
        return { output: { error: 'PPT Agent is disabled in Lab settings' }, isError: true }
      }
      const workflowId = stringArg(args.workflowId)
      const parentThreadId = stringArg(args.parentThreadId)
      const projectArg = stringArg(args.projectDir)
      const deckTitle = stringArg(args.deckTitle)
      const pageCount = integerArg(args.pageCount, 1, 50, 0)
      const slides = parseReviewSlides(args.slides)
      if (!parentThreadId || !projectArg || !deckTitle || pageCount === 0 || slides.length === 0) {
        return { output: { error: 'parentThreadId, projectDir, deckTitle, pageCount, and valid slides are required' }, isError: true }
      }
      const project = await resolveWorkspacePath(projectArg, context, { enforceWorkspaceBoundary: true })
      assertCanWritePath(project.absolutePath, context)
      await mkdir(project.absolutePath, { recursive: true })
      const workspaceRoot = await realpath(project.workspaceRoot)
      const projectDir = await realpath(project.absolutePath)
      if (!isInside(workspaceRoot, projectDir)) {
        return { output: { error: 'projectDir resolves outside the active workspace' }, isError: true }
      }
      const resolvedSlides = await Promise.all(slides.map(async (slide) => {
        if (!slide.imagePath) return slide
        if (!slide.imagePath.replaceAll('\\', '/').startsWith('.kun/images/')) {
          throw new Error(`imagePath must come from generate_image: ${slide.imagePath}`)
        }
        const image = await resolveWorkspacePath(slide.imagePath, context, { enforceWorkspaceBoundary: true })
        const info = await stat(image.absolutePath)
        if (!info.isFile() || info.size === 0 || !/\.(?:png|jpe?g|webp)$/i.test(image.relativePath)) {
          throw new Error(`slide image must be an existing PNG, JPEG, or WebP file: ${slide.imagePath}`)
        }
        return { ...slide, imagePath: image.relativePath }
      }))
      return withFileMutationQueue(reviewManifestPath(projectDir), async () => {
        const existing = await readPptReviewManifest(projectDir)
        if (!existing && resolvedSlides.length !== pageCount) {
          return { output: { error: `initial review must cover all ${pageCount} slides; received ${resolvedSlides.length}` }, isError: true }
        }
        if (!existing && resolvedSlides.some((slide) => slide.slideId)) {
          return { output: { error: 'slideId must be omitted for an initial review; the workflow assigns stable ids' }, isError: true }
        }
        if (existing && existing.deck.slideCount !== pageCount) {
          return { output: { error: `pageCount ${pageCount} does not match workflow slide count ${existing.deck.slideCount}` }, isError: true }
        }
        if (existing && (!workflowId || workflowId !== existing.workflowId)) {
          return { output: { error: 'workflowId must match the existing PPT review workflow' }, isError: true }
        }
        if (existing && (existing.childId !== context.threadId || existing.parentThreadId !== parentThreadId)) {
          return { output: { error: 'PPT review revisions must resume the original child and parent thread' }, isError: true }
        }
        const styleSummary = stringArg(args.styleSummary)
        const styleSpec = existing?.styleSpec ?? {
          fonts: [],
          colorTokens: {},
          typeScale: {},
          spacingScale: [],
          backgroundLanguage: styleSummary || 'Consistent 16:9 generated slide visual system',
          imageTreatment: 'full-slide generated visual concepts',
          chartTreatment: 'native editable PPT elements in the approved deck'
        }
        if (!existing) {
          const manifest = createPptReviewManifest({
            parentThreadId,
            childId: context.threadId,
            projectDir: relative(workspaceRoot, projectDir).replaceAll('\\', '/') || '.',
            deckTitle,
            styleSpec,
            slides: resolvedSlides.map((slide) => ({ title: slide.title, prompt: slide.prompt }))
          })
          const nextManifest = {
            ...manifest,
            phase: 'awaiting_review' as const,
            slides: manifest.slides.map((slide, index) => reviewSlideRevision(slide, resolvedSlides[index]))
          }
          await writePptReviewManifest(projectDir, nextManifest)
          const manifestPath = relative(workspaceRoot, reviewManifestPath(projectDir)).replaceAll('\\', '/')
          return { output: { reviewBundle: toPptReviewBundle(nextManifest, manifestPath), manifestPath } }
        }
        const updates = new Map<string, ReviewBundleSlideInput>()
        for (const slide of resolvedSlides) {
          if (!slide.slideId || !existing.slides.some((candidate) => candidate.slideId === slide.slideId)) {
            return { output: { error: 'every revision slide must use a stable slideId from the existing workflow' }, isError: true }
          }
          if (updates.has(slide.slideId)) {
            return { output: { error: `duplicate slideId: ${slide.slideId}` }, isError: true }
          }
          updates.set(slide.slideId, slide)
        }
        const nextManifest = {
          ...existing,
          phase: 'awaiting_review' as const,
          slides: existing.slides.map((slide) => {
            const update = updates.get(slide.slideId)
            return update ? reviewSlideRevision(slide, update, existing.styleSpec) : slide
          })
        }
        await writePptReviewManifest(projectDir, nextManifest)
        const manifestPath = relative(workspaceRoot, reviewManifestPath(projectDir)).replaceAll('\\', '/')
        return { output: { reviewBundle: toPptReviewBundle(nextManifest, manifestPath), manifestPath } }
      })
    })
  })
}
