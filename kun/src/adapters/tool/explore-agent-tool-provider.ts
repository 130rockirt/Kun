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
  'Submit one batch containing 2-4 non-overlapping tasks for a complex investigation (for example API wiring, UI, and tests). Each task needs a short distinct title plus a narrow, self-contained query that states what evidence to return.',
  'Tasks in one batch run concurrently when policy and global capacity allow. If an investigation depends on evidence from this batch, submit it in a later explore_agent batch.',
  '即使后续需要修改文件，也必须先调用 explore_agent；它优先于主代理直接使用 read/grep/glob/ls/repo_map/find/bash，复杂问题应在一个批次中提交 2-4 个独立调查任务。',
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
              tasks: {
                type: 'array',
                minItems: 1,
                maxItems: 4,
                description: 'One wave of 1-4 independent exploration tasks. Use 2-4 non-overlapping tasks for complex investigations and a later batch for dependent follow-ups.',
                items: {
                  type: 'object',
                  properties: {
                    title: {
                      type: 'string',
                      minLength: 1,
                      description: 'Distinct short UI title for this exploration task.'
                    },
                    query: {
                      type: 'string',
                      minLength: 1,
                      description: 'Narrow, self-contained investigation request, including the file:line evidence or concise conclusion to return.'
                    }
                  },
                  required: ['title', 'query'],
                  additionalProperties: false
                }
              },
              workspace: {
                type: 'string',
                description: 'Optional workspace root to explore. Defaults to the parent turn workspace.'
              }
            },
            required: ['tasks'],
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
            const parsedTasks = parseExploreTasks(args.tasks)
            if ('error' in parsedTasks) {
              return { output: { error: parsedTasks.error }, isError: true }
            }
            const workspace = stringValue(args.workspace) || context.workspace
            const resolvedCfg = cfg ?? {}
            const inlineProfile = buildExploreInlineProfile(resolvedCfg)
            const batch = new ExploreBatchState(parsedTasks.tasks, onUpdate)
            await batch.emit()
            const runTask = async (task: ExploreTask, index: number): Promise<void> => {
              try {
                const record = await runtime.runChild({
                  parentThreadId: context.threadId,
                  parentTurnId: context.turnId,
                  launcher: 'explore_agent',
                  label: task.title,
                  prompt: task.query,
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
                  onQueued: async (childId, _profile, metadata) => {
                    await batch.update(index, {
                      childId,
                      status: 'queued',
                      profileName: metadata?.profileName?.trim() || 'Repository Explorer',
                      model: resolveExploreModel(metadata?.model, context)
                    })
                  },
                  onRunning: async (childId, _profile, metadata) => {
                    await batch.update(index, {
                      childId,
                      status: 'running',
                      profileName: metadata?.profileName?.trim() || 'Repository Explorer',
                      model: resolveExploreModel(metadata?.model, context)
                    })
                  },
                  signal: context.abortSignal
                })
                const failed = record.status === 'failed' || record.status === 'aborted'
                await batch.update(index, {
                  childId: record.id,
                  status: record.status,
                  summary: record.summary,
                  error: failed ? record.error ?? record.status : undefined,
                  model: resolveExploreModel(record.model, context),
                  profileName: record.profileSnapshot?.name?.trim() || 'Repository Explorer',
                  toolInvocations: record.toolInvocations,
                  durationMs: record.durationMs,
                  usage: record.usage,
                  parentThreadId: record.parentThreadId,
                  parentTurnId: record.parentTurnId,
                  launcher: 'explore_agent',
                  terminationReason: record.terminationReason,
                  resumable: record.resumable === true,
                  resumeCount: record.resumeCount ?? 0,
                  summaryTruncated: record.summaryTruncated,
                  resultRef: record.resultRef,
                  resultUnavailableReason: record.resultUnavailableReason
                })
              } catch (error) {
                await batch.update(index, {
                  status: context.abortSignal.aborted ? 'aborted' : 'failed',
                  error: errorMessage(error)
                })
              }
            }
            if (requiresSerialExploreBatch(context.approvalPolicy)) {
              for (const [index, task] of parsedTasks.tasks.entries()) {
                if (context.abortSignal.aborted) {
                  await batch.abortRemaining(index)
                  break
                }
                await Promise.allSettled([runTask(task, index)])
              }
            } else {
              await Promise.allSettled(parsedTasks.tasks.map(runTask))
            }
            const output = batch.output()
            return { output, isError: output.status === 'failed' }
          }
        })
      ]
    }
  ]
}

