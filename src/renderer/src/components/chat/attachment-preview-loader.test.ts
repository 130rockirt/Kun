import { describe, expect, it, vi } from 'vitest'
import {
  AttachmentPreviewLoader,
  attachmentPreviewFailureStateForScope,
  type AttachmentPreview
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
    const gate = deferred<AttachmentPreview>()
    const run = vi.fn(() => gate.promise)
    const loader = new AttachmentPreviewLoader()

    const first = loader.load('thread:attachment', run)
    const second = loader.load('thread:attachment', run)
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))

    gate.resolve({ previewUrl: 'data:image/png;base64,first' })
    await expect(Promise.all([first, second])).resolves.toEqual([
      { previewUrl: 'data:image/png;base64,first' },
      { previewUrl: 'data:image/png;base64,first' }
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
      return { previewUrl: `preview-${index}` }
    }))

    await vi.waitFor(() => expect(active).toBe(2))
    for (const gate of gates) gate.resolve()
    await expect(Promise.all(requests)).resolves.toHaveLength(6)
    expect(maximumActive).toBe(2)
  })

  it('returns cached previews and evicts least-recently-used entries by byte budget', async () => {
    const loader = new AttachmentPreviewLoader({ maxCacheBytes: 10 })
    const loadA = vi.fn(async () => ({ previewUrl: 'aaaaaa' }))
    const loadB = vi.fn(async () => ({ previewUrl: 'bbbbbb' }))

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
      .mockResolvedValueOnce({ previewUrl: 'data:image/png;base64,recovered' })

    await expect(loader.load('attachment', run)).rejects.toThrow('preview unavailable')
    await expect(loader.load('attachment', run)).resolves.toEqual({
      previewUrl: 'data:image/png;base64,recovered'
    })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('reuses a successful preview after a failed request is retried on re-entry', async () => {
    const loader = new AttachmentPreviewLoader()
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('scope was not ready'))
      .mockResolvedValueOnce({ previewUrl: 'data:image/png;base64,recovered' })

    await expect(loader.load('thread-a:attachment', run)).rejects.toThrow('scope was not ready')
    await expect(loader.load('thread-a:attachment', run)).resolves.toEqual({
      previewUrl: 'data:image/png;base64,recovered'
    })
    await expect(loader.load('thread-a:attachment', run)).resolves.toEqual({
      previewUrl: 'data:image/png;base64,recovered'
    })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('retains attachment metadata when a resolved preview is reused after remount', async () => {
    const loader = new AttachmentPreviewLoader()
    const run = vi.fn(async () => ({
      previewUrl: 'data:image/png;base64,AQID',
      attachment: {
        id: 'att_1',
        kind: 'image' as const,
        name: 'restored.png',
        mimeType: 'image/png',
        byteSize: 3,
        width: 16,
        height: 9
      }
    }))

    const first = await loader.load('thread-a:att_1', run)
    const remounted = await loader.load('thread-a:att_1', run)

    expect(remounted).toEqual(first)
    expect(remounted.attachment).toMatchObject({
      name: 'restored.png',
      mimeType: 'image/png',
      byteSize: 3,
      width: 16,
      height: 9
    })
    expect(run).toHaveBeenCalledTimes(1)
  })
})
