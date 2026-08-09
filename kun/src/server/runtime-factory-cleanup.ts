export async function settleCleanupSteps(
  steps: readonly (() => void | Promise<void>)[]
): Promise<void> {
  let firstError: unknown
  for (const step of steps) {
    try {
      await step()
    } catch (error) {
      if (firstError === undefined) firstError = error
    }
  }
  if (firstError !== undefined) throw firstError
}

/**
 * Composition root for serve mode. This is intentionally the only
 * place that wires concrete adapters to ports; domain, services, loop,
 * and HTTP handlers stay constructor-injected and testable.
 */
