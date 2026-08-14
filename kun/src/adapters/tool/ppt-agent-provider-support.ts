import { z } from 'zod'
import { ModelReasoningEffort, type SubagentProfileConfig } from '../../contracts/capabilities.js'
import type { TurnItem, UserTurnItem } from '../../contracts/items.js'
import type { TurnService } from '../../services/turn-service.js'
import { ChildSourceEnvelope, type ChildSecuritySnapshot } from '../../delegation/delegation-runtime.js'
import { PPT_AGENT_PROFILE } from '../../delegation/builtin-profiles.js'
import { intersectChildSecurity } from '../../delegation/delegation-runtime-support.js'
import type { ToolExecutionUpdate, ToolHostContext } from '../../ports/tool-host.js'
import type { PptAgentAction } from './ppt-agent-workflow-control.js'

export const PPT_AGENT_ALLOWED_TOOLS = [
  'read', 'grep', 'glob', 'ls', 'write', 'edit',
  'ppt_read_guide', 'ppt_read_direction_selection', 'ppt_read_review_context',
  'ppt_submit_design_plan', 'ppt_import_asset', 'ppt_export', 'ppt_generate_previews',
  'ppt_create_direction_bundle', 'ppt_create_review_bundle',
  'web_fetch', 'web_search', 'generate_image'
] as const

type PptProviderToolConfig = {
  model?: string
  providerId?: string
  reasoningEffort?: ModelReasoningEffort
}

export type PptProviderReviewContext = {
  kind: 'ppt-review'
  schemaVersion: 1
  workflowId: string
  childId: string
  slides: Array<{ slideId: string; revision: number; annotations?: string[] }>
}

export type PptProviderDirectionContext = {
  kind: 'ppt-direction'
  schemaVersion: 1
  workflowId: string
  childId: string
  directions: Array<{ directionId: string; revision: number }>
}

export type PptProviderDirectionInputAnswer = {
  workflowId: string
  childId: string
  answer: string
}

export type PptProviderSourceEnvelope = z.infer<typeof ChildSourceEnvelope> & {
  reviewContexts: PptProviderReviewContext[]
  directionContexts: PptProviderDirectionContext[]
  directionInputAnswers: PptProviderDirectionInputAnswer[]
}

type Resolution<T> = { ok: true; value: T } | { ok: false; error: string }

const ReviewContext = z.object({
  kind: z.literal('ppt-review'), schemaVersion: z.literal(1), workflowId: z.string().min(1), childId: z.string().min(1),
  slides: z.array(z.object({
    slideId: z.string().min(1), revision: z.number().int().nonnegative(),
    annotations: z.array(z.string().trim().min(1).max(2_048)).optional()
  }).strict()).min(1)
}).strict()

const DirectionContext = z.object({
  kind: z.literal('ppt-direction'), schemaVersion: z.literal(1), workflowId: z.string().min(1), childId: z.string().min(1),
  directions: z.array(z.object({
    directionId: z.string().min(1), revision: z.number().int().positive()
  }).strict()).max(1)
}).strict()

export async function resolvePptProviderSource(
  turns: Pick<TurnService, 'getTurn'> | undefined,
  context: ToolHostContext
): Promise<Resolution<PptProviderSourceEnvelope>> {
  if (!turns) return fail('PPT source unavailable: active turn reader is not configured')
  const turn = await turns.getTurn(context.threadId, context.turnId).catch(() => null)
  if (!turn) return fail(`PPT source unavailable: active turn ${context.threadId}/${context.turnId} was not found`)
  const userItems = turn.items.filter((item): item is UserTurnItem =>
    item.turnId === context.turnId && item.kind === 'user_message')
  if (userItems.length !== 1) {
    return fail(userItems.length === 0
      ? `PPT source unavailable: active turn ${context.threadId}/${context.turnId} has no user message`
      : 'PPT source unavailable: the active turn received mid-turn steering; start a new turn and retry so no user request is silently merged or discarded')
  }
  const userItem = userItems[0]
  const composerContexts = userItem.composerContexts ?? turn.composerContexts ?? []
  const reviewContexts: PptProviderReviewContext[] = []
  const directionContexts: PptProviderDirectionContext[] = []
  const directionInputAnswers = pptDirectionInputAnswers(turn.items)
  for (const composerContext of composerContexts) {
    if (!('source' in composerContext.provenance) || composerContext.provenance.source !== 'dev-preview') continue
    if (composerContext.reference.kind === 'ppt-review') {
      const parsed = ReviewContext.safeParse(composerContext.reference)
      if (!parsed.success) return fail(`PPT source unavailable: invalid structured review context ${composerContext.id}`)
      reviewContexts.push(parsed.data)
    }
    if (composerContext.reference.kind === 'ppt-direction') {
      const parsed = DirectionContext.safeParse(composerContext.reference)
      if (!parsed.success) return fail(`PPT source unavailable: invalid structured direction context ${composerContext.id}`)
      directionContexts.push(parsed.data)
    }
  }
  const source = ChildSourceEnvelope.safeParse({
    prompt: turn.prompt,
    ...(userItem.displayText !== undefined ? { displayText: userItem.displayText } : {}),
    attachmentIds: userItem.attachmentIds ?? turn.attachmentIds,
    composerContexts,
    fileReferences: userItem.fileReferences ?? [],
    agentSurface: turn.agentSurface ?? context.agentSurface
  })
  return source.success
    ? { ok: true, value: { ...source.data, reviewContexts, directionContexts, directionInputAnswers } }
    : fail('PPT source unavailable: active turn source is invalid')
}

