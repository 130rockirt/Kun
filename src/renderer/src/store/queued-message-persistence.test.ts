import { describe, expect, it } from 'vitest'
import type { BrowserStorageLike } from '../lib/browser-storage'
import {
  emptyQueuedMessageRegistry,
  forgetQueuedMessagesForThread,
  queuedMessagesForThread,
  readQueuedMessageRegistry,
  reconcileQueuedMessages,
  saveQueuedMessagesForThread
} from './queued-message-persistence'

class MemoryStorage implements BrowserStorageLike {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

describe('queued-message-persistence', () => {
  it('restores pending messages independently for each thread', () => {
    const storage = new MemoryStorage()
    saveQueuedMessagesForThread('thread-a', [
      {
        id: 'q-1',
        text: 'finish the first change',
        clientRequestId: 'turn_client_1',
        deliveryState: 'pending',
        serviceTier: 'priority',
        fileReferences: [{
          path: '/workspace/src/App.tsx',
          relativePath: 'src/App.tsx',
          name: 'App.tsx'
        }]
      }
    ], storage)
    saveQueuedMessagesForThread('thread-b', [
      { id: 'q-2', text: 'review the result', deliveryState: 'pending' }
    ], storage)

    expect(queuedMessagesForThread('thread-a', storage)).toEqual([
      expect.objectContaining({
        id: 'q-1',
        text: 'finish the first change',
        clientRequestId: 'turn_client_1',
        deliveryState: 'pending',
        serviceTier: 'priority',
        fileReferences: [expect.objectContaining({ relativePath: 'src/App.tsx' })]
      })
    ])
    expect(queuedMessagesForThread('thread-b', storage)).toEqual([
      expect.objectContaining({ id: 'q-2', deliveryState: 'pending' })
    ])
  })

  it('keeps in-flight work while running and removes it only after the turn settles', () => {
    const inFlight = [{
      id: 'q-running',
      text: 'complete the queued task',
      deliveryState: 'in_flight' as const,
      deliveryTurnId: 'turn-2',
      deliveryUserMessageItemId: 'user-2'
    }]

    expect(reconcileQueuedMessages(inFlight, {
      busy: true,
      turnId: 'turn-2'
    })).toEqual(inFlight)
    expect(reconcileQueuedMessages(inFlight, {
      busy: false,
      turnId: null,
      blocks: [{ id: 'user-2', kind: 'user', text: 'complete the queued task' }]
    })).toEqual([])
  })

  it('requeues an in-flight marker when idle history has no proof it was accepted', () => {
    expect(reconcileQueuedMessages([{
      id: 'q-unconfirmed',
      text: 'retry safely',
      deliveryState: 'in_flight',
      deliveryTurnId: 'turn-missing',
      deliveryUserMessageItemId: 'user-missing'
    }], {
      busy: false,
      turnId: null,
      blocks: []
    })).toEqual([{
      id: 'q-unconfirmed',
      text: 'retry safely',
      deliveryState: 'pending'
    }])
  })

  it('returns an interrupted pre-send item to pending instead of losing it', () => {
    expect(reconcileQueuedMessages([{
      id: 'q-starting',
      text: 'do not lose me',
      deliveryState: 'starting'
    }], {
      busy: false,
      turnId: null
    })).toEqual([{
      id: 'q-starting',
      text: 'do not lose me',
      deliveryState: 'pending'
    }])
  })

  it('keeps paused messages across persistence and idle/running reconciliation', () => {
    const storage = new MemoryStorage()
    const paused = [{ id: 'q-paused', text: 'send later', deliveryState: 'paused' as const }]
    saveQueuedMessagesForThread('thread-a', paused, storage)

    expect(queuedMessagesForThread('thread-a', storage)).toEqual(paused)
    expect(reconcileQueuedMessages(paused, { busy: false, turnId: null })).toEqual(paused)
    expect(reconcileQueuedMessages(paused, { busy: true, turnId: 'turn-live' })).toEqual(paused)
  })

  it('does not treat paused messages as automatically sendable', async () => {
    const { isPendingQueuedMessage } = await import('./queued-message-persistence')
    expect(isPendingQueuedMessage({ id: 'q-paused', text: 'send later', deliveryState: 'paused' })).toBe(false)
  })

  it('forgets a deleted thread queue and ignores malformed storage', () => {
    const storage = new MemoryStorage()
    saveQueuedMessagesForThread('thread-a', [
      { id: 'q-1', text: 'pending', deliveryState: 'pending' }
    ], storage)
    forgetQueuedMessagesForThread('thread-a', storage)
    expect(readQueuedMessageRegistry(storage)).toEqual(emptyQueuedMessageRegistry())

    storage.setItem('kun.queuedMessages.v1', '{broken')
    expect(readQueuedMessageRegistry(storage)).toEqual(emptyQueuedMessageRegistry())
  })
})
