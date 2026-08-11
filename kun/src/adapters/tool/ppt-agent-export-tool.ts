import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, rename, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  PPT_REVIEW_MANIFEST_VERSION,
  readPptReviewManifest,
  writePptReviewManifest
} from '../../ppt/ppt-review-manifest.js'
import {
  markPptGovernanceExported,
  writePptDesignGovernance
} from '../../ppt/ppt-design-governance.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { resolveWorkspacePath, withToolBoundary } from './builtin-tool-utils.js'
import { withFileMutationQueue } from './file-mutation-queue.js'
import {
  requireCurrentPptGovernance,
  requiresPptDesignGovernance
} from './ppt-agent-governance-tools.js'
import {
  MAX_EXPORT_OUTPUT_CHARS,
  assertPptWorkflowBinding,
  governanceProjectionMatches,
  requireToolchainDirectory,
  stringArg,
  truncate,
  validatePptx,
  type PptAgentLocalToolOptions
} from './ppt-agent-local-tools-support.js'
import {
  assertPptScopedExistingPath,
  assertPptScopedMutationPath
} from './ppt-agent-physical-path.js'
import { assertCanWritePath } from './sandbox-policy.js'
import { LocalToolHost, type LocalTool } from './local-tool-host.js'

export const PPT_EXPORT_TOOL_NAME = 'ppt_export'

const execFileAsync = promisify(execFile)
const runtimeRequire = createRequire(import.meta.url)

