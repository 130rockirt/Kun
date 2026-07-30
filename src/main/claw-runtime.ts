import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { URL } from 'node:url'
import {
  type LarkChannel,
  type NormalizedMessage
} from '@larksuiteoapi/node-sdk'
import type {
  AppSettingsV1,
  ClawGeneratedFileV1,
  ClawImChannelV1,
  ClawImConversationV1,
  ClawImProvider,
  ClawImRemoteSessionV1,
  ClawRunResult,
  ClawRuntimeStatus,
  ModelProviderProfileV1
} from '../shared/app-settings'
import {
  DEFAULT_CLAW_MODEL,
  DEFAULT_MODEL_PROVIDER_ID,
  buildClawRuntimePrompt,
  getKunRuntimeSettings,
  getModelProviderSettings,
  isComposerChatModelId,
  listNonTextModelIds,
  modelProfileSupportsTextChat,
  modelProviderModelProfile,
  normalizeModelProviderId,
  parseClawUserPromptForDisplay
} from '../shared/app-settings'
import { parseClawCommand } from '../shared/claw-commands'
import {
  asString,
  clawConversationKey,
  extractIncomingChannelId,
  extractIncomingProvider,
  extractIncomingPrompt,
  extractIncomingRemoteSession,
  extractSenderLabel,
  finalAssistantReplyText,
  isRunningStatus,
  IM_COMPLETED_NO_TEXT_REPLY,
  IM_PROCESSING_ACK,
  latestGeneratedFiles,
  nestedRecord,
  normalizeTaskModel,
  parseJsonObject,
  readRequestBody,
  replyTextForGeneratedFiles,
  runtimeErrorMessage,
  sanitizePathSegment,
  shouldSendGeneratedFilesForPrompt,
  sleep,
  webhookUrl,
  writeJson,
  type ClawRuntimeDeps,
  type RunPromptOptions,
  type ThreadDetailJson,
  type ThreadRecordJson,
  createDeferredCloseHandle,
  type SseSubscriber,
  subscribeRuntimeThreadEvents
} from './claw-runtime-helpers'
import { getRuntimeBaseUrlForSettings, runtimeAuthHeaders } from './runtime/kun-adapter'
import { FeishuStreamer } from './feishu-streamer'
import type { TelegramInboundPayload } from './telegram-runtime'
import {
  bindClawConversationToThread,
  clearClawThreadBinding,
  currentClawThreadId,
  findClawConversation,
  setClawConversationModelSelection
} from './claw-conversation-registry'
import { authorizeImGeneratedFiles } from './im-attachment-pipeline'
import { FeishuTransportAdapter } from './feishu-transport-adapter'
import { WeixinTransportAdapter } from './weixin-transport-adapter'
import { ImTransportRouter } from './im-transport-router'
import {
  handleTelegramInbound,
  type ImIncomingRemoteSession
} from './telegram-inbound-coordinator'
import { handleFeishuInbound } from './feishu-inbound-coordinator'
import { syncWeixinConnectWelcomes as runWeixinConnectWelcomes } from './weixin-welcome-coordinator'

type IncomingRemoteSession = ImIncomingRemoteSession


function isMissingThreadResult(result: { ok: boolean; status: number; body: string }): boolean {
  if (result.ok) return false
  const message = runtimeErrorMessage(result, '').toLowerCase()
  return result.status === 404 && message.includes('thread') && message.includes('not found')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function cdataText(value: string): string {
  return value.replace(/\]\]>/g, ']]]]><![CDATA[>')
}

function buildImRuntimePrompt(prompt: string): string {
  return [
    '<kun_im_context>',
    '<channel>remote_im</channel>',
    '<interactive_gui_input_available>false</interactive_gui_input_available>',
    '<instruction>The user is on a remote IM channel and cannot answer GUI prompts. Do not ask for structured GUI input or wait for GUI confirmation. If information is missing, state your assumption and continue, or ask in the final reply so the user can answer in the next IM message.</instruction>',
    '</kun_im_context>',
    '',
    '<user_message><![CDATA[',
    cdataText(prompt),
    ']]></user_message>'
  ].join('\n')
}


function isChineseLocale(settings: AppSettingsV1): boolean {
  return settings.locale.toLowerCase().startsWith('zh')
}

function currentImModel(
  settings: AppSettingsV1,
  channel?: ClawImChannelV1,
  conversation?: ClawImConversationV1
): string {
  return conversation?.model?.trim() ||
    channel?.model?.trim() ||
    settings.claw.im.model.trim() ||
    DEFAULT_CLAW_MODEL
}

function currentImProviderId(
  settings: AppSettingsV1,
  channel?: ClawImChannelV1,
  conversation?: ClawImConversationV1
): string {
  return conversation?.providerId?.trim() ||
    channel?.providerId?.trim() ||
    settings.claw.im.providerId?.trim() ||
    getKunRuntimeSettings(settings).providerId.trim() ||
    DEFAULT_MODEL_PROVIDER_ID
}

function providerLabel(provider: ModelProviderProfileV1): string {
  const name = provider.name.trim()
  return name && name !== provider.id ? `${name} (${provider.id})` : provider.id
}

function providerTextModels(settings: AppSettingsV1, provider: ModelProviderProfileV1): string[] {
  const nonTextModelIds = listNonTextModelIds(settings)
  const models: string[] = []
  for (const model of provider.models) {
    const trimmed = model.trim()
    if (!trimmed) continue
    if (!isComposerChatModelId(trimmed, nonTextModelIds)) continue
    if (!modelProfileSupportsTextChat(modelProviderModelProfile(provider, trimmed))) continue
    models.push(trimmed)
  }
  return models
}

function findImProvider(settings: AppSettingsV1, value: string): ModelProviderProfileV1 | undefined {
  const query = value.trim()
  if (!query) return undefined
  const normalizedId = normalizeModelProviderId(query)
  const providers = getModelProviderSettings(settings).providers
  return providers.find((provider) => provider.id === normalizedId) ??
    providers.find((provider) => provider.id.toLowerCase() === query.toLowerCase()) ??
    providers.find((provider) => provider.name.trim().toLowerCase() === query.toLowerCase())
}

function currentImProvider(
  settings: AppSettingsV1,
  channel?: ClawImChannelV1,
  conversation?: ClawImConversationV1
): ModelProviderProfileV1 {
  const providers = getModelProviderSettings(settings).providers
  const providerId = currentImProviderId(settings, channel, conversation)
  return providers.find((provider) => provider.id === providerId) ??
    providers.find((provider) => provider.id === DEFAULT_MODEL_PROVIDER_ID) ??
    providers[0]
}

function firstProviderModel(settings: AppSettingsV1, providerId: string): string {
  const provider = findImProvider(settings, providerId)
  return provider ? providerTextModels(settings, provider)[0] ?? DEFAULT_CLAW_MODEL : DEFAULT_CLAW_MODEL
}

function validProviderModel(settings: AppSettingsV1, provider: ModelProviderProfileV1, model: string): string | undefined {
  const trimmed = model.trim()
  if (!trimmed || trimmed === DEFAULT_CLAW_MODEL) return undefined
  return providerTextModels(settings, provider).find((item) => item === trimmed)
}

function settingsWithImModelProvider(
  settings: AppSettingsV1,
  providerId: string | undefined,
  model: string
): AppSettingsV1 {
  const trimmedProviderId = providerId?.trim()
  if (!trimmedProviderId) return settings
  const provider = findImProvider(settings, trimmedProviderId)
  const requestedModel = model.trim()
  const resolvedModel = requestedModel && requestedModel !== DEFAULT_CLAW_MODEL
    ? provider
      ? validProviderModel(settings, provider, requestedModel) ?? firstProviderModel(settings, trimmedProviderId)
      : requestedModel
    : firstProviderModel(settings, trimmedProviderId)
  return {
    ...settings,
    agents: {
      ...settings.agents,
      kun: {
        ...settings.agents.kun,
        providerId: trimmedProviderId,
        model: resolvedModel
      }
    }
  }
}

function effectiveImRuntimeModel(settings: AppSettingsV1, requestedModel: string): string {
  const trimmed = requestedModel.trim()
  if (trimmed && trimmed.toLowerCase() !== DEFAULT_CLAW_MODEL) return trimmed
  return getKunRuntimeSettings(settings).model.trim() || trimmed || DEFAULT_CLAW_MODEL
}

function imCommandHelpText(settings: AppSettingsV1): string {
  if (isChineseLocale(settings)) {
    return [
      'Claw IM 命令：',
      '- `/help`：查看命令帮助',
      '- `/new`：当前 IM 连接开启新话题',
      '- `/clear`：等同于 `/new`，当前 IM 连接开启新话题',
      '- `/stop`：停止当前 Kun 会话里正在运行的任务',
      '- `/pwd`：查看当前 Kun 会话工作目录本地路径',
      '- `/usage`：查看当前 Kun 会话 token 消耗、供应商和模型',
      '- `/list-skills`：查看当前 Kun 可用技能',
      '- `/list-mcp`：查看当前 Kun MCP 服务器',
      '- `/list-goal`：查看当前 Kun 会话目标',
      '- `/goal <目标>`：设置当前 Kun 会话目标',
      '- `/list-threads`：列出最近的 Kun 会话',
      '- `/current`：查看当前 IM 会话连接的 Kun 会话',
      '- `/switch <序号|thread id>`：切换当前 IM 会话到指定 Kun 会话',
      '- `/list-model`：查看所有可用文本模型',
      '- `/model <序号>`：按 `/list-model` 列出的序号切换当前 IM 连接模型',
      '命令前缀可以从 `/` 改成 `-`，例如 `-new`、`-list-threads`、`-switch 2`。'
    ].join('\n')
  }
  return [
    'Claw IM commands:',
    '- `/help`: show command help',
    '- `/new`: start a new topic for this IM connection',
    '- `/clear`: same as `/new`, start a new topic for this IM connection',
    '- `/stop`: stop the running task in the current Kun conversation',
    '- `/pwd`: show the local workspace path for the current Kun conversation',
    '- `/usage`: show token usage plus provider/model for the current Kun conversation',
    '- `/list-skills`: list available Kun skills',
    '- `/list-mcp`: list Kun MCP servers',
    '- `/list-goal`: show the current Kun conversation goal',
    '- `/goal <objective>`: set the current Kun conversation goal',
    '- `/list-threads`: list recent Kun conversations',
    '- `/current`: show the Kun conversation connected to this IM chat',
    '- `/switch <number|thread id>`: switch this IM chat to a Kun conversation',
    '- `/list-model`: list all available text models',
    '- `/model <number>`: switch this IM connection to a model listed by `/list-model`',
    'The command prefix can be changed from `/` to `-`, for example `-new`, `-list-threads`, or `-switch 2`.'
  ].join('\n')
}

