import { create } from 'zustand'
import { getProvider } from '../agent/registry'
import { rendererRuntimeClient } from '../agent/runtime-client'
import { type OpError } from './canvas/shape-ops'
import { applyShapeOpsFromText } from './canvas/apply-shape-ops'
import { focusViewportOnIds } from './canvas/canvas-focus'

export type DesignMessageBlock =
  | { kind: 'user'; id: string; text: string; createdAt: string }
  | { kind: 'assistant'; id: string; text: string; createdAt: string }

type DesignAssistantState = {
  designThreadId: string | null
  designBlocks: DesignMessageBlock[]
  designInput: string
  designBusy: boolean
  /** IDs the most-recent AI message touched. SelectionOverlay glows these for ~800ms. */
  lastAiAffectedIds: string[]
  /** Timestamp (ms since epoch) when the glow should start. null = no glow. */
  lastAiActionAt: number | null

  setDesignInput: (text: string) => void
  clearDesignConversation: () => void
  ensureDesignThread: (workspaceRoot: string) => Promise<string>
  sendDesignMessage: (
    text: string,
    prompt: string,
    workspaceRoot: string,
    opts?: { model?: string; reasoningEffort?: string }
  ) => Promise<void>
  appendBlock: (block: DesignMessageBlock) => void
  /** Parse an assistant message for design_canvas / legacy shapeops blocks and execute them. */
  applyAiShapeOps: (text: string) => { affectedIds: string[]; errors: OpError[] }
  /** Glow + camera-focus the shapes an AI turn just touched. Safe to call from any apply path. */
  markAiAffected: (ids: string[]) => void
}

const DESIGN_THREAD_KEY = 'kun.design-assistant.threadRegistry.v1'

function readDesignAssistantThreadId(workspaceRoot: string): string | null {
  try {
    const raw = localStorage.getItem(DESIGN_THREAD_KEY)
    if (!raw) return null
    const map = JSON.parse(raw) as Record<string, string>
    return map[workspaceRoot] ?? null
  } catch {
    return null
  }
}

function writeDesignAssistantThreadId(workspaceRoot: string, threadId: string): void {
  try {
    const raw = localStorage.getItem(DESIGN_THREAD_KEY)
    const map = raw ? (JSON.parse(raw) as Record<string, string>) : {}
    map[workspaceRoot] = threadId
    localStorage.setItem(DESIGN_THREAD_KEY, JSON.stringify(map))
  } catch {
    // non-fatal
  }
}

let nextBlockId = 0
function makeBlockId(): string {
  return `design-block-${++nextBlockId}`
}

export const useDesignAssistantStore = create<DesignAssistantState>((set, get) => ({
  designThreadId: null,
  designBlocks: [],
  designInput: '',
  designBusy: false,
  lastAiAffectedIds: [],
  lastAiActionAt: null,

  setDesignInput: (text) => set({ designInput: text }),

  clearDesignConversation: () =>
    set({
      designBlocks: [],
      designThreadId: null,
      designBusy: false,
      lastAiAffectedIds: [],
      lastAiActionAt: null
    }),

  appendBlock: (block) =>
    set((s) => ({ designBlocks: [...s.designBlocks, block] })),

  applyAiShapeOps: (text) => {
    const { affectedIds, errors } = applyShapeOpsFromText(text)
    if (affectedIds.length > 0) get().markAiAffected(affectedIds)
    return { affectedIds, errors }
  },

  markAiAffected: (ids) => {
    if (ids.length === 0) return
    set({ lastAiAffectedIds: ids, lastAiActionAt: Date.now() })
    focusViewportOnIds(ids)
  },

  ensureDesignThread: async (workspaceRoot) => {
    const existing = get().designThreadId
    if (existing) return existing

    const savedId = readDesignAssistantThreadId(workspaceRoot)
    if (savedId) {
      set({ designThreadId: savedId })
      return savedId
    }

    const provider = getProvider()
    const thread = await provider.createThread({
      workspace: workspaceRoot,
      title: 'Design Assistant',
      agentSurface: 'design'
    })
    const threadId = thread.id
    writeDesignAssistantThreadId(workspaceRoot, threadId)
    set({ designThreadId: threadId })
    return threadId
  },

  sendDesignMessage: async (text, prompt, workspaceRoot, opts) => {
    const state = get()
    if (state.designBusy) return

    set({ designBusy: true, designInput: '' })
    state.appendBlock({
      kind: 'user',
      id: makeBlockId(),
      text,
      createdAt: new Date().toISOString()
    })

    try {
      const threadId = await get().ensureDesignThread(workspaceRoot)
      const provider = getProvider()
      const model = opts?.model?.trim()
      const reasoningEffort = opts?.reasoningEffort?.trim()
      const { turnId } = await provider.sendUserMessage(threadId, prompt, {
        displayText: text,
        mode: 'agent',
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {})
      })

      const sseStreamId = `design-rail-${threadId}-${turnId}`
      const { streamId } = await rendererRuntimeClient.startSse(threadId, 0, sseStreamId, {
        acknowledgedBatches: true
      })

      let assistantText = ''
      const unsubscribe = rendererRuntimeClient.onSseEvent((payload) => {
        if (payload.streamId !== streamId) return
        try {
          for (const rawEvent of payload.events) {
            const event = rawEvent as { type?: string; delta?: string; text?: string }
            if (event.type === 'text_delta' && event.delta) {
              assistantText += event.delta
            } else if (event.type === 'turn_complete') {
              unsubscribe()
              rendererRuntimeClient.stopSse(streamId)
              get().appendBlock({
                kind: 'assistant',
                id: makeBlockId(),
                text: assistantText,
                createdAt: new Date().toISOString()
              })
              // Auto-apply ShapeOps blocks the AI emitted (round-trip without a manual step).
              try {
                get().applyAiShapeOps(assistantText)
              } catch {
                // ignore — the executor logs its own errors in result.errors
              }
              set({ designBusy: false })
            }
          }
        } finally {
          if (payload.batchId) void rendererRuntimeClient.ackSse(streamId, payload.batchId)
        }
      })
    } catch {
      set({ designBusy: false })
      get().appendBlock({
        kind: 'assistant',
        id: makeBlockId(),
        text: 'Failed to send design message.',
        createdAt: new Date().toISOString()
      })
    }
  }
}))
