const INITIAL_RETRY_DELAY_MS = 100
const MAX_RETRY_DELAY_MS = 30_000

export class GraphRuntimeReconfigureRetry {
  private attempt = 0
  private timer?: NodeJS.Timeout

  constructor(
    private readonly operation: () => void,
    private readonly random: () => number = Math.random
  ) {}

  reset(): void {
    this.attempt = 0
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  schedule(): void {
    if (this.timer) return
    const ceiling = Math.min(
      MAX_RETRY_DELAY_MS,
      INITIAL_RETRY_DELAY_MS * (2 ** Math.min(this.attempt, 16))
    )
    const jitter = 0.5 + Math.max(0, Math.min(1, this.random())) * 0.5
    const delay = Math.max(1, Math.round(ceiling * jitter))
    this.attempt += 1
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.operation()
    }, delay)
    this.timer.unref?.()
  }
}
