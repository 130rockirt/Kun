import type { AttachmentReference } from '../../agent/types'

export type AttachmentPreviewFailureState = {
  scopeKey: string
  failedPreviewIds: Record<string, true>
}

export function attachmentPreviewFailureStateForScope(
  current: AttachmentPreviewFailureState,
  nextScopeKey: string
): AttachmentPreviewFailureState {
  return current.scopeKey === nextScopeKey
    ? current
    : { scopeKey: nextScopeKey, failedPreviewIds: {} }
}

export type AttachmentPreview = {
  previewUrl: string
  attachment?: AttachmentReference
}

type PreviewTask = () => Promise<AttachmentPreview>

type QueuedPreview = {
  run: PreviewTask
  resolve: (value: AttachmentPreview) => void
  reject: (reason?: unknown) => void
}

export type AttachmentPreviewLoaderOptions = {
  maxConcurrent?: number
  maxQueued?: number
  maxCacheBytes?: number
  measureBytes?: (value: AttachmentPreview) => number
}

const DEFAULT_MAX_CONCURRENT = 2
const DEFAULT_MAX_QUEUED = 64
const DEFAULT_MAX_CACHE_BYTES = 24 * 1024 * 1024

/**
 * Shares expensive attachment preview requests across the whole renderer.
 *
 * In-flight work intentionally survives component cleanup: React StrictMode
 * mounts, cleans up, and mounts effects again in development, and aborting the
 * first request would immediately duplicate the same multi-megabyte load.
 */
export class AttachmentPreviewLoader {
  private readonly maxConcurrent: number
  private readonly maxQueued: number
  private readonly maxCacheBytes: number
  private readonly measureBytes: (value: AttachmentPreview) => number
  private readonly inFlight = new Map<string, Promise<AttachmentPreview>>()
  private readonly cache = new Map<string, { value: AttachmentPreview; bytes: number }>()
  private readonly queue: QueuedPreview[] = []
  private activeCount = 0
  private cacheBytes = 0

  constructor(options: AttachmentPreviewLoaderOptions = {}) {
    this.maxConcurrent = positiveInteger(options.maxConcurrent, DEFAULT_MAX_CONCURRENT)
    this.maxQueued = positiveInteger(options.maxQueued, DEFAULT_MAX_QUEUED)
    this.maxCacheBytes = nonNegativeInteger(options.maxCacheBytes, DEFAULT_MAX_CACHE_BYTES)
    this.measureBytes = options.measureBytes ?? ((value) => value.previewUrl.length)
  }

  load(key: string, run: PreviewTask): Promise<AttachmentPreview> {
    const normalizedKey = key.trim()
    if (!normalizedKey) return Promise.reject(new Error('attachment preview key is required'))

    const cached = this.cache.get(normalizedKey)
    if (cached) {
      // Map insertion order is the LRU order. Touch the entry on every hit.
      this.cache.delete(normalizedKey)
      this.cache.set(normalizedKey, cached)
      return Promise.resolve(cached.value)
    }

    const existing = this.inFlight.get(normalizedKey)
    if (existing) return existing

    const request = this.enqueue(run)
      .then((value) => {
        this.remember(normalizedKey, value)
        return value
      })
      .finally(() => {
        if (this.inFlight.get(normalizedKey) === request) {
          this.inFlight.delete(normalizedKey)
        }
      })
    this.inFlight.set(normalizedKey, request)
    return request
  }

  clear(): void {
    this.cache.clear()
    this.cacheBytes = 0
  }

  private enqueue(run: PreviewTask): Promise<AttachmentPreview> {
    if (this.queue.length >= this.maxQueued) {
      return Promise.reject(new Error('attachment preview queue is full'))
    }
    return new Promise<AttachmentPreview>((resolve, reject) => {
      this.queue.push({ run, resolve, reject })
      this.drain()
    })
  }

  private drain(): void {
    while (this.activeCount < this.maxConcurrent) {
      const next = this.queue.shift()
      if (!next) return
      this.activeCount += 1
      void Promise.resolve()
        .then(next.run)
        .then(next.resolve, next.reject)
        .finally(() => {
          this.activeCount = Math.max(0, this.activeCount - 1)
          this.drain()
        })
    }
  }

  private remember(key: string, value: AttachmentPreview): void {
    const measured = this.measureBytes(value)
    const bytes = Number.isFinite(measured) ? Math.max(0, Math.floor(measured)) : 0
    const previous = this.cache.get(key)
    if (previous) {
      this.cache.delete(key)
      this.cacheBytes = Math.max(0, this.cacheBytes - previous.bytes)
    }

    while (this.cache.size > 0 && this.cacheBytes + bytes > this.maxCacheBytes) {
      const oldestKey = this.cache.keys().next().value
      if (typeof oldestKey !== 'string') break
      const oldest = this.cache.get(oldestKey)
      this.cache.delete(oldestKey)
      this.cacheBytes = Math.max(0, this.cacheBytes - (oldest?.bytes ?? 0))
    }

    if (bytes > this.maxCacheBytes) return
    this.cache.set(key, { value, bytes })
    this.cacheBytes += bytes
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : fallback
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) >= 0 ? Math.floor(Number(value)) : fallback
}

export const attachmentPreviewLoader = new AttachmentPreviewLoader()
