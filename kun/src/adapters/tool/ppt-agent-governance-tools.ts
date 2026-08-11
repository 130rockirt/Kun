import { access, mkdir, readFile, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import type { ToolHostContext } from '../../ports/tool-host.js'
import {
  createPptDesignGovernanceState,
  currentPptGovernanceSnapshot,
  PptDesignPlanInput,
  PptPolicyExceptionRule,
  pptDesignGovernancePath,
  pptGovernanceReadinessErrors,
  readPptDesignGovernance,
  resolvePptDesignGovernanceStore,
  recordPptGuideRead,
  submitPptDesignPlan,
  writePptDesignGovernance,
  type PptDesignGovernanceSnapshot,
  type PptDesignGovernanceState,
  type PptDesignGovernanceStore
} from '../../ppt/ppt-design-governance.js'
import { loadPptCoreDesignPolicy, type PptCoreDesignPolicy } from '../../ppt/ppt-design-policy.js'
import { LocalToolHost, type LocalTool } from './local-tool-host.js'
import { resolveWorkspacePath, withToolBoundary } from './builtin-tool-utils.js'
import { withFileMutationQueue } from './file-mutation-queue.js'
import { assertPptScopedMutationPath } from './ppt-agent-physical-path.js'
import { assertCanWritePath } from './sandbox-policy.js'
import {
  assertPptWorkflowBinding,
  integerArg,
  isInside,
  requireToolchainDirectory,
  stringArg,
  type PptAgentLocalToolOptions
} from './ppt-agent-local-tools-support.js'

export const PPT_READ_GUIDE_TOOL_NAME = 'ppt_read_guide'
export const PPT_SUBMIT_DESIGN_PLAN_TOOL_NAME = 'ppt_submit_design_plan'

const MAX_GUIDE_BYTES = 512 * 1024
const DEFAULT_GUIDE_LINES = 180
const MAX_GUIDE_LINES = 400

type ShouldAdvertise = (context: ToolHostContext) => boolean

export function buildPptAgentGovernanceTools(
  options: PptAgentLocalToolOptions,
  shouldAdvertise: ShouldAdvertise
): LocalTool[] {
  const canMutateGovernance = (context: ToolHostContext): boolean =>
    shouldAdvertise(context) && context.pptWorkflowScope?.action !== 'approve_and_build'
  return [
    createPptReadGuideTool(options, canMutateGovernance),
    createPptSubmitDesignPlanTool(options, canMutateGovernance)
  ]
}

export function requiresPptDesignGovernance(_context: ToolHostContext): boolean {
  return true
}

export async function requireCurrentPptGovernance(input: {
  options: PptAgentLocalToolOptions
  context: ToolHostContext
  workspaceRoot: string
  projectDir: string
  workflowId?: string
}): Promise<{
  state: PptDesignGovernanceState
  snapshot: PptDesignGovernanceSnapshot
  policy: PptCoreDesignPolicy
  store: PptDesignGovernanceStore
}> {
  assertPptWorkflowBinding({
    context: input.context,
    ...(input.workflowId ? { workflowId: input.workflowId } : {}),
    projectDir: relative(input.workspaceRoot, input.projectDir).replaceAll('\\', '/') || '.'
  })
  const toolchain = await requireToolchainDirectory(input.options)
  const policy = await loadPptCoreDesignPolicy(toolchain)
  const store = await governanceStore(
    input.options,
    input.context,
    input.workspaceRoot,
    input.projectDir
  )
  const state = await readPptDesignGovernance(store)
  const errors = pptGovernanceReadinessErrors(state, policy)
  if (!state || errors.length > 0) {
    throw new Error(`PPT design governance is incomplete: ${errors.join('; ')}`)
  }
  if (state.childId !== input.context.threadId) {
    throw new Error('PPT design governance belongs to another child thread')
  }
  if (input.workflowId && state.workflowId !== input.workflowId) {
    throw new Error('workflowId does not match the governed PPT workflow')
  }
  return { state, snapshot: currentPptGovernanceSnapshot(state, policy), policy, store }
}

function createPptReadGuideTool(
  options: PptAgentLocalToolOptions,
  shouldAdvertise: ShouldAdvertise
): LocalTool {
  return LocalToolHost.defineTool({
    name: PPT_READ_GUIDE_TOOL_NAME,
    description: [
      'Read a bounded section of a trusted bundled PPTD or slide-design guide.',
      'Category design is governed: pass workflowId and projectDir when reading slides_categories.md or a slides_categories/*.md guide.',
      'The complete category index must be read before exactly one complete detailed category guide.'
    ].join(' '),
    toolKind: 'file_change',
    policy: 'auto',
    sideEffect: 'unknown',
    effects: { network: false, externalWrite: false, processExecution: false, guiAutomation: false },
    shouldAdvertise,
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'Host-owned PPT workflow id for governed category reads.' },
        projectDir: { type: 'string', description: 'Workspace-relative managed PPT project directory.' },
        path: { type: 'string', description: 'Relative Markdown path inside the bundled PPT reference directory.' },
        start_line: { type: 'integer', minimum: 1, description: 'One-based first line. Defaults to 1.' },
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
    execute: async (args, context) => withToolBoundary(async () => {
      if (options.enabled?.() === false) return disabledResult()
      assertPptWorkflowBinding({
        context,
        actions: ['start', 'revise_previews', 'retry_failed']
      })
      const requested = stringArg(args.path).replaceAll('\\', '/')
      if (!requested || isAbsolute(requested) || extname(requested).toLowerCase() !== '.md') {
        return errorResult('path must be a relative .md file inside the PPT reference directory')
      }
      const toolchain = await requireToolchainDirectory(options)
      const referenceRoot = resolve(toolchain, 'reference')
      const target = resolve(referenceRoot, requested)
      if (!isInside(referenceRoot, target)) return errorResult('path escapes the PPT reference directory')
      const info = await stat(target)
      if (!info.isFile() || info.size > MAX_GUIDE_BYTES) {
        return errorResult(`guide must be a file no larger than ${MAX_GUIDE_BYTES} bytes`)
      }
      const content = await readFile(target, 'utf8')
      const lines = content.split(/\r?\n/)
      const startLine = integerArg(args.start_line, 1, Number.MAX_SAFE_INTEGER, 1)
      const maxLines = integerArg(args.max_lines, 1, MAX_GUIDE_LINES, DEFAULT_GUIDE_LINES)
      const startIndex = Math.min(startLine - 1, lines.length)
      const selected = lines.slice(startIndex, startIndex + maxLines)
      const endLine = startIndex + selected.length
      const governed = requested === 'slides_categories.md' || requested.startsWith('slides_categories/')
      if (governed) {
        const workflowId = stringArg(args.workflowId)
        const projectArg = stringArg(args.projectDir)
        if (!workflowId || !projectArg) {
          return errorResult('workflowId and projectDir are required for governed category guide reads')
        }
        assertPptWorkflowBinding({ context, workflowId, projectDir: projectArg })
        const project = await resolveProjectDir(projectArg, context)
        const store = await governanceStore(
          options,
          context,
          project.workspaceRoot,
          project.projectDir
        )
        const policy = await loadPptCoreDesignPolicy(toolchain)
        await withFileMutationQueue(pptDesignGovernancePath(store), async () => {
          const existing = await readPptDesignGovernance(store)
          if (existing && (existing.workflowId !== workflowId || existing.childId !== context.threadId)) {
            throw new Error('PPT design governance must resume the original workflow and child thread')
          }
          const state = !existing || existing.policy.sha256 !== policy.sha256
            ? createPptDesignGovernanceState({
                workflowId,
                childId: context.threadId,
                binding: store.identity,
                policy
              })
            : existing
          const next = recordPptGuideRead({
            state,
            path: requested,
            startLine: startIndex + 1,
            endLine,
            totalLines: lines.length
          })
          await writePptDesignGovernance(store, next)
        })
      }
      const truncated = endLine < lines.length
      return {
        output: {
          path: requested,
          start_line: startIndex + 1,
          end_line: endLine,
          total_lines: lines.length,
          content: selected.join('\n'),
          truncated,
          ...(truncated ? { next_line: endLine + 1 } : {}),
          ...(governed ? { governanceTracked: true } : {})
        }
      }
    })
  })
}

