const SUPERVISION_DELIVERY_HEARTBEAT_MS = 10_000

export function startGraphSupervisionDeliveryHeartbeat(options: {
  runId: string
  renew: () => Promise<unknown>
}): () => Promise<void> {
  let stopped = false
  let stopPromise: Promise<void> | undefined
  let renewal: Promise<void> = Promise.resolve()
  const timer = setInterval(() => {
    if (stopped) return
    renewal = renewal.then(async () => {
      if (stopped) return
      await options.renew()
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(
        `[kun] Graph supervision delivery lease renewal failed for ${options.runId}: ` +
        message.slice(0, 512)
      )
    })
  }, SUPERVISION_DELIVERY_HEARTBEAT_MS)
  timer.unref?.()
  return () => {
    if (stopPromise) return stopPromise
    stopped = true
    clearInterval(timer)
    stopPromise = renewal
    return stopPromise
  }
}
