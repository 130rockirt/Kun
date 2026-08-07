import type { DelegationRuntime } from '../../delegation/delegation-runtime.js'
import { EXPLORE_PROFILE } from '../../delegation/builtin-profiles.js'
import {
  ModelReasoningEffort,
  type SubagentProfileConfig
} from '../../contracts/capabilities.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
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

/**
 * First-class `explore_agent` tool: the main agent delegates a scoped
 * exploration query to a read-oriented child that may use full bash plus the
 * exploration allow-list. It reuses the whole subagent runtime (child thread,
 * events, approval inheritance, SubagentCallCard rendering) while keeping the
 * delegate_task router untouched. Disabled via Lab settings removes the tool
 * from the main agent's tool list entirely.
 */
export function buildExploreAgentToolProvider(
  runtime: DelegationRuntime | undefined,
  config: () => ExploreAgentToolConfig | undefined
): CapabilityToolProvider[] {
  if (!runtime?.enabled()) return []
  if (config()?.enabled === false) return []
  return [
    {
      id: EXPLORE_AGENT_PROVIDER_ID,
      kind: 'delegation',
      enabled: true,
      available: true,
      tools: [
        LocalToolHost.defineTool({
          name: EXPLORE_AGENT_TOOL_NAME,
          description: [
            'Use this first for any repository or project exploration: locating files or symbols, searching code or keywords, tracing call paths or dependencies, understanding architecture or behavior, or gathering context before a change.',
            '即使后续需要修改文件，也必须先调用 explore_agent；它优先于主代理直接使用 read/grep/glob/ls/repo_map/find/bash，并可为独立调查并行发起多个调用。',
            'Only use direct inspection tools for narrow follow-up verification after this tool returns, or when explore_agent is unavailable or fails.',
            '它可以运行 bash 与只读探索工具（read/grep/glob/ls/repo_map/find/web_fetch/web_search），但始终不会修改文件。'
          ].join(' '),
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Self-contained investigation request: what to locate or explain, and which file:line evidence or concise conclusion to return.'
              },
              workspace: {
                type: 'string',
                description: 'Optional workspace root to explore. Defaults to the parent turn workspace.'
              }
            },
            required: ['query'],
            additionalProperties: false
          },
          policy: 'auto',
          execute: async (args, context) => {
            const cfg = config()
            if (!cfg || cfg.enabled === false) {
              return {
                output: { error: 'explore_agent is disabled in Lab settings' },
                isError: true
              }
            }
            const query = stringValue(args.query)
            if (!query) return { output: { error: 'query is required' }, isError: true }
            const workspace = stringValue(args.workspace) || context.workspace
            const inlineProfile = buildExploreInlineProfile(cfg)
            const record = await runtime.runChild({
              parentThreadId: context.threadId,
              parentTurnId: context.turnId,
              label: '探索项目',
              prompt: query,
              workspace,
              inlineProfile,
              agentSurface: context.agentSurface ?? 'code',
              // Follow the parent session's model/provider/reasoning/service
              // tier unless the Lab settings configure an explicit override.
              inheritSessionDefaults: true,
              ...(cfg.fast === true ? { serviceTier: 'priority' as const } : {}),
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
              signal: context.abortSignal
            })
            const failed = record.status === 'failed' || record.status === 'aborted'
            return {
              output: {
                summary: record.summary ?? '',
                toolInvocations: record.toolInvocations ?? 0,
                usage: record.usage,
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
