import type { AgentProvider } from '../agent/types'
import type { AttachmentReference } from '../agent/types'
import type { ChatState, ChatStoreGet, ChatStoreSet, QueuedUserMessage, SendMessageOverrides } from './chat-store-types'
import { rendererRuntimeClient } from '../agent/runtime-client'
import { describeRuntimeError, getRuntimeErrorCode } from '../lib/format-runtime-error'
import { runtimePromptForSurface } from './chat-store-send-prompt'
import { startWorkspaceCheckpointSnapshot } from './chat-store-thread-send-checkpoint'
import { rememberPendingClawFeishuMirror } from './chat-store-runtime-notifications'
import {
  activeClawChannel,
  rememberTurnModel,
  toWriteTurnContext
} from './chat-store-helpers'
import {
  ensureRuntimeProviderForSend
} from './chat-store-thread-action-helpers'
import {
  pendingQueuedMessage,
  turnAdmissionOutcomeMayBeUnknown,
  withoutConsumedComposerContexts
} from './chat-store-thread-actions-support'
import type { ComposerContextAttachment } from '@kun/extension-api'

export type RuntimeQueueSendInput = {
  provider: AgentProvider
  activeThreadId: string
  trimmedText: string
  clientRequestId: string
  mode?: string
  orchestration: QueuedUserMessage['orchestration']
  requestedAgentSurface: 'code' | 'write' | 'design' | undefined
  writeContext: SendMessageOverrides['writeContext']
  composerModel: string
  composerProviderId: string
  composerAccountId: string | undefined
  userModelChip: string | undefined
  displayText: string | undefined
  reasoningEffort: string | undefined
  serviceTier: 'priority' | undefined
  subagentResume: QueuedUserMessage['subagentResume']
  messageSource: QueuedUserMessage['messageSource']
  persona: SendMessageOverrides['persona']
  designProfile: SendMessageOverrides['designProfile']
  designDocumentTarget: SendMessageOverrides['designDocumentTarget']
  designImagePlacementTarget: SendMessageOverrides['designImagePlacementTarget']
  attachmentIds: readonly string[] | undefined
  attachments: readonly AttachmentReference[] | undefined
  fileReferences: SendMessageOverrides['fileReferences']
  composerContexts: ComposerContextAttachment[]
  queued: QueuedUserMessage | undefined
  overrides: SendMessageOverrides | undefined
  set: ChatStoreSet
  get: ChatStoreGet
  persistActiveQueuedMessages: () => void
}

/**
 * Submit a busy-thread follow-up straight into the durable runtime queue
 * (enqueueIfBusy). Returns true when the runtime admitted the turn, false on
 * a deterministic rejection, and null when the attempt outcome is unknown
 * and the caller should keep its local fallback queue entry.
 */
