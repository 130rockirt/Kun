export function recoverWriteReferenceContextError(
  error: unknown,
  setError: (message: string) => void,
  restorePrompt: () => void
): void {
  const message = error instanceof Error ? error.message : String(error)
  setError(message)
  void window.kunGui?.logError?.('write-context', 'Failed to prepare Work reference context', {
    message
  })
  restorePrompt()
}
