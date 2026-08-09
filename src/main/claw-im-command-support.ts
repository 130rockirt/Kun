import type {
  AppSettingsV1,
  ClawImChannelV1
} from '../shared/app-settings'
import {
  asString,
  parseJsonObject,
  type ThreadRecordJson
} from './claw-runtime-helpers'
import {
  imKunErrorText,
  isChineseLocale,
  type ImModelResolution
} from './claw-im-model-support'

export type ImSkillSummary = {
  id: string
  name: string
  description?: string
  source?: string
}

export type ImMcpServerSummary = {
  id: string
  enabled: boolean
  available: boolean
  status: string
  transport?: string
  toolCount?: number
  lastError?: string
}

export type ImThreadUsageSummary = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  turns: number
  costUsd?: number
  costCny?: number
}

export type ImGoalSummary = {
  objective: string
  status?: string
  tokensUsed?: number
}

export function parseSkillsResponse(body: string): { enabled: boolean; skills: ImSkillSummary[] } {
  const parsed = parseJsonObject(body)
  const skills = Array.isArray(parsed?.skills) ? parsed.skills : []
  return {
    enabled: parsed?.enabled === true,
    skills: skills
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
      .map((item): ImSkillSummary => ({
        id: asString(item.id),
        name: asString(item.name),
        description: asString(item.description),
        source: asString(item.source)
      }))
      .filter((skill) => skill.id || skill.name)
  }
}

export function imSkillListText(settings: AppSettingsV1, enabled: boolean, skills: readonly ImSkillSummary[]): string {
  if (!enabled) {
    return isChineseLocale(settings)
      ? 'Kun 技能当前未启用。'
      : 'Kun skills are currently disabled.'
  }
  if (skills.length === 0) {
    return isChineseLocale(settings)
      ? '当前没有发现可用技能。'
      : 'No available skills were discovered.'
  }
  const rows = skills.slice(0, 30).map((skill, index) => {
    const name = skill.name || skill.id
    const source = skill.source ? ` · ${skill.source}` : ''
    const description = skill.description ? `：${skill.description}` : ''
    return `- ${index + 1}. \`${skill.id || name}\` ${name}${source}${description}`
  })
  const extra = skills.length > rows.length
    ? (isChineseLocale(settings) ? `还有 ${skills.length - rows.length} 个技能未显示。` : `${skills.length - rows.length} more skills not shown.`)
    : ''
  return [
    isChineseLocale(settings) ? '可用 Kun 技能：' : 'Available Kun skills:',
    ...rows,
    ...(extra ? [extra] : [])
  ].join('\n')
}

export function parseMcpResponse(body: string): ImMcpServerSummary[] {
  const parsed = parseJsonObject(body)
  const servers = Array.isArray(parsed?.mcpServers) ? parsed.mcpServers : []
  return servers
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
    .map((item): ImMcpServerSummary => ({
      id: asString(item.id),
      enabled: item.enabled === true,
      available: item.available === true,
      status: asString(item.status),
      transport: asString(item.transport),
      toolCount: typeof item.toolCount === 'number' && Number.isFinite(item.toolCount)
        ? item.toolCount
        : undefined,
      lastError: asString(item.lastError)
    }))
    .filter((server) => server.id)
}

export function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function optionalNumberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function parseThreadUsageResponse(body: string, threadId: string): ImThreadUsageSummary {
  const parsed = parseJsonObject(body)
  const buckets = Array.isArray(parsed?.buckets) ? parsed.buckets : []
  const bucket = buckets.find((item): item is Record<string, unknown> => {
    return typeof item === 'object' &&
      item !== null &&
      !Array.isArray(item) &&
      asString((item as Record<string, unknown>).thread_id) === threadId
  })
  if (!bucket) {
    return {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      turns: 0
    }
  }
  return {
    promptTokens: numberValue(bucket.input_tokens),
    completionTokens: numberValue(bucket.output_tokens),
    totalTokens: numberValue(bucket.total_tokens),
    cachedTokens: numberValue(bucket.cached_tokens),
    cacheHitTokens: numberValue(bucket.cache_hit_tokens) || numberValue(bucket.cached_tokens),
    cacheMissTokens: numberValue(bucket.cache_miss_tokens),
    turns: numberValue(bucket.turns),
    costUsd: optionalNumberValue(bucket.cost_usd),
    costCny: optionalNumberValue(bucket.cost_cny)
  }
}

