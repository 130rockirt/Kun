import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import {
  ChildSourceEnvelope,
  type ChildSecuritySnapshot,
  type DelegationRuntime
} from '../../delegation/delegation-runtime.js'
import {
  PPT_AGENT_PROFILE
} from '../../delegation/builtin-profiles.js'
import { intersectChildSecurity } from '../../delegation/delegation-runtime-support.js'
import {
  ModelReasoningEffort,
  type SubagentProfileConfig
} from '../../contracts/capabilities.js'
import type { ToolExecutionUpdate, ToolHostContext } from '../../ports/tool-host.js'
import type { TurnService } from '../../services/turn-service.js'
import type { UserTurnItem } from '../../contracts/items.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import { LocalToolHost } from './local-tool-host.js'
import type { PptPreviewMode } from '../../ppt/ppt-review-manifest.js'
import {
  formatPptCoreDesignPolicyControl,
  loadPptCoreDesignPolicy
} from '../../ppt/ppt-design-policy.js'
import { requireToolchainDirectory } from './ppt-agent-local-tools-support.js'
import { validatePersistedPptReviewIdentity } from './ppt-agent-review-context.js'
import {
  reviewBundleContractError,
  validatedDeckArtifact
} from './ppt-agent-output-contracts.js'
import {
  blocksPptExport,
  deliverableInstruction,
  effectivePptProviderId,
  imageFirstFallbackNotice,
  initialPptPreviewMode,
  managedPptProviderUnavailable,
  pptAgentAction,
  visualWorkflowInstruction
} from './ppt-agent-workflow-control.js'

export const PPT_AGENT_TOOL_NAME = 'ppt_agent' as const
export const PPT_AGENT_PROVIDER_ID = 'ppt-agent' as const

export type PptAgentToolConfig = {
  enabled?: boolean
  model?: string
  providerId?: string
  reasoningEffort?: ModelReasoningEffort
  fast?: boolean
  imageFirst?: boolean
  imageGenAvailable?: boolean
  imageGenReason?: string
  imageGenSupportsReferenceEdit?: boolean
  /** Runtime providers that cannot execute Kun's governed local PPT tools. */
  toolIncompatibleProviderIds?: readonly string[]
  /** Covers a provider-kind default when the active route has no provider id. */
  defaultProviderLacksManagedTools?: boolean
}

export type PptAgentTurnReader = Pick<TurnService, 'getTurn'>

const PptReviewContextV1 = z.object({
  kind: z.literal('ppt-review'),
  schemaVersion: z.literal(1),
  workflowId: z.string().min(1),
  childId: z.string().min(1),
  slides: z.array(z.object({
    slideId: z.string().min(1),
    revision: z.number().int().nonnegative(),
    annotations: z.array(z.string().trim().min(1).max(2_048)).optional()
  }).strict()).min(1)
}).strict()
export type PptReviewContextV1 = z.infer<typeof PptReviewContextV1>

export type PptSourceEnvelope = z.infer<typeof ChildSourceEnvelope> & {
  reviewContexts: PptReviewContextV1[]
}

/**
 * First-class PPT allow-list. Full file authoring plus the managed `ppt_export`
 * tool, web helpers and image generation
 * so the child can build a PPTD project, export a verified PPTX and generate
 * artwork. Deliberately excludes `ppt_to_board`, GUI design tools and the
 * delegation tools: whiteboard layout is replayed by the parent agent because
 * child design-tool results never reach the canvas (verdict B), and the child
 * must not spin up further children.
 */
export const PPT_AGENT_ALLOWED_TOOLS = [
  'read',
  'grep',
  'glob',
  'ls',
  'write',
  'edit',
  'ppt_read_guide',
  'ppt_read_review_context',
  'ppt_submit_design_plan',
  'ppt_import_asset',
  'ppt_export',
  'ppt_generate_previews',
  'ppt_create_review_bundle',
  'web_fetch',
  'web_search',
  'generate_image'
] as const

