export const ATTACHMENT_PRUNE_DELAY_MS = 30_000
export const ATTACHMENT_PRUNE_INTERVAL_MS = 60 * 60 * 1_000
export const THREAD_GUARDIAN_DELAY_MS = 45_000
export const THREAD_GUARDIAN_INTERVAL_MS = 6 * 60 * 60 * 1_000
export const MAINTENANCE_SLICE_RETRY_MS = 250

type MaintenanceTask = () => Promise<boolean | void>

export type RuntimeBackgroundMaintenance = {
  start(): void
  stop(): void
}

export function createRuntimeBackgroundMaintenance(input: {
  pruneAttachments: MaintenanceTask
  inspectThreads: MaintenanceTask
  onError: (task: 'attachment pruning' | 'thread guardian', error: unknown) => void
  attachmentDelayMs?: number
  attachmentIntervalMs?: number
  guardianDelayMs?: number
  guardianIntervalMs?: number
  sliceRetryMs?: number
}): RuntimeBackgroundMaintenance {
  let started = false
  let stopped = false
  let running = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let attachmentAt = Number.POSITIVE_INFINITY
  let guardianAt = Number.POSITIVE_INFINITY

  const schedule = (): void => {
    if (stopped || !started || running) return
    if (timer) clearTimeout(timer)
    const delay = Math.max(0, Math.min(attachmentAt, guardianAt) - Date.now())
    if (delay === 0) {
      queueMicrotask(runNext)
      return
    }
    timer = setTimeout(runNext, delay)
    timer.unref?.()
  }
  const runNext = (): void => {
    timer = undefined
    if (stopped || running) return
    const attachmentDue = attachmentAt <= guardianAt
    const task = attachmentDue ? 'attachment pruning' : 'thread guardian'
    const action = attachmentDue ? input.pruneAttachments : input.inspectThreads
    running = true
    void action().then((complete) => {
      const retry = complete === false
      const nextDelay = retry
        ? input.sliceRetryMs ?? MAINTENANCE_SLICE_RETRY_MS
        : attachmentDue
          ? input.attachmentIntervalMs ?? ATTACHMENT_PRUNE_INTERVAL_MS
          : input.guardianIntervalMs ?? THREAD_GUARDIAN_INTERVAL_MS
      if (attachmentDue) attachmentAt = Date.now() + nextDelay
      else guardianAt = Date.now() + nextDelay
    }).catch((error) => {
      input.onError(task, error)
      if (attachmentDue) attachmentAt = Date.now() +
        (input.attachmentIntervalMs ?? ATTACHMENT_PRUNE_INTERVAL_MS)
      else guardianAt = Date.now() +
        (input.guardianIntervalMs ?? THREAD_GUARDIAN_INTERVAL_MS)
    }).finally(() => {
      running = false
      schedule()
    })
  }
  const start = () => {
    if (started || stopped) return
    started = true
    attachmentAt = Date.now() + (input.attachmentDelayMs ?? ATTACHMENT_PRUNE_DELAY_MS)
    guardianAt = Date.now() + (input.guardianDelayMs ?? THREAD_GUARDIAN_DELAY_MS)
    schedule()
  }
  const stop = () => {
    stopped = true
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  return { start, stop }
}