export function childPptSourceEnvelope(source: PptProviderSourceEnvelope): z.infer<typeof ChildSourceEnvelope> {
  return ChildSourceEnvelope.parse({
    prompt: source.prompt,
    ...(source.displayText !== undefined ? { displayText: source.displayText } : {}),
    attachmentIds: source.attachmentIds,
    composerContexts: source.composerContexts.filter((item) =>
      item.reference.kind !== 'ppt-review' && item.reference.kind !== 'ppt-direction'),
    fileReferences: source.fileReferences,
    ...(source.agentSurface ? { agentSurface: source.agentSurface } : {})
  })
}

export function scopePptReviewContext(
  contexts: readonly PptProviderReviewContext[], action: PptAgentAction, childId: string, workflowId: string
): Resolution<PptProviderReviewContext | undefined> {
  if (action === 'start' || action === 'select_direction' || action === 'revise_directions') {
    return { ok: true, value: undefined }
  }
  const matching = contexts.filter((item) => item.childId === childId && item.workflowId === workflowId)
  if (matching.length === 1) return { ok: true, value: matching[0] }
  if (matching.length > 1) return fail(`PPT source unavailable: duplicate review context for workflow ${workflowId}`)
  return fail(contexts.length > 0
    ? `PPT source unavailable: review context does not match child ${childId} and workflow ${workflowId}`
    : `PPT source unavailable: review context is required for workflow ${workflowId}`)
}

export function scopePptDirectionContext(
  contexts: readonly PptProviderDirectionContext[], action: PptAgentAction, childId: string, workflowId: string
): Resolution<PptProviderDirectionContext | undefined> {
  if (action !== 'select_direction' && action !== 'revise_directions') return { ok: true, value: undefined }
  const matching = contexts.filter((item) => item.childId === childId && item.workflowId === workflowId)
  if (matching.length !== contexts.length) {
    return fail(`PPT source unavailable: direction context does not match child ${childId} and workflow ${workflowId}`)
  }
  if (matching.length === 1) return { ok: true, value: matching[0] }
  if (matching.length > 1) return fail(`PPT source unavailable: duplicate direction context for workflow ${workflowId}`)
  return { ok: true, value: undefined }
}

export function scopePptDirectionInputAnswer(
  answers: readonly PptProviderDirectionInputAnswer[],
  action: PptAgentAction,
  childId: string,
  workflowId: string
): PptProviderDirectionInputAnswer | undefined {
  if (action !== 'select_direction') return undefined
  for (let index = answers.length - 1; index >= 0; index -= 1) {
    const answer = answers[index]
    if (answer.childId === childId && answer.workflowId === workflowId) return answer
  }
  return undefined
}

function pptDirectionInputAnswers(
  items: readonly TurnItem[]
): PptProviderDirectionInputAnswer[] {
  const out: PptProviderDirectionInputAnswer[] = []
  for (const item of items) {
    if (item.kind !== 'user_input') continue
    const input = item
    if (input.status !== 'submitted') continue
    for (const answer of input.answers ?? []) {
      if (!input.questions.some((question) => question.id === answer.id)) continue
      const identity = parsePptDirectionInputQuestionId(answer.id)
      const value = answer.value.trim() || answer.label.trim()
      if (identity && value) out.push({ ...identity, answer: value })
    }
  }
  return out
}

function parsePptDirectionInputQuestionId(
  value: string
): Pick<PptProviderDirectionInputAnswer, 'workflowId' | 'childId'> | null {
  const match = value.match(/^ppt_direction:([^:]+):([^:]+)$/)
  return match ? { workflowId: match[1], childId: match[2] } : null
}

export async function emitPptLifecycleUpdate(
  onUpdate: ((update: ToolExecutionUpdate) => Promise<void> | void) | undefined,
  args: { childId: string; status: 'queued' | 'running'; title: string; profile?: string; metadata?: { profileName?: string; model?: string; reasoningEffort?: string } }
): Promise<void> {
  await onUpdate?.({
    output: {
      childId: args.childId, status: args.status, title: args.title, profile: args.profile ?? 'ppt',
      profileName: args.metadata?.profileName?.trim() || 'PPT Agent',
      ...(args.metadata?.model ? { model: args.metadata.model } : {}),
      ...(args.metadata?.reasoningEffort ? { reasoningEffort: args.metadata.reasoningEffort } : {})
    },
    isError: false
  })
}

export function buildPptProviderProfile(cfg: PptProviderToolConfig): { id: string; profile: SubagentProfileConfig; source: 'builtin' } {
  const model = cfg.model?.trim()
  const providerId = cfg.providerId?.trim()
  const reasoningEffort = ModelReasoningEffort.safeParse(cfg.reasoningEffort).success ? cfg.reasoningEffort : undefined
  return {
    id: 'ppt', source: 'builtin',
    profile: {
      mode: 'subagent', toolPolicy: 'inherit', skillsEnabled: false,
      allowedTools: [...PPT_AGENT_ALLOWED_TOOLS],
      blockedTools: ['delegate_task', 'generate_subagent', 'load_skill'],
      systemPrompt: PPT_AGENT_PROFILE.systemPrompt,
      ...(model && providerId ? { model, providerId } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {})
    }
  }
}

export function pptProviderChildSecurity(
  context: ToolHostContext, workspace: string, projectDir: string
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

export function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error }
}