const PPT_AGENT_DESCRIPTION = [
  'Use `ppt_agent` for any presentation/PPT task: create, edit, replicate, or read a deck.',
  'It reads the exact active user turn and its attachments from the host; never restate, summarize, expand, or invent presentation content in tool arguments.',
  'For later review actions, pass only the original childId and workflowId so the same PPT child continues with its saved visual plan. Structured review selections are resolved from the active turn context.',
  'An optional short title is display metadata only and never enters the child request.',
  'The child writes deck files under the workspace; the parent owns deliverable verification (deck structure, .pptx export, per-page fade).',
  'PPT 演示文稿任务（创建/编辑/复刻/读取）都应优先交给 ppt_agent；主代理只传工作流控制，不得改写用户内容。'
].join(' ')

/**
 * First-class `ppt_agent` tool: the host forwards the exact active turn to an
 * isolated PPT child and injects the canonical governed design workflow. It
 * reuses the whole subagent runtime (child thread, events,
 * approval inheritance, SubagentCallCard rendering) while keeping the
 * delegate_task router untouched. Lab disable is enforced live via
 * `shouldAdvertise` (and an execute backstop), mirroring explore_agent.
 */
export function buildPptAgentToolProvider(
  runtime: DelegationRuntime | undefined,
  config: () => PptAgentToolConfig | undefined,
  turns?: PptAgentTurnReader
): CapabilityToolProvider[] {
  if (!runtime?.enabled()) return []
  const shouldAdvertise = (_context: ToolHostContext): boolean =>
    config()?.enabled !== false
  return [
    {
      id: PPT_AGENT_PROVIDER_ID,
      kind: 'delegation',
      enabled: true,
      available: true,
      tools: [
        LocalToolHost.defineTool({
          name: PPT_AGENT_TOOL_NAME,
          description: PPT_AGENT_DESCRIPTION,
          inputSchema: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['start', 'revise_previews', 'retry_failed', 'approve_and_build'],
                description: 'Workflow action. Defaults to start; review follow-ups resume the original PPT child.'
              },
              childId: { type: 'string', description: 'Existing PPT child id required for a review follow-up.' },
              workflowId: { type: 'string', description: 'Persisted PPT review workflow id required for a review follow-up.' },
              title: {
                type: 'string',
                description: 'Optional 2-6 word UI title. This metadata is never sent as presentation content.'
              }
            },
            required: [],
            additionalProperties: false
          },
          policy: 'auto',
          // The child writes deck files, so this is a mutation surface. The
          // registry models sideEffect as 'read-only' | 'unknown' only;
          // 'unknown' is the convention for mutation tools (see graph tools).
          sideEffect: 'unknown',
          shouldAdvertise,
          execute: async (args, context, onUpdate) => {
            const cfg = config()
            if (cfg?.enabled === false) {
              return {
                output: { error: 'ppt_agent is disabled in Lab settings' },
                isError: true
              }
            }
            const source = await resolvePptSourceEnvelope(turns, context)
            if (!source.ok) {
              return {
                output: { phase: 'source_unavailable', error: source.error },
                isError: true
              }
            }
            const title = stringValue(args.title) || 'Presentation'
            const workspace = context.workspace
            const configuredCfg = cfg ?? {}
            const effectiveProvider = effectivePptProviderId(configuredCfg, context)
            if (managedPptProviderUnavailable(configuredCfg, effectiveProvider)) {
              return {
                output: {
                  phase: 'unavailable',
                  error: 'The selected provider cannot execute Kun managed PPT tools; configure a tool-capable PPT Agent model in Lab settings'
                },
                isError: true
              }
            }
            const imageGenAllowed =
              (!context.allowedToolNames || context.allowedToolNames.includes('generate_image')) &&
              !context.blockedToolNames?.includes('generate_image')
            const resolvedCfg: PptAgentToolConfig = {
              ...configuredCfg,
              imageGenAvailable: configuredCfg.imageGenAvailable === true && imageGenAllowed,
              ...(!imageGenAllowed
                ? { imageGenReason: 'generate_image is unavailable in the current tool policy' }
                : {})
            }
            const action = pptAgentAction(args.action)
            const childId = stringValue(args.childId)
            const requestedWorkflowId = stringValue(args.workflowId)
            const workflowId = action === 'start'
              ? `ppt_${randomUUID()}`
              : requestedWorkflowId
            const projectDir = `.kun/ppt/${workflowId}`
            const deliverable = 'pptx' as const
            if (action !== 'start' && (!childId || !workflowId)) {
              return { output: { error: 'childId and workflowId are required for PPT review follow-ups' }, isError: true }
            }
            const scopedReview = scopedPptReviewContext(source.value.reviewContexts, action, childId, workflowId)
            if (!scopedReview.ok) {
              return { output: { phase: 'source_unavailable', error: scopedReview.error }, isError: true }
            }
            let persistedPreviewMode: PptPreviewMode | undefined
            let persistedPlanFingerprint: string | undefined
            if (action !== 'start') {
              if (!scopedReview.value) {
                return { output: { phase: 'source_unavailable', error: 'PPT source unavailable: review context is required' }, isError: true }
              }
              const identity = await validatePersistedPptReviewIdentity(
                runtime,
                context.threadId,
                scopedReview.value
              )
              if (!identity.ok) {
                return { output: { phase: 'source_unavailable', error: identity.error }, isError: true }
              }
              if (!identity.previewMode || !identity.planFingerprint) {
                return {
                  output: {
                    phase: 'unavailable',
                    error: 'This pre-governance PPT review cannot be migrated in place; start a new PPT Agent workflow while the existing legacy artifacts remain unchanged'
                  },
                  isError: true
                }
              }
              persistedPreviewMode = identity.previewMode
              persistedPlanFingerprint = identity.planFingerprint
            }
            const previewMode = persistedPreviewMode ?? initialPptPreviewMode(resolvedCfg)
            if (
              action !== 'start' &&
              action !== 'approve_and_build' &&
              previewMode === 'image-first' &&
              resolvedCfg.imageGenAvailable !== true
            ) {
              return {
                output: {
                  childId,
                  workflowId,
                  projectDir,
                  phase: 'failed_recoverable',
                  mode: 'visual-first',
                  error: 'PPT image-first review cannot continue because generate_image is currently unavailable; retry after restoring the image-generation capability'
                },
                isError: true
              }
            }
            const toolchain = await requireToolchainDirectory({})
            const policyControl = formatPptCoreDesignPolicyControl(
              await loadPptCoreDesignPolicy(toolchain)
            )
            const inlineProfile = buildPptInlineProfile(resolvedCfg)
            const fallbackNotice = imageFirstFallbackNotice(resolvedCfg, action)
            const workflowInstruction = visualWorkflowInstruction(
              resolvedCfg,
              previewMode,
              action,
              workflowId,
              context.threadId,
              projectDir,
              scopedReview.value !== undefined
            )
            const executionBlockedTools = blocksPptExport(action)
              ? ['ppt_export']
              : undefined
            const pptWorkflowScope = {
              action,
              workflowId,
              projectDir,
              parentThreadId: context.threadId,
              previewMode,
              ...(scopedReview.value
                ? {
                    reviewContext: {
                      childId: scopedReview.value.childId,
                      slides: scopedReview.value.slides
                    }
                  }
                : {})
            } as const
            const controlPrompt = [
              policyControl,
              `PPT WORKFLOW CONTROL: action=${action}; workflowId=${workflowId}; projectDir=${projectDir}.`,
              fallbackNotice,
              workflowInstruction,
              deliverableInstruction(deliverable, action)
            ].filter(Boolean).join('\n\n')
            const childSecurity = pptChildSecurity(context, workspace, projectDir)
            const record = action === 'start'
              ? await runtime.runChild({
              parentThreadId: context.threadId,
              parentTurnId: context.turnId,
              launcher: 'ppt_agent',
              label: title,
              prompt: source.value.prompt,
              source: childSourceEnvelope(source.value),
              controlPrompt,
              pptWorkflowScope,
              workspace,
              inlineProfile,
              agentSurface: source.value.agentSurface ?? 'code',
              // Follow the parent session's model/provider/reasoning/service
              // tier unless the Lab settings configure an explicit override.
              inheritSessionDefaults: true,
              ...(resolvedCfg.fast === true ? { serviceTier: 'priority' as const } : {}),
              ...(context.serviceTier ? { inheritedServiceTier: context.serviceTier } : {}),
              ...(context.actingModelRoute?.model
                ? { inheritedModel: context.actingModelRoute.model }
                : context.model?.id?.trim()
                  ? { inheritedModel: context.model.id.trim() }
                  : {}),
              ...(context.actingModelRoute?.providerId
                ? { inheritedProviderId: context.actingModelRoute.providerId }
                : context.modelProviderId?.trim()
                  ? { inheritedProviderId: context.modelProviderId.trim() }
                  : {}),
              ...(context.actingModelRoute?.accountId
                ? { inheritedAccountId: context.actingModelRoute.accountId }
                : {}),
              ...(context.reasoningEffort?.trim()
                ? { inheritedReasoningEffort: context.reasoningEffort.trim() }
                : {}),
              ...(context.guiDesignCanvas === true ? { guiDesignCanvas: true } : {}),
              security: childSecurity,
              ...(executionBlockedTools ? { executionBlockedTools } : {}),
              approvalPolicy: context.approvalPolicy,
              ...(context.sandboxMode ? { sandboxMode: context.sandboxMode } : {}),
              approvalReviewer: context.approvalReviewer ?? 'user',
              ...(context.clientSurface ? { clientSurface: context.clientSurface } : {}),
              returnFormat: 'summary',
              onQueued: async (childId, profile, metadata) => {
                await emitPptLifecycle(onUpdate, {
                  childId,
                  status: 'queued',
                  title,
                  profile,
                  metadata: {
                    ...metadata,
                    profileName: metadata?.profileName?.trim() || 'PPT Agent',
                    model: metadata?.model?.trim() ||
                      context.actingModelRoute?.model?.trim() ||
                      context.model?.id?.trim() ||
                      undefined
                  }
                })
              },
              onRunning: async (childId, profile, metadata) => {
                await emitPptLifecycle(onUpdate, {
                  childId,
                  status: 'running',
                  title,
                  profile,
                  metadata: {
                    ...metadata,
                    profileName: metadata?.profileName?.trim() || 'PPT Agent',
                    model: metadata?.model?.trim() ||
                      context.actingModelRoute?.model?.trim() ||
                      context.model?.id?.trim() ||
                      undefined
                  }
                })
              },
              signal: context.abortSignal
            })
              : await runtime.resumeChild({
                childId,
                parentThreadId: context.threadId,
                parentTurnId: context.turnId,
                prompt: source.value.prompt,
                source: childSourceEnvelope(source.value),
                controlPrompt,
                pptWorkflowScope,
                expectedProfile: 'ppt',
                expectedLaunchers: ['ppt_agent'],
                expectedWorkflowId: workflowId,
                security: childSecurity,
                ...(executionBlockedTools ? { executionBlockedTools } : {}),
                signal: context.abortSignal,
                onQueued: async (resumedChildId, profile, metadata) => emitPptLifecycle(onUpdate, {
                  childId: resumedChildId,
                  status: 'queued',
                  title,
                  profile,
                  metadata
                }),
                onRunning: async (resumedChildId, profile, metadata) => emitPptLifecycle(onUpdate, {
                  childId: resumedChildId,
                  status: 'running',
                  title,
                  profile,
                  metadata
                })
              })
            const reviewExpected = action !== 'approve_and_build'
            const currentReviewBundle = reviewExpected && record.reviewBundleParentTurnId === context.turnId
              ? record.reviewBundle
              : undefined
            const reviewContractError = reviewExpected && currentReviewBundle === undefined
              ? 'PPT child completed without the required visual review bundle'
              : reviewBundleContractError(currentReviewBundle, record.id, workflowId, projectDir, previewMode)
            const deckArtifact = record.deckArtifactParentTurnId === context.turnId
              ? record.deckArtifact
              : undefined
            const deckExpected = deliverable === 'pptx' && action === 'approve_and_build'
            const deckContractError = deckExpected && !validatedDeckArtifact(
              deckArtifact,
              workflowId,
              projectDir,
              persistedPlanFingerprint
            )
              ? 'PPT child completed without a validated PPTX export'
              : ''
            const contractError = reviewContractError || deckContractError
            const failed = record.status === 'failed' || record.status === 'aborted' || Boolean(contractError)
            const resolvedModel =
              record.model?.trim() ||
              (typeof context.actingModelRoute?.model === 'string'
                ? context.actingModelRoute.model.trim()
                : '') ||
              context.model?.id?.trim() ||
              ''
            const profileName =
              record.profileSnapshot?.name?.trim() ||
              'PPT Agent'
            return {
              output: {
                childId: record.id,
                workflowId,
                projectDir,
                status: record.status,
                title,
                summary: record.summary ?? '',
                phase: failed ? 'failed_recoverable' : currentReviewBundle ? 'awaiting_review' : 'completed',
                mode: previewMode === 'editable' ? 'direct' : 'visual-first',
                deliverable,
                ...(fallbackNotice ? { fallbackNotice } : {}),
                ...(currentReviewBundle !== undefined ? { reviewBundle: currentReviewBundle } : {}),
                ...(deckArtifact !== undefined ? { deckArtifact } : {}),
                toolInvocations: record.toolInvocations ?? 0,
                usage: record.usage,
                profile: 'ppt',
                profileName,
                ...(resolvedModel ? { model: resolvedModel } : {}),
                ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
                ...(failed ? { error: contractError || record.error || record.status } : {})
              },
              isError: failed
            }
          }
        })
      ]
    }
  ]
}

