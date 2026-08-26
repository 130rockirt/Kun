export type SlotWaiter = {
  resolve: () => void
  reject: (error: unknown) => void
  signal: AbortSignal
  onAbort: () => void
  timer?: ReturnType<typeof setTimeout>
  settled: boolean
}

export class ChildQueueTimeoutError extends Error {
  readonly code = 'child_queue_timeout'

  constructor(readonly timeoutMs: number) {
    super(`Child run could not start within ${timeoutMs}ms because all execution slots remained occupied.`)
    this.name = 'ChildQueueTimeoutError'
  }
}

export function enqueueSlotWaiter(input: {
  waiters: SlotWaiter[]
  signal: AbortSignal
  queueTimeoutMs?: number
  drain: () => void
}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const rejectOnce = (waiter: SlotWaiter, error: Error): void => {
      if (waiter.settled) return
      waiter.settled = true
      removeSlotWaiter(input.waiters, waiter)
      reject(error)
      input.drain()
    }
    const waiter: SlotWaiter = {
      resolve,
      reject,
      signal: input.signal,
      settled: false,
      onAbort: () => rejectOnce(waiter, new Error('aborted while queued'))
    }
    input.signal.addEventListener('abort', waiter.onAbort, { once: true })
    if (input.queueTimeoutMs !== undefined && Number.isFinite(input.queueTimeoutMs) && input.queueTimeoutMs >= 0) {
      waiter.timer = setTimeout(
        () => rejectOnce(waiter, new ChildQueueTimeoutError(input.queueTimeoutMs!)),
        input.queueTimeoutMs
      )
    }
    input.waiters.push(waiter)
    input.drain()
  })
}

export function admitSlotWaiter(waiter: SlotWaiter): boolean {
  cleanupSlotWaiter(waiter)
  if (waiter.settled) return false
  waiter.settled = true
  if (waiter.signal.aborted) {
    waiter.reject(new Error('aborted while queued'))
    return false
  }
  return true
}

function removeSlotWaiter(waiters: SlotWaiter[], waiter: SlotWaiter): void {
  const index = waiters.indexOf(waiter)
  if (index >= 0) waiters.splice(index, 1)
  cleanupSlotWaiter(waiter)
}

function cleanupSlotWaiter(waiter: SlotWaiter): void {
  waiter.signal.removeEventListener('abort', waiter.onAbort)
  if (waiter.timer) clearTimeout(waiter.timer)
}