export function imMcpListText(settings: AppSettingsV1, servers: readonly ImMcpServerSummary[]): string {
  if (servers.length === 0) {
    return isChineseLocale(settings)
      ? '当前没有配置 Kun MCP 服务器。'
      : 'No Kun MCP servers are configured.'
  }
  const rows = servers.map((server, index) => {
    const state = server.available
      ? (isChineseLocale(settings) ? '可用' : 'available')
      : server.enabled
        ? (server.status || (isChineseLocale(settings) ? '不可用' : 'unavailable'))
        : (isChineseLocale(settings) ? '已禁用' : 'disabled')
    const transport = server.transport ? ` · ${server.transport}` : ''
    const tools = typeof server.toolCount === 'number' ? ` · ${server.toolCount} tools` : ''
    const error = server.lastError ? ` · ${server.lastError}` : ''
    return `- ${index + 1}. \`${server.id}\` ${state}${transport}${tools}${error}`
  })
  return [
    isChineseLocale(settings) ? 'Kun MCP 服务器：' : 'Kun MCP servers:',
    ...rows
  ].join('\n')
}

export function imWorkspaceText(settings: AppSettingsV1, threadId: string, workspace: string): string {
  return isChineseLocale(settings)
    ? `当前 Kun 会话 \`${threadId}\` 的工作目录：\n\`${workspace}\``
    : `Workspace for current Kun conversation \`${threadId}\`:\n\`${workspace}\``
}

export function imWorkspaceMissingText(settings: AppSettingsV1, threadId: string): string {
  return imKunErrorText(settings, isChineseLocale(settings)
    ? `没有读取到当前 Kun 会话 \`${threadId}\` 的工作目录。`
    : `Could not read the workspace path for current Kun conversation \`${threadId}\`.`)
}

export function imMarkdownLines(lines: string[]): string {
  return lines.join('  \n')
}

export function imUsageText(
  settings: AppSettingsV1,
  threadId: string,
  usage: ImThreadUsageSummary,
  model: ImModelResolution
): string {
  const costParts = [
    usage.costUsd !== undefined ? `USD ${usage.costUsd.toFixed(6)}` : '',
    usage.costCny !== undefined ? `CNY ${usage.costCny.toFixed(6)}` : ''
  ].filter(Boolean)
  const costText = costParts.length > 0 ? costParts.join(' · ') : (isChineseLocale(settings) ? '无' : 'none')
  if (isChineseLocale(settings)) {
    return imMarkdownLines([
      `当前 Kun 会话：\`${threadId}\``,
      `供应商：\`${model.provider.id}\``,
      `模型：\`${model.model}\``,
      `Token 消耗：total ${usage.totalTokens} · input ${usage.promptTokens} · output ${usage.completionTokens}`,
      `缓存：cached ${usage.cachedTokens} · hit ${usage.cacheHitTokens} · miss ${usage.cacheMissTokens}`,
      `轮次：${usage.turns}`,
      `费用：${costText}`
    ])
  }
  return imMarkdownLines([
    `Current Kun conversation: \`${threadId}\``,
    `Provider: \`${model.provider.id}\``,
    `Model: \`${model.model}\``,
    `Token usage: total ${usage.totalTokens} · input ${usage.promptTokens} · output ${usage.completionTokens}`,
    `Cache: cached ${usage.cachedTokens} · hit ${usage.cacheHitTokens} · miss ${usage.cacheMissTokens}`,
    `Turns: ${usage.turns}`,
    `Cost: ${costText}`
  ])
}

export function parseGoalResponse(body: string): ImGoalSummary | null {
  const parsed = parseJsonObject(body)
  const goal = typeof parsed?.goal === 'object' && parsed.goal !== null && !Array.isArray(parsed.goal)
    ? parsed.goal as Record<string, unknown>
    : null
  if (!goal) return null
  const objective = asString(goal.objective)
  if (!objective) return null
  const tokensUsed = typeof goal.tokensUsed === 'number' && Number.isFinite(goal.tokensUsed)
    ? goal.tokensUsed
    : undefined
  return {
    objective,
    status: asString(goal.status),
    tokensUsed
  }
}

export function imNoCurrentThreadText(settings: AppSettingsV1): string {
  return imKunErrorText(settings, isChineseLocale(settings)
    ? '当前 IM 会话还没有绑定 Kun 会话。先发送普通消息创建会话，或用 `/list-threads` 和 `/switch` 切换到已有会话。'
    : 'This IM chat is not connected to a Kun conversation yet. Send a normal message to create one, or use `/list-threads` and `/switch` to pick one.')
}