export function createPptExportTool(
  options: PptAgentLocalToolOptions,
  shouldAdvertise: (context: ToolHostContext) => boolean
): LocalTool {
  return LocalToolHost.defineTool({
    name: PPT_EXPORT_TOOL_NAME,
    description: [
      'Export a workspace PPTD project to an editable .pptx with Kun\'s bundled offline WASM exporter.',
      'The tool performs ZIP/OpenXML structure and editability checks, rejects raster-only pages, counts slides, and verifies the requested fade transition before publishing the output.',
      'Validated outputs are published only inside the workspace presentations directory.'
    ].join(' '),
    toolKind: 'file_change',
    policy: 'auto',
    sideEffect: 'unknown',
    effects: { network: false, externalWrite: false, processExecution: true, guiAutomation: false },
    shouldAdvertise,
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Workspace-relative deck.pptd path or PPTD project directory.' },
        output: { type: 'string', description: 'Workspace-relative .pptx destination under presentations/.' },
        transition: { type: 'string', enum: ['fade', 'none'], description: 'Per-slide transition. Defaults to fade.' },
        force: { type: 'boolean', description: 'Replace an existing output file. Defaults to false.' }
      },
      required: ['input', 'output'],
      additionalProperties: false
    },
    execute: async (args, context) => withToolBoundary(async () => {
      if (options.enabled?.() === false) {
        return { output: { error: 'PPT Agent is disabled in Lab settings' }, isError: true }
      }
      const scope = assertPptWorkflowBinding({ context, actions: ['approve_and_build'] })
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
      const lexicalProject = resolve(input.workspaceRoot, scope.projectDir)
      const presentations = resolve(output.workspaceRoot, 'presentations')
      const inspectProject = () => assertPptScopedExistingPath({
        workspaceRoot: input.workspaceRoot,
        scopeRoot: lexicalProject,
        targetPath: lexicalProject,
        label: 'PPT project',
        expected: 'directory',
        recursive: true
      })
      const inspectInput = () => assertPptScopedExistingPath({
        workspaceRoot: input.workspaceRoot,
        scopeRoot: lexicalProject,
        targetPath: input.absolutePath,
        label: 'PPT export input',
        expected: 'file-or-directory'
      })
      const inspectOutput = () => assertPptScopedMutationPath({
        workspaceRoot: output.workspaceRoot,
        scopeRoot: presentations,
        targetPath: output.absolutePath,
        label: 'PPT presentations output',
        expected: 'file'
      })
      const [projectProof, inputProof] = await Promise.all([inspectProject(), inspectInput()])
      await inspectOutput()
      if (inputProof.kind === 'file' && extname(inputProof.lexicalPath).toLowerCase() !== '.pptd') {
        return { output: { error: 'input must be a PPTD project directory or .pptd manifest' }, isError: true }
      }
      assertPptWorkflowBinding({
        context,
        projectDir: relative(projectProof.physicalWorkspaceRoot, projectProof.physicalPath).replaceAll('\\', '/') || '.'
      })
      const governance = requiresPptDesignGovernance(context)
        ? await requireCurrentPptGovernance({
            options,
            context,
            workspaceRoot: projectProof.physicalWorkspaceRoot,
            projectDir: projectProof.physicalPath
          })
        : undefined
      const reviewManifest = governance ? await readPptReviewManifest(projectProof.physicalPath) : undefined
      if (governance && (
        !reviewManifest ||
        reviewManifest.version !== PPT_REVIEW_MANIFEST_VERSION ||
        reviewManifest.phase !== 'awaiting_review' ||
        reviewManifest.workflowId !== governance.state.workflowId ||
        reviewManifest.childId !== context.threadId ||
        governance.state.reviewedPlanFingerprint !== governance.snapshot.designPlan.fingerprint ||
        !governanceProjectionMatches(reviewManifest.governance, governance.snapshot)
      )) {
        return {
          output: { error: 'the current design plan has no fresh review bundle; create a governed review before export' },
          isError: true
        }
      }

      return withFileMutationQueue(output.absolutePath, async () => {
        if (context.abortSignal.aborted) throw new Error('PPT export aborted before start')
        const [currentProject, currentInput] = await Promise.all([inspectProject(), inspectInput()])
        let currentOutput = await inspectOutput()
        if (args.force !== true && currentOutput.exists) {
          return { output: { error: 'output already exists; pass force=true to replace it' }, isError: true }
        }
        const toolchain = await requireToolchainDirectory(options)
        const exporter = resolve(toolchain, 'scripts', 'local-export', 'export-pptd.mjs')
        const wasm = resolve(toolchain, 'scripts', 'local-export', 'pptd_wasm_bg.wasm')
        await Promise.all([access(exporter), access(wasm)])
        await mkdir(dirname(output.absolutePath), { recursive: true })
        currentOutput = await inspectOutput()
        const temporaryOutput = join(
          dirname(output.absolutePath),
          `.${randomUUID()}.${output.absolutePath.split(/[\\/]/).pop()}.tmp.pptx`
        )
        assertCanWritePath(temporaryOutput, context)
        const inspectTemporary = (existing: boolean) => existing
          ? assertPptScopedExistingPath({
              workspaceRoot: output.workspaceRoot,
              scopeRoot: presentations,
              targetPath: temporaryOutput,
              label: 'PPT temporary output',
              expected: 'file'
            })
          : assertPptScopedMutationPath({
              workspaceRoot: output.workspaceRoot,
              scopeRoot: presentations,
              targetPath: temporaryOutput,
              label: 'PPT temporary output',
              expected: 'file'
            })
        await inspectTemporary(false)
        const transition = args.transition === 'none' ? 'none' : 'fade'

        try {
          const result = await execFileAsync(process.execPath, [
            exporter,
            currentInput.physicalPath,
            '--output',
            temporaryOutput,
            '--no-sign',
            '--local-images-only',
            '--transition',
            transition,
            '--wasm',
            wasm
          ], {
            cwd: currentInput.kind === 'directory' ? currentInput.physicalPath : currentProject.physicalPath,
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
          })
          const temporaryProof = await inspectTemporary(true)
          const validation = await validatePptx(temporaryProof.physicalPath, transition)
          if (governance && validation.slides !== governance.snapshot.designPlan.pageStrategy.pageCount) {
            throw new Error(
              `exported slide count ${validation.slides} does not match governed page count ${governance.snapshot.designPlan.pageStrategy.pageCount}`
            )
          }
          currentOutput = await inspectOutput()
          if (args.force === true && currentOutput.exists) {
            await rm(currentOutput.physicalPath)
            currentOutput = await inspectOutput()
          }
          await rename(temporaryProof.physicalPath, currentOutput.physicalPath)
          const published = await assertPptScopedExistingPath({
            workspaceRoot: output.workspaceRoot,
            scopeRoot: presentations,
            targetPath: output.absolutePath,
            label: 'PPT presentations output',
            expected: 'file'
          })
          if (governance) {
            const manifestTarget = resolve(lexicalProject, '.kun-ppt-review', 'manifest.json')
            await assertPptScopedMutationPath({
              workspaceRoot: input.workspaceRoot,
              scopeRoot: lexicalProject,
              targetPath: manifestTarget,
              label: 'PPT review manifest',
              expected: 'file'
            })
            await writePptDesignGovernance(
              governance.store,
              markPptGovernanceExported(governance.state, governance.snapshot.designPlan.fingerprint)
            )
            if (reviewManifest) {
              await writePptReviewManifest(currentProject.physicalPath, {
                ...reviewManifest,
                phase: 'completed',
                validatedExport: {
                  output: output.relativePath,
                  planFingerprint: governance.snapshot.designPlan.fingerprint,
                  slides: validation.slides
                }
              })
            }
          }
          return {
            output: {
              output: output.relativePath,
              absolutePath: published.physicalPath,
              exporter: 'local-wasm-patched',
              slides: validation.slides,
              editableSlides: validation.editableSlides,
              fadeTransitions: validation.fadeTransitions,
              bytes: validation.bytes,
              transition,
              validated: true,
              ...(governance ? {
                workflowId: governance.state.workflowId,
                projectDir: relative(currentProject.physicalWorkspaceRoot, currentProject.physicalPath).replaceAll('\\', '/') || '.',
                planFingerprint: governance.snapshot.designPlan.fingerprint
              } : {}),
              log: truncate(`${result.stdout ?? ''}${result.stderr ?? ''}`)
            }
          }
        } finally {
          const temporaryProof = await inspectTemporary(false).catch(() => undefined)
          if (temporaryProof?.exists) await rm(temporaryProof.physicalPath, { force: true }).catch(() => undefined)
        }
      })
    })
  })
}