export async function submitToRuntimeQueue(input: RuntimeQueueSendInput): Promise<boolean | null> {
  const {
    provider: p, activeThreadId, trimmedText, clientRequestId, mode, orchestration,
    requestedAgentSurface, writeContext, composerModel, composerProviderId,
    composerAccountId, userModelChip, displayText, reasoningEffort, serviceTier,
    subagentResume, messageSource, persona, designProfile, designDocumentTarget,
    designImagePlacementTarget, attachmentIds, attachments, fileReferences, composerContexts,
    queued, overrides, set, get
  } = input
  try {
    const channel = get().route === 'claw' ? activeClawChannel(get()) : null
    await ensureRuntimeProviderForSend({
      providerId: channel ? undefined : composerProviderId,
      model: composerModel
    })
    const settings = await rendererRuntimeClient.getSettings()
    const runtimeText = runtimePromptForSurface({
      channel,
      requestedAgentSurface,
      writeContext,
      settings,
      prompt: trimmedText
    })
    const checkpointRequestId = startWorkspaceCheckpointSnapshot({
      settings,
      threads: get().threads,
      activeThreadId,
      fallbackWorkspaceRoot: settings.workspaceRoot
    })
    const sendOptions = {
      clientRequestId,
      ...(mode ? { mode } : {}),
      orchestration,
      agentSurface: requestedAgentSurface ??
        (writeContext || get().route === 'write'
          ? 'write' as const
          : queued?.guiDesignMode || get().route === 'design' ? 'design' as const : 'code' as const),
      ...(composerModel ? { model: composerModel } : {}),
      ...(!channel && composerProviderId ? { providerId: composerProviderId } : {}),
      ...(!channel && composerAccountId ? { accountId: composerAccountId } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(!channel && serviceTier ? { serviceTier } : {}),
      ...(subagentResume ? { subagentResume } : {}),
      ...(messageSource ? { messageSource } : {}),
      ...(displayText ? { displayText } : {}),
      ...((queued?.guiPlan ?? overrides?.guiPlan) ? { guiPlan: queued?.guiPlan ?? overrides?.guiPlan } : {}),
      ...(designProfile ? { designProfile } : {}),
      ...(designDocumentTarget ? { designDocumentTarget } : {}),
      ...(designImagePlacementTarget ? { designImagePlacementTarget } : {}),
      ...(writeContext ? { writeContext: toWriteTurnContext(writeContext) } : {}),
      ...(persona ? { persona } : {}),
      ...((queued?.guiDesignArtifact ?? overrides?.guiDesignArtifact)
        ? { guiDesignArtifact: queued?.guiDesignArtifact ?? overrides?.guiDesignArtifact }
        : {}),
      ...(attachmentIds?.length ? { attachmentIds: [...attachmentIds] } : {}),
      ...(checkpointRequestId ? { workspaceCheckpointRequestId: checkpointRequestId } : {}),
      ...(fileReferences?.length ? { fileReferences } : {}),
      ...(composerContexts.length ? { composerContexts } : {})
    }
    let accepted: Awaited<ReturnType<typeof p.sendUserMessage>>
    try {
      accepted = await p.sendUserMessage(activeThreadId, runtimeText, {
        ...sendOptions,
        enqueueIfBusy: true
      })
    } catch (busyError) {
      const busyCode = getRuntimeErrorCode(busyError)
      if (busyCode !== 'thread_busy' && busyCode !== 'turn_in_progress') throw busyError
      // The turn settled between the busy check and admission; submit as a
      // regular turn instead of queueing behind nothing.
      accepted = await p.sendUserMessage(activeThreadId, runtimeText, sendOptions)
    }
    const acceptedMessage = pendingQueuedMessage({
      ...queued,
      id: queued?.id ?? `q-${clientRequestId}`,
      text: trimmedText,
      clientRequestId,
      ...(composerContexts.length ? { composerContexts } : {}),
      ...(fileReferences?.length ? { fileReferences } : {}),
      ...(attachmentIds?.length ? { attachmentIds: [...attachmentIds] } : {}),
      ...(attachments?.length ? { attachments: [...attachments] } : {}),
      ...(designProfile ? { designProfile } : {}),
      ...(designDocumentTarget ? { designDocumentTarget } : {}),
      ...(designImagePlacementTarget ? { designImagePlacementTarget } : {}),
      ...(writeContext ? { writeContext } : {}),
      ...((queued?.guiPlan ?? overrides?.guiPlan) ? { guiPlan: queued?.guiPlan ?? overrides?.guiPlan } : {}),
      ...(displayText ? { displayText } : {}),
      ...(mode ? { mode } : {}),
      orchestration,
      ...(composerModel ? { model: composerModel } : {}),
      ...(userModelChip ? { modelLabel: userModelChip } : {})
    })
    // pendingQueuedMessage strips delivery markers; restore them for the
    // runtime-admitted entry.
    acceptedMessage.deliveryState = 'in_flight'
    acceptedMessage.deliveryTurnId = accepted.turnId
    acceptedMessage.deliveryUserMessageItemId =
      accepted.userMessageItemId ?? acceptedMessage.id
    set((s) => {
      // upsertQueuedSubmission always resets to pending; the accepted entry
      // is already admitted to the runtime queue, so merge it manually to
      // keep its in_flight delivery state.
      const existingIndex = s.queuedMessages.findIndex((message) =>
        message.id === acceptedMessage.id ||
        Boolean(acceptedMessage.clientRequestId && message.clientRequestId === acceptedMessage.clientRequestId)
      )
      const queuedMessages = existingIndex < 0
        ? [...s.queuedMessages, acceptedMessage]
        : s.queuedMessages.map((message, index) => index === existingIndex
            ? { ...message, ...acceptedMessage, id: message.id }
            : message)
      return {
        queuedMessages,
        extensionComposerContexts: withoutConsumedComposerContexts(s, composerContexts),
        error: null
      }
    })
    input.persistActiveQueuedMessages()
    if (accepted.userMessageItemId && userModelChip) {
      rememberTurnModel(activeThreadId, accepted.userMessageItemId, userModelChip)
    }
    if (channel && typeof window.kunGui?.mirrorClawChannelMessage === 'function') {
      const mirrored = await window.kunGui
        .mirrorClawChannelMessage(activeThreadId, trimmedText, 'user')
        .catch(() => ({ ok: false as const }))
      if (mirrored.ok) {
        rememberPendingClawFeishuMirror(accepted.turnId, {
          threadId: activeThreadId,
          userBlockId: accepted.userMessageItemId ?? acceptedMessage.id,
          userText: trimmedText
        })
      }
    }
    return true
  } catch (error) {
    // Unknown outcome means the runtime may have admitted the queued turn
    // already; the idempotent clientRequestId makes the local retry below
    // safe, so only bail out on errors that cannot have created server state.
    if (!turnAdmissionOutcomeMayBeUnknown(error)) {
      const view = describeRuntimeError(error)
      set({ error: view.message })
      return false
    }
    return null
  }
}
