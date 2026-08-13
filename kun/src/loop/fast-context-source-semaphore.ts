import type { ToolHostContext } from '../ports/tool-host.js'

export const FAST_CONTEXT_SOURCE_TOOL_CAPACITY = 4
const FAST_CONTEXT_SOURCE_TOOL_NAMES = new Set(['grep', 'glob', 'read'])

type Waiter = {
  resolve: (release: () => void) => void
  reject: (error: Error) => void
  signal: AbortSignal
  onAbort: () => void
}

/** Process-wide budget shared by every Fast Context child, not every turn. */
export class FastContextSourceSemaphore {
  private active = 0
  private readonly waiters: Waiter[] = []

  constructor(private readonly capacity = FAST_CONTEXT_SOURCE_TOOL_CAPACITY) {}

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new Error('Fast Context source tool aborted while queued'))
    if (this.active < this.capacity && this.waiters.length === 0) {
      this.active += 1
      return Promise.resolve(this.releaseOnce())
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(new Error('Fast Context source tool aborted while queued'))
        }
      }
      signal.addEventListener('abort', waiter.onAbort, { once: true })
      this.waiters.push(waiter)
      this.drain()
    })
  }

  async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    const release = await this.acquire(signal)
    try {
      return await work()
    } finally {
      release()
    }
  }

  snapshot(): { active: number; waiting: number; capacity: number } {
    return { active: this.active, waiting: this.waiters.length, capacity: this.capacity }
  }

  private releaseOnce(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.active = Math.max(0, this.active - 1)
      this.drain()
    }
  }

  private drain(): void {
    while (this.active < this.capacity) {
      const waiter = this.waiters.shift()
      if (!waiter) return
      waiter.signal.removeEventListener('abort', waiter.onAbort)
      if (waiter.signal.aborted) {
        waiter.reject(new Error('Fast Context source tool aborted while queued'))
        continue
      }
      this.active += 1
      waiter.resolve(this.releaseOnce())
    }
  }
}

const sharedSemaphore = new FastContextSourceSemaphore()

export function withFastContextSourceToolSlot<T>(input: {
  context: ToolHostContext
  toolName: string
  work: () => Promise<T>
}): Promise<T> {
  if (input.context.fastContext !== true || !FAST_CONTEXT_SOURCE_TOOL_NAMES.has(input.toolName)) {
    return input.work()
  }
  return sharedSemaphore.run(input.context.abortSignal, input.work)
}

/** Test-only observability without exposing a mutable singleton. */
export function fastContextSourceToolSemaphoreSnapshot(): { active: number; waiting: number; capacity: number } {
  return sharedSemaphore.snapshot()
}