function imModelListText(
  settings: AppSettingsV1,
  channel?: ClawImChannelV1,
  conversation?: ClawImConversationV1
): string {
  const current = currentImModelResolution(settings, channel, conversation)
  const currentProviderId = current.provider.id
  const currentModel = current.model
  const rows = listImModelOptions(settings).map((option, index) => {
    const { provider, model } = option
    const marker = provider.id === currentProviderId && model === currentModel ? '*' : '-'
    return `${marker} ${index + 1}. \`${model}\` · provider \`${provider.id}\``
  })
  if (isChineseLocale(settings)) {
    return [
      `当前供应商：\`${currentProviderId}\`。`,
      `当前模型：\`${currentModel}\`。`,
      ...(rows.length > 0
        ? ['可用模型：', ...rows, '切换模型：`/model <序号>`。']
        : ['还没有可用的文本模型，请先在设置里为供应商配置模型。'])
    ].join('\n')
  }
  return [
    `Current provider: \`${currentProviderId}\`.`,
    `Current model: \`${currentModel}\`.`,
    ...(rows.length > 0
      ? ['Available models:', ...rows, 'Switch model with `/model <number>`.']
      : ['No usable text models are available yet. Add models for a provider in Settings first.'])
  ].join('\n')
}

type ImModelResolution = {
  provider: ModelProviderProfileV1
  model: string
}

function listImModelOptions(settings: AppSettingsV1): ImModelResolution[] {
  return getModelProviderSettings(settings).providers.flatMap((provider) =>
    providerTextModels(settings, provider).map((model) => ({ provider, model }))
  )
}

function resolveImModelByIndex(settings: AppSettingsV1, value: string): ImModelResolution | undefined {
  const raw = value.trim()
  if (!/^\d+$/.test(raw)) return undefined
  const index = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(index) || index < 1) return undefined
  return listImModelOptions(settings)[index - 1]
}

function imModelCommandHint(settings: AppSettingsV1, value: string): string {
  const count = listImModelOptions(settings).length
  return imKunErrorText(settings, isChineseLocale(settings)
    ? `无效的模型序号 \`${value}\`。${count > 0 ? '发送 `/list-model` 查看可用序号。' : '还没有可用的文本模型。'}`
    : `Invalid model number \`${value}\`. ${count > 0 ? 'Send `/list-model` to see available numbers.' : 'No usable text models are available yet.'}`)
}

function imModelChangedText(settings: AppSettingsV1, providerId: string, model: string): string {
  return isChineseLocale(settings)
    ? `Claw IM 模型已切换到 \`${model}\`，供应商为 \`${providerId}\`。`
    : `Claw IM model switched to \`${model}\` with provider \`${providerId}\`.`
}

function currentImModelResolution(
  settings: AppSettingsV1,
  channel?: ClawImChannelV1,
  conversation?: ClawImConversationV1
): ImModelResolution {
  const provider = currentImProvider(settings, channel, conversation)
  const requestedModel = currentImModel(settings, channel, conversation)
  const model = validProviderModel(settings, provider, requestedModel) ?? firstProviderModel(settings, provider.id)
  return { provider, model }
}

function imNewTopicText(settings: AppSettingsV1): string {
  return isChineseLocale(settings)
    ? '新话题已开启。下一条消息会创建新的本地会话。'
    : 'Started a new topic. The next message will create a fresh local conversation.'
}

function imKunErrorText(_settings: AppSettingsV1, message: string): string {
  return imKunSystemText(message)
}

function imKunSystemText(message: string): string {
  const trimmed = message.trim()
  if (trimmed.startsWith('[Kun]')) return trimmed
  if (trimmed.startsWith('Kun:')) return `[Kun] ${trimmed.slice('Kun:'.length).trim()}`
  return `[Kun] ${trimmed}`
}

type ImSkillSummary = {
  id: string
  name: string
  description?: string
  source?: string
}

type ImMcpServerSummary = {
  id: string
  enabled: boolean
  available: boolean
  status: string
  transport?: string
  toolCount?: number
  lastError?: string
}

