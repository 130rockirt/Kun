import type { DelegatedRuntimeCapabilities, DelegatedTurnRuntime } from '../delegated-turn-runtime.js'
import type { TurnRunOutcome } from '../../loop/turn-execution-types.js'
import {
  type CursorSdkRuntimeDeps,
  CursorTurnInterruptedError
} from './cursor-sdk-runtime-support.js'
import { cursorSdkCapabilities } from './cursor-sdk-runtime-trace.js'
import { runCursorSdkTurnOwned } from './cursor-sdk-runtime-lifecycle.js'

export class CursorSdkRuntime implements DelegatedTurnRuntime {
  constructor(private readonly deps: CursorSdkRuntimeDeps) {}

  handlesProvider(providerId: string | undefined): boolean {
    if (providerId && this.deps.providerIds.has(providerId)) return true
    if (!this.deps.defaultIsCursor) return false
    return !providerId || !this.deps.providerConfigs[providerId]
  }

  capabilities(providerId: string | undefined): DelegatedRuntimeCapabilities | undefined {
    if (!this.handlesProvider(providerId)) return undefined
    return cursorSdkCapabilities(Boolean(this.deps.loadKunTurnContext))
  }

  async runTurn(
    threadId: string,
    turnId: string,
    signal: AbortSignal,
    providerId?: string
  ): Promise<TurnRunOutcome> {
    const runtimeController = new AbortController()
    const abortRuntime = (): void => runtimeController.abort()
    signal.addEventListener('abort', abortRuntime, { once: true })
    if (signal.aborted) abortRuntime()
    const execute = () => runCursorSdkTurnOwned(this.deps,
      threadId,
      turnId,
      runtimeController.signal,
      providerId,
      abortRuntime
    )
    try {
      return await (this.deps.sessionCoordinator
        ? this.deps.sessionCoordinator.runExclusive(threadId, execute)
        : execute())
    } finally {
      abortRuntime()
      signal.removeEventListener('abort', abortRuntime)
    }
  }
}
