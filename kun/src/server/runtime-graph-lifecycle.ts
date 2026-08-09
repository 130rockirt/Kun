import {
  GraphRuntimeComposition,
  TurnService
} from './runtime-factory-dependencies.js'

export async function shutdownGraphExecutionForHost(input: {
  graphRuntime: Pick<GraphRuntimeComposition, 'quiesceExecution' | 'stop'>
  turnService: Pick<TurnService, 'suspendActiveTurnsForShutdown'>
}): Promise<void> {
  // Scheduler shutdown owns the special non-consuming worker interruption
  // marker. Park source turns only after every active attempt has recorded it.
  await input.graphRuntime.quiesceExecution()
  await input.turnService.suspendActiveTurnsForShutdown()
  await input.graphRuntime.stop()
}

export async function resumeInterruptedGraphPlanning(input: {
  graphRuntime: Pick<GraphRuntimeComposition, 'drafts'>
  turnService: Pick<
    TurnService,
    'getTurn' | 'resumeGraphPlanningTurn'
  >
  runTurn: (threadId: string, turnId: string) => Promise<unknown> | void
}): Promise<number> {
  const drafts = await input.graphRuntime.drafts.list({
    statuses: ['planning', 'validating', 'repairing']
  })
  let resumed = 0
  for (const draft of drafts) {
    const source = await input.turnService.getTurn(draft.threadId, draft.sourceTurnId)
    if (
      source?.status !== 'running' ||
      source.orchestration !== 'graph'
    ) continue
    try {
      const outcome = await input.turnService.resumeGraphPlanningTurn({
        threadId: draft.threadId,
        turnId: draft.sourceTurnId
      })
      if (outcome !== 'resumed') continue
      resumed += 1
      void Promise.resolve(input.runTurn(draft.threadId, draft.sourceTurnId))
        .catch((error) => {
          console.warn(
            `[kun] restarted Graph planning turn ${draft.sourceTurnId} failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        })
    } catch (error) {
      console.warn(
        `[kun] could not resume Graph planning draft ${draft.id}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }
  return resumed
}

export async function waitForActiveRuns(
  runs: ReadonlySet<Promise<unknown>>,
  timeoutMs = 5_000
): Promise<void> {
  const pending = [...runs]
  if (pending.length === 0) return
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => { timeout = setTimeout(resolve, timeoutMs) })
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
