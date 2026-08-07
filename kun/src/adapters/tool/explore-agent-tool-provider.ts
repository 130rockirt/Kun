import type { DelegationRuntime } from '../../delegation/delegation-runtime.js'
import { EXPLORE_PROFILE } from '../../delegation/builtin-profiles.js'
import {
  ModelReasoningEffort,
  type SubagentProfileConfig
} from '../../contracts/capabilities.js'
import type { ToolExecutionUpdate, ToolHostContext } from '../../ports/tool-host.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import { LocalToolHost } from './local-tool-host.js'

export const EXPLORE_AGENT_TOOL_NAME = 'explore_agent' as const
export const EXPLORE_AGENT_PROVIDER_ID = 'explore-agent' as const

export type ExploreAgentToolConfig = {
  enabled?: boolean
  model?: string
  providerId?: string
  reasoningEffort?: ModelReasoningEffort
  fast?: boolean
}

/**
 * First-class exploration tool allow-list. Full bash plus read-only search /
 * inspection tools and the web helpers. Deliberately excludes mutation and
 * delegation tools (write/edit/delete/delegate_task/...) so the child can
 * investigate freely but never modify the workspace.
 */
export const EXPLORE_AGENT_ALLOWED_TOOLS = [
  'bash',
  'read',
  'grep',
  'glob',
  'ls',
  'repo_map',
  'find',
  'web_fetch',
  'web_search'
] as const

const EXPLORE_AGENT_PROMPT_PREAMBLE = [
  '你是 Kun 的只读探索代理。',
  '只查找文件、搜索关键字、列目录、读取内容并返回结论（文件:行 + 简要说明），',
  '绝不修改任何文件或外部状态，也不要执行会改动工作区的命令。'
].join('')

const EXPLORE_AGENT_DESCRIPTION = [
  'Use this first for any repository or project exploration: locating files or symbols, searching code or keywords, tracing call paths or dependencies, understanding architecture or behavior, or gathering context before a change.',
  'Complex questions MUST be split into multiple parallel explore_agent calls with non-overlapping scopes (for example one call for API wiring, another for UI, another for tests). Never pack a whole-repo investigation into a single call.',
  'Each call needs a short distinct title (2-6 words) for the UI plus a narrow, self-contained query that states what evidence to return.',
  '即使后续需要修改文件，也必须先调用 explore_agent；它优先于主代理直接使用 read/grep/glob/ls/repo_map/find/bash，并应为独立调查面并行发起多个调用。',
  'Only use direct inspection tools for narrow follow-up verification after this tool returns, or when explore_agent is unavailable or fails.',
  '它可以运行 bash 与只读探索工具（read/grep/glob/ls/repo_map/find/web_fetch/web_search），但始终不会修改文件。'
].join(' ')

/**
 * First-class `explore_agent` tool: the main agent delegates a scoped
 * exploration query to a read-oriented child that may use full bash plus the
 * exploration allow-list. It reuses the whole subagent runtime (child thread,
 * events, approval inheritance, SubagentCallCard rendering) while keeping the
 * delegate_task router untouched. Lab disable is enforced live via
 * `shouldAdvertise` (and an execute backstop) so hot-applied settings can
 * hide or restore the tool without rebuilding the provider away.
 */
export function buildExploreAgentToolProvider(
  runtime: DelegationRuntime | undefined,
  config: () => ExploreAgentToolConfig | undefined
): CapabilityToolProvider[] {
  if (!runtime?.enabled()) return []
  const shouldAdvertise = (_context: ToolHostContext): boolean =>
    config()?.enabled !== false
  return [
    {
      id: EXPLORE_AGENT_PROVIDER_ID,
      kind: 'delegation',
      enabled: true,
      available: true,
      tools: [
        LocalToolHost.defineTool({
          name: EXPLORE_AGENT_TOOL_NAME,
          description: EXPLORE_AGENT_DESCRIPTION,
          inputSchema: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'Distinct 2-6 word UI title for this exploration (shown in the parallel explore list).'
              },
              query: {
                type: 'string',
                description: 'Narrow, self-contained investigation request: what to locate or explain, and which file:line evidence or concise conclusion to return. Do not restate the whole user question if multiple explores are running in parallel.'
              },
              workspace: {
                type: 'string',
                description: 'Optional workspace root to explore. Defaults to the parent turn workspace.'
              }
            },
            required: ['title', 'query'],
            additionalProperties: false
          },
          policy: 'auto',
          sideEffect: 'read-only',
          shouldAdvertise,
          execute: async (args, context, onUpdate) => {
            const cfg = config()
            if (cfg?.enabled === false) {
              return {
                output: { error: 'explore_agent is disabled in Lab settings' },
                isError: true
              }
            }
            const title = stringValue(args.title)
            const query = stringValue(args.query)
            if (!title) return { output: { error: 'title is required' }, isError: true }
            if (!query) return { output: { error: 'query is required' }, isError: true }
            const workspace = stringValue(args.workspace) || context.workspace
            const resolvedCfg = cfg ?? {}
            const inlineProfile = buildExploreInlineProfile(resolvedCfg)
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
                await emitExploreLifecycle(onUpdate, {
                  childId,
                  status: 'queued',
                  title,
                  profile,
                  metadata: {
                    ...metadata,
                    profileName: metadata?.profileName?.trim() || 'Repository Explorer',
                    model: metadata?.model?.trim() ||
                      context.actingModelRoute?.model?.trim() ||
                      context.model?.id?.trim() ||
                      undefined
                  }
                })
              },
              onRunning: async (childId, profile, metadata) => {
                await emitExploreLifecycle(onUpdate, {
                  childId,
                  status: 'running',
                  title,
                  profile,
                  metadata: {
                    ...metadata,
                    profileName: metadata?.profileName?.trim() || 'Repository Explorer',
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
              'Repository Explorer'
            return {
              output: {
                childId: record.id,
                status: record.status,
                title,
                summary: record.summary ?? '',
                toolInvocations: record.toolInvocations ?? 0,
                usage: record.usage,
                profile: 'explore',
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

async function emitExploreLifecycle(
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
      profile: args.profile ?? 'explore',
      profileName: args.metadata?.profileName?.trim() || 'Repository Explorer',
      ...(args.metadata?.model ? { model: args.metadata.model } : {}),
      ...(args.metadata?.reasoningEffort ? { reasoningEffort: args.metadata.reasoningEffort } : {})
    },
    isError: false
  })
}

function buildExploreInlineProfile(
  cfg: ExploreAgentToolConfig
): { id: string; profile: SubagentProfileConfig; source: 'builtin' } {
  const model = cfg.model?.trim()
  const providerId = cfg.providerId?.trim()
  const reasoningEffort = ModelReasoningEffort.safeParse(cfg.reasoningEffort).success
    ? cfg.reasoningEffort
    : undefined
  return {
    id: 'explore',
    source: 'builtin',
    profile: {
      mode: 'subagent',
      toolPolicy: 'inherit',
      skillsEnabled: false,
      allowedTools: [...EXPLORE_AGENT_ALLOWED_TOOLS],
      blockedTools: ['delegate_task', 'generate_subagent', 'load_skill'],
      systemPrompt: EXPLORE_PROFILE.systemPrompt,
      promptPreamble: EXPLORE_AGENT_PROMPT_PREAMBLE,
      ...(model && providerId ? { model, providerId } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {})
    }
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
