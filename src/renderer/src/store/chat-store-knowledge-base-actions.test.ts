import { describe, expect, it, vi } from 'vitest'
import type { AgentProvider } from '../agent/types'
import type { ChatState, ChatStoreSet } from './chat-store-types'
import { createKnowledgeBaseActions } from './chat-store-knowledge-base-actions'

function harness(options: { busy?: boolean; status?: string } = {}) {
  const mount = {
    id: 'kb_docs', root: '/tmp/docs', name: 'Docs',
    source: 'write-workspace' as const, access: 'read-only' as const
  }
  const updateThreadKnowledgeBases = vi.fn(async () => ({
    id: 'thr_1', title: 'Task', model: 'm', mode: 'agent', updatedAt: 'now',
    status: 'idle', knowledgeBases: [mount]
  }))
  const getThreadKnowledgeBases = vi.fn(async () => ({
    mounts: [mount],
    statuses: [{ id: mount.id, state: 'ready' as const, documentCount: 1, nodeCount: 3 }]
  }))
  const provider = { updateThreadKnowledgeBases, getThreadKnowledgeBases } as unknown as AgentProvider
  let state = {
    activeThreadId: 'thr_1',
    busy: options.busy ?? false,
    error: null,
    threads: [{
      id: 'thr_1', title: 'Task', model: 'm', mode: 'agent', updatedAt: 'old',
      status: options.status ?? 'idle', knowledgeBases: []
    }],
    knowledgeBaseStatuses: {}
  } as unknown as ChatState
  const set: ChatStoreSet = (partial) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    state = { ...state, ...patch }
  }
  const actions = createKnowledgeBaseActions({ set, get: () => state, getProvider: () => provider })
  state = { ...state, ...actions }
  return { actions, mount, updateThreadKnowledgeBases, get state() { return state } }
}

describe('knowledge-base store actions', () => {
  it('persists mounts and refreshes index statuses', async () => {
    const test = harness()
    expect(await test.actions.setThreadKnowledgeBases('thr_1', [test.mount])).toBe(true)
    expect(test.updateThreadKnowledgeBases).toHaveBeenCalledWith('thr_1', [test.mount])
    expect(test.state.threads[0]?.knowledgeBases).toEqual([test.mount])
    expect(test.state.knowledgeBaseStatuses.thr_1?.[0]).toMatchObject({ state: 'ready' })
  })

  it('blocks mount mutation while the active task is running', async () => {
    const test = harness({ busy: true, status: 'running' })
    expect(await test.actions.setThreadKnowledgeBases('thr_1', [test.mount])).toBe(false)
    expect(test.updateThreadKnowledgeBases).not.toHaveBeenCalled()
    expect(test.state.error).toMatch(/cannot be changed/i)
  })
})