type PptSourceResolution<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

async function resolvePptSourceEnvelope(
  turns: PptAgentTurnReader | undefined,
  context: ToolHostContext
): Promise<PptSourceResolution<PptSourceEnvelope>> {
  if (!turns) {
    return { ok: false, error: 'PPT source unavailable: active turn reader is not configured' }
  }
  const turn = await turns.getTurn(context.threadId, context.turnId).catch(() => null)
  if (!turn) {
    return {
      ok: false,
      error: `PPT source unavailable: active turn ${context.threadId}/${context.turnId} was not found`
    }
  }
  const userItems = turn.items.filter((item): item is UserTurnItem =>
    item.turnId === context.turnId && item.kind === 'user_message')
  if (userItems.length !== 1) {
    return {
      ok: false,
      error: userItems.length === 0
        ? `PPT source unavailable: active turn ${context.threadId}/${context.turnId} has no user message`
        : 'PPT source unavailable: the active turn received mid-turn steering; start a new turn and retry so no user request is silently merged or discarded'
    }
  }
  const userItem = userItems[0]
  const composerContexts = userItem.composerContexts ?? turn.composerContexts ?? []
  const reviewContexts: PptReviewContextV1[] = []
  for (const composerContext of composerContexts) {
    if (
      !('source' in composerContext.provenance) ||
      composerContext.provenance.source !== 'dev-preview' ||
      composerContext.reference.kind !== 'ppt-review'
    ) continue
    const parsed = PptReviewContextV1.safeParse(composerContext.reference)
    if (!parsed.success) {
      return {
        ok: false,
        error: `PPT source unavailable: invalid structured review context ${composerContext.id}`
      }
    }
    reviewContexts.push(parsed.data)
  }
  const parsedSource = ChildSourceEnvelope.safeParse({
    prompt: turn.prompt,
    ...(userItem.displayText !== undefined ? { displayText: userItem.displayText } : {}),
    attachmentIds: userItem.attachmentIds ?? turn.attachmentIds,
    composerContexts,
    fileReferences: userItem.fileReferences ?? [],
    agentSurface: turn.agentSurface ?? context.agentSurface
  })
  if (!parsedSource.success) {
    return { ok: false, error: 'PPT source unavailable: active turn source is invalid' }
  }
  return { ok: true, value: { ...parsedSource.data, reviewContexts } }
}