function createPptSubmitDesignPlanTool(
  options: PptAgentLocalToolOptions,
  shouldAdvertise: ShouldAdvertise
): LocalTool {
  return LocalToolHost.defineTool({
    name: PPT_SUBMIT_DESIGN_PLAN_TOOL_NAME,
    description: [
      'Validate and persist the complete design plan for a governed PPT workflow.',
      'The category index and one matching detailed guide must already be completely read.',
      'Policy exceptions require an exact quote from the host-owned source request; the source request is never accepted as a tool argument.'
    ].join(' '),
    toolKind: 'file_change',
    policy: 'auto',
    sideEffect: 'unknown',
    effects: { network: false, externalWrite: false, processExecution: false, guiAutomation: false },
    shouldAdvertise,
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string' },
        projectDir: { type: 'string' },
        plan: designPlanInputSchema()
      },
      required: ['workflowId', 'projectDir', 'plan'],
      additionalProperties: false
    },
    execute: async (args, context) => withToolBoundary(async () => {
      if (options.enabled?.() === false) return disabledResult()
      const workflowId = stringArg(args.workflowId)
      const projectArg = stringArg(args.projectDir)
      if (!workflowId || !projectArg) return errorResult('workflowId, projectDir, and plan are required')
      assertPptWorkflowBinding({
        context,
        workflowId,
        projectDir: projectArg,
        actions: ['start', 'revise_previews', 'retry_failed']
      })
      const parsed = PptDesignPlanInput.safeParse(args.plan)
      if (!parsed.success) {
        return errorResult(`invalid design plan: ${parsed.error.issues.map(formatIssue).join('; ')}`)
      }
      const project = await resolveProjectDir(projectArg, context)
      const store = await governanceStore(
        options,
        context,
        project.workspaceRoot,
        project.projectDir
      )
      const toolchain = await requireToolchainDirectory(options)
      const policy = await loadPptCoreDesignPolicy(toolchain)
      const sourceRequest = await options.resolveSourceRequest?.(context) ?? context.approvalIntent
      if (typeof sourceRequest !== 'string' || sourceRequest.length === 0) {
        return errorResult('host-owned source request is unavailable; design plan cannot be verified')
      }
      return withFileMutationQueue(pptDesignGovernancePath(store), async () => {
        const existing = await readPptDesignGovernance(store)
        if (!existing) return errorResult('read the governed category guides before submitting a design plan')
        if (existing.workflowId !== workflowId || existing.childId !== context.threadId) {
          return errorResult('PPT design plan must resume the original workflow and child thread')
        }
        const readiness = pptGovernanceReadinessErrors(existing, policy).filter(
          (message) => !message.startsWith('submit a complete design plan')
        )
        if (readiness.length > 0) return errorResult(`PPT design governance is incomplete: ${readiness.join('; ')}`)
        const next = submitPptDesignPlan({
          state: existing,
          plan: parsed.data,
          sourceRequest,
          policy
        })
        await writePptDesignGovernance(store, next)
        return {
          output: {
            workflowId,
            category: next.selectedCategory,
            categoryGuide: next.categoryGuide,
            policy: next.policy,
            planRevision: next.planRevision,
            planFingerprint: next.designPlan?.fingerprint,
            validated: true
          }
        }
      })
    })
  })
}

