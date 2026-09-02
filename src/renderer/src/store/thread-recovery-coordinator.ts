export type ThreadRecoveryReason =
  | 'selection'
  | 'sse_disconnect'
  | 'watchdog'
  | 'manual_retry'
  | 'runtime_restart'
  | 'send_reconcile'
  | 'replay_reset'

export type ThreadRecoveryOptions = {
  reason?: ThreadRecoveryReason
  forceTimeline?: boolean
}

type RecoveryFlight = {
  controller: AbortController
  promise: Promise<boolean>
  reason: ThreadRecoveryReason
  startedAt: number
}

export type ThreadRecoveryDiagnostics = {
  started: number
  joined: number
  cancelled: number
  inflight: number
  forcedHydrations: number
}

const flights = new Map<string, RecoveryFlight>()
const attempts = new Map<string, number>()
const forcedHydration = new Set<string>()
const catchingUp = new Set<string>()
const activityListeners = new Set<() => void>()
let started = 0
let joined = 0
let cancelled = 0

function notifyActivity(): void {
  for (const listener of activityListeners) listener()
}

export function runThreadRecovery(
  threadId: string,
  reason: ThreadRecoveryReason,
  task: (signal: AbortSignal) => Promise<boolean>
): Promise<boolean> {
  const existing = flights.get(threadId)
  if (existing) {
    joined += 1
    return existing.promise
  }
  if (catchingUp.has(threadId)) {
    joined += 1
    return Promise.resolve(true)
  }
  const controller = new AbortController()
  started += 1
  const promise = Promise.resolve()
    .then(() => task(controller.signal))
    .finally(() => {
      if (flights.get(threadId)?.promise === promise) {
        flights.delete(threadId)
        notifyActivity()
      }
    })
  flights.set(threadId, { controller, promise, reason, startedAt: Date.now() })
  notifyActivity()
  return promise
}

export function cancelThreadRecovery(threadId: string): void {
  const flight = flights.get(threadId)
  const wasCatchingUp = catchingUp.delete(threadId)
  if (flight) {
    cancelled += 1
    flights.delete(threadId)
    flight.controller.abort()
  }
  if (flight || wasCatchingUp) notifyActivity()
}

export function cancelThreadRecoveriesExcept(threadId?: string): void {
  for (const candidate of new Set([...flights.keys(), ...catchingUp])) {
    if (candidate !== threadId) cancelThreadRecovery(candidate)
  }
}

export function hasForegroundThreadRecovery(): boolean {
  return flights.size > 0 || catchingUp.size > 0
}

export function onThreadRecoveryActivity(listener: () => void): () => void {
  activityListeners.add(listener)
  return () => activityListeners.delete(listener)
}

export function requireThreadTimelineHydration(threadId: string): void {
  forcedHydration.add(threadId)
}

export function markThreadRecoveryCatchingUp(threadId: string): void {
  if (catchingUp.has(threadId)) return
  catchingUp.add(threadId)
  notifyActivity()
}

export function releaseThreadRecoveryCatchup(threadId: string): void {
  if (!catchingUp.delete(threadId)) return
  notifyActivity()
}

export function consumeThreadTimelineHydration(threadId: string): boolean {
  return forcedHydration.delete(threadId)
}

export function noteThreadRecoveryEvidence(threadId: string): void {
  attempts.delete(threadId)
  releaseThreadRecoveryCatchup(threadId)
}

export function threadRecoveryBackoffMs(
  threadId: string,
  random: () => number = Math.random
): number {
  const attempt = Math.min((attempts.get(threadId) ?? 0) + 1, 8)
  attempts.set(threadId, attempt)
  const ceiling = Math.min(30_000, 500 * (2 ** (attempt - 1)))
  return Math.max(0, Math.floor(random() * ceiling))
}

export function threadRecoveryDiagnostics(): ThreadRecoveryDiagnostics {
  return {
    started,
    joined,
    cancelled,
    inflight: flights.size + catchingUp.size,
    forcedHydrations: forcedHydration.size
  }
}

export function resetThreadRecoveryCoordinator(): void {
  for (const flight of flights.values()) flight.controller.abort()
  flights.clear()
  attempts.clear()
  forcedHydration.clear()
  catchingUp.clear()
  started = 0
  joined = 0
  cancelled = 0
  notifyActivity()
}
