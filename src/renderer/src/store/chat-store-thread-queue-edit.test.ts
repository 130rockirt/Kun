import { describe, expect, it, vi } from 'vitest'
import type { ChatState, ChatStoreGet, ChatStoreSet } from './chat-store-types'
import { createThreadQueueActions } from './chat-store-thread-queue-actions'
import type {
  StoreActionContext,
  ThreadActionRuntime
} from './chat-store-thread-actions-support'

describe('chat store queued message edit', () => {
  it('persists an accepted same-id edit and leaves rejected rows untouched', () => {
    let state = {
      queuedMessages: [
        {
          id: 'q-edit',
          text: 'before',
          clientRequestId: 'request-stable',
          model: 'gpt-5.6-sol',
          backgroundRuntimeText: 'derived-before'
        },
        { id: 'q-plan', text: 'internal', displayText: 'visible', mode: 'plan' }
      ]
    } as ChatState
    const set: ChatStoreSet = (partial) => {
      const update = typeof partial === 'function' ? partial(state) : partial
      state = { ...state, ...update }
    }
    const get: ChatStoreGet = () => state
    const persistActiveQueuedMessages = vi.fn()
    const actions = createThreadQueueActions(
      { set, get, sseAbortRef: { current: null } } as StoreActionContext,
      { persistActiveQueuedMessages } as unknown as ThreadActionRuntime
    )

    expect(actions.editQueuedMessage('q-edit', ' after ')).toBe(true)
    expect(state.queuedMessages).toEqual([
      expect.objectContaining({
        id: 'q-edit',
        text: 'after',
        clientRequestId: expect.stringMatching(/^turn_/),
        model: 'gpt-5.6-sol'
      }),
      expect.objectContaining({ id: 'q-plan', text: 'internal', displayText: 'visible' })
    ])
    expect(state.queuedMessages[0]).not.toHaveProperty('backgroundRuntimeText')
    expect(state.queuedMessages[0]?.clientRequestId).not.toBe('request-stable')
    expect(persistActiveQueuedMessages).toHaveBeenCalledOnce()

    expect(actions.editQueuedMessage('q-plan', 'changed')).toBe(false)
    expect(actions.editQueuedMessage('missing', 'changed')).toBe(false)
    expect(persistActiveQueuedMessages).toHaveBeenCalledOnce()
  })

  it('retains a failed provisional admission instead of retrying it into deletion', async () => {
    let state = {
      busy: false,
      error: null,
      queuedMessages: [{
        id: 'q-provisional',
        text: 'create the first design document',
        clientRequestId: 'request-settled',
        waitForRuntimeAdmission: true,
        deliveryState: 'failed' as const
      }]
    } as ChatState
    const set: ChatStoreSet = (partial) => {
      const update = typeof partial === 'function' ? partial(state) : partial
      state = { ...state, ...update }
    }
    const get: ChatStoreGet = () => state
    const persistActiveQueuedMessages = vi.fn()
    const actions = createThreadQueueActions(
      { set, get, sseAbortRef: { current: null } } as StoreActionContext,
      { persistActiveQueuedMessages } as unknown as ThreadActionRuntime
    )

    await expect(actions.guideQueuedMessage('q-provisional')).resolves.toBe(false)
    expect(state.queuedMessages).toEqual([
      expect.objectContaining({
        id: 'q-provisional',
        deliveryState: 'failed',
        waitForRuntimeAdmission: true
      })
    ])
    expect(state.error).toBeTruthy()
    expect(persistActiveQueuedMessages).not.toHaveBeenCalled()
  })
})
