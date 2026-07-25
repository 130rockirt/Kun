import type { AgentProvider, NormalizedThread, ThreadEventSink } from '../agent/types'
import type { ChatState, ChatStoreGet } from './chat-store-types'
import {
  composerModelSelectable,
  providerIdForComposerModel,
  providerIdMatchesComposerModel,
  readThreadComposerSelection
} from './chat-store-helpers'

export function fallbackComposerProviderIdForSend(state: ChatState): string {
  return state.route === 'claw' ? '' : state.composerProviderId.trim()
}

export async function ensureRuntimeProviderForSend(input: {
  providerId?: string
  model?: string
}): Promise<void> {
  const providerId = input.providerId?.trim()
  const model = input.model?.trim()
  if (!providerId || !model || model.toLowerCase() === 'auto') return
}

export function composerSelectionForThread(
  state: ChatState,
  thread: Pick<NormalizedThread, 'id' | 'model'> | null | undefined,
  options: {
    hasUserMessages?: boolean
    runtimeModel?: string
  } = {}
): { model: string; providerId: string } | null {
  if (!thread) return null
  const pickList = state.composerPickList
  const stored = readThreadComposerSelection(thread.id)
  const storedModel = stored?.model.trim() ?? ''
  const threadModel = options.runtimeModel?.trim() || thread.model.trim()
  const storedSelectable = composerModelSelectable(pickList, state.composerModelGroups, storedModel)
  const storedShouldWin = storedSelectable && (
    options.hasUserMessages !== false ||
    stored?.source === 'user' ||
    stored?.source === 'default'
  )
  const model = storedShouldWin
    ? storedModel
    : composerModelSelectable(pickList, state.composerModelGroups, threadModel)
      ? threadModel
      : storedSelectable
        ? storedModel
        : ''
  if (!model) return null
  const usesStoredModel = storedModel.toLowerCase() === model.toLowerCase()
  const storedProviderId =
    stored && usesStoredModel &&
      providerIdMatchesComposerModel(state.composerModelGroups, stored.providerId, model)
      ? stored.providerId
      : ''
  return {
    model,
    providerId: storedProviderId || providerIdForComposerModel(state.composerModelGroups, model)
  }
}

export function subscribeThreadEventsWithRecovery(
  provider: AgentProvider,
  threadId: string,
  sinceSeq: number,
  sink: ThreadEventSink,
  signal: AbortSignal,
  get: ChatStoreGet
): void {
  void provider.subscribeThreadEvents(threadId, sinceSeq, sink, signal)
    .catch(() => undefined)
    .then(() => {
      if (signal.aborted) return
      const state = get()
      if (state.activeThreadId !== threadId || !state.busy) return
      void state.recoverActiveTurn()
    })
}
