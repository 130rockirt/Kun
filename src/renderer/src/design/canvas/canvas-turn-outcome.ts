import type { NormalizedThread } from '../../agent/types'

export type CanvasTurnOutcome = 'completed' | 'aborted' | 'failed' | 'unknown'

type CanvasThreadTerminalState = Pick<
  NormalizedThread,
  'id' | 'latestTurnId' | 'latestTurnStatus'
>

export function normalizeCanvasTurnOutcome(
  status: string | null | undefined
): CanvasTurnOutcome {
  const normalized = status?.trim().toLowerCase()
  if (normalized === 'completed' || normalized === 'success') return 'completed'
  if (normalized === 'aborted' || normalized === 'cancelled' || normalized === 'canceled') {
    return 'aborted'
  }
  if (normalized === 'failed' || normalized === 'error') return 'failed'
  return 'unknown'
}

function canvasThreadTerminalState(
  threads: readonly CanvasThreadTerminalState[] | undefined,
  threadId: string
): CanvasThreadTerminalState | undefined {
  return threads?.find((thread) => thread.id === threadId)
}

export function canvasLiveTurnOutcome(options: {
  threads?: readonly CanvasThreadTerminalState[]
  threadId?: string | null
  turnId?: string | null
}): CanvasTurnOutcome {
  const threadId = options.threadId?.trim()
  const turnId = options.turnId?.trim()
  if (!threadId || !turnId) return 'unknown'
  const thread = canvasThreadTerminalState(options.threads, threadId)
  if (!thread) return 'unknown'
  const latestTurnId = thread.latestTurnId?.trim()
  if (latestTurnId && latestTurnId !== turnId) return 'unknown'
  return normalizeCanvasTurnOutcome(thread.latestTurnStatus)
}

export function canvasDurableTurnOutcome(options: {
  threads?: readonly CanvasThreadTerminalState[]
  threadId: string
  turnId: string
}): CanvasTurnOutcome {
  const thread = canvasThreadTerminalState(options.threads, options.threadId)
  if (!thread || thread.latestTurnId?.trim() !== options.turnId.trim()) return 'unknown'
  return normalizeCanvasTurnOutcome(thread.latestTurnStatus)
}

export function canvasTurnAllowsContinuation(outcome: CanvasTurnOutcome): boolean {
  return outcome !== 'aborted' && outcome !== 'failed'
}
