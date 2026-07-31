import type {
  AgentProvider,
  ChatBlock,
  CompactionBlock,
  ThreadEventSink,
  ToolBlock,
  ToolEventPayload
} from '../agent/types'
import { DEFAULT_KUN_MODEL, MODEL_REASONING_EFFORTS } from '@shared/app-settings'
import type {
  ChatState,
  SideConversation,
  SideConversationDraftOptions,
  SidePanelState
} from './chat-store-types'
import {
  accountIdForComposerSelection,
  providerIdForComposerModel
} from './chat-store-helpers'
import { upsertUserBlock } from './chat-store-runtime-helpers'
import { serviceTierForComposerSelection } from '../components/chat/composer-fast-mode'

type SideContext = {
  set: (partial: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>)) => void
  get: () => ChatState
  getProvider: () => AgentProvider
  /** i18n reference (kept loose; the host already imports the default). */
  t: (key: string) => string
  formatRuntimeError: (error: unknown) => string
  shouldOpenSettingsForError: (error: unknown) => boolean
}

type ActiveSideAbort = {
  sideId: string
  abort: AbortController
}

const sideAbortControllers = new Map<string, AbortController>()

function compactTitlePrefix(value: string): string {
  return Array.from(value.trim()).slice(0, 5).join('')
}

function defaultSideTitle(parentTitle: string, parentThreadId: string): string {
  const trimmed = parentTitle.trim()
  if (trimmed) return `${compactTitlePrefix(trimmed)} · side`
  return `${parentThreadId.slice(0, 8)} · side`
}

function defaultSideModel(state: ChatState, parentThreadId: string): string {
  const parent = state.threads.find((thread) => thread.id === parentThreadId)
  if (parent?.model) return parent.model
  if (state.composerModel) return state.composerModel
  return DEFAULT_KUN_MODEL
}

function defaultSideProviderId(
  state: ChatState,
  parentThreadId: string,
  model: string
): string {
  const normalizedModel = model.trim().toLowerCase()
  const parent = state.threads.find((thread) => thread.id === parentThreadId)
  if (
    parent?.providerId?.trim() &&
    parent.model.trim().toLowerCase() === normalizedModel
  ) {
    return parent.providerId.trim()
  }
  if (
    state.composerProviderId.trim() &&
    state.composerModel.trim().toLowerCase() === normalizedModel
  ) {
    return state.composerProviderId.trim()
  }
  return providerIdForComposerModel(state.composerModelGroups, model)
}

function sideReasoningEffortRequestValue(value: string): string | undefined {
  const normalized = value.trim().toLowerCase()
  return MODEL_REASONING_EFFORTS.includes(normalized as (typeof MODEL_REASONING_EFFORTS)[number])
    ? normalized
    : undefined
}

function patchSide(
  state: ChatState,
  sideId: string,
  patch: (side: SideConversation) => SideConversation
): Partial<ChatState> {
  const current = state.sideConversations[sideId]
  if (!current) return {}
  return { sideConversations: { ...state.sideConversations, [sideId]: patch(current) } }
}

function setSidePanel(panel: SidePanelState, patch: Partial<SidePanelState>): SidePanelState {
  return { ...panel, ...patch }
}

function flushSideLiveBlocks(side: SideConversation): { side: SideConversation; blocks: ChatBlock[] } {
  let nextBlocks = side.blocks
  let nextLiveReasoning = side.liveReasoning
  let nextLiveAssistant = side.liveAssistant
  if (nextLiveReasoning) {
    const block: ChatBlock = {
      kind: 'reasoning',
      id: side.liveReasoningItemId ?? `live_reasoning_${side.lastSeq || Date.now()}`,
      turnId: side.liveReasoningTurnId ?? side.turnId ?? undefined,
      createdAt: side.liveReasoningCreatedAt ?? new Date().toISOString(),
      text: nextLiveReasoning
    }
    nextBlocks = upsertSideTimelineBlock(nextBlocks, block)
    nextLiveReasoning = ''
  }
  if (nextLiveAssistant) {
    const block: ChatBlock = {
      kind: 'assistant',
      id: side.liveAssistantItemId ?? `live_assistant_${side.lastSeq || Date.now()}`,
      turnId: side.liveAssistantTurnId ?? side.turnId ?? undefined,
      createdAt: side.liveAssistantCreatedAt ?? new Date().toISOString(),
      text: nextLiveAssistant
    }
    nextBlocks = upsertSideTimelineBlock(nextBlocks, block)
    nextLiveAssistant = ''
  }
  if (nextBlocks === side.blocks) return { side, blocks: nextBlocks }
  return {
    side: {
      ...side,
      blocks: nextBlocks,
      liveReasoning: nextLiveReasoning,
      liveAssistant: nextLiveAssistant,
      liveReasoningItemId: undefined,
      liveReasoningTurnId: undefined,
      liveReasoningCreatedAt: undefined,
      liveAssistantItemId: undefined,
      liveAssistantTurnId: undefined,
      liveAssistantCreatedAt: undefined
    },
    blocks: nextBlocks
  }
}

