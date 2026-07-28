export type TurnLimitsConfig = {
  maxSteps?: number
  maxWallTimeMs?: number
  maxToolCallsPerStep?: number
}

export type NormalizedTurnLimits = {
  maxSteps?: number
  maxWallTimeMs: number
  maxToolCallsPerStep: number
}

export function normalizeTurnLimits(input: TurnLimitsConfig | undefined): NormalizedTurnLimits {
  return {
    ...(input?.maxSteps !== undefined
      ? { maxSteps: Math.max(1, Math.floor(input.maxSteps)) }
      : {}),
    maxWallTimeMs: Math.max(1, Math.floor(input?.maxWallTimeMs ?? 24 * 60 * 60_000)),
    maxToolCallsPerStep: Math.max(1, Math.floor(input?.maxToolCallsPerStep ?? 10_000))
  }
}