async function resolveProjectDir(
  projectArg: string,
  context: ToolHostContext
): Promise<{ workspaceRoot: string; projectDir: string }> {
  const project = await resolveWorkspacePath(projectArg, context, { enforceWorkspaceBoundary: true })
  assertCanWritePath(project.absolutePath, context)
  const validate = () => assertPptScopedMutationPath({
    workspaceRoot: project.workspaceRoot,
    scopeRoot: project.absolutePath,
    targetPath: project.absolutePath,
    label: 'PPT project directory',
    expected: 'directory'
  })
  await validate()
  return withFileMutationQueue(project.absolutePath, async () => {
    await validate()
    await mkdir(project.absolutePath, { recursive: true })
    const proof = await validate()
    await access(proof.physicalPath)
    return { workspaceRoot: proof.physicalWorkspaceRoot, projectDir: proof.physicalPath }
  })
}

async function governanceStore(
  options: PptAgentLocalToolOptions,
  context: ToolHostContext,
  workspaceRoot: string,
  projectDir: string
): Promise<PptDesignGovernanceStore> {
  const directory = options.governanceDirectory?.(context)?.trim()
  if (!directory) {
    throw new Error('PPT governance store is unavailable; runtime data directory is not configured')
  }
  return resolvePptDesignGovernanceStore({
    governanceDirectory: directory,
    workspaceCanonicalPath: workspaceRoot,
    projectCanonicalPath: projectDir,
    childId: context.threadId
  })
}