type ImThreadUsageSummary = {
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

type ImGoalSummary = {
  objective: string
  status?: string
  tokensUsed?: number
}

function parseSkillsResponse(body: string): { enabled: boolean; skills: ImSkillSummary[] } {
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

function imSkillListText(settings: AppSettingsV1, enabled: boolean, skills: readonly ImSkillSummary[]): string {
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

function parseMcpResponse(body: string): ImMcpServerSummary[] {
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

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function optionalNumberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseThreadUsageResponse(body: string, threadId: string): ImThreadUsageSummary {
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

function imMcpListText(settings: AppSettingsV1, servers: readonly ImMcpServerSummary[]): string {
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

function imWorkspaceText(settings: AppSettingsV1, threadId: string, workspace: string): string {
  return isChineseLocale(settings)
    ? `当前 Kun 会话 \`${threadId}\` 的工作目录：\n\`${workspace}\``
    : `Workspace for current Kun conversation \`${threadId}\`:\n\`${workspace}\``
}

function imWorkspaceMissingText(settings: AppSettingsV1, threadId: string): string {
  return imKunErrorText(settings, isChineseLocale(settings)
    ? `没有读取到当前 Kun 会话 \`${threadId}\` 的工作目录。`
    : `Could not read the workspace path for current Kun conversation \`${threadId}\`.`)
}

function imMarkdownLines(lines: string[]): string {
  return lines.join('  \n')
}

function imUsageText(
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

function parseGoalResponse(body: string): ImGoalSummary | null {
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

function imNoCurrentThreadText(settings: AppSettingsV1): string {
  return imKunErrorText(settings, isChineseLocale(settings)
    ? '当前 IM 会话还没有绑定 Kun 会话。先发送普通消息创建会话，或用 `/list-threads` 和 `/switch` 切换到已有会话。'
    : 'This IM chat is not connected to a Kun conversation yet. Send a normal message to create one, or use `/list-threads` and `/switch` to pick one.')
}

function imGoalText(settings: AppSettingsV1, goal: ImGoalSummary | null): string {
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

function imGoalMissingObjectiveText(settings: AppSettingsV1): string {
  return imKunErrorText(settings, isChineseLocale(settings)
    ? '`/goal` 后面必须带目标内容，例如：`/goal 阅读并总结文档 A`。查看当前目标请用 `/list-goal`。'
    : '`/goal` requires an objective, for example: `/goal Read and summarize document A`. Use `/list-goal` to view the current goal.')
}

function imGoalAlreadyExistsText(settings: AppSettingsV1, goal: ImGoalSummary): string {
  return imKunErrorText(settings, isChineseLocale(settings)
    ? `当前会话已经有目标，不能重复设置：\n${goal.objective}`
    : `This conversation already has a goal, so a new one was not set:\n${goal.objective}`)
}

function imGoalChangedText(settings: AppSettingsV1, goal: ImGoalSummary | null): string {
  if (!goal) {
    return isChineseLocale(settings)
      ? '目标已更新。'
      : 'Goal updated.'
  }
  return isChineseLocale(settings)
    ? `目标已设置：\n${goal.objective}`
    : `Goal set:\n${goal.objective}`
}

function imThreadTitle(thread: ThreadRecordJson): string {
  const title = thread.title?.trim()
  return title || thread.id
}

function imThreadTimestamp(thread: ThreadRecordJson): number {
  const value = Date.parse(thread.updatedAt ?? thread.createdAt ?? '')
  return Number.isFinite(value) ? value : 0
}

function isImThreadCandidate(
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

function parseListThreadsResponse(body: string): ThreadRecordJson[] {
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

function imThreadListText(
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

function imCurrentThreadText(
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

function resolveImThreadSwitchTarget(
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

function imThreadSwitchNotFoundText(settings: AppSettingsV1, target: string): string {
  return imKunErrorText(settings, isChineseLocale(settings)
    ? `没有找到可切换的会话 \`${target}\`。发送 \`/list-threads\` 查看最近会话。`
    : `Could not find a switchable conversation for \`${target}\`. Send \`/list-threads\` to list recent conversations.`)
}

function imSharedThreadWarningText(settings: AppSettingsV1): string {
  return isChineseLocale(settings)
    ? '注意：这个 Kun 会话也被其他 IM 会话持有。Kun 不会对共享会话做 IM 侧并发控制，请不要在多个 IM 里同时对话。'
    : 'Note: this Kun conversation is also held by another IM chat. Kun does not add IM-side concurrency control for shared conversations, so avoid chatting into it from multiple IM chats at the same time.'
}

function imThreadSwitchedText(settings: AppSettingsV1, thread: ThreadRecordJson, shared: boolean): string {
  const text = isChineseLocale(settings)
    ? `已切换到 Kun 会话 \`${thread.id}\`：${imThreadTitle(thread)}。后续消息会继续这个上下文。`
    : `Switched to Kun conversation \`${thread.id}\`: ${imThreadTitle(thread)}. Future messages will continue that context.`
  return shared ? `${text}\n\n${imSharedThreadWarningText(settings)}` : text
}

function hasOtherImThreadBinding(
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

function imStopNoRunningTurnText(settings: AppSettingsV1): string {
  return imKunErrorText(settings, isChineseLocale(settings)
    ? '当前 Kun 会话没有正在运行的任务。'
    : 'The current Kun conversation has no running task.')
}

function imStopSucceededText(settings: AppSettingsV1, turnId: string): string {
  return isChineseLocale(settings)
    ? `Kun 已停止当前任务：\`${turnId}\`。`
    : `Kun stopped the current task: \`${turnId}\`.`
}

/**
 * One-time intro sent to an IM conversation when the channel is first
 * connected: who the assistant is, what it can do, and the IM commands.
 */
export function imWelcomeText(settings: AppSettingsV1, channel?: ClawImChannelV1): string {
  const profile = channel?.agentProfile
  const name = profile?.name.trim() || channel?.label.trim() || 'Kun'
  const description = profile?.description.trim() ?? ''
  if (isChineseLocale(settings)) {
    return [
      `你好，我是 ${name}，通过 Kun 连接到这个对话的 AI 助手。`,
      ...(description ? [description] : []),
      '你可以直接发消息让我帮忙：回答问题、查资料、读写已连接电脑工作区里的文件、生成文档等，完成后我会在这里回复你。',
      imCommandHelpText(settings),
      '直接发一条消息就可以开始。'
    ].join('\n\n')
  }
  return [
    `Hi, I am ${name}, an AI assistant connected to this chat through Kun.`,
    ...(description ? [description] : []),
    'Send me a message and I will handle it on the connected computer: answering questions, research, reading and writing workspace files, generating documents — I reply here once done.',
    imCommandHelpText(settings),
    'Send any message to get started.'
  ].join('\n\n')
}

/**
 * How long the background push keeps polling a turn that outran the IM
 * response window before giving up (30 min). Generous enough for long
 * agentic runs, bounded so a stuck turn never leaks a forever-poll.
 */
const RESULT_PUSH_MAX_WAIT_MS = 30 * 60 * 1_000

export class ClawRuntime {
  private readonly deps: ClawRuntimeDeps
  private server: Server | null = null
  private serverKey = ''
  private readonly feishuTransport: FeishuTransportAdapter
  private readonly weixinTransport: WeixinTransportAdapter
  private readonly imTransport: ImTransportRouter
  /** Channels with an in-flight first-message welcome delivery. */
  private readonly welcomeInFlight = new Set<string>()
  /** WeChat channels already greeted (or attempted) at connect time this run. */
  private readonly weixinConnectWelcomeAttempted = new Set<string>()
  /** `${threadId}:${turnId}` of turns with an in-flight delayed-result push. */
  private readonly pendingResultPushes = new Set<string>()
  private readonly resultPushTasks = new Set<Promise<void>>()
  private readonly lifecycleTasks = new Set<Promise<void>>()
  private readonly webhookCloseTasks = new Set<Promise<void>>()
  private readonly stopController = new AbortController()

  constructor(deps: ClawRuntimeDeps) {
    this.deps = deps
    this.feishuTransport = new FeishuTransportAdapter({
      logError: deps.logError,
      onMessage: (channelId, message) => this.trackLifecycleTask(
        'Feishu inbound handler failed',
        this.handleFeishuMessage(channelId, message)
      ),
      allowedFileDirs: (settings, channel) => [
        this.resolveChannelWorkspaceRoot(settings, channel),
        settings.claw.im.workspaceRoot,
        settings.workspaceRoot
      ]
    })
    this.weixinTransport = new WeixinTransportAdapter({
      send: deps.sendWeixinBridgeMessage,
      resolveAccountUserId: deps.resolveWeixinAccountUserId,
      logError: deps.logError
    })
    this.imTransport = new ImTransportRouter({
      feishu: this.feishuTransport,
      weixin: this.weixinTransport,
      telegram: deps.telegramRuntime,
      logError: deps.logError
    })
  }

  /** @internal Legacy characterization seam; lifecycle ownership stays in the adapter. */
  private get feishuChannels(): Map<string, LarkChannel> {
    return this.feishuTransport.channelRegistry
  }

  sync(settings: AppSettingsV1): void {
    if (this.stopController.signal.aborted) return
    this.syncWebhook(settings)
    this.trackLifecycleTask('Feishu channel sync failed', this.feishuTransport.sync(settings))
    this.pruneWeixinWelcomeAttempts(settings)
    this.trackLifecycleTask('WeChat welcome sync failed', this.syncWeixinConnectWelcomes(settings))
    this.syncTelegramChannels(settings)
  }

  private trackLifecycleTask(message: string, task: Promise<void>): Promise<void> {
    const tracked = task.catch((error) => {
      this.deps.logError('claw-lifecycle', message, {
        message: error instanceof Error ? error.message : String(error)
      })
    })
    this.lifecycleTasks.add(tracked)
    void tracked.finally(() => this.lifecycleTasks.delete(tracked))
    return tracked
  }

  private pruneWeixinWelcomeAttempts(settings: AppSettingsV1): void {
    const configured = new Set(
      settings.claw.channels
        .filter((channel) => channel.enabled && channel.provider === 'weixin')
        .map((channel) => channel.id)
    )
    for (const channelId of this.weixinConnectWelcomeAttempted) {
      if (!configured.has(channelId)) this.weixinConnectWelcomeAttempted.delete(channelId)
    }
  }

  /**
   * Delegates Telegram channel reconciliation to the dedicated long-polling
   * runtime. Unlike Feishu (which owns its SDK channels here), Telegram's
   * connection state lives in {@link TelegramRuntime}; ClawRuntime only needs
   * to tell it about the current settings and check `has()` for outbound pushes.
   */
  private syncTelegramChannels(settings: AppSettingsV1): void {
    this.deps.telegramRuntime?.sync(settings)
  }

  /**
   * Greets the WeChat owner right after a channel is first connected.
   * The QR login records the owner's user id, so the intro can be
   * pushed before any inbound message. Failures fall back to the
   * first-inbound-message welcome.
   */
  private syncWeixinConnectWelcomes(settings: AppSettingsV1): Promise<void> {
    return runWeixinConnectWelcomes(settings, {
      alreadyAttempted: (channelId) => this.weixinConnectWelcomeAttempted.has(channelId),
      welcomeInFlight: (channelId) => this.welcomeInFlight.has(channelId),
      markAttempted: (channelId) => {
        this.weixinConnectWelcomeAttempted.add(channelId)
      },
      beginWelcome: (channelId) => {
        this.welcomeInFlight.add(channelId)
      },
      endWelcome: (channelId) => {
        this.welcomeInFlight.delete(channelId)
      },
      resolveOwner: (channel) => this.weixinTransport.resolveOwner(channel),
      sendWelcome: (channel, owner, text) => this.weixinTransport.sendText({
        channel,
        remoteSession: { chatId: owner },
        text,
        failureMessage: 'Failed to greet the WeChat owner after connect; the welcome will be sent on the first inbound message instead.'
      }),
      welcomeText: imWelcomeText,
      markWelcomeSent: (channelId) => this.markChannelWelcomeSent(channelId),
      logError: this.deps.logError,
      stopped: () => this.stopController.signal.aborted
    })
  }

  private async markChannelWelcomeSent(channelId: string): Promise<void> {
    if (this.stopController.signal.aborted) return
    const settings = await this.deps.store.load()
    if (this.stopController.signal.aborted) return
    const now = new Date().toISOString()
    await this.deps.store.patch({
      claw: {
        channels: settings.claw.channels.map((item) =>
          item.id === channelId ? { ...item, welcomeSentAt: now, updatedAt: now } : item
        )
      }
    })
  }

  /** Welcome text still owed to this channel, or '' when already delivered. */
  private pendingWelcomeText(settings: AppSettingsV1, channel: ClawImChannelV1 | undefined): string {
    if (!channel || channel.welcomeSentAt || this.welcomeInFlight.has(channel.id)) return ''
    return imWelcomeText(settings, channel)
  }

  async stop(): Promise<void> {
    this.stopController.abort()
    void this.closeWebhook(true)
    await this.feishuTransport.stop()
    while (
      this.lifecycleTasks.size > 0 ||
      this.resultPushTasks.size > 0 ||
      this.webhookCloseTasks.size > 0
    ) {
      await Promise.allSettled([
        ...this.lifecycleTasks,
        ...this.resultPushTasks,
        ...this.webhookCloseTasks
      ])
    }
    this.welcomeInFlight.clear()
    this.weixinConnectWelcomeAttempted.clear()
    this.pendingResultPushes.clear()
  }

  async status(): Promise<ClawRuntimeStatus> {
    const settings = await this.deps.store.load()
    return {
      imServerRunning: this.server !== null && settings.claw.enabled && settings.claw.im.enabled,
      imUrl: webhookUrl(settings),
      runningTaskIds: []
    }
  }

  async runTask(_taskId: string): Promise<ClawRunResult> {
    return { ok: false, message: 'Claw scheduled tasks have moved to Schedule.' }
  }

  private async runPrompt(settings: AppSettingsV1, options: RunPromptOptions): Promise<ClawRunResult> {
    const workspace = options.workspaceRoot.trim() || settings.workspaceRoot
    const existingThreadId = options.threadId?.trim()
    const requestedModel = normalizeTaskModel(options.model) ?? (settings.agents.kun.model.trim() || DEFAULT_CLAW_MODEL)
    const runtimeSettings = settingsWithImModelProvider(settings, options.providerId, requestedModel)
    const model = effectiveImRuntimeModel(runtimeSettings, requestedModel)
    const createThread = async (): Promise<ThreadRecordJson | null> => {
      const body: Record<string, unknown> = { workspace, model, mode: options.mode }
      if (options.source === 'im') {
        body.approvalPolicy = runtimeSettings.agents.kun.approvalPolicy
        body.sandboxMode = runtimeSettings.agents.kun.sandboxMode
      }
      const create = await this.requestRuntime(runtimeSettings, '/v1/threads', {
        method: 'POST',
        body: JSON.stringify(body)
      })
      if (!create.ok) return null
      return JSON.parse(create.body) as ThreadRecordJson
    }
    const patchThreadTitle = (thread: ThreadRecordJson): void => {
      if (!options.title.trim()) return
      void this.requestRuntime(runtimeSettings, `/v1/threads/${encodeURIComponent(thread.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: options.title.trim() })
      }).catch((error) => {
        if (this.stopController.signal.aborted) return
        this.deps.logError('claw-runtime', 'Failed to update the IM thread title.', {
          threadId: thread.id,
          message: error instanceof Error ? error.message : String(error)
        })
      })
    }
    let thread: ThreadRecordJson | null = existingThreadId ? { id: existingThreadId } : await createThread()
    if (!thread) return { ok: false, message: 'Failed to create thread.' }
    if (!existingThreadId) patchThreadTitle(thread)

    const runtimePrompt = options.source === 'im'
      ? buildImRuntimePrompt(options.prompt)
      : buildClawRuntimePrompt(runtimeSettings, options.prompt, { channel: options.channel })
    const displayText = options.displayText?.trim() || parseClawUserPromptForDisplay(options.prompt).text
    const turnBody: Record<string, unknown> = {
      prompt: runtimePrompt,
      mode: options.mode
    }
    if (displayText && displayText !== runtimePrompt) turnBody.displayText = displayText
    if (model) turnBody.model = model
    // IM senders can only reply in their chat app; they cannot answer
    // GUI prompts, so the runtime must not expose user-input tools.
    // Permission fields are pure passthrough from the agent settings so
    // IM turns follow the same policy the user picked for the GUI.
    if (options.source === 'im') {
      turnBody.clientSurface = 'im'
      turnBody.disableUserInput = true
      turnBody.imContext = true
      turnBody.approvalPolicy = runtimeSettings.agents.kun.approvalPolicy
      turnBody.sandboxMode = runtimeSettings.agents.kun.sandboxMode
    }
    let turn = await this.startRuntimeTurn(runtimeSettings, thread.id, turnBody)
    if (!turn.ok && existingThreadId && isMissingThreadResult(turn)) {
      this.deps.logError('claw-runtime', 'Configured IM thread was missing; creating a replacement thread.', {
        threadId: existingThreadId,
        channelId: options.channel?.id,
        source: options.source
      })
      thread = await createThread()
      if (!thread) return { ok: false, message: 'Failed to create thread.' }
      patchThreadTitle(thread)
      turn = await this.startRuntimeTurn(runtimeSettings, thread.id, turnBody)
    }
    if (!turn.ok) return { ok: false, message: runtimeErrorMessage(turn, 'Failed to start turn.') }

    const parsedTurn = parseJsonObject(turn.body)
    const turnId = asString(parsedTurn?.turnId) || asString(nestedRecord(parsedTurn?.turn).id)
    if (!turnId) {
      return { ok: false, message: 'Failed to start turn: missing turn id.' }
    }
    if (turnId && options.onTurnStarted) {
      await options.onTurnStarted({ threadId: thread.id, turnId })
    }
    if (!options.waitForResult) {
      return { ok: true, threadId: thread.id, turnId, message: 'Started' }
    }

    const outcome = await this.waitForAssistantResult(
      runtimeSettings,
      thread.id,
      turnId,
      options.responseTimeoutMs,
      workspace
    )
    if (outcome.status === 'failed' || outcome.status === 'aborted') {
      return { ok: false, message: outcome.error || `Agent turn ${outcome.status}.` }
    }
    if (outcome.status === 'timeout') {
      // The turn outran the response window but keeps running in the
      // runtime. Ack now; the caller pushes the real result back when
      // the turn finishes (see `scheduleImResultPush`). Returning the
      // last-seen text here is what used to leak an intermediate plan.
      return {
        ok: true,
        threadId: thread.id,
        turnId,
        text: '',
        message: IM_PROCESSING_ACK,
        files: [],
        completed: false
      }
    }
    return {
      ok: true,
      threadId: thread.id,
      turnId,
      text: outcome.text,
      message: outcome.text || IM_COMPLETED_NO_TEXT_REPLY,
      files: outcome.files,
      completed: true
    }
  }

  /**
   * Polls a turn to completion. Resolves with the turn's concluding
   * text (never an intermediate plan) and any generated files.
   */
  private async waitForAssistantResult(
    settings: AppSettingsV1,
    threadId: string,
    turnId: string,
    timeoutMs: number,
    workspaceRoot?: string
  ): Promise<{
    status: 'completed' | 'failed' | 'aborted' | 'timeout'
    text: string
    files: ClawGeneratedFileV1[]
    error?: string
  }> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await sleep(1_500, this.stopController.signal)
      if (this.stopController.signal.aborted) {
        return { status: 'aborted', text: '', files: [], error: 'Claw runtime stopped.' }
      }
      const detailRes = await this.requestRuntime(
        settings,
        `/v1/threads/${encodeURIComponent(threadId)}`,
        { method: 'GET' }
      )
      if (this.stopController.signal.aborted) {
        return { status: 'aborted', text: '', files: [], error: 'Claw runtime stopped.' }
      }
      if (!detailRes.ok) {
        throw new Error(runtimeErrorMessage(detailRes, 'Failed to read thread result.'))
      }
      const detail = JSON.parse(detailRes.body) as ThreadDetailJson
      const targetTurn = Array.isArray(detail.turns)
        ? detail.turns.find((turn) => turn.id === turnId)
        : undefined
      if (!targetTurn) continue
      if (isRunningStatus(targetTurn.status)) continue
      if (targetTurn.status === 'failed' || targetTurn.status === 'aborted') {
        return {
          status: targetTurn.status,
          text: '',
          files: [],
          error: targetTurn.error?.trim() || `Agent turn ${targetTurn.status}.`
        }
      }
      if (targetTurn.status === 'completed') {
        return {
          status: 'completed',
          text: finalAssistantReplyText(detail, { turnId }),
          files: latestGeneratedFiles(detail, { turnId, workspaceRoot })
        }
      }
    }
    return { status: 'timeout', text: '', files: [] }
  }

  private async subscribeSse(
    settings: AppSettingsV1,
    threadId: string,
    streamer: FeishuStreamer,
    signal: AbortSignal
  ): Promise<{ close: () => void }> {
    const baseUrl = getRuntimeBaseUrlForSettings(settings)
    if (!baseUrl) throw new Error('runtime_base_url_unavailable')
    const headers: Record<string, string> = { Accept: 'text/event-stream' }
    const auth = runtimeAuthHeaders(settings).get('Authorization')
    if (auth) headers.Authorization = auth
    const onEvent = (event: { kind?: string; [k: string]: unknown }): void => {
      streamer.onSseEvent(event as Record<string, unknown>)
    }
    return subscribeRuntimeThreadEvents({
      baseUrl,
      threadId,
      headers,
      onEvent,
      signal,
      logError: (category, message, detail) => this.deps.logError(category, message, detail)
    })
  }

  private subscribeSseForStreamer(
    settings: AppSettingsV1,
    threadId: string,
    streamer: FeishuStreamer
  ): SseSubscriber {
    return (signal) => {
      // subscribeRuntimeThreadEvents is async, but SseSubscriber contract is
      // synchronous (returns a { close } handle). Kick off the async
      // subscription and surface its close synchronously by racing the
      // setup; if the setup itself throws (e.g. no base URL) we log via
      // deps.logError and continue with a no-op close. The streamer will
      // still rely on its own responseTimeoutMs abort as a backstop.
      return createDeferredCloseHandle(
        this.subscribeSse(settings, threadId, streamer, signal),
        (error) => {
          this.deps.logError('claw-feishu-stream', 'SSE subscription setup failed', {
            message: error instanceof Error ? error.message : String(error),
            threadId
          })
        }
      )
    }
  }

  private async runStreamingReply(input: {
    bridge: LarkChannel
    chatId: string
    threadId: string
    turnId: string
    replyOptions: { replyTo?: string; replyInThread?: boolean }
    responseTimeoutMs: number
    context: Record<string, unknown>
  }): Promise<{ ok: boolean; messageId: string; finalText: string; fellBack: boolean; message: string }> {
    const streamer = new FeishuStreamer({
      bridge: input.bridge,
      chatId: input.chatId,
      turnId: input.turnId,
      threadId: input.threadId,
      replyOptions: input.replyOptions,
      logger: (category, message, detail) => this.deps.logError(category, message, detail)
    })
    const stopSignal = this.stopController.signal
    const stopStreaming = (): void => streamer.abort()
    if (stopSignal.aborted) stopStreaming()
    else stopSignal.addEventListener('abort', stopStreaming, { once: true })
    const timeout = setTimeout(() => streamer.abort(), input.responseTimeoutMs)
    try {
      const settings = await this.deps.store.load()
      const result = await streamer.start({
        subscribe: this.subscribeSseForStreamer(settings, input.threadId, streamer)
      })
      return {
        ok: result.ok,
        messageId: result.messageId,
        finalText: result.finalText,
        fellBack: result.fellBack,
        message: result.ok ? 'streamed' : 'stream_failed'
      }
    } catch (error) {
      if (stopSignal.aborted) {
        return {
          ok: false,
          messageId: '',
          finalText: streamer.getAccumulatedText(),
          fellBack: false,
          message: 'stopped'
        }
      }
      this.deps.logError('claw-feishu-stream', 'Streaming reply failed; falling back to one-shot send.', {
        message: error instanceof Error ? error.message : String(error),
        ...input.context
      })
      const finalText = streamer.getAccumulatedText() || ''
      try {
        const fb = await input.bridge.send(
          input.chatId,
          { markdown: finalText || 'Sorry, I could not finish streaming the response.' },
          input.replyOptions
        )
        return { ok: true, messageId: fb.messageId, finalText, fellBack: true, message: 'fell_back' }
      } catch (fbError) {
        return {
          ok: false,
          messageId: '',
          finalText,
          fellBack: true,
          message: fbError instanceof Error ? fbError.message : String(fbError)
        }
      }
    } finally {
      clearTimeout(timeout)
      stopSignal.removeEventListener('abort', stopStreaming)
      streamer.dispose()
    }
  }

  private requestRuntime(
    settings: AppSettingsV1,
    pathAndQuery: string,
    init: { method?: string; body?: string; headers?: Record<string, string> } = {}
  ): Promise<{ ok: boolean; status: number; body: string }> {
    return this.deps.runtimeRequest(settings, pathAndQuery, {
      ...init,
      signal: this.stopController.signal
    })
  }

  private startRuntimeTurn(
    settings: AppSettingsV1,
    threadId: string,
    turnBody: Record<string, unknown>
  ): Promise<{ ok: boolean; status: number; body: string }> {
    return this.requestRuntime(
      settings,
      `/v1/threads/${encodeURIComponent(threadId)}/turns`,
      { method: 'POST', body: JSON.stringify(turnBody) }
    )
  }

  /**
   * Fire-and-forget delivery of a turn's result that outran the IM
   * response window. Keeps polling in the background and pushes the
   * concluding text (or a completion note) back over the bridge when the
   * turn finishes. No-op for providers/recipients we cannot push to, and
   * deduped per turn so a retried inbound never double-pushes.
   */
  private scheduleImResultPush(
    settings: AppSettingsV1,
    input: {
      channel?: ClawImChannelV1
      remoteSession?: Pick<ClawImRemoteSessionV1, 'chatId' | 'messageId' | 'threadId' | 'senderId' | 'senderName'>
      threadId: string
      turnId?: string
      workspaceRoot: string
    }
  ): void {
    const { channel, turnId } = input
    if (!channel || !turnId) return
    if (this.stopController.signal.aborted) return
    if (!this.imTransport.canPush(channel)) return
    const key = `${input.threadId}:${turnId}`
    if (this.pendingResultPushes.has(key)) return
    this.pendingResultPushes.add(key)
    let task: Promise<void>
    task = (async () => {
      try {
        const outcome = await this.waitForAssistantResult(
          settings,
          input.threadId,
          turnId,
          RESULT_PUSH_MAX_WAIT_MS,
          input.workspaceRoot
        )
        if (this.stopController.signal.aborted) return
        if (outcome.status === 'timeout') {
          this.deps.logError(
            'claw-im',
            'Gave up pushing a delayed agent result: turn still running after the maximum wait.',
            { threadId: input.threadId, turnId }
          )
          return
        }
        const files =
          outcome.status === 'completed'
            ? await this.resolveImGeneratedFiles(outcome.files, input.workspaceRoot, {
                purpose: 'agent-file-delayed-resolve',
                channelId: channel.id,
                threadId: input.threadId,
                turnId,
                chatId: input.remoteSession?.chatId
              })
            : []
        const body =
          outcome.status === 'completed'
            ? replyTextForGeneratedFiles(outcome.text.trim() || IM_COMPLETED_NO_TEXT_REPLY, files)
            : `❌ 任务未完成：${outcome.error || outcome.status}`
        await this.pushImMessage(channel, input.remoteSession, body)
        if (outcome.status === 'completed') {
          await this.pushImGeneratedFiles(channel, input.remoteSession, files, {
            channelId: channel.id,
            threadId: input.threadId,
            turnId,
            chatId: input.remoteSession?.chatId
          })
        }
      } catch (error) {
        this.deps.logError('claw-im', 'Failed to push a delayed agent result.', {
          message: errorMessage(error),
          threadId: input.threadId,
          turnId
        })
      } finally {
        this.pendingResultPushes.delete(key)
      }
    })().finally(() => {
      this.resultPushTasks.delete(task)
    })
    this.resultPushTasks.add(task)
    void task
  }

  /** Pushes generated files for a delayed IM turn that finished after the response window. */
  private async pushImGeneratedFiles(
    channel: ClawImChannelV1,
    remoteSession: Pick<ClawImRemoteSessionV1, 'chatId' | 'messageId' | 'threadId' | 'senderId' | 'senderName'> | undefined,
    files: readonly ClawGeneratedFileV1[],
    context: Record<string, unknown>
  ): Promise<void> {
    await this.imTransport.sendFiles({ channel, remoteSession, files, context })
  }
  /** Pushes a standalone bridge message to the sender of an inbound IM. */
  private async pushImMessage(
    channel: ClawImChannelV1,
    remoteSession: Pick<ClawImRemoteSessionV1, 'chatId' | 'messageId' | 'threadId' | 'senderId' | 'senderName'> | undefined,
    text: string
  ): Promise<void> {
    await this.imTransport.sendText({
      channel,
      remoteSession,
      text,
      context: { purpose: 'agent-reply-delayed', channelId: channel.id }
    })
  }

  private resolveChannelWorkspaceRoot(settings: AppSettingsV1, channel?: ClawImChannelV1): string {
    return channel?.workspaceRoot.trim() || settings.claw.im.workspaceRoot.trim() || settings.workspaceRoot
  }

  private legacyEmptyBaseConversationWorkspaceRoot(
    session: Pick<ClawImRemoteSessionV1, 'chatId' | 'threadId'>
  ): string {
    const key = sanitizePathSegment(session.threadId.trim() || session.chatId.trim(), 'conversation')
    return `/conversations/${key}`
  }

  private resolveConversationWorkspaceRoot(
    settings: AppSettingsV1,
    channel: ClawImChannelV1,
    session: Pick<ClawImRemoteSessionV1, 'chatId' | 'threadId'>
  ): string {
    const base = this.resolveChannelWorkspaceRoot(settings, channel).trim()
    const key = sanitizePathSegment(session.threadId.trim() || session.chatId.trim(), 'conversation')
    return base ? `${base.replace(/\/+$/, '')}/conversations/${key}` : ''
  }

  private resolveIncomingWorkspaceRoot(
    settings: AppSettingsV1,
    channel: ClawImChannelV1 | undefined,
    conversation: ClawImConversationV1 | undefined,
    remoteSession: Pick<ClawImRemoteSessionV1, 'chatId' | 'threadId'> | undefined
  ): string {
    const storedConversationRoot = conversation?.workspaceRoot.trim() ?? ''
    if (storedConversationRoot && remoteSession) {
      const legacyEmptyBaseRoot = this.legacyEmptyBaseConversationWorkspaceRoot(remoteSession)
      if (storedConversationRoot !== legacyEmptyBaseRoot) return storedConversationRoot
    } else if (storedConversationRoot) {
      return storedConversationRoot
    }
    const conversationRoot = channel && remoteSession
      ? this.resolveConversationWorkspaceRoot(settings, channel, remoteSession)
      : ''
    return conversationRoot || this.resolveChannelWorkspaceRoot(settings, channel)
  }

  private findChannelConversation(
    channel: ClawImChannelV1,
    session: Pick<ClawImRemoteSessionV1, 'chatId' | 'threadId'>
  ): ClawImConversationV1 | undefined {
    return findClawConversation(channel, session)
  }

  private async resetIncomingImThread(
    input: {
      channel?: ClawImChannelV1
      conversation?: ClawImConversationV1
      remoteSession?: Pick<ClawImRemoteSessionV1, 'chatId' | 'messageId' | 'threadId' | 'senderId' | 'senderName'>
    }
  ): Promise<void> {
    if (!input.channel) return
    const currentSettings = await this.deps.store.load()
    const currentChannel = currentSettings.claw.channels.find((item) => item.id === input.channel?.id)
    if (!currentChannel) return
    const session = input.remoteSession
    const currentConversation = session
      ? this.findChannelConversation(currentChannel, session)
      : input.conversation
        ? currentChannel.conversations.find((item) => item.id === input.conversation?.id)
        : undefined
    const now = new Date().toISOString()
    await this.deps.store.patch({
      claw: {
        channels: currentSettings.claw.channels.map((item) => {
          if (item.id !== currentChannel.id) return item
          return clearClawThreadBinding({
            channel: item,
            conversation: currentConversation,
            remoteSession: session,
            now
          })
        })
      }
    })
  }

  private async setIncomingImProvider(
    channel: ClawImChannelV1 | undefined,
    conversation: ClawImConversationV1 | undefined,
    remoteSession: Pick<ClawImRemoteSessionV1, 'chatId' | 'messageId' | 'threadId' | 'senderId' | 'senderName'> | undefined,
    providerId: string,
    model: string
  ): Promise<void> {
    if (!channel) {
      await this.deps.store.patch({ claw: { im: { providerId, model } } })
      return
    }
    const currentSettings = await this.deps.store.load()
    const now = new Date().toISOString()
    await this.deps.store.patch({
      claw: {
        channels: currentSettings.claw.channels.map((item) => {
          if (item.id !== channel.id) return item
          const currentConversation = conversation
            ? item.conversations.find((entry) => entry.id === conversation.id)
            : remoteSession
              ? this.findChannelConversation(item, remoteSession)
              : undefined
          return setClawConversationModelSelection({
            channel: item,
            conversation: currentConversation,
            remoteSession,
            providerId,
            model,
            workspaceRoot: remoteSession
              ? this.resolveConversationWorkspaceRoot(currentSettings, item, remoteSession)
              : '',
            now,
            createId: randomUUID
          })
        })
      }
    })
  }

  private currentIncomingImThreadId(
    channel: ClawImChannelV1 | undefined,
    conversation: ClawImConversationV1 | undefined,
    remoteSession?: Pick<ClawImRemoteSessionV1, 'chatId' | 'threadId'> | undefined
  ): string {
    return currentClawThreadId({ channel, conversation, remoteSession })
  }

  private async listIncomingImThreads(
    settings: AppSettingsV1,
    limit: number
  ): Promise<ThreadRecordJson[]> {
    const response = await this.requestRuntime(
      settings,
      `/v1/threads?limit=${encodeURIComponent(String(limit))}`,
      { method: 'GET' }
    )
    if (!response.ok) {
      throw new Error(runtimeErrorMessage(response, 'Failed to list threads.'))
    }
    return parseListThreadsResponse(response.body)
      .sort((a, b) => imThreadTimestamp(b) - imThreadTimestamp(a))
      .slice(0, limit)
  }

  private async listIncomingImSwitchableThreads(
    settings: AppSettingsV1,
    channel: ClawImChannelV1 | undefined
  ): Promise<ThreadRecordJson[]> {
    const response = await this.requestRuntime(
      settings,
      '/v1/threads?limit=50',
      { method: 'GET' }
    )
    if (!response.ok) {
      throw new Error(runtimeErrorMessage(response, 'Failed to list threads.'))
    }
    const knownThreadIds = new Set<string>()
    if (channel?.threadId.trim()) knownThreadIds.add(channel.threadId.trim())
    for (const conversation of channel?.conversations ?? []) {
      if (conversation.localThreadId.trim()) knownThreadIds.add(conversation.localThreadId.trim())
    }
    return parseListThreadsResponse(response.body)
      .filter((thread) => isImThreadCandidate(thread, channel, knownThreadIds))
      .sort((a, b) => imThreadTimestamp(b) - imThreadTimestamp(a))
  }

  private async listIncomingImSkills(settings: AppSettingsV1): Promise<{ enabled: boolean; skills: ImSkillSummary[] }> {
    const response = await this.requestRuntime(
      settings,
      '/v1/skills',
      { method: 'GET' }
    )
    if (!response.ok) {
      throw new Error(runtimeErrorMessage(response, 'Failed to list skills.'))
    }
    return parseSkillsResponse(response.body)
  }

  private async listIncomingImMcpServers(settings: AppSettingsV1): Promise<ImMcpServerSummary[]> {
    const response = await this.requestRuntime(
      settings,
      '/v1/runtime/tools',
      { method: 'GET' }
    )
    if (!response.ok) {
      throw new Error(runtimeErrorMessage(response, 'Failed to list MCP servers.'))
    }
    return parseMcpResponse(response.body)
  }

  private async getIncomingImGoal(settings: AppSettingsV1, threadId: string): Promise<ImGoalSummary | null> {
    const response = await this.requestRuntime(
      settings,
      `/v1/threads/${encodeURIComponent(threadId)}/goal`,
      { method: 'GET' }
    )
    if (!response.ok) {
      throw new Error(runtimeErrorMessage(response, 'Failed to read goal.'))
    }
    return parseGoalResponse(response.body)
  }

  private async setIncomingImGoal(
    settings: AppSettingsV1,
    threadId: string,
    objective: string
  ): Promise<ImGoalSummary | null> {
    const response = await this.requestRuntime(
      settings,
      `/v1/threads/${encodeURIComponent(threadId)}/goal`,
      {
        method: 'POST',
        body: JSON.stringify({ objective })
      }
    )
    if (!response.ok) {
      throw new Error(runtimeErrorMessage(response, 'Failed to set goal.'))
    }
    return parseGoalResponse(response.body)
  }

  private async getIncomingImThreadDetail(settings: AppSettingsV1, threadId: string): Promise<ThreadDetailJson> {
    const response = await this.requestRuntime(
      settings,
      `/v1/threads/${encodeURIComponent(threadId)}`,
      { method: 'GET' }
    )
    if (!response.ok) {
      throw new Error(runtimeErrorMessage(response, 'Failed to read thread.'))
    }
    return JSON.parse(response.body) as ThreadDetailJson
  }

  private async getIncomingImThreadUsage(settings: AppSettingsV1, threadId: string): Promise<ImThreadUsageSummary> {
    const response = await this.requestRuntime(
      settings,
      `/v1/usage?group_by=thread&thread_id=${encodeURIComponent(threadId)}`,
      { method: 'GET' }
    )
    if (!response.ok) {
      throw new Error(runtimeErrorMessage(response, 'Failed to read usage.'))
    }
    return parseThreadUsageResponse(response.body, threadId)
  }

  private incomingImThreadWorkspace(
    detail: ThreadDetailJson,
    conversation: ClawImConversationV1 | undefined
  ): string {
    const record = detail as ThreadDetailJson & { workspace?: unknown }
    return asString(record.workspace) ||
      asString(record.thread?.workspace) ||
      conversation?.workspaceRoot.trim() ||
      ''
  }

  private runningTurnId(detail: ThreadDetailJson): string {
    const turns = Array.isArray(detail.turns) ? detail.turns : []
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index]
      if (turn.id.trim() && isRunningStatus(turn.status)) return turn.id.trim()
    }
    return ''
  }

  private async stopIncomingImTurn(settings: AppSettingsV1, threadId: string): Promise<string | null> {
    const detail = await this.getIncomingImThreadDetail(settings, threadId)
    const turnId = this.runningTurnId(detail)
    if (!turnId) return null
    const response = await this.requestRuntime(
      settings,
      `/v1/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/interrupt`,
      {
        method: 'POST',
        body: JSON.stringify({ discard: false })
      }
    )
    if (!response.ok) {
      throw new Error(runtimeErrorMessage(response, 'Failed to stop turn.'))
    }
    return turnId
  }

  private async switchIncomingImThread(
    settings: AppSettingsV1,
    input: {
      channel?: ClawImChannelV1
      conversation?: ClawImConversationV1
      remoteSession?: Pick<ClawImRemoteSessionV1, 'chatId' | 'messageId' | 'threadId' | 'senderId' | 'senderName'>
      threadId: string
    }
  ): Promise<boolean> {
    if (!input.channel) return false
    const currentSettings = await this.deps.store.load()
    const currentChannel = currentSettings.claw.channels.find((item) => item.id === input.channel?.id)
    if (!currentChannel) return false
    const session = input.remoteSession
    const currentConversation = session
      ? this.findChannelConversation(currentChannel, session)
      : input.conversation
        ? currentChannel.conversations.find((item) => item.id === input.conversation?.id)
        : undefined
    const now = new Date().toISOString()
    const modelResolution = currentImModelResolution(settings, currentChannel, input.conversation)
    await this.deps.store.patch({
      claw: {
        channels: currentSettings.claw.channels.map((item) => {
          if (item.id !== currentChannel.id) return item
          return bindClawConversationToThread({
            channel: item,
            conversation: currentConversation,
            remoteSession: session,
            threadId: input.threadId,
            workspaceRoot: session
              ? this.resolveConversationWorkspaceRoot(settings, currentChannel, session)
              : '',
            providerId: modelResolution.provider.id,
            model: modelResolution.model,
            now,
            createId: randomUUID
          })
        })
      }
    })
    this.deps.notifyChannelActivity?.({ channelId: currentChannel.id, threadId: input.threadId })
    return true
  }

  private async handleIncomingImCommand(
    settings: AppSettingsV1,
    input: {
      text: string
      channel?: ClawImChannelV1
      conversation?: ClawImConversationV1
      remoteSession?: Pick<ClawImRemoteSessionV1, 'chatId' | 'messageId' | 'threadId' | 'senderId' | 'senderName'>
    }
  ): Promise<string | null> {
    const command = parseClawCommand(input.text)
    if (!command) return null
    if (command.kind === 'help') return imCommandHelpText(settings)
    if (command.kind === 'stop') {
      const currentThreadId = this.currentIncomingImThreadId(input.channel, input.conversation, input.remoteSession)
      if (!currentThreadId) return imNoCurrentThreadText(settings)
      const stoppedTurnId = await this.stopIncomingImTurn(settings, currentThreadId)
      return stoppedTurnId
        ? imStopSucceededText(settings, stoppedTurnId)
        : imStopNoRunningTurnText(settings)
    }
    if (command.kind === 'showSkills') {
      const result = await this.listIncomingImSkills(settings)
      return imSkillListText(settings, result.enabled, result.skills)
    }
    if (command.kind === 'showMcp') {
      return imMcpListText(settings, await this.listIncomingImMcpServers(settings))
    }
    if (command.kind === 'showGoal') {
      const currentThreadId = this.currentIncomingImThreadId(input.channel, input.conversation, input.remoteSession)
      if (!currentThreadId) return imNoCurrentThreadText(settings)
      return imGoalText(settings, await this.getIncomingImGoal(settings, currentThreadId))
    }
    if (command.kind === 'showWorkspace') {
      const currentThreadId = this.currentIncomingImThreadId(input.channel, input.conversation, input.remoteSession)
      if (!currentThreadId) return imNoCurrentThreadText(settings)
      const detail = await this.getIncomingImThreadDetail(settings, currentThreadId)
      const workspace = this.incomingImThreadWorkspace(detail, input.conversation)
      return workspace
        ? imWorkspaceText(settings, currentThreadId, workspace)
        : imWorkspaceMissingText(settings, currentThreadId)
    }
    if (command.kind === 'showUsage') {
      const currentThreadId = this.currentIncomingImThreadId(input.channel, input.conversation, input.remoteSession)
      if (!currentThreadId) return imNoCurrentThreadText(settings)
      return imUsageText(
        settings,
        currentThreadId,
        await this.getIncomingImThreadUsage(settings, currentThreadId),
        currentImModelResolution(settings, input.channel, input.conversation)
      )
    }
    if (command.kind === 'invalidGoal') return imGoalMissingObjectiveText(settings)
    if (command.kind === 'setGoal') {
      const currentThreadId = this.currentIncomingImThreadId(input.channel, input.conversation, input.remoteSession)
      if (!currentThreadId) return imNoCurrentThreadText(settings)
      const existingGoal = await this.getIncomingImGoal(settings, currentThreadId)
      if (existingGoal) return imGoalAlreadyExistsText(settings, existingGoal)
      return imGoalChangedText(
        settings,
        await this.setIncomingImGoal(settings, currentThreadId, command.objective)
      )
    }
    if (command.kind === 'showThreads') {
      const currentThreadId = this.currentIncomingImThreadId(input.channel, input.conversation, input.remoteSession)
      const threads = await this.listIncomingImThreads(settings, settings.claw.im.recentThreadListLimit)
      return imThreadListText(settings, threads, currentThreadId)
    }
    if (command.kind === 'showCurrentThread') {
      const currentThreadId = this.currentIncomingImThreadId(input.channel, input.conversation, input.remoteSession)
      if (!currentThreadId) return imCurrentThreadText(settings, undefined, currentThreadId)
      const threads = await this.listIncomingImSwitchableThreads(settings, input.channel)
      return imCurrentThreadText(
        settings,
        threads.find((thread) => thread.id === currentThreadId),
        currentThreadId,
        hasOtherImThreadBinding(settings, currentThreadId, input.channel?.id, input.conversation?.id)
      )
    }
    if (command.kind === 'switchThread') {
      const switchTarget = command.target.trim()
      const threads = await this.listIncomingImThreads(
        settings,
        /^\d+$/.test(switchTarget) ? settings.claw.im.recentThreadListLimit : 50
      )
      const target = resolveImThreadSwitchTarget(threads, command.target)
      if (!target) return imThreadSwitchNotFoundText(settings, command.target)
      const shared = hasOtherImThreadBinding(
        settings,
        target.id,
        input.channel?.id,
        input.conversation?.id
      )
      const switched = await this.switchIncomingImThread(settings, {
        channel: input.channel,
        conversation: input.conversation,
        remoteSession: input.remoteSession,
        threadId: target.id
      })
      if (!switched) {
        return imKunErrorText(settings, isChineseLocale(settings)
          ? '当前消息没有匹配到可保存切换状态的 IM 通道，无法切换会话。'
          : 'This message did not match an IM channel that can persist thread switching.')
      }
      return imThreadSwitchedText(settings, target, shared)
    }
    if (command.kind === 'showModel') return imModelListText(settings, input.channel, input.conversation)
    if (command.kind === 'model') {
      const resolved = resolveImModelByIndex(settings, command.model)
      if (!resolved) return imModelCommandHint(settings, command.model)
      await this.setIncomingImProvider(
        input.channel,
        input.conversation,
        input.remoteSession,
        resolved.provider.id,
        resolved.model
      )
      return imModelChangedText(settings, resolved.provider.id, resolved.model)
    }
    if (command.kind === 'clear') {
      await this.resetIncomingImThread({
        channel: input.channel,
        conversation: input.conversation,
        remoteSession: input.remoteSession
      })
      return imNewTopicText(settings)
    }
    return null
  }

  private async handleIncomingImCommandSafely(
    settings: AppSettingsV1,
    input: {
      text: string
      channel?: ClawImChannelV1
      conversation?: ClawImConversationV1
      remoteSession?: Pick<ClawImRemoteSessionV1, 'chatId' | 'messageId' | 'threadId' | 'senderId' | 'senderName'>
    }
  ): Promise<string | null> {
    try {
      const reply = await this.handleIncomingImCommand(settings, input)
      return reply === null ? null : imKunSystemText(reply)
    } catch (error) {
      const message = errorMessage(error)
      this.deps.logError('claw-im-command', 'IM command failed', {
        command: input.text.trim().slice(0, 80),
        channelId: input.channel?.id,
        message
      })
      return imKunErrorText(settings, message || 'IM command failed.')
    }
  }

  private async processIncomingImPrompt(
    settings: AppSettingsV1,
    input: {
      prompt: string
      sender: string
      provider: ClawImProvider
      channel?: ClawImChannelV1
      conversation?: ClawImConversationV1
      remoteSession?: Pick<ClawImRemoteSessionV1, 'chatId' | 'messageId' | 'threadId' | 'senderId' | 'senderName'>
      /**
       * When `false`, the turn is started (and the conversation
       * persisted) but `waitForAssistantResult` is skipped — the caller
       * is responsible for observing the turn's outcome (e.g. via
       * `runStreamingReply`). Defaults to `true` for the legacy
       * `processIncomingImPrompt` polling path.
       */
      waitForResult?: boolean
    }
  ): Promise<ClawRunResult> {
    const { channel, conversation, prompt, provider, remoteSession, sender } = input
    const initialThreadId = currentClawThreadId({ channel, conversation, remoteSession })
    const modelResolution = currentImModelResolution(settings, channel, conversation)
    const result = await this.runPrompt(settings, {
      prompt,
      title: channel ? `[Claw IM:${channel.label}] ${sender}` : `[Claw IM:${provider}] ${sender}`,
      workspaceRoot: this.resolveIncomingWorkspaceRoot(settings, channel, conversation, remoteSession),
      model: modelResolution.model,
      providerId: modelResolution.provider.id,
      mode: settings.claw.im.mode,
      waitForResult: input.waitForResult !== false,
      responseTimeoutMs: settings.claw.im.responseTimeoutMs,
      source: 'im',
      threadId: initialThreadId || undefined,
      channel,
      onTurnStarted: async ({ threadId }) => {
        if (!channel) return
        const now = new Date().toISOString()
        // Patch from a fresh settings snapshot: the request-scoped
        // `settings` may be stale by now (e.g. the welcome marker was
        // persisted while this turn was starting).
        const latestSettings = await this.deps.store.load()
        if (remoteSession) {
          await this.deps.store.patch({
            claw: {
              channels: latestSettings.claw.channels.map((item) => {
                if (item.id !== channel.id) return item
                const existingConversation = conversation ?? findClawConversation(item, remoteSession)
                return bindClawConversationToThread({
                  channel: item,
                  conversation: existingConversation,
                  remoteSession,
                  threadId,
                  workspaceRoot: this.resolveIncomingWorkspaceRoot(
                    settings,
                    item,
                    existingConversation,
                    remoteSession
                  ),
                  providerId: modelResolution.provider.id,
                  model: modelResolution.model,
                  now,
                  createId: randomUUID
                })
              })
            }
          })
        } else if (!initialThreadId) {
          await this.deps.store.patch({
            claw: {
              channels: latestSettings.claw.channels.map((item) =>
                item.id === channel.id
                  ? {
                      ...item,
                      threadId,
                      updatedAt: now
                    }
                  : item
              )
            }
          })
        }
        this.deps.notifyChannelActivity?.({ channelId: channel.id, threadId })
      }
    })
    return result
  }
  private async rememberImRemoteSession(
    settings: AppSettingsV1,
    channel: ClawImChannelV1,
    remoteSession: IncomingRemoteSession
  ): Promise<void> {
    const nextRemoteSession = { ...remoteSession, updatedAt: new Date().toISOString() }
    const current = channel.remoteSession
    if (
      current?.chatId === nextRemoteSession.chatId &&
      current?.messageId === nextRemoteSession.messageId &&
      current?.threadId === nextRemoteSession.threadId &&
      current?.senderId === nextRemoteSession.senderId &&
      current?.senderName === nextRemoteSession.senderName
    ) {
      return
    }
    await this.deps.store.patch({
      claw: {
        channels: settings.claw.channels.map((item) =>
          item.id === channel.id
            ? {
                ...item,
                remoteSession: nextRemoteSession,
                updatedAt: nextRemoteSession.updatedAt
              }
            : item
        )
      }
    })
  }
  private async resolveImGeneratedFiles(
    files: readonly ClawGeneratedFileV1[],
    workspaceRoot: string,
    context: Record<string, unknown>
  ): Promise<ClawGeneratedFileV1[]> {
    return authorizeImGeneratedFiles({
      files,
      workspaceRoot,
      context,
      logError: this.deps.logError
    })
  }

  private async recentGeneratedFilesForThread(
    settings: AppSettingsV1,
    threadId: string,
    workspaceRoot: string,
    context: Record<string, unknown>,
    turnId?: string
  ): Promise<ClawGeneratedFileV1[]> {
    const targetThreadId = threadId.trim()
    if (!targetThreadId) return []
    try {
      const detailRes = await this.requestRuntime(
        settings,
        `/v1/threads/${encodeURIComponent(targetThreadId)}`,
        { method: 'GET' }
      )
      if (!detailRes.ok) {
        this.deps.logError('claw-feishu', 'Failed to read recent generated files from Kun thread', {
          ...context,
          threadId: targetThreadId,
          message: runtimeErrorMessage(detailRes, 'Failed to read thread result.')
        })
        return []
      }
      return latestGeneratedFiles(JSON.parse(detailRes.body) as ThreadDetailJson, {
        workspaceRoot,
        ...(turnId ? { turnId } : {}),
        maxFiles: 3
      })
    } catch (error) {
      this.deps.logError('claw-feishu', 'Failed to inspect Kun thread for recent generated files', {
        ...context,
        threadId: targetThreadId,
        message: errorMessage(error)
      })
      return []
    }
  }

  private findImChannelForThread(
    settings: AppSettingsV1,
    threadId: string
  ): { channel: ClawImChannelV1; conversation?: ClawImConversationV1 } | null {
    const targetThreadId = threadId.trim()
    if (!targetThreadId) return null
    for (const channel of settings.claw.channels) {
      if (!channel.enabled) continue
      const conversation =
        [...channel.conversations]
          .filter((item) => item.localThreadId.trim() === targetThreadId)
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0]
      if (conversation) return { channel, conversation }
      if (channel.threadId.trim() === targetThreadId) return { channel }
    }
    return null
  }

  async mirrorThreadMessageToIm(
    threadId: string,
    text: string,
    direction: 'user' | 'assistant'
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const trimmed = text.trim()
    if (!trimmed) return { ok: false, message: 'Message is empty.' }
    const settings = await this.deps.store.load()
    const target = this.findImChannelForThread(settings, threadId)
    if (!target) return { ok: false, message: 'Channel not found.' }
    return this.imTransport.mirror({
      channel: target.channel,
      conversation: target.conversation,
      threadId,
      text: trimmed,
      direction
    })
  }
  async mirrorThreadMessageToFeishu(
    threadId: string,
    text: string,
    direction: 'user' | 'assistant'
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    return this.mirrorThreadMessageToIm(threadId, text, direction)
  }

  /**
   * Entry point for inbound Telegram updates. The {@link TelegramRuntime}
   * long-poll loop calls this with a normalized payload per private-chat
   * message. Mirrors {@link handleFeishuMessage}: welcome, slash commands,
   * scheduled-task detection, then the regular agent turn — but adapts to
   * Telegram's chat-id/message-id scheme and image attachments.
   */
  async handleTelegramUpdate(payload: TelegramInboundPayload): Promise<void> {
    return handleTelegramInbound(payload, {
      loadSettings: () => this.deps.store.load(),
      telegramRuntime: this.deps.telegramRuntime,
      resolveIncomingWorkspaceRoot: (settings, channel, conversation, remoteSession) =>
        this.resolveIncomingWorkspaceRoot(settings, channel, conversation, remoteSession),
      resolveChannelWorkspaceRoot: (settings, channel) =>
        this.resolveChannelWorkspaceRoot(settings, channel),
      pendingWelcomeText: (settings, channel) => this.pendingWelcomeText(settings, channel),
      beginWelcome: (channelId) => {
        this.welcomeInFlight.add(channelId)
      },
      endWelcome: (channelId) => {
        this.welcomeInFlight.delete(channelId)
      },
      markWelcomeSent: (channelId) => this.markChannelWelcomeSent(channelId),
      handleCommand: (settings, input) => this.handleIncomingImCommandSafely(settings, input),
      resolveModel: (settings, channel, conversation) => {
        const resolution = currentImModelResolution(settings, channel, conversation)
        return { providerId: resolution.provider.id, model: resolution.model }
      },
      createScheduledTaskFromText: this.deps.createScheduledTaskFromText,
      processPrompt: (settings, input) => this.processIncomingImPrompt(settings, input),
      scheduleResultPush: (settings, input) => this.scheduleImResultPush(settings, input),
      resolveGeneratedFiles: (files, workspaceRoot, context) =>
        this.resolveImGeneratedFiles(files, workspaceRoot, context),
      formatError: imKunErrorText,
      logError: this.deps.logError
    })
  }

  private handleFeishuMessage(channelId: string, message: NormalizedMessage): Promise<void> {
    return handleFeishuInbound(channelId, message, {
      getBridge: (id) => this.feishuTransport.get(id),
      loadSettings: () => this.deps.store.load(),
      rememberRemoteSession: (settings, channel, remoteSession) =>
        this.rememberImRemoteSession(settings, channel, remoteSession),
      resolveIncomingWorkspaceRoot: (settings, channel, conversation, remoteSession) =>
        this.resolveIncomingWorkspaceRoot(settings, channel, conversation, remoteSession),
      resolveChannelWorkspaceRoot: (settings, channel) =>
        this.resolveChannelWorkspaceRoot(settings, channel),
      pendingWelcomeText: (settings, channel) => this.pendingWelcomeText(settings, channel),
      beginWelcome: (id) => {
        this.welcomeInFlight.add(id)
      },
      endWelcome: (id) => {
        this.welcomeInFlight.delete(id)
      },
      markWelcomeSent: (id) => this.markChannelWelcomeSent(id),
      sendMessage: (bridge, to, input, options, context) =>
        this.feishuTransport.send(bridge, to, input, options, context),
      sendGeneratedFiles: (bridge, to, files, options, context) =>
        this.feishuTransport.sendFilesWithBridge(bridge, to, files, context, options),
      handleCommand: (settings, input) => this.handleIncomingImCommandSafely(settings, input),
      resolveModel: (settings, channel, conversation) => {
        const resolution = currentImModelResolution(settings, channel, conversation)
        return { providerId: resolution.provider.id, model: resolution.model }
      },
      createScheduledTaskFromText: this.deps.createScheduledTaskFromText,
      formatError: imKunErrorText,
      resolveGeneratedFiles: (files, workspaceRoot, context) =>
        this.resolveImGeneratedFiles(files, workspaceRoot, context),
      recentGeneratedFiles: (settings, threadId, workspaceRoot, context, turnId) =>
        this.recentGeneratedFilesForThread(settings, threadId, workspaceRoot, context, turnId),
      processPrompt: (settings, input) => this.processIncomingImPrompt(settings, input),
      runStreamingReply: (input) => this.runStreamingReply(input),
      scheduleResultPush: (settings, input) => this.scheduleImResultPush(settings, input),
      logError: this.deps.logError
    })
  }


  private syncWebhook(settings: AppSettingsV1): void {
    const im = settings.claw.im
    const key = `${im.port}|${im.path}`
    if (this.server && this.serverKey === key) return
    void this.closeWebhook()

    const server = createServer((req, res) => {
      this.trackLifecycleTask('Claw webhook handler failed', this.handleWebhook(req, res))
    })
    server.on('error', (error) => {
      this.deps.logError('claw-webhook', 'Claw IM webhook server failed', {
        message: error instanceof Error ? error.message : String(error)
      })
      if (this.server === server) {
        void this.closeWebhook()
      }
    })
    server.listen(im.port, '127.0.0.1')
    this.server = server
    this.serverKey = key
  }

  private closeWebhook(forceConnections = false): Promise<void> {
    if (!this.server) return Promise.resolve()
    const server = this.server
    this.server = null
    this.serverKey = ''
    const task = new Promise<void>((resolve) => {
      try {
        server.close(() => resolve())
        if (forceConnections) server.closeAllConnections?.()
      } catch {
        resolve()
      }
    })
    this.webhookCloseTasks.add(task)
    void task.finally(() => this.webhookCloseTasks.delete(task))
    return task
  }

  private async handleWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (this.stopController.signal.aborted) {
        writeJson(res, 503, { ok: false, message: 'Kun: Claw runtime is stopping.' })
        return
      }
      const settings = await this.deps.store.load()
      const im = settings.claw.im
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/claw/internal/gui-plan/create' && req.method === 'POST') {
        // The legacy `gui_plan_create` MCP bridge is no longer the
        // active plan path. GUI plan creation now flows through the
        // native Kun `create_plan` tool. Reject legacy calls
        // loudly so older clients see a clear migration error.
        writeJson(res, 410, {
          ok: false,
          code: 'gui_plan_create_retired',
          message:
            'Kun: The /claw/internal/gui-plan/create endpoint is no longer active. Use the Kun create_plan tool.'
        })
        return
      }
      if (req.method !== 'POST' || url.pathname !== im.path) {
        writeJson(res, 404, { ok: false, message: 'Kun: Not found.' })
        return
      }
      if (!settings.claw.enabled || !im.enabled) {
        writeJson(res, 503, { ok: false, message: 'Kun: Claw IM webhook is disabled.' })
        return
      }
      if (im.secret) {
        const auth = req.headers.authorization ?? ''
        // 新名字 x-kun-secret 优先;旧名字 x-deepseek-gui-secret 已配置
        // 在外部系统里,属于对外契约,必须长期兼容。
        const rawHeaderSecret = req.headers['x-kun-secret'] ?? req.headers['x-deepseek-gui-secret']
        const headerSecret = Array.isArray(rawHeaderSecret) ? rawHeaderSecret[0] : rawHeaderSecret
        if (auth !== `Bearer ${im.secret}` && headerSecret !== im.secret) {
          writeJson(res, 401, { ok: false, message: 'Kun: Unauthorized.' })
          return
        }
      }

      const body = await readRequestBody(req)
      const payload = parseJsonObject(body)
      if (!payload) {
        writeJson(res, 400, { ok: false, message: 'Kun: Expected a JSON object.' })
        return
      }
      const prompt = extractIncomingPrompt(payload)
      if (!prompt) {
        writeJson(res, 400, { ok: false, message: 'Kun: No message text found.' })
        return
      }
      const sender = extractSenderLabel(payload)
      const provider = extractIncomingProvider(payload, im.provider)
      const incomingChannelId = extractIncomingChannelId(payload)
      const channel = incomingChannelId
        ? settings.claw.channels.find(
            (item) => item.enabled && item.id === incomingChannelId
          ) ?? settings.claw.channels.find(
            (item) => item.enabled && item.provider === provider
          )
        : settings.claw.channels.find(
            (item) => item.enabled && item.provider === provider
          )
      const remoteSession = extractIncomingRemoteSession(payload) ??
        this.imTransport.legacyRemoteSession(provider, payload, sender)
      if (channel && remoteSession) await this.rememberImRemoteSession(settings, channel, remoteSession)
      const conversation =
        channel && remoteSession
          ? this.findChannelConversation(channel, {
              chatId: remoteSession.chatId,
              threadId: remoteSession.threadId
            })
          : undefined
      // First inbound message on a freshly connected channel: push the
      // intro over the WeChat bridge when possible (it lands before the
      // model reply), otherwise prepend it to this response.
      let welcomePrefix = ''
      const welcomeText = this.pendingWelcomeText(settings, channel)
      if (welcomeText && channel) {
        this.welcomeInFlight.add(channel.id)
        try {
          const pushed = await this.imTransport.pushWelcome({
            channel,
            remoteSession: remoteSession ?? undefined,
            text: welcomeText
          })
          if (!pushed) welcomePrefix = `${welcomeText}\n\n---\n\n`
          await this.markChannelWelcomeSent(channel.id)
        } finally {
          this.welcomeInFlight.delete(channel.id)
        }
      }
      const commandReply = await this.handleIncomingImCommandSafely(settings, {
        text: prompt,
        channel,
        conversation,
        remoteSession: remoteSession ?? undefined
      })
      if (commandReply !== null) {
        writeJson(res, 200, { ok: true, reply: `${welcomePrefix}${commandReply}` })
        return
      }
      const modelResolution = currentImModelResolution(settings, channel, conversation)
      const taskCreation = await this.deps.createScheduledTaskFromText?.(prompt, {
        workspaceRoot: this.resolveChannelWorkspaceRoot(settings, channel),
        clawChannelId: channel?.id ?? null,
        providerId: modelResolution.provider.id,
        modelHint: modelResolution.model,
        mode: im.mode
      }) ?? { kind: 'noop' as const }
      if (taskCreation.kind === 'created') {
        writeJson(res, 200, { ok: true, createdTaskId: taskCreation.taskId, reply: `${welcomePrefix}${taskCreation.confirmationText}` })
        return
      }
      if (taskCreation.kind === 'error') {
        const reply = imKunErrorText(settings, taskCreation.message)
        writeJson(res, 500, { ok: false, message: reply, reply })
        return
      }
      const result = await this.processIncomingImPrompt(settings, {
        prompt,
        sender,
        provider,
        channel,
        conversation,
        remoteSession: remoteSession ?? undefined
      })
      if (!result.ok) {
        writeJson(res, 500, {
          ...result,
          message: imKunErrorText(settings, result.message),
          reply: imKunErrorText(settings, result.message)
        })
        return
      }
      if (result.completed === false) {
        // The turn outran the response window. Ack now and push the real
        // result back when it finishes, instead of replying with whatever
        // intermediate text happened to exist at the timeout.
        this.scheduleImResultPush(settings, {
          channel,
          remoteSession: remoteSession ?? undefined,
          threadId: result.threadId,
          turnId: result.turnId,
          workspaceRoot: this.resolveIncomingWorkspaceRoot(settings, channel, conversation, remoteSession ?? undefined)
        })
        writeJson(res, 200, {
          ok: true,
          threadId: result.threadId,
          turnId: result.turnId,
          reply: `${welcomePrefix}${IM_PROCESSING_ACK}`
        })
        return
      }
      // Current-turn deliverable media files ride along in the response so
      // push-capable bridges (WeChat) can upload them after the text reply.
      // The prompt heuristic remains as a fallback for explicit file-send
      // requests when the current run returns an empty list.
      const generatedFiles = result.files ?? []
      const files = generatedFiles.length > 0 || shouldSendGeneratedFilesForPrompt(prompt)
        ? await this.resolveImGeneratedFiles(
            generatedFiles,
            this.resolveIncomingWorkspaceRoot(settings, channel, conversation, remoteSession ?? undefined),
            {
              purpose: 'im-webhook-file-resolve',
              provider,
              channelId: channel?.id,
              threadId: result.threadId,
              turnId: result.turnId
            }
          )
        : []
      const replyBody = result.text?.trim() || result.message?.trim() || IM_COMPLETED_NO_TEXT_REPLY
      writeJson(res, 200, { ...result, files, reply: `${welcomePrefix}${replyBody}` })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.logError('claw-webhook', 'Claw IM webhook request failed', { message })
      writeJson(res, 500, { ok: false, message: 'Kun: Internal server error.' })
    }
  }
}

export function createClawRuntime(deps: ClawRuntimeDeps): ClawRuntime {
  return new ClawRuntime(deps)
}
