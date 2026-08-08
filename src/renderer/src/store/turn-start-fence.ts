let turnStartGeneration = 0

export function currentTurnStartGeneration(): number {
  return turnStartGeneration
}

export function invalidatePendingTurnStarts(): void {
  turnStartGeneration += 1
}
