import type { DelegationRuntime } from '../../delegation/delegation-runtime.js'
import {
  PPT_AGENT_PROFILE,
  PPT_AGENT_PROMPT_PREAMBLE
} from '../../delegation/builtin-profiles.js'
import {
  ModelReasoningEffort,
  type SubagentProfileConfig
} from '../../contracts/capabilities.js'
import type { ToolExecutionUpdate, ToolHostContext } from '../../ports/tool-host.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import { LocalToolHost } from './local-tool-host.js'

export const PPT_AGENT_TOOL_NAME = 'ppt_agent' as const
export const PPT_AGENT_PROVIDER_ID = 'ppt-agent' as const

export type PptAgentToolConfig = {
  enabled?: boolean
  model?: string
  providerId?: string
  reasoningEffort?: ModelReasoningEffort
  fast?: boolean
}

/**
 * First-class PPT allow-list. Full file authoring plus the managed `ppt_export`
 * tool, optional shell access for visual QA, web helpers and image generation
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
  'ppt_export',
  'bash',
  'web_fetch',
  'web_search',
  'generate_image'
] as const

const PPT_AGENT_DESCRIPTION = [
  'Use `ppt_agent` for any presentation/PPT task: create, edit, replicate, or read a deck.',
  'It runs a dedicated PPT agent child that produces a PPTD project + locally exported .pptx (open-kimi-ppt-skill workflow distilled into its system prompt), can call generate_image for artwork, and returns a boardSpec the parent replays on the Design whiteboard when the user asked to present.',
  'Give it a short distinct title (2-6 words) for the UI plus a self-contained query covering: topic/content, page count, style direction, whether to generate artwork, and whether the user wants the deck laid out on the whiteboard.',
  'The child writes deck files under the workspace; the parent owns deliverable verification (deck structure, .pptx export, per-page fade).',
  'PPT 演示文稿任务（创建/编辑/复刻/读取）都应优先交给 ppt_agent；委托时给出清晰的目标与交付物要求。'
].join(' ')

/**
 * First-class `ppt_agent` tool: the main agent delegates a presentation task
 * to a PPT-oriented child whose system prompt distills the open-kimi-ppt-skill
 * workflow. It reuses the whole subagent runtime (child thread, events,
 * approval inheritance, SubagentCallCard rendering) while keeping the
 * delegate_task router untouched. Lab disable is enforced live via
 * `shouldAdvertise` (and an execute backstop), mirroring explore_agent.
 */
export function buildPptAgentToolProvider(
  runtime: DelegationRuntime | undefined,
  config: () => PptAgentToolConfig | undefined
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
              title: {
                type: 'string',
                description: 'Distinct 2-6 word UI title for this PPT task (shown in the child-run card).'
              },
              query: {
                type: 'string',
                description: 'Complete PPT request: topic/content, page count, style direction, whether to generate artwork, and whether to lay the deck out on the whiteboard.'
              },
              workspace: {
                type: 'string',
                description: 'Optional workspace root. Defaults to the parent turn workspace.'
              },
              deliverable: {
                type: 'string',
                enum: ['pptx', 'pptd-only'],
                description: 'Optional deliverable preference. Defaults to PPTD project + locally exported .pptx.'
              }
            },
            required: ['title', 'query'],
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
            const title = stringValue(args.title)
            const query = stringValue(args.query)
            if (!title) return { output: { error: 'title is required' }, isError: true }
            if (!query) return { output: { error: 'query is required' }, isError: true }
            const workspace = stringValue(args.workspace) || context.workspace
            const resolvedCfg = cfg ?? {}
            const inlineProfile = buildPptInlineProfile(resolvedCfg)
            const record = await runtime.runChild({
              parentThreadId: context.threadId,
              parentTurnId: context.turnId,
              label: title,
              prompt: query,
              workspace,
              inlineProfile,
              agentSurface: context.agentSurface ?? 'code',
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
              security: {
                sandboxRoot: workspace,
                ...(context.allowedProviderIds
                  ? { allowedProviderIds: [...context.allowedProviderIds] }
                  : {}),
                ...(context.allowedToolNames
                  ? { allowedToolNames: [...context.allowedToolNames] }
                  : {}),
                ...(context.allowedSkillIds
                  ? { allowedSkillIds: [...context.allowedSkillIds] }
                  : {}),
                ...(context.allowedReadPaths
                  ? { allowedReadPaths: [...context.allowedReadPaths] }
                  : {}),
                ...(context.allowedWritePaths
                  ? { allowedWritePaths: [...context.allowedWritePaths] }
                  : {}),
                ...(context.allowedArtifactIds
                  ? { allowedArtifactIds: [...context.allowedArtifactIds] }
                  : {}),
                ...(context.blockedProviderIds
                  ? { blockedProviderIds: [...context.blockedProviderIds] }
                  : {}),
                ...(context.blockedToolNames
                  ? { blockedToolNames: [...context.blockedToolNames] }
                  : {}),
                ...(context.blockedSkillIds
                  ? { blockedSkillIds: [...context.blockedSkillIds] }
                  : {}),
                memoryEnabled: context.memoryPolicy?.enabled === true
              },
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
                    profileName: metadata?.profileName?.trim() || 'PPT Master',
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
                    profileName: metadata?.profileName?.trim() || 'PPT Master',
                    model: metadata?.model?.trim() ||
                      context.actingModelRoute?.model?.trim() ||
                      context.model?.id?.trim() ||
                      undefined
                  }
                })
              },
              signal: context.abortSignal
            })
            const failed = record.status === 'failed' || record.status === 'aborted'
            const resolvedModel =
              record.model?.trim() ||
              (typeof context.actingModelRoute?.model === 'string'
                ? context.actingModelRoute.model.trim()
                : '') ||
              context.model?.id?.trim() ||
              ''
            const profileName =
              record.profileSnapshot?.name?.trim() ||
              'PPT Master'
            return {
              output: {
                childId: record.id,
                status: record.status,
                title,
                summary: record.summary ?? '',
                toolInvocations: record.toolInvocations ?? 0,
                usage: record.usage,
                profile: 'ppt',
                profileName,
                ...(resolvedModel ? { model: resolvedModel } : {}),
                ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
                ...(failed ? { error: record.error ?? record.status } : {})
              },
              isError: failed
            }
          }
        })
      ]
    }
  ]
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
      profileName: args.metadata?.profileName?.trim() || 'PPT Master',
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
      promptPreamble: PPT_AGENT_PROMPT_PREAMBLE,
      ...(model && providerId ? { model, providerId } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {})
    }
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
