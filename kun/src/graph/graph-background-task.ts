export function graphErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_048)
}

export function runGraphBackgroundTask(
  label: string,
  operation: Promise<unknown>
): void {
  void operation.catch((error) => {
    console.warn(`[kun] ${label}: ${graphErrorMessage(error)}`)
  })
}
