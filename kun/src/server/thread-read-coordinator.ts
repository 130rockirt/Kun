import {
  enterForegroundRuntimeRead,
  noteRuntimeReadOverload
} from './runtime-load-shedder.js'

export type ThreadReadPriority = 'foreground' | 'background'

type QueueEntry<T> = {
  key: string
  priority: ThreadReadPriority
  operation: () => Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

export class ThreadReadOverloadedError extends Error {
  constructor(readonly retryAfterSeconds = 1) {
    super('thread timeline reader is temporarily overloaded')
    this.name = 'ThreadReadOverloadedError'
  }
}

export type ThreadReadCoordinatorStats = {
  activeForeground: number
  activeBackground: number
  queuedForeground: number
  queuedBackground: number
  joined: number
  started: number
  rejected: number
}

export class ThreadReadCoordinator {
  private readonly inflight = new Map<string, Promise<unknown>>()
  private readonly foreground: QueueEntry<unknown>[] = []
  private readonly background: QueueEntry<unknown>[] = []
  private activeForeground = 0
  private activeBackground = 0
  private joined = 0
  private started = 0
  private rejected = 0

  constructor(private readonly limits = {
    foreground: 2,
    background: 1,
    queued: 8
  }) {}

  run<T>(key: string, priority: ThreadReadPriority, operation: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key)
    if (existing) {
      this.joined += 1
      return existing as Promise<T>
    }
    if (this.foreground.length + this.background.length >= this.limits.queued) {
      this.rejected += 1
      noteRuntimeReadOverload()
      return Promise.reject(new ThreadReadOverloadedError())
    }
    let entry!: QueueEntry<T>
    const promise = new Promise<T>((resolve, reject) => {
      entry = { key, priority, operation, resolve, reject }
    })
    this.inflight.set(key, promise)
    if (this.canStart(priority)) this.start(entry as QueueEntry<unknown>)
    else (priority === 'foreground' ? this.foreground : this.background)
      .push(entry as QueueEntry<unknown>)
    return promise
  }

  hasForegroundWork(): boolean {
    return this.activeForeground > 0 || this.foreground.length > 0
  }

  stats(): ThreadReadCoordinatorStats {
    return {
      activeForeground: this.activeForeground,
      activeBackground: this.activeBackground,
      queuedForeground: this.foreground.length,
      queuedBackground: this.background.length,
      joined: this.joined,
      started: this.started,
      rejected: this.rejected
    }
  }

  private canStart(priority: ThreadReadPriority): boolean {
    if (priority === 'foreground') return this.activeForeground < this.limits.foreground
    return this.activeBackground < this.limits.background &&
      this.activeForeground === 0 && this.foreground.length === 0
  }

  private start(entry: QueueEntry<unknown>): void {
    this.started += 1
    if (entry.priority === 'foreground') this.activeForeground += 1
    else this.activeBackground += 1
    const releaseForeground = entry.priority === 'foreground'
      ? enterForegroundRuntimeRead() : () => undefined
    void entry.operation().then(entry.resolve, entry.reject).finally(() => {
      releaseForeground()
      this.inflight.delete(entry.key)
      if (entry.priority === 'foreground') this.activeForeground -= 1
      else this.activeBackground -= 1
      this.pump()
    })
  }

  private pump(): void {
    while (this.foreground.length > 0 && this.canStart('foreground')) {
      this.start(this.foreground.shift()!)
    }
    while (this.background.length > 0 && this.canStart('background')) {
      this.start(this.background.shift()!)
    }
  }
}