type ExploreTask = { title: string; query: string }
type ExploreChildStatus = 'queued' | 'running' | 'completed' | 'failed' | 'aborted'
type ExploreBatchStatus = 'running' | 'completed' | 'partial' | 'failed'

type ExploreChildOutput = ExploreTask & {
  index: number
  childId?: string
  status: ExploreChildStatus
  summary?: string
  error?: string
  model?: string
  profile: 'explore'
  profileName: string
  toolInvocations?: number
  durationMs?: number
  usage?: object
  parentThreadId?: string
  parentTurnId?: string
  launcher?: 'explore_agent'
  terminationReason?: 'manual_stop' | 'runtime_restart' | 'child_error'
  resumable?: boolean
  resumeCount?: number
  summaryTruncated?: boolean
  resultRef?: {
    artifactId: string
    byteSize: number
    lineCount: number
    mimeType: 'text/markdown'
  }
  resultUnavailableReason?: string
}

type ExploreBatchOutput = {
  status: ExploreBatchStatus
  total: number
  completed: number
  failed: number
  children: ExploreChildOutput[]
}

class ExploreBatchState {
  private readonly children: ExploreChildOutput[]
  private emission = Promise.resolve()

  constructor(
    tasks: ExploreTask[],
    private readonly onUpdate: ((update: ToolExecutionUpdate) => Promise<void> | void) | undefined
  ) {
    this.children = tasks.map((task, index) => ({
      index,
      ...task,
      status: 'queued',
      profile: 'explore',
      profileName: 'Repository Explorer'
    }))
  }

  output(): ExploreBatchOutput {
    const children = this.children.map((child) => ({ ...child }))
    const completed = children.filter((child) => child.status === 'completed').length
    const failed = children.filter((child) =>
      child.status === 'failed' || child.status === 'aborted'
    ).length
    const terminal = completed + failed
    const status: ExploreBatchStatus = terminal < children.length
      ? 'running'
      : completed === children.length
        ? 'completed'
        : completed > 0
          ? 'partial'
          : 'failed'
    return { status, total: children.length, completed, failed, children }
  }

  async emit(): Promise<void> {
    if (!this.onUpdate) return
    const snapshot = this.output()
    this.emission = this.emission.then(async () => {
      await this.onUpdate?.({ output: snapshot, isError: false })
    })
    await this.emission
  }

  async update(index: number, patch: Partial<ExploreChildOutput>): Promise<void> {
    const current = this.children[index]
    if (!current || !canAdvanceExploreStatus(current.status, patch.status)) return
    this.children[index] = compactExploreChild({ ...current, ...patch })
    await this.emit()
  }

  async abortRemaining(startIndex: number): Promise<void> {
    for (let index = startIndex; index < this.children.length; index += 1) {
      await this.update(index, {
        status: 'aborted',
        error: 'parent turn aborted before child started'
      })
    }
  }
}

function canAdvanceExploreStatus(
  current: ExploreChildStatus,
  next: ExploreChildStatus | undefined
): boolean {
  if (!next) return true
  const rank: Record<ExploreChildStatus, number> = {
    queued: 0,
    running: 1,
    completed: 2,
    failed: 2,
    aborted: 2
  }
  return rank[next] >= rank[current] && rank[current] < 2
}

function compactExploreChild(child: ExploreChildOutput): ExploreChildOutput {
  return Object.fromEntries(
    Object.entries(child).filter(([, value]) => value !== undefined)
  ) as ExploreChildOutput
}

function parseExploreTasks(value: unknown): { tasks: ExploreTask[] } | { error: string } {
  if (!Array.isArray(value)) return { error: 'tasks must be an array with 1-4 items' }
  if (value.length < 1) return { error: 'tasks must contain at least 1 item' }
  if (value.length > 4) return { error: 'tasks must contain at most 4 items' }
  const tasks: ExploreTask[] = []
  for (const [index, candidate] of value.entries()) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return { error: `tasks[${index}] must be an object` }
    }
    const task = candidate as Record<string, unknown>
    const title = stringValue(task.title)
    const query = stringValue(task.query)
    if (!title) return { error: `tasks[${index}].title is required` }
    if (!query) return { error: `tasks[${index}].query is required` }
    tasks.push({ title, query })
  }
  return { tasks }
}

function requiresSerialExploreBatch(approvalPolicy: ToolHostContext['approvalPolicy']): boolean {
  return approvalPolicy === 'always' || approvalPolicy === 'untrusted' || approvalPolicy === 'never'
}

function resolveExploreModel(model: string | undefined, context: ToolHostContext): string | undefined {
  return model?.trim() ||
    context.actingModelRoute?.model?.trim() ||
    context.model?.id?.trim() ||
    undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
