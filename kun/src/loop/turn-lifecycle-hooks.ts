import type { TurnItem } from '../contracts/items.js'
import { hasHooksForPhase, runObserverHooks, runUserPromptSubmitHooks, type ResolvedHook } from '../hooks/hook-engine.js'
import type { IdGenerator } from '../ports/id-generator.js'
import type { ThreadStore } from '../ports/thread-store.js'
import type { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import type { TurnService } from '../services/turn-service.js'
import { resolveTurnClientSurface } from './turn-context-resolver.js'

export type TurnLifecycleHookDeps = {
  hooks?: readonly ResolvedHook[]
  threadStore: Pick<ThreadStore, 'get'>
  turns: Pick<TurnService, 'getTurn' | 'applyItem'>
  events: Pick<RuntimeEventRecorder, 'record'>
  ids: Pick<IdGenerator, 'next'>
  nowIso: () => string
}

export async function runTurnStartLifecycleHooks(
  deps: TurnLifecycleHookDeps,
  input: { threadId: string; turnId: string }
): Promise<string | undefined> {
  const hasStart = hasHooksForPhase(deps.hooks, 'TurnStart')
  const hasSubmit = hasHooksForPhase(deps.hooks, 'UserPromptSubmit')
  if (!hasStart && !hasSubmit) return undefined
  const [turn, thread] = await Promise.all([
    deps.turns.getTurn(input.threadId, input.turnId),
    deps.threadStore.get(input.threadId)
  ])
  const payload = {
    threadId: input.threadId,
    turnId: input.turnId,
    prompt: turn?.prompt ?? '',
    ...(turn ? { clientSurface: resolveTurnClientSurface(turn) } : {}),
    ...(thread?.workspace ? { workspace: thread.workspace } : {})
  }
  if (hasStart) {
    const started = await runObserverHooks(deps.hooks, { phase: 'TurnStart', ...payload })
    await recordLifecycleHookWarnings(deps.events, input, started.warnings)
  }
  if (!hasSubmit) return undefined
  const submit = await runUserPromptSubmitHooks(deps.hooks, payload)
  await recordLifecycleHookWarnings(deps.events, input, submit.warnings)
  if (submit.denied) return submit.denied
  if (submit.additionalContext.length === 0) return undefined

  const now = deps.nowIso()
  const item: TurnItem = {
    id: deps.ids.next('item_hook'),
    turnId: input.turnId,
    threadId: input.threadId,
    role: 'user',
    status: 'completed',
    createdAt: now,
    finishedAt: now,
    kind: 'user_message',
    text: `<hook-context>\n${submit.additionalContext.join('\n\n')}\n</hook-context>`
  }
  await deps.turns.applyItem(input.threadId, item)
  return undefined
}

/** TurnEnd observers are best effort and must never interrupt cleanup. */
export async function runTurnEndLifecycleHooks(
  deps: Pick<TurnLifecycleHookDeps, 'hooks' | 'events' | 'threadStore' | 'turns'>,
  input: {
    threadId: string
    turnId: string
    status: 'completed' | 'failed' | 'aborted'
    error?: string
  }
): Promise<void> {
  if (!hasHooksForPhase(deps.hooks, 'TurnEnd')) return
  try {
    const [turn, thread] = await Promise.all([
      deps.turns.getTurn(input.threadId, input.turnId),
      deps.threadStore.get(input.threadId)
    ])
    const outcome = await runObserverHooks(deps.hooks, {
      phase: 'TurnEnd',
      threadId: input.threadId,
      turnId: input.turnId,
      status: input.status,
      ...(turn ? { clientSurface: resolveTurnClientSurface(turn) } : {}),
      ...(thread?.workspace ? { workspace: thread.workspace } : {}),
      ...(input.error ? { error: input.error } : {})
    })
    await recordLifecycleHookWarnings(deps.events, input, outcome.warnings)
  } catch {
    // Observe-only: a TurnEnd hook must never break turn cleanup.
  }
}

export async function recordLifecycleHookWarnings(
  events: Pick<RuntimeEventRecorder, 'record'>,
  input: { threadId: string; turnId: string },
  warnings: readonly string[]
): Promise<void> {
  for (const message of warnings) {
    await events.record({
      kind: 'error',
      threadId: input.threadId,
      turnId: input.turnId,
      message,
      code: 'hook_warning',
      severity: 'warning'
    })
  }
}