function childSourceEnvelope(
  source: PptSourceEnvelope
): z.infer<typeof ChildSourceEnvelope> {
  const composerContexts = source.composerContexts.filter((context) =>
    context.reference.kind !== 'ppt-review')
  return ChildSourceEnvelope.parse({
    prompt: source.prompt,
    ...(source.displayText !== undefined ? { displayText: source.displayText } : {}),
    attachmentIds: source.attachmentIds,
    composerContexts,
    fileReferences: source.fileReferences,
    ...(source.agentSurface ? { agentSurface: source.agentSurface } : {})
  })
}

function scopedPptReviewContext(
  contexts: readonly PptReviewContextV1[],
  action: 'start' | 'revise_previews' | 'retry_failed' | 'approve_and_build',
  childId: string,
  workflowId: string
): PptSourceResolution<PptReviewContextV1 | undefined> {
  if (action === 'start') return { ok: true, value: undefined }
  const matching = contexts.filter((context) =>
    context.childId === childId && context.workflowId === workflowId)
  if (matching.length === 1) return { ok: true, value: matching[0] }
  if (matching.length > 1) {
    return { ok: false, error: `PPT source unavailable: duplicate review context for workflow ${workflowId}` }
  }
  return {
    ok: false,
    error: contexts.length > 0
      ? `PPT source unavailable: review context does not match child ${childId} and workflow ${workflowId}`
      : `PPT source unavailable: review context is required for workflow ${workflowId}`
  }
}

