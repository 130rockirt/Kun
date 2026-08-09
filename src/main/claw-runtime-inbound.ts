import { randomUUID } from 'node:crypto'
import type {
  AppSettingsV1,
  ClawGeneratedFileV1,
  ClawImChannelV1,
  ClawImConversationV1,
  ClawImProvider,
  ClawImRemoteSessionV1,
  ClawRunResult
} from '../shared/app-settings'
import { parseClawCommand } from '../shared/claw-commands'
import {
  latestGeneratedFiles,
  runtimeErrorMessage,
  type ThreadDetailJson
} from './claw-runtime-helpers'
import {
  bindClawConversationToThread,
  currentClawThreadId,
  findClawConversation
} from './claw-conversation-registry'
import { authorizeImGeneratedFiles } from './im-attachment-pipeline'
import type { ImIncomingRemoteSession as IncomingRemoteSession } from './telegram-inbound-coordinator'
import {
  hasOtherImThreadBinding,
  imCurrentThreadText,
  imGoalAlreadyExistsText,
  imGoalChangedText,
  imGoalMissingObjectiveText,
  imGoalText,
  imMcpListText,
  imNoCurrentThreadText,
  imSkillListText,
  imStopNoRunningTurnText,
  imStopSucceededText,
  imThreadListText,
  imThreadSwitchNotFoundText,
  imThreadSwitchedText,
  imUsageText,
  imWorkspaceMissingText,
  imWorkspaceText,
  resolveImThreadSwitchTarget
} from './claw-im-command-support'
import {
  currentImModelResolution,
  errorMessage,
  imCommandHelpText,
  imKunErrorText,
  imKunSystemText,
  imModelChangedText,
  imModelCommandHint,
  imModelListText,
  imNewTopicText,
  resolveImModelByIndex,
  isChineseLocale
} from './claw-im-model-support'
import { ClawRuntimeConversations } from './claw-runtime-conversations'

export abstract class ClawRuntimeInbound extends ClawRuntimeConversations {
  protected async handleIncomingImCommand(
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

  protected async handleIncomingImCommandSafely(
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

  protected async processIncomingImPrompt(
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
  protected async rememberImRemoteSession(
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
  protected async resolveImGeneratedFiles(
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

  protected async recentGeneratedFilesForThread(
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

  protected findImChannelForThread(
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

}
