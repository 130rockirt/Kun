export const ATTACHMENT_PRUNE_DELAY_MS = 30_000
export const ATTACHMENT_PRUNE_INTERVAL_MS = 60 * 60 * 1_000
export const THREAD_GUARDIAN_DELAY_MS = 45_000
export const THREAD_GUARDIAN_INTERVAL_MS = 6 * 60 * 60 * 1_000

type MaintenanceTask = () => Promise<void>

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
}): RuntimeBackgroundMaintenance {
  let started = false
  let stopped = false
  let attachmentTimer: ReturnType<typeof setTimeout> | undefined
  let attachmentInterval: ReturnType<typeof setInterval> | undefined
  let guardianTimer: ReturnType<typeof setTimeout> | undefined
  let guardianInterval: ReturnType<typeof setInterval> | undefined

  const run = (task: 'attachment pruning' | 'thread guardian', action: MaintenanceTask) => {
    void action().catch((error) => input.onError(task, error))
  }
  const start = () => {
    if (started || stopped) return
    started = true
    attachmentTimer = setTimeout(() => {
      attachmentTimer = undefined
      if (stopped) return
      run('attachment pruning', input.pruneAttachments)
      attachmentInterval = setInterval(() => {
        if (!stopped) run('attachment pruning', input.pruneAttachments)
      }, input.attachmentIntervalMs ?? ATTACHMENT_PRUNE_INTERVAL_MS)
      attachmentInterval.unref?.()
    }, input.attachmentDelayMs ?? ATTACHMENT_PRUNE_DELAY_MS)
    attachmentTimer.unref?.()
    guardianTimer = setTimeout(() => {
      guardianTimer = undefined
      if (stopped) return
      run('thread guardian', input.inspectThreads)
      guardianInterval = setInterval(() => {
        if (!stopped) run('thread guardian', input.inspectThreads)
      }, input.guardianIntervalMs ?? THREAD_GUARDIAN_INTERVAL_MS)
      guardianInterval.unref?.()
    }, input.guardianDelayMs ?? THREAD_GUARDIAN_DELAY_MS)
    guardianTimer.unref?.()
  }
  const stop = () => {
    stopped = true
    if (attachmentTimer) clearTimeout(attachmentTimer)
    if (attachmentInterval) clearInterval(attachmentInterval)
    if (guardianTimer) clearTimeout(guardianTimer)
    if (guardianInterval) clearInterval(guardianInterval)
    attachmentTimer = undefined
    attachmentInterval = undefined
    guardianTimer = undefined
    guardianInterval = undefined
  }
  return { start, stop }
}
