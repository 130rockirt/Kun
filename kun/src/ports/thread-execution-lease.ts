import type { ThreadExecutionLease } from '../contracts/runtime-flavor.js'

export class ThreadExecutionBusyError extends Error {
  constructor(readonly owner: ThreadExecutionLease) {
    super(`thread ${owner.threadId} already has an active turn`)
    this.name = 'ThreadExecutionBusyError'
  }
}

export interface ThreadExecutionLeasePort {
  acquire(threadId: string, turnId: string): Promise<ThreadExecutionLease>
  release(threadId: string, turnId: string): Promise<void>
  owner(threadId: string): Promise<ThreadExecutionLease | null>
  setLeaseLostHandler?(handler: (lease: ThreadExecutionLease) => void): void
  shutdown?(): Promise<void>
}
