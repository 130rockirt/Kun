import type { ChatState, ChatStoreGet, ChatStoreSet } from './chat-store-types'

let startupRuntimeProbeTimer: ReturnType<typeof setTimeout> | null = null
let busyWatchdogTimer: ReturnType<typeof setTimeout> | null = null
let busyRecoveryAttempts = 0
let turnCompletionPollTimer: ReturnType<typeof setInterval> | null = null

type BusyWatchdogOptions = {
  timeoutMs: number
  maxAttempts: number
  finalizeBusyState: (state: ChatState) => Partial<ChatState>
  flushLiveBlocks: (state: ChatState, base: Partial<ChatState>) => Partial<ChatState>
  busyTimeoutMessage: () => string
}

type TurnCompletionPollOptions = {
  loadThreadState: (
    state: ChatState,
    threadId: string
  ) => Promise<{ status: string; latestTurnStatus?: string }>
  threadLooksRunning: (threadStatus: string) => boolean
  onCompletedThreads: (
    done: Array<{ id: string; latestTurnStatus?: string }>,
    state: ChatState,
    set: ChatStoreSet,
    get: ChatStoreGet
  ) => void | Promise<void>
  isMissingThreadError?: (error: unknown) => boolean
  onMissingThreads?: (
    ids: string[],
    state: ChatState,
    set: ChatStoreSet,
    get: ChatStoreGet
  ) => void | Promise<void>
}

type CompletionPollOutcome =
  | { kind: 'completed'; id: string; latestTurnStatus?: string }
  | { kind: 'missing'; id: string }
  | null

export function scheduleStartupRuntimeProbe(get: ChatStoreGet): void {
  if (startupRuntimeProbeTimer) {
    clearTimeout(startupRuntimeProbeTimer)
  }
  startupRuntimeProbeTimer = setTimeout(() => {
    startupRuntimeProbeTimer = null
    void get().probeRuntime('user')
  }, 900)
}

export function clearBusyWatchdog(): void {
  if (busyWatchdogTimer) {
    clearTimeout(busyWatchdogTimer)
    busyWatchdogTimer = null
  }
}

export function resetBusyRecoveryAttempts(): void {
  busyRecoveryAttempts = 0
}

export function armBusyWatchdog(
  set: ChatStoreSet,
  get: ChatStoreGet,
  options: BusyWatchdogOptions
): void {
  clearBusyWatchdog()
  busyWatchdogTimer = setTimeout(() => {
    const state = get()
    if (!state.busy) return
    busyRecoveryAttempts += 1
    if (busyRecoveryAttempts <= options.maxAttempts && state.activeThreadId) {
      void state.recoverActiveTurn()
      return
    }
    set((snapshot) => {
      const base: Partial<ChatState> = {
        ...options.finalizeBusyState(snapshot),
        busy: false,
        currentTurnId: null,
        currentTurnOrchestration: null,
        error: options.busyTimeoutMessage()
      }
      return options.flushLiveBlocks(snapshot, base)
    })
    // The thread is idle again as far as the UI is concerned; queued
    // messages would otherwise wait for a completion event that will
    // never come.
    void get().drainQueuedMessages?.()
  }, options.timeoutMs)
}

export function stopTurnCompletionPoll(): void {
  if (turnCompletionPollTimer) {
    clearInterval(turnCompletionPollTimer)
    turnCompletionPollTimer = null
  }
}

export function syncTurnCompletionPoll(
  set: ChatStoreSet,
  get: ChatStoreGet,
  options: TurnCompletionPollOptions
): void {
  const ids = Object.keys(get().watchTurnCompletion).filter((id) => get().watchTurnCompletion[id])
  if (ids.length === 0) {
    stopTurnCompletionPoll()
    return
  }
  if (turnCompletionPollTimer != null) return

  const tick = (): void => {
    void pollTurnCompletionWatch(set, get, options)
  }

  turnCompletionPollTimer = setInterval(tick, 2500)
  void tick()
}

async function pollTurnCompletionWatch(
  set: ChatStoreSet,
  get: ChatStoreGet,
  options: TurnCompletionPollOptions
): Promise<void> {
  const state = get()
  if (state.runtimeConnection !== 'ready') {
    stopTurnCompletionPoll()
    return
  }

  const ids = Object.keys(state.watchTurnCompletion).filter((id) => state.watchTurnCompletion[id])
  if (ids.length === 0) {
    stopTurnCompletionPoll()
    return
  }

  const outcomes: CompletionPollOutcome[] = await Promise.all(ids.map(async (threadId) => {
    try {
      const thread = await options.loadThreadState(state, threadId)
      return options.threadLooksRunning(thread.status)
        ? null
        : { kind: 'completed' as const, id: threadId, latestTurnStatus: thread.latestTurnStatus }
    } catch (error) {
      return options.isMissingThreadError?.(error) ? { kind: 'missing' as const, id: threadId } : null
    }
  }))
  const completed = outcomes.filter((outcome): outcome is Extract<CompletionPollOutcome, { kind: 'completed' }> =>
    outcome?.kind === 'completed'
  )
  const done = completed.map(({ id, latestTurnStatus }) => ({ id, latestTurnStatus }))
  const missingIds = outcomes.flatMap((outcome) =>
    outcome?.kind === 'missing' ? [outcome.id] : []
  )

  if (done.length > 0) {
    await options.onCompletedThreads(done, state, set, get)
  }
  if (missingIds.length > 0) {
    await options.onMissingThreads?.(missingIds, state, set, get)
  }

  if (Object.keys(get().watchTurnCompletion).filter((id) => get().watchTurnCompletion[id]).length === 0) {
    stopTurnCompletionPoll()
  }
}