function upsertSideTimelineBlock(blocks: ChatBlock[], incoming: ChatBlock): ChatBlock[] {
  const index = blocks.findIndex(
    (block) => block.kind === incoming.kind && block.id === incoming.id
  )
  if (index < 0) return [...blocks, incoming]
  const current = blocks[index]
  if (
    (
      (current.kind === 'assistant' && incoming.kind === 'assistant') ||
      (current.kind === 'reasoning' && incoming.kind === 'reasoning')
    ) &&
    current.turnId === incoming.turnId &&
    current.createdAt === incoming.createdAt &&
    current.text === incoming.text
  ) return blocks
  const next = [...blocks]
  next[index] = incoming
  return next
}

function buildSideSink(sideId: string, ctx: SideContext, sinceSeq = 0): ThreadEventSink {
  // Replayed or re-delivered deltas duplicate text already on screen;
  // drop anything at or below the subscription's replay floor.
  let appliedDeltaSeqFloor = sinceSeq
  return {
    onSeq: (seq) => {
      ctx.set((s) => patchSide(s, sideId, (side) => ({ ...side, lastSeq: Math.max(side.lastSeq, seq) })))
    },
    onUserMessage: (ev) => {
      ctx.set((s) =>
        patchSide(s, sideId, (side) => {
          const flushed = flushSideLiveBlocks(side)
          const blocks = upsertUserBlock(flushed.blocks, ev)
          return {
            ...flushed.side,
            blocks,
            busy: true,
            turnId: ev.turnId ?? side.turnId,
            userItemId: ev.itemId
          }
        })
      )
    },
    onDeltas: (rawDeltas) => {
      const deltas: typeof rawDeltas = []
      for (const delta of rawDeltas) {
        if (delta.threadId && delta.threadId !== sideId) continue
        if (typeof delta.seq === 'number') {
          if (delta.seq <= appliedDeltaSeqFloor) continue
          appliedDeltaSeqFloor = delta.seq
        }
        deltas.push(delta)
      }
      if (deltas.length === 0) return
      ctx.set((s) =>
        patchSide(s, sideId, (side) => {
          const seqs = deltas
            .map((delta) => delta.seq)
            .filter((value): value is number => typeof value === 'number')
          const lastSeq = seqs.length > 0 ? Math.max(side.lastSeq, ...seqs) : side.lastSeq
          let liveReasoning = side.liveReasoning
          let liveReasoningItemId = side.liveReasoningItemId
          let liveReasoningTurnId = side.liveReasoningTurnId
          let liveReasoningCreatedAt = side.liveReasoningCreatedAt
          let liveAssistant = side.liveAssistant
          let liveAssistantItemId = side.liveAssistantItemId
          let liveAssistantTurnId = side.liveAssistantTurnId
          let liveAssistantCreatedAt = side.liveAssistantCreatedAt
          let blocks = side.blocks
          for (const delta of deltas) {
            if (delta.kind === 'agent_reasoning') {
              if (delta.itemId && liveReasoningItemId && delta.itemId !== liveReasoningItemId) {
                if (liveReasoning.trim()) {
                  blocks = upsertSideTimelineBlock(blocks, {
                    kind: 'reasoning',
                    id: liveReasoningItemId,
                    turnId: liveReasoningTurnId,
                    createdAt: liveReasoningCreatedAt,
                    text: liveReasoning
                  })
                }
                liveReasoning = ''
              }
              liveReasoningItemId = delta.itemId ?? liveReasoningItemId
              liveReasoningTurnId = delta.turnId ?? liveReasoningTurnId ?? side.turnId ?? undefined
              liveReasoningCreatedAt = delta.createdAt ?? liveReasoningCreatedAt
              liveReasoning += delta.text
            } else {
              if (delta.itemId && liveAssistantItemId && delta.itemId !== liveAssistantItemId) {
                if (liveAssistant.trim()) {
                  blocks = upsertSideTimelineBlock(blocks, {
                    kind: 'assistant',
                    id: liveAssistantItemId,
                    turnId: liveAssistantTurnId,
                    createdAt: liveAssistantCreatedAt,
                    text: liveAssistant
                  })
                }
                liveAssistant = ''
              }
              liveAssistantItemId = delta.itemId ?? liveAssistantItemId
              liveAssistantTurnId = delta.turnId ?? liveAssistantTurnId ?? side.turnId ?? undefined
              liveAssistantCreatedAt = delta.createdAt ?? liveAssistantCreatedAt
              liveAssistant += delta.text
            }
          }
          return {
            ...side,
            blocks,
            lastSeq,
            liveReasoning,
            liveReasoningItemId,
            liveReasoningTurnId,
            liveReasoningCreatedAt,
            liveAssistant,
            liveAssistantItemId,
            liveAssistantTurnId,
            liveAssistantCreatedAt,
            busy: true
          }
        })
      )
    },
    onAssistantItem: (item) => {
      if (item.threadId !== sideId) return
      ctx.set((s) =>
        patchSide(s, sideId, (side) => {
          const block: ChatBlock = item.kind === 'agent_message'
            ? {
                kind: 'assistant',
                id: item.itemId,
                turnId: item.turnId,
                createdAt: item.createdAt,
                text: item.text
              }
            : {
                kind: 'reasoning',
                id: item.itemId,
                turnId: item.turnId,
                createdAt: item.createdAt,
                text: item.text
              }
          const next = { ...side, blocks: upsertSideTimelineBlock(side.blocks, block) }
          if (item.kind === 'agent_message' && side.liveAssistantItemId === item.itemId) {
            next.liveAssistant = ''
            next.liveAssistantItemId = undefined
            next.liveAssistantTurnId = undefined
            next.liveAssistantCreatedAt = undefined
          }
          if (item.kind === 'agent_reasoning' && side.liveReasoningItemId === item.itemId) {
            next.liveReasoning = ''
            next.liveReasoningItemId = undefined
            next.liveReasoningTurnId = undefined
            next.liveReasoningCreatedAt = undefined
          }
          return next
        })
      )
    },
    onTool: (ev: ToolEventPayload) => {
      ctx.set((s) =>
        patchSide(s, sideId, (side) => {
          const idx = side.blocks.findIndex((b) => b.kind === 'tool' && b.id === ev.itemId)
          let blocks: ChatBlock[]
          if (idx >= 0) {
            const cur = side.blocks[idx]
            if (cur.kind !== 'tool') return side
            const next: ToolBlock = {
              ...cur,
              turnId: ev.turnId ?? cur.turnId,
              summary: ev.summary || cur.summary,
              status: ev.status,
              toolKind: ev.toolKind ?? cur.toolKind,
              detail: ev.detail ?? cur.detail,
              filePath: ev.filePath ?? cur.filePath,
              meta: ev.meta ?? cur.meta
            }
            blocks = [...side.blocks]
            blocks[idx] = next
          } else {
            const block: ToolBlock = {
              kind: 'tool',
              id: ev.itemId,
              turnId: ev.turnId,
              createdAt: ev.createdAt ?? new Date().toISOString(),
              summary: ev.summary,
              status: ev.status,
              toolKind: ev.toolKind,
              detail: ev.detail,
              filePath: ev.filePath,
              meta: ev.meta
            }
            blocks = [...side.blocks, block]
          }
          return { ...side, blocks, busy: true }
        })
      )
    },
    onCompaction: (ev) => {
      ctx.set((s) =>
        patchSide(s, sideId, (side) => {
          const index = side.blocks.findIndex(
            (block) => block.kind === 'compaction' && block.id === ev.itemId
          )
          const current = index >= 0 ? side.blocks[index] : undefined
          const block: CompactionBlock = {
            kind: 'compaction',
            id: ev.itemId,
            turnId: ev.turnId,
            createdAt: current?.kind === 'compaction'
              ? current.createdAt
              : ev.createdAt ?? new Date().toISOString(),
            summary: ev.summary || (current?.kind === 'compaction' ? current.summary : ''),
            status: ev.status,
            detail: ev.detail ?? (current?.kind === 'compaction' ? current.detail : undefined),
            auto: ev.auto ?? (current?.kind === 'compaction' ? current.auto : undefined),
            messagesBefore: ev.messagesBefore ?? (current?.kind === 'compaction' ? current.messagesBefore : undefined),
            messagesAfter: ev.messagesAfter ?? (current?.kind === 'compaction' ? current.messagesAfter : undefined)
          }
          const blocks = [...side.blocks]
          if (index >= 0) blocks[index] = block
          else blocks.push(block)
          return { ...side, blocks }
        })
      )
    },
    onApproval: (req) => {
      ctx.set((s) =>
        patchSide(s, sideId, (side) => ({
          ...side,
          blocks: [
            ...side.blocks,
            {
              kind: 'approval',
              id: `approval-${req.approvalId}`,
              turnId: req.turnId,
              createdAt: req.createdAt ?? new Date().toISOString(),
              approvalId: req.approvalId,
              summary: req.summary,
              toolName: req.toolName,
              status: 'pending',
              ...(req.meta ? { meta: req.meta } : {})
            }
          ]
        }))
      )
    },
    onApprovalStatus: (ev) => {
      ctx.set((s) =>
        patchSide(s, sideId, (side) => ({
          ...side,
          blocks: side.blocks.map((block) =>
            block.kind === 'approval' && block.approvalId === ev.approvalId
              ? {
                  ...block,
                  status: ev.status,
                  errorMessage: ev.errorMessage ?? block.errorMessage
                }
              : block
          )
        }))
      )
    },
    onApprovalReview: (ev) => {
      ctx.set((s) =>
        patchSide(s, sideId, (side) => {
          const id = `approval-review-${ev.reviewId}`
          const current = side.blocks.find(
            (block): block is Extract<ChatBlock, { kind: 'approval_review' }> =>
              block.kind === 'approval_review' && block.reviewId === ev.reviewId
          )
          return {
            ...side,
            blocks: upsertSideTimelineBlock(side.blocks, {
              kind: 'approval_review',
              id,
              reviewId: ev.reviewId,
              approvalId: ev.approvalId,
              turnId: ev.turnId ?? current?.turnId,
              createdAt: current?.createdAt ?? ev.createdAt ?? new Date().toISOString(),
              summary: ev.summary || current?.summary || 'Tool action',
              toolName: ev.toolName ?? current?.toolName,
              status: ev.status,
              decision: ev.decision ?? current?.decision,
              riskLevel: ev.riskLevel ?? current?.riskLevel,
              rationale: ev.rationale ?? current?.rationale
            })
          }
        })
      )
    },
    onUserInput: (req) => {
      ctx.set((s) =>
        patchSide(s, sideId, (side) => ({
          ...side,
          blocks: [
            ...side.blocks,
            {
              kind: 'user_input',
              id: req.itemId,
              turnId: req.turnId,
              createdAt: req.createdAt ?? new Date().toISOString(),
              requestId: req.requestId,
              questions: req.questions,
              status: 'pending',
              live: true
            }
          ]
        }))
      )
    },
    onUserInputStatus: (ev) => {
      ctx.set((s) =>
        patchSide(s, sideId, (side) => ({
          ...side,
          blocks: side.blocks.map((block) =>
            block.kind === 'user_input' && block.id === ev.itemId
              ? {
                  ...block,
                  status: ev.status,
                  live: false,
                  ...(ev.answers ? { answers: ev.answers } : {})
                }
              : block
          )
        }))
      )
    },
    onGoal: () => {
      // Side conversations do not render goal chips yet.
    },
    onTodos: () => {
      // Side conversations do not render runtime todo chips yet.
    },
    onTurnComplete: () => {
      const completedTurnId = ctx.get().sideConversations[sideId]?.turnId
      ctx.set((s) =>
        patchSide(s, sideId, (side) => {
          const flushed = flushSideLiveBlocks(side)
          return { ...flushed.side, busy: false, turnId: null }
        })
      )
      void reconcileCompletedSideTurn(sideId, completedTurnId, ctx)
    },
    onError: (err, options) => {
      const completedTurnId = ctx.get().sideConversations[sideId]?.turnId
      ctx.set((s) =>
        patchSide(s, sideId, (side) => ({
          ...side,
          busy: false,
          error: ctx.formatRuntimeError(err)
        }))
      )
      if (options?.terminal) void reconcileCompletedSideTurn(sideId, completedTurnId, ctx)
    },
    onUsage: (usage) => {
      // Side usage is reported only to keep lastSeq cursors consistent;
      // a per-thread usage counter can be wired here in the future.
      void usage
    }
  }
}