export function imGoalText(settings: AppSettingsV1, goal: ImGoalSummary | null): string {
  if (!goal) {
    return isChineseLocale(settings)
      ? '当前 Kun 会话还没有设置目标。使用 `/goal <目标>` 设置。'
      : 'The current Kun conversation has no goal yet. Set one with `/goal <objective>`.'
  }
  const status = goal.status ? ` · ${goal.status}` : ''
  const tokens = typeof goal.tokensUsed === 'number' ? ` · ${goal.tokensUsed} tokens` : ''
  return isChineseLocale(settings)
    ? `当前目标${status}${tokens}：\n${goal.objective}`
    : `Current goal${status}${tokens}:\n${goal.objective}`
}

export function imGoalMissingObjectiveText(settings: AppSettingsV1): string {
  return imKunErrorText(settings, isChineseLocale(settings)
    ? '`/goal` 后面必须带目标内容，例如：`/goal 阅读并总结文档 A`。查看当前目标请用 `/list-goal`。'
    : '`/goal` requires an objective, for example: `/goal Read and summarize document A`. Use `/list-goal` to view the current goal.')
}

export function imGoalAlreadyExistsText(settings: AppSettingsV1, goal: ImGoalSummary): string {
  return imKunErrorText(settings, isChineseLocale(settings)
    ? `当前会话已经有目标，不能重复设置：\n${goal.objective}`
    : `This conversation already has a goal, so a new one was not set:\n${goal.objective}`)
}

export function imGoalChangedText(settings: AppSettingsV1, goal: ImGoalSummary | null): string {
  if (!goal) {
    return isChineseLocale(settings)
      ? '目标已更新。'
      : 'Goal updated.'
  }
  return isChineseLocale(settings)
    ? `目标已设置：\n${goal.objective}`
    : `Goal set:\n${goal.objective}`
}

export function imThreadTitle(thread: ThreadRecordJson): string {
  const title = thread.title?.trim()
  return title || thread.id
}

export function imThreadTimestamp(thread: ThreadRecordJson): number {
  const value = Date.parse(thread.updatedAt ?? thread.createdAt ?? '')
  return Number.isFinite(value) ? value : 0
}

export function isImThreadCandidate(
  thread: ThreadRecordJson,
  channel: ClawImChannelV1 | undefined,
  knownThreadIds: Set<string>
): boolean {
  if (knownThreadIds.has(thread.id)) return true
  if (!channel) return true
  const title = thread.title?.trim() ?? ''
  const prefix = `[Claw IM:${channel.label}]`
  return title.startsWith(prefix)
}

export function parseListThreadsResponse(body: string): ThreadRecordJson[] {
  const parsed = parseJsonObject(body)
  const threads = Array.isArray(parsed?.threads) ? parsed.threads : []
  return threads
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
    .map((item): ThreadRecordJson => ({
      id: asString(item.id),
      title: asString(item.title),
      status: asString(item.status),
      workspace: asString(item.workspace),
      createdAt: asString(item.createdAt),
      updatedAt: asString(item.updatedAt)
    }))
    .filter((thread) => thread.id.trim())
}

export function imThreadListText(
  settings: AppSettingsV1,
  threads: readonly ThreadRecordJson[],
  currentThreadId: string
): string {
  if (threads.length === 0) {
    return isChineseLocale(settings)
      ? '还没有找到可切换的 Kun 会话。先发送普通消息创建会话，或发送 `/new` 开启新话题。'
      : 'No switchable Kun conversations were found yet. Send a normal message to create one, or send `/new` to start a new topic.'
  }
  const rows = threads.map((thread, index) => {
    const marker = thread.id === currentThreadId ? '*' : '-'
    const status = thread.status?.trim() ? ` · ${thread.status.trim()}` : ''
    return `${marker} ${index + 1}. \`${thread.id}\` ${imThreadTitle(thread)}${status}`
  })
  if (isChineseLocale(settings)) {
    return [
      currentThreadId ? `当前会话：\`${currentThreadId}\`。` : '当前还没有绑定 Kun 会话。',
      '最近 Kun 会话：',
      ...rows,
      '切换会话：`/switch <序号|thread id>`。新话题：`/new`。'
    ].join('\n')
  }
  return [
    currentThreadId ? `Current conversation: \`${currentThreadId}\`.` : 'No Kun conversation is connected yet.',
    'Recent Kun conversations:',
    ...rows,
    'Switch with `/switch <number|thread id>`. Start fresh with `/new`.'
  ].join('\n')
}

