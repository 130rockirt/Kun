import { describe, expect, it, vi } from 'vitest'
import {
  AttachmentPreviewLoader,
  attachmentPreviewFailureStateForScope
} from './attachment-preview-loader'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

describe('AttachmentPreviewLoader', () => {
  it('shares one in-flight request across StrictMode-style duplicate loads', async () => {
    const gate = deferred<string>()
    const run = vi.fn(() => gate.promise)
    const loader = new AttachmentPreviewLoader()

    const first = loader.load('thread:attachment', run)
    const second = loader.load('thread:attachment', run)
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))

    gate.resolve('data:image/png;base64,first')
    await expect(Promise.all([first, second])).resolves.toEqual([
      'data:image/png;base64,first',
      'data:image/png;base64,first'
    ])
  })

  it('runs no more than two preview requests concurrently', async () => {
    const loader = new AttachmentPreviewLoader({ maxConcurrent: 2 })
    const gates = Array.from({ length: 6 }, () => deferred<void>())
    let active = 0
    let maximumActive = 0
    const requests = gates.map((gate, index) => loader.load(`attachment:${index}`, async () => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await gate.promise
      active -= 1
      return `preview-${index}`
    }))

    await vi.waitFor(() => expect(active).toBe(2))
    for (const gate of gates) gate.resolve()
    await expect(Promise.all(requests)).resolves.toHaveLength(6)
    expect(maximumActive).toBe(2)
  })

  it('returns cached previews and evicts least-recently-used entries by byte budget', async () => {
    const loader = new AttachmentPreviewLoader({ maxCacheBytes: 10 })
    const loadA = vi.fn(async () => 'aaaaaa')
    const loadB = vi.fn(async () => 'bbbbbb')

    await loader.load('a', loadA)
    await loader.load('b', loadB)
    await loader.load('b', loadB)
    await loader.load('a', loadA)

    expect(loadB).toHaveBeenCalledTimes(1)
    expect(loadA).toHaveBeenCalledTimes(2)
  })

  it('keeps failures within one scope and clears them when a thread switch changes scope', () => {
    const failed = {
      scopeKey: '["thread-a","/workspace/a"]',
      failedPreviewIds: { attachment: true as const }
    }

    expect(attachmentPreviewFailureStateForScope(failed, failed.scopeKey)).toBe(failed)
    expect(attachmentPreviewFailureStateForScope(failed, '["thread-b","/workspace/b"]')).toEqual({
      scopeKey: '["thread-b","/workspace/b"]',
      failedPreviewIds: {}
    })
    expect(attachmentPreviewFailureStateForScope(failed, '["thread-a","/workspace/a"]'))
      .toBe(failed)
  })

  it('does not permanently cache failed preview requests', async () => {
    const loader = new AttachmentPreviewLoader()
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('preview unavailable'))
      .mockResolvedValueOnce('data:image/png;base64,recovered')

    await expect(loader.load('attachment', run)).rejects.toThrow('preview unavailable')
    await expect(loader.load('attachment', run)).resolves.toBe('data:image/png;base64,recovered')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('reuses a successful preview after a failed request is retried on re-entry', async () => {
    const loader = new AttachmentPreviewLoader()
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('scope was not ready'))
      .mockResolvedValueOnce('data:image/png;base64,recovered')

    await expect(loader.load('thread-a:attachment', run)).rejects.toThrow('scope was not ready')
    await expect(loader.load('thread-a:attachment', run)).resolves.toBe('data:image/png;base64,recovered')
    await expect(loader.load('thread-a:attachment', run)).resolves.toBe('data:image/png;base64,recovered')
    expect(run).toHaveBeenCalledTimes(2)
  })
})