async function reconcileCompletedSideTurn(
  sideId: string,
  completedTurnId: string | null | undefined,
  ctx: SideContext
): Promise<void> {
  try {
    const detail = await ctx.getProvider().getThreadDetail(sideId)
    ctx.set((state) =>
      patchSide(state, sideId, (side) => {
        if (side.busy || side.turnId) return side
        const hasCompletedTurn = !completedTurnId || detail.blocks.some(
          (block) => block.turnId === completedTurnId
        )
        if (!hasCompletedTurn) return side
        return {
          ...side,
          blocks: detail.blocks,
          lastSeq: Math.max(side.lastSeq, detail.latestSeq),
          liveReasoning: '',
          liveAssistant: '',
          liveReasoningItemId: undefined,
          liveReasoningTurnId: undefined,
          liveReasoningCreatedAt: undefined,
          liveAssistantItemId: undefined,
          liveAssistantTurnId: undefined,
          liveAssistantCreatedAt: undefined
        }
      })
    )
  } catch {
    // The live projection remains visible; the next side-thread reload retries
    // from the persisted runtime snapshot.
  }
}

function teardownSideSubscription(sideId: string): void {
  const ac = sideAbortControllers.get(sideId)
  if (ac) {
    ac.abort()
    sideAbortControllers.delete(sideId)
  }
}

