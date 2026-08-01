import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  syncSharedBusinessStorageOnce,
  type SharedBusinessStorageCursor
} from './shared-business-storage'

const DESIGN_REGISTRY_KEY = 'kun.design.threadRegistry.v1'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('shared business storage synchronization', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('pushes a Design registry written while the remote read is pending', async () => {
    const storage = new MemoryStorage()
    const oldRegistry = '{"version":1,"workspaces":{"old":{}}}'
    const newRegistry = '{"version":1,"workspaces":{"drawing-new":{}}}'
    storage.setItem(DESIGN_REGISTRY_KEY, oldRegistry)
    vi.stubGlobal('localStorage', storage)

    const pendingRead = deferred<{ revision: number; value: Record<string, string> }>()
    const write = vi.fn(async (_revision: number, value: Record<string, string>) => ({
      revision: 8,
      value
    }))
    const cursor: SharedBusinessStorageCursor = {
      baseline: { [DESIGN_REGISTRY_KEY]: oldRegistry },
      revision: 7
    }

    const syncing = syncSharedBusinessStorageOnce({
      read: () => pendingRead.promise,
      write
    }, cursor)
    storage.setItem(DESIGN_REGISTRY_KEY, newRegistry)
    pendingRead.resolve({
      revision: 7,
      value: { [DESIGN_REGISTRY_KEY]: oldRegistry }
    })

    const result = await syncing

    expect(write).toHaveBeenCalledWith(7, {
      [DESIGN_REGISTRY_KEY]: newRegistry
    })
    expect(storage.getItem(DESIGN_REGISTRY_KEY)).toBe(newRegistry)
    expect(result.baseline[DESIGN_REGISTRY_KEY]).toBe(newRegistry)
    expect(result.retry).toBe(false)
  })

  it('protects a newer local registry written while its previous value is being committed', async () => {
    const storage = new MemoryStorage()
    const remoteRegistry = '{"version":1,"workspaces":{}}'
    const firstLocalRegistry = '{"version":1,"workspaces":{"drawing-1":{}}}'
    const latestLocalRegistry = '{"version":1,"workspaces":{"drawing-2":{}}}'
    storage.setItem(DESIGN_REGISTRY_KEY, firstLocalRegistry)
    vi.stubGlobal('localStorage', storage)

    const pendingWrite = deferred<{ revision: number; value: Record<string, string> }>()
    const write = vi.fn(() => pendingWrite.promise)
    const syncing = syncSharedBusinessStorageOnce({
      read: vi.fn(async () => ({
        revision: 3,
        value: { [DESIGN_REGISTRY_KEY]: remoteRegistry }
      })),
      write
    }, {
      baseline: { [DESIGN_REGISTRY_KEY]: remoteRegistry },
      revision: 3
    })

    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce())
    storage.setItem(DESIGN_REGISTRY_KEY, latestLocalRegistry)
    pendingWrite.resolve({
      revision: 4,
      value: { [DESIGN_REGISTRY_KEY]: firstLocalRegistry }
    })

    const result = await syncing

    expect(storage.getItem(DESIGN_REGISTRY_KEY)).toBe(latestLocalRegistry)
    expect(result.baseline[DESIGN_REGISTRY_KEY]).toBe(firstLocalRegistry)
    expect(result.retry).toBe(true)
  })
})