async function emitPptLifecycle(
  onUpdate: ((update: ToolExecutionUpdate) => Promise<void> | void) | undefined,
  args: {
    childId: string
    status: 'queued' | 'running'
    title: string
    profile?: string
    metadata?: { profileName?: string; model?: string; reasoningEffort?: string }
  }
): Promise<void> {
  await onUpdate?.({
    output: {
      childId: args.childId,
      status: args.status,
      title: args.title,
      profile: args.profile ?? 'ppt',
      profileName: args.metadata?.profileName?.trim() || 'PPT Agent',
      ...(args.metadata?.model ? { model: args.metadata.model } : {}),
      ...(args.metadata?.reasoningEffort ? { reasoningEffort: args.metadata.reasoningEffort } : {})
    },
    isError: false
  })
}

function buildPptInlineProfile(
  cfg: PptAgentToolConfig
): { id: string; profile: SubagentProfileConfig; source: 'builtin' } {
  const model = cfg.model?.trim()
  const providerId = cfg.providerId?.trim()
  const reasoningEffort = ModelReasoningEffort.safeParse(cfg.reasoningEffort).success
    ? cfg.reasoningEffort
    : undefined
  return {
    id: 'ppt',
    source: 'builtin',
    profile: {
      mode: 'subagent',
      toolPolicy: 'inherit',
      skillsEnabled: false,
      allowedTools: [...PPT_AGENT_ALLOWED_TOOLS],
      blockedTools: ['delegate_task', 'generate_subagent', 'load_skill'],
      systemPrompt: PPT_AGENT_PROFILE.systemPrompt,
      ...(model && providerId ? { model, providerId } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {})
    }
  }
}

