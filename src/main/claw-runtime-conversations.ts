import { randomUUID } from 'node:crypto'
import type {
  AppSettingsV1,
  ClawImChannelV1,
  ClawImConversationV1,
  ClawImRemoteSessionV1
} from '../shared/app-settings'
import {
  asString,
  isRunningStatus,
  runtimeErrorMessage,
  type ThreadDetailJson,
  type ThreadRecordJson
} from './claw-runtime-helpers'
import {
  bindClawConversationToThread,
  clearClawThreadBinding,
  currentClawThreadId,
  findClawConversation,
  setClawConversationModelSelection
} from './claw-conversation-registry'
import {
  isImThreadCandidate,
  parseGoalResponse,
  parseListThreadsResponse,
  parseMcpResponse,
  parseSkillsResponse,
  parseThreadUsageResponse,
  imThreadTimestamp,
  type ImGoalSummary,
  type ImMcpServerSummary,
  type ImSkillSummary,
  type ImThreadUsageSummary
} from './claw-im-command-support'
import { currentImModelResolution } from './claw-im-model-support'
import { ClawRuntimePrompt } from './claw-runtime-prompt'

export abstract class ClawRuntimeConversations extends ClawRuntimePrompt {
  protected findChannelConversation(
    channel: ClawImChannelV1,
    session: Pick<ClawImRemoteSessionV1, 'chatId' | 'threadId'>
  ): ClawImConversationV1 | undefined {
    return findClawConversation(channel, session)
  }

  protected async resetIncomingImThread(
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

  protected async setIncomingImProvider(
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

  protected currentIncomingImThreadId(
    channel: ClawImChannelV1 | undefined,
    conversation: ClawImConversationV1 | undefined,
    remoteSession?: Pick<ClawImRemoteSessionV1, 'chatId' | 'threadId'> | undefined
  ): string {
    return currentClawThreadId({ channel, conversation, remoteSession })
  }

  protected async listIncomingImThreads(
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

  protected async listIncomingImSwitchableThreads(
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

  protected async listIncomingImSkills(settings: AppSettingsV1): Promise<{ enabled: boolean; skills: ImSkillSummary[] }> {
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

  protected async listIncomingImMcpServers(settings: AppSettingsV1): Promise<ImMcpServerSummary[]> {
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

  protected async getIncomingImGoal(settings: AppSettingsV1, threadId: string): Promise<ImGoalSummary | null> {
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

  protected async setIncomingImGoal(
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

  protected async getIncomingImThreadDetail(settings: AppSettingsV1, threadId: string): Promise<ThreadDetailJson> {
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

  protected async getIncomingImThreadUsage(settings: AppSettingsV1, threadId: string): Promise<ImThreadUsageSummary> {
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

  protected incomingImThreadWorkspace(
    detail: ThreadDetailJson,
    conversation: ClawImConversationV1 | undefined
  ): string {
    const record = detail as ThreadDetailJson & { workspace?: unknown }
    return asString(record.workspace) ||
      asString(record.thread?.workspace) ||
      conversation?.workspaceRoot.trim() ||
      ''
  }

  protected runningTurnId(detail: ThreadDetailJson): string {
    const turns = Array.isArray(detail.turns) ? detail.turns : []
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index]
      if (turn.id.trim() && isRunningStatus(turn.status)) return turn.id.trim()
    }
    return ''
  }

  protected async stopIncomingImTurn(settings: AppSettingsV1, threadId: string): Promise<string | null> {
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

  protected async switchIncomingImThread(
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

}
