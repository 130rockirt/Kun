import { describe, expect, it, vi } from 'vitest'
import type { ChatState, ChatStoreGet, ChatStoreSet } from './chat-store-types'
import { createThreadQueueActions } from './chat-store-thread-queue-actions'
import type {
  StoreActionContext,
  ThreadActionRuntime
} from './chat-store-thread-actions-support'

describe('chat store queued message edit', () => {
  it('restores a plain pending message, persists the queue, and rejects ineligible rows', () => {
    let state = {
      queuedMessages: [
        { id: 'q-plain', text: 'before', deliveryState: 'pending' as const },
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

    expect(actions.restoreQueuedMessage('q-plain')).toEqual(
      expect.objectContaining({ id: 'q-plain', text: 'before' })
    )
    expect(state.queuedMessages).toEqual([
      { id: 'q-plan', text: 'internal', displayText: 'visible', mode: 'plan' }
    ])
    expect(persistActiveQueuedMessages).toHaveBeenCalledOnce()

    expect(actions.restoreQueuedMessage('q-plan')).toBeNull()
    expect(actions.restoreQueuedMessage('missing')).toBeNull()
    expect(persistActiveQueuedMessages).toHaveBeenCalledOnce()
  })

  it('restores an image-bearing queued message, persists the queue, and rejects ineligible rows', () => {
    const imageMessage = {
      id: 'q-image',
      text: 'inspect the screenshot',
      deliveryState: 'pending' as const,
      attachmentIds: ['attachment-1'],
      attachments: [{ id: 'attachment-1', kind: 'image' as const, name: 'shot.png' }]
    }
    let state = {
      queuedMessages: [imageMessage, { id: 'q-plan', text: 'internal', mode: 'plan' }]
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

    expect(actions.restoreQueuedMessage('q-image')).toEqual(imageMessage)
    expect(state.queuedMessages).toEqual([{ id: 'q-plan', text: 'internal', mode: 'plan' }])
    expect(persistActiveQueuedMessages).toHaveBeenCalledOnce()

    expect(actions.restoreQueuedMessage('q-plan')).toBeNull()
    expect(actions.restoreQueuedMessage('missing')).toBeNull()
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
