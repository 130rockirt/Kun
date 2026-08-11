import type { AgentProvider } from '../agent/provider-types'
import type { KnowledgeBaseMount } from '../agent/types'
import type { ChatState, ChatStoreGet, ChatStoreSet } from './chat-store-types'

type KnowledgeBaseActionContext = {
  set: ChatStoreSet
  get: ChatStoreGet
  getProvider: () => AgentProvider
}

type KnowledgeBaseActions = Pick<
  ChatState,
  'setThreadKnowledgeBases' | 'refreshThreadKnowledgeBases' | 'reindexThreadKnowledgeBase'
>

export function createKnowledgeBaseActions({
  set,
  get,
  getProvider
}: KnowledgeBaseActionContext): KnowledgeBaseActions {
  return {
    setThreadKnowledgeBases: async (threadId, mounts) => {
      const thread = get().threads.find((candidate) => candidate.id === threadId)
      if (!thread) return false
      if (thread.status === 'running' || (get().activeThreadId === threadId && get().busy)) {
        set({ error: 'Knowledge bases cannot be changed while this task is running.' })
        return false
      }
      const update = getProvider().updateThreadKnowledgeBases
      if (!update) {
        set({ error: 'The active runtime does not support knowledge bases.' })
        return false
      }
      try {
        const updated = await update.call(getProvider(), threadId, mounts)
        set((state) => ({
          threads: state.threads.map((candidate) =>
            candidate.id === threadId ? { ...candidate, ...updated } : candidate
          ),
          error: null
        }))
        await get().refreshThreadKnowledgeBases(threadId)
        return true
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) })
        return false
      }
    },

    refreshThreadKnowledgeBases: async (threadId) => {
      const targetId = threadId ?? get().activeThreadId
      if (!targetId) return
      const read = getProvider().getThreadKnowledgeBases
      if (!read) return
      try {
        const result = await read.call(getProvider(), targetId)
        set((state) => ({
          threads: state.threads.map((thread) =>
            thread.id === targetId ? { ...thread, knowledgeBases: result.mounts } : thread
          ),
          knowledgeBaseStatuses: {
            ...state.knowledgeBaseStatuses,
            [targetId]: result.statuses
          }
        }))
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) })
      }
    },

    reindexThreadKnowledgeBase: async (threadId, knowledgeBaseId) => {
      const rebuild = getProvider().reindexThreadKnowledgeBase
      if (!rebuild) return false
      try {
        const next = await rebuild.call(getProvider(), threadId, knowledgeBaseId)
        set((state) => ({
          knowledgeBaseStatuses: {
            ...state.knowledgeBaseStatuses,
            [threadId]: [
              ...(state.knowledgeBaseStatuses[threadId] ?? []).filter((status) => status.id !== next.id),
              next
            ]
          },
          error: null
        }))
        return true
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) })
        return false
      }
    }
  }
}