function startSideSubscription(sideId: string, sinceSeq: number, ctx: SideContext): void {
  teardownSideSubscription(sideId)
  const ac = new AbortController()
  sideAbortControllers.set(sideId, ac)
  const sink = buildSideSink(sideId, ctx, sinceSeq)
  const provider = ctx.getProvider()
  void provider.subscribeThreadEvents(sideId, sinceSeq, sink, ac.signal)
}

export function createSideActions(ctx: SideContext): Pick<
  ChatState,
  | 'spawnSideConversation'
  | 'openSideConversationDraft'
  | 'sendSideMessage'
  | 'interruptSide'
  | 'resolveSideUserInput'
  | 'setSideInput'
  | 'setSideModel'
  | 'setSideReasoningEffort'
  | 'setSideFastMode'
  | 'setSideAttachments'
  | 'selectSideConversation'
  | 'setSidePanelOpen'
  | 'closeSideConversation'
  | 'discardSideConversation'
  | 'promoteSideConversation'
> {
  const actions: Pick<
    ChatState,
    | 'spawnSideConversation'
    | 'openSideConversationDraft'
    | 'sendSideMessage'
    | 'interruptSide'
    | 'resolveSideUserInput'
    | 'setSideInput'
    | 'setSideModel'
    | 'setSideReasoningEffort'
    | 'setSideFastMode'
    | 'setSideAttachments'
    | 'selectSideConversation'
    | 'setSidePanelOpen'
    | 'closeSideConversation'
    | 'discardSideConversation'
    | 'promoteSideConversation'
  > = {
    spawnSideConversation: async (seedText, options?: SideConversationDraftOptions) => {
      const state = ctx.get()
      const parentId = state.activeThreadId
      if (!parentId) {
        ctx.set({ error: ctx.t('common:sideConversationNeedsActiveThread') })
        return null
      }
      if (state.runtimeConnection !== 'ready') {
        ctx.set({ error: ctx.t('common:runtimeActionNeedsConnection') })
        return null
      }
      const provider = ctx.getProvider()
      if (typeof provider.forkThread !== 'function') {
        ctx.set({ error: ctx.t('common:runtimeFeatureUnsupported') })
        return null
      }
      const parentThread = state.threads.find((thread) => thread.id === parentId)
      const title = defaultSideTitle(parentThread?.title ?? '', parentId)
      let forked
      try {
        forked = await provider.forkThread(parentId, { relation: 'side', title })
      } catch (e) {
        ctx.set({
          error: ctx.formatRuntimeError(e),
          ...(ctx.shouldOpenSettingsForError(e)
            ? { route: 'settings' as const, settingsSection: 'agents' as const }
            : {})
        })
        return null
      }
      const now = new Date().toISOString()
      const inheritedAt = new Date().toISOString()
      const draftModel = options?.model?.trim() || defaultSideModel(state, parentId)
      const draftProviderId =
        options && Object.prototype.hasOwnProperty.call(options, 'providerId')
          ? options.providerId?.trim() ?? ''
          : defaultSideProviderId(state, parentId, draftModel)
      const draftReasoningEffort =
        sideReasoningEffortRequestValue(options?.reasoningEffort ?? '') ?? 'max'
      const side: SideConversation = {
        threadId: forked.id,
        parentThreadId: parentId,
        title: forked.title ?? title,
        createdAt: now,
        inheritedAt,
        blocks: [],
        liveReasoning: '',
        liveAssistant: '',
        lastSeq: 0,
        input: '',
        model: draftModel,
        providerId: draftProviderId,
        reasoningEffort: draftReasoningEffort,
        fastMode: options?.fastMode ?? state.composerFastMode,
        attachments: [...(options?.attachments ?? [])],
        busy: false,
        turnId: null,
        userItemId: null,
        error: null
      }
      ctx.set((s) => ({
        sideConversations: { ...s.sideConversations, [forked.id]: side },
        sidePanel: setSidePanel(s.sidePanel, { open: true, activeSideId: forked.id })
      }))
      // Start a dedicated SSE subscription for this side thread. The
      // main `activeThreadId` and main subscription are untouched.
      startSideSubscription(forked.id, 0, ctx)
      if (seedText?.trim() || side.attachments.length > 0) {
        // Call the side action directly through the closure we are
        // currently building so store-level `state.sendSideMessage`
        // shims (e.g. test harnesses) cannot swallow the seed send.
        const started = await actions.sendSideMessage(forked.id, seedText?.trim() ?? '')
        if (!started) return forked.id
      }
      return forked.id
    },

    openSideConversationDraft: () => {
      ctx.set((s) => ({
        sidePanel: setSidePanel(s.sidePanel, { open: true, activeSideId: null })
      }))
    },

    sendSideMessage: async (sideId, text) => {
      const state = ctx.get()
      const side = state.sideConversations[sideId]
      if (!side) return false
      if (side.busy) return false
      const trimmed = text.trim()
      const attachmentIds = side.attachments
        .map((attachment) => attachment.id.trim())
        .filter(Boolean)
      if (!trimmed && attachmentIds.length === 0) return false
      const provider = ctx.getProvider()
      const reasoningEffort = sideReasoningEffortRequestValue(side.reasoningEffort)
      const providerId = side.providerId.trim()
      const accountId = accountIdForComposerSelection(
        state.composerModelGroups,
        providerId,
        side.model
      )
      const serviceTier = serviceTierForComposerSelection(
        side.fastMode,
        state.composerModelGroups,
        side.model,
        providerId
      )
      try {
        const { turnId } = await provider.sendUserMessage(sideId, trimmed, {
          model: side.model,
          ...(providerId ? { providerId } : {}),
          ...(accountId ? { accountId } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
          ...(serviceTier ? { serviceTier } : {}),
          ...(attachmentIds.length ? { attachmentIds } : {})
        })
        ctx.set((s) =>
          patchSide(s, sideId, (cur) => ({
            ...cur,
            input: '',
            attachments: cur.attachments.filter(
              (attachment) => !attachmentIds.includes(attachment.id.trim())
            ),
            busy: true,
            turnId,
            error: null
          }))
        )
        // Re-attach the subscription from the last seen seq so we don't
        // miss items emitted between the previous reconnect and the new
        // turn creation.
        startSideSubscription(sideId, side.lastSeq, ctx)
        return true
      } catch (e) {
        ctx.set((s) =>
          patchSide(s, sideId, (cur) => ({
            ...cur,
            error: ctx.formatRuntimeError(e)
          }))
        )
        return false
      }
    },

    interruptSide: async (sideId) => {
      const state = ctx.get()
      const side = state.sideConversations[sideId]
      if (!side || !side.turnId) return
      const provider = ctx.getProvider()
      try {
        await provider.interruptTurn(sideId, side.turnId)
        ctx.set((s) => patchSide(s, sideId, (cur) => ({ ...cur, busy: false })))
      } catch (e) {
        ctx.set((s) =>
          patchSide(s, sideId, (cur) => ({
            ...cur,
            error: ctx.formatRuntimeError(e)
          }))
        )
      }
    },

    resolveSideUserInput: async (sideId, blockId, action) => {
      const side = ctx.get().sideConversations[sideId]
      const block = side?.blocks.find((candidate) => candidate.id === blockId)
      if (
        !side ||
        !block ||
        block.kind !== 'user_input' ||
        block.status !== 'pending' ||
        block.live !== true
      ) {
        return
      }

      const provider = ctx.getProvider()
      try {
        if (action.kind === 'submit') {
          if (typeof provider.submitUserInputResponse !== 'function') {
            throw new Error(ctx.t('common:runtimeUserInputUnsupported'))
          }
          await provider.submitUserInputResponse(block.requestId, action.answers)
          ctx.set((state) =>
            patchSide(state, sideId, (current) => ({
              ...current,
              blocks: current.blocks.map((candidate) =>
                candidate.id === blockId && candidate.kind === 'user_input'
                  ? {
                      ...candidate,
                      status: 'submitted',
                      answers: action.answers,
                      live: false,
                      errorMessage: undefined
                    }
                  : candidate
              )
            }))
          )
          return
        }

        if (typeof provider.cancelUserInput !== 'function') {
          throw new Error(ctx.t('common:runtimeUserInputUnsupported'))
        }
        await provider.cancelUserInput(block.requestId)
        ctx.set((state) =>
          patchSide(state, sideId, (current) => ({
            ...current,
            blocks: current.blocks.map((candidate) =>
              candidate.id === blockId && candidate.kind === 'user_input'
                ? {
                    ...candidate,
                    status: 'cancelled',
                    live: false,
                    errorMessage: undefined
                  }
                : candidate
            )
          }))
        )
      } catch (error) {
        const message = ctx.formatRuntimeError(error)
        void window.kunGui?.logError?.('side-user-input', 'Failed to resolve side user input', {
          message,
          sideId,
          blockId
        }).catch(() => undefined)
        ctx.set((state) =>
          patchSide(state, sideId, (current) => ({
            ...current,
            error: message,
            blocks: current.blocks.map((candidate) =>
              candidate.id === blockId && candidate.kind === 'user_input'
                ? {
                    ...candidate,
                    status: 'error',
                    live: false,
                    errorMessage: message,
                    ...(action.kind === 'submit' ? { answers: action.answers } : {})
                  }
                : candidate
            )
          }))
        )
      }
    },

    setSideInput: (sideId, text) => {
      ctx.set((s) => patchSide(s, sideId, (cur) => ({ ...cur, input: text })))
    },

    setSideModel: (sideId, model, providerId) => {
      ctx.set((s) =>
        patchSide(s, sideId, (cur) => ({
          ...cur,
          model,
          providerId: providerId?.trim() ?? ''
        }))
      )
    },

    setSideReasoningEffort: (sideId, effort) => {
      ctx.set((s) => patchSide(s, sideId, (cur) => ({ ...cur, reasoningEffort: effort })))
    },

    setSideFastMode: (sideId, enabled) => {
      ctx.set((s) => patchSide(s, sideId, (cur) => ({ ...cur, fastMode: enabled })))
    },

    setSideAttachments: (sideId, attachments) => {
      ctx.set((s) => patchSide(s, sideId, (cur) => ({ ...cur, attachments: [...attachments] })))
    },

    selectSideConversation: (sideId) => {
      ctx.set((s) => {
        if (!s.sideConversations[sideId]) return {}
        return { sidePanel: setSidePanel(s.sidePanel, { activeSideId: sideId, open: true }) }
      })
    },

    setSidePanelOpen: (open) => {
      ctx.set((s) => ({ sidePanel: setSidePanel(s.sidePanel, { open }) }))
    },

    closeSideConversation: async (sideId) => {
      const state = ctx.get()
      const closingSide = state.sideConversations[sideId] ?? null
      teardownSideSubscription(sideId)
      ctx.set((s) => {
        const next = { ...s.sideConversations }
        delete next[sideId]
        const nextActiveId =
          s.sidePanel.activeSideId === sideId && closingSide
            ? Object.values(next).find((side) => side.parentThreadId === closingSide.parentThreadId)?.threadId ?? null
            : s.sidePanel.activeSideId
        const nextPanel: SidePanelState = {
          open: nextActiveId ? s.sidePanel.open : false,
          activeSideId: nextActiveId
        }
        return { sideConversations: next, sidePanel: nextPanel }
      })
    },

    discardSideConversation: async (sideId) => {
      const state = ctx.get()
      const side = state.sideConversations[sideId]
      teardownSideSubscription(sideId)
      ctx.set((s) => {
        const next = { ...s.sideConversations }
        delete next[sideId]
        const nextActiveId =
          s.sidePanel.activeSideId === sideId && side
            ? Object.values(next).find((candidate) => candidate.parentThreadId === side.parentThreadId)?.threadId ?? null
            : s.sidePanel.activeSideId
        const nextPanel: SidePanelState = {
          open: nextActiveId ? s.sidePanel.open : false,
          activeSideId: nextActiveId
        }
        return { sideConversations: next, sidePanel: nextPanel }
      })
      if (side) {
        const provider = ctx.getProvider()
        try {
          await provider.deleteThread(sideId)
        } catch (e) {
          ctx.set({
            error: ctx.formatRuntimeError(e),
            ...(ctx.shouldOpenSettingsForError(e)
              ? { route: 'settings' as const, settingsSection: 'agents' as const }
              : {})
          })
        }
      }
    },

    promoteSideConversation: async (sideId) => {
      const state = ctx.get()
      const side = state.sideConversations[sideId]
      if (!side) return
      // Use the provider's renameThread surface to clear the relation by
      // PATCHing the thread. The HTTP client encodes relation='primary'
      // as a generic runtimeRequest body — we use a direct request here
      // because the rename surface is title-only.
      try {
        const response = await window.kunGui.runtimeRequest(
          `/v1/threads/${encodeURIComponent(sideId)}`,
          'PATCH',
          JSON.stringify({ relation: 'primary' })
        )
        if (!response.ok) {
          ctx.set({ error: ctx.formatRuntimeError(new Error(response.body || 'promote failed')) })
          return
        }
      } catch (e) {
        ctx.set({ error: ctx.formatRuntimeError(e) })
        return
      }
      await ctx.get().refreshThreads()
      // Closing is a structural teardown; call directly so a stubbed
      // `state.closeSideConversation` (e.g. in tests) cannot swallow it.
      await actions.closeSideConversation(sideId)
    }
  }
  return actions
}

/**
 * Internal helper: tear down all side subscriptions. Used by the
 * `boot`/`unmount` path to avoid dangling SSE streams on app shutdown.
 */
export function teardownAllSideSubscriptions(): void {
  for (const ac of sideAbortControllers.values()) ac.abort()
  sideAbortControllers.clear()
}
