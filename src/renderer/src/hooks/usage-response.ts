export const USAGE_REQUEST_TIMEOUT_MS = 12_000

export function parseUsageResponse<T>(body: string, label: string): T {
  try {
    return JSON.parse(body) as T
  } catch {
    throw new Error(`${label} response was not valid JSON`)
  }
}

export function withUsageRequestTimeout<T>(
  request: Promise<T>,
  label: string,
  timeoutMs = USAGE_REQUEST_TIMEOUT_MS
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} request timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })

  return Promise.race([request, timeoutPromise]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout)
  })
}