export function imCurrentThreadText(
  settings: AppSettingsV1,
  thread: ThreadRecordJson | undefined,
  currentThreadId: string,
  shared = false
): string {
  if (!currentThreadId) {
    return imKunErrorText(settings, isChineseLocale(settings)
      ? '当前 IM 会话还没有绑定 Kun 会话。发送普通消息会创建一个新会话。'
      : 'This IM chat is not connected to a Kun conversation yet. Send a normal message to create one.')
  }
  if (!thread) {
    return imKunErrorText(settings, isChineseLocale(settings)
      ? `当前绑定的 Kun 会话是 \`${currentThreadId}\`，但线程列表里暂时没有读取到它。`
      : `This IM chat is connected to \`${currentThreadId}\`, but it was not found in the thread list.`)
  }
  const status = thread.status?.trim() ? ` · ${thread.status.trim()}` : ''
  const text = isChineseLocale(settings)
    ? `当前 Kun 会话：\`${thread.id}\` ${imThreadTitle(thread)}${status}。`
    : `Current Kun conversation: \`${thread.id}\` ${imThreadTitle(thread)}${status}.`
  return shared ? `${text}\n\n${imSharedThreadWarningText(settings)}` : text
}

export function resolveImThreadSwitchTarget(
  threads: readonly ThreadRecordJson[],
  target: string
): ThreadRecordJson | null {
  const query = target.trim()
  if (!query) return null
  const index = Number.parseInt(query, 10)
  if (String(index) === query && index >= 1 && index <= threads.length) {
    return threads[index - 1]
  }
  const lowered = query.toLowerCase()
  return threads.find((thread) => thread.id === query) ??
    threads.find((thread) => thread.id.toLowerCase() === lowered) ??
    null
}

export function imThreadSwitchNotFoundText(settings: AppSettingsV1, target: string): string {
  return imKunErrorText(settings, isChineseLocale(settings)
    ? `没有找到可切换的会话 \`${target}\`。发送 \`/list-threads\` 查看最近会话。`
    : `Could not find a switchable conversation for \`${target}\`. Send \`/list-threads\` to list recent conversations.`)
}

export function imSharedThreadWarningText(settings: AppSettingsV1): string {
  return isChineseLocale(settings)
    ? '注意：这个 Kun 会话也被其他 IM 会话持有。Kun 不会对共享会话做 IM 侧并发控制，请不要在多个 IM 里同时对话。'
    : 'Note: this Kun conversation is also held by another IM chat. Kun does not add IM-side concurrency control for shared conversations, so avoid chatting into it from multiple IM chats at the same time.'
}

export function imThreadSwitchedText(settings: AppSettingsV1, thread: ThreadRecordJson, shared: boolean): string {
  const text = isChineseLocale(settings)
    ? `已切换到 Kun 会话 \`${thread.id}\`：${imThreadTitle(thread)}。后续消息会继续这个上下文。`
    : `Switched to Kun conversation \`${thread.id}\`: ${imThreadTitle(thread)}. Future messages will continue that context.`
  return shared ? `${text}\n\n${imSharedThreadWarningText(settings)}` : text
}

export function hasOtherImThreadBinding(
  settings: AppSettingsV1,
  threadId: string,
  currentChannelId: string | undefined,
  currentConversationId: string | undefined
): boolean {
  const targetThreadId = threadId.trim()
  if (!targetThreadId) return false
  for (const channel of settings.claw.channels) {
    if (!channel.enabled) continue
    for (const conversation of channel.conversations) {
      if (conversation.localThreadId.trim() !== targetThreadId) continue
      if (channel.id === currentChannelId && conversation.id === currentConversationId) continue
      return true
    }
    if (channel.threadId.trim() !== targetThreadId) continue
    if (channel.id === currentChannelId && !currentConversationId) continue
    return true
  }
  return false
}

export function imStopNoRunningTurnText(settings: AppSettingsV1): string {
  return imKunErrorText(settings, isChineseLocale(settings)
    ? '当前 Kun 会话没有正在运行的任务。'
    : 'The current Kun conversation has no running task.')
}

export function imStopSucceededText(settings: AppSettingsV1, turnId: string): string {
  return isChineseLocale(settings)
    ? `Kun 已停止当前任务：\`${turnId}\`。`
    : `Kun stopped the current task: \`${turnId}\`.`
}

/**
 * One-time intro sent to an IM conversation when the channel is first
 * connected: who the assistant is, what it can do, and the IM commands.
 */
