export type DelegatedRuntimeCapabilities = {
  nativeResume: boolean
  structuredStreaming: boolean
  kunTools: boolean
  externalApproval: boolean
  liveSteering: boolean
  nativeContextTelemetry: boolean
  fork: boolean
}

/**
 * A provider-native runtime that owns an entire Kun turn instead of exposing an
 * HTTP ModelClient. Subscription CLIs/SDKs implement this narrow boundary.
 */
export interface DelegatedTurnRuntime {
  handlesProvider(providerId: string | undefined): boolean
  capabilities(providerId: string | undefined): DelegatedRuntimeCapabilities | undefined
  runTurn(
    threadId: string,
    turnId: string,
    signal: AbortSignal,
    providerId?: string
  ): Promise<'completed' | 'failed' | 'aborted'>
}

export function composeDelegatedTurnRuntimes(
  runtimes: readonly DelegatedTurnRuntime[]
): DelegatedTurnRuntime | undefined {
  const active = runtimes.filter(Boolean)
  if (active.length === 0) return undefined
  return {
    handlesProvider(providerId) {
      return active.some((runtime) => runtime.handlesProvider(providerId))
    },
    capabilities(providerId) {
      return active.find((candidate) => candidate.handlesProvider(providerId))
        ?.capabilities(providerId)
    },
    async runTurn(threadId, turnId, signal, providerId) {
      const runtime = active.find((candidate) => candidate.handlesProvider(providerId))
      if (runtime) return runtime.runTurn(threadId, turnId, signal, providerId)
      throw new Error('no delegated runtime owns this turn')
    }
  }
}