function pptChildSecurity(
  context: ToolHostContext,
  workspace: string,
  projectDir: string
): ChildSecuritySnapshot {
  const inherited = {
    sandboxRoot: workspace,
    ...(context.allowedProviderIds ? { allowedProviderIds: [...context.allowedProviderIds] } : {}),
    ...(context.allowedToolNames ? { allowedToolNames: [...context.allowedToolNames] } : {}),
    ...(context.allowedSkillIds ? { allowedSkillIds: [...context.allowedSkillIds] } : {}),
    ...(context.allowedReadPaths ? { allowedReadPaths: [...context.allowedReadPaths] } : {}),
    ...(context.allowedWritePaths ? { allowedWritePaths: [...context.allowedWritePaths] } : {}),
    ...(context.allowedArtifactIds ? { allowedArtifactIds: [...context.allowedArtifactIds] } : {}),
    ...(context.blockedProviderIds ? { blockedProviderIds: [...context.blockedProviderIds] } : {}),
    ...(context.blockedToolNames ? { blockedToolNames: [...context.blockedToolNames] } : {}),
    ...(context.blockedSkillIds ? { blockedSkillIds: [...context.blockedSkillIds] } : {}),
    instructionsEnabled: false,
    memoryEnabled: false
  }
  return intersectChildSecurity(inherited, {
    sandboxRoot: workspace,
    allowedWritePaths: [projectDir, '.kun/images', 'presentations'],
    instructionsEnabled: false,
    memoryEnabled: false
  })
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