function designPlanInputSchema(): Record<string, unknown> {
  const color = { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' }
  return {
    type: 'object',
    properties: {
      category: { type: 'string', enum: ['analysis-decision', 'business-plan', 'management-report', 'academic-research', 'education-training', 'tech-engineering', 'brand-creative'] },
      audience: { type: 'string', minLength: 3 },
      purpose: { type: 'string', minLength: 3 },
      pageStrategy: {
        type: 'object',
        properties: { pageCount: { type: 'integer', minimum: 1, maximum: 50 }, narrative: { type: 'string', minLength: 8 } },
        required: ['pageCount', 'narrative'],
        additionalProperties: false
      },
      fontRoles: {
        type: 'object',
        properties: { display: { type: 'string', minLength: 1 }, body: { type: 'string', minLength: 1 }, monospace: { type: 'string', minLength: 1 } },
        required: ['display', 'body'],
        additionalProperties: false
      },
      colorRoles: {
        type: 'object',
        properties: { background: color, foreground: color, accent: color, muted: color, positive: color, caution: color, critical: color },
        required: ['background', 'foreground', 'accent', 'muted', 'positive', 'caution', 'critical'],
        additionalProperties: false
      },
      backgroundTreatment: {
        oneOf: [
          {
            type: 'object',
            properties: { kind: { const: 'solid' } },
            required: ['kind'],
            additionalProperties: false
          },
          {
            type: 'object',
            properties: {
              kind: { const: 'gradient' },
              stops: { type: 'array', items: color, minItems: 2, maxItems: 8 }
            },
            required: ['kind', 'stops'],
            additionalProperties: false
          },
          {
            type: 'object',
            properties: { kind: { const: 'image' } },
            required: ['kind'],
            additionalProperties: false
          }
        ]
      },
      effects: {
        type: 'array',
        items: { type: 'string', enum: ['glow', 'glass', 'particles', 'ornamental-grid'] },
        uniqueItems: true
      },
      typeScale: {
        type: 'object',
        properties: { title: { type: 'number', minimum: 28 }, section: { type: 'number', minimum: 22 }, body: { type: 'number', minimum: 14 }, caption: { type: 'number', minimum: 10 } },
        required: ['title', 'section', 'body', 'caption'],
        additionalProperties: false
      },
      spacingRhythm: {
        type: 'object',
        properties: { unit: { type: 'number', exclusiveMinimum: 0 }, pageMargin: { type: 'number', exclusiveMinimum: 0 }, columns: { type: 'integer', minimum: 1, maximum: 12 }, gutter: { type: 'number', minimum: 0 } },
        required: ['unit', 'pageMargin', 'columns', 'gutter'],
        additionalProperties: false
      },
      layoutSystem: { type: 'string', minLength: 8 },
      imageryStrategy: { type: 'string', minLength: 8 },
      policyExceptions: {
        type: 'array',
        items: {
          type: 'object',
          properties: { rule: { type: 'string', enum: [...PptPolicyExceptionRule.options] }, evidence: { type: 'string', minLength: 4 } },
          required: ['rule', 'evidence'],
          additionalProperties: false
        }
      }
    },
    required: ['category', 'audience', 'purpose', 'pageStrategy', 'fontRoles', 'colorRoles', 'backgroundTreatment', 'effects', 'typeScale', 'spacingRhythm', 'layoutSystem', 'imageryStrategy'],
    additionalProperties: false
  }
}

function formatIssue(issue: { path: PropertyKey[]; message: string }): string {
  const path = issue.path.length > 0 ? issue.path.join('.') : 'plan'
  return `${path}: ${issue.message}`
}

function disabledResult(): { output: { error: string }; isError: true } {
  return errorResult('PPT Agent is disabled in Lab settings')
}

function errorResult(message: string): { output: { error: string }; isError: true } {
  return { output: { error: message }, isError: true }
}
