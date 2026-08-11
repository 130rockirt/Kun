const CONTEXT_OVERFLOW_CODES = new Set([
  'context_length_exceeded',
  'context_window_exceeded',
  'context_overflow',
  'input_too_long',
  'max_context_length_exceeded',
  'prompt_too_long'
])

const CONTEXT_OVERFLOW_PATTERNS = [
  /maximum context (?:length|window)/iu,
  /context (?:length|window).{0,80}(?:exceed|overflow|too (?:large|long))/iu,
  /(?:prompt|input).{0,80}too (?:large|long)/iu,
  /too many (?:input )?tokens/iu,
  /reduce (?:the )?(?:length|number) of (?:the )?(?:messages|prompt|input)/iu,
  /token limit.{0,40}(?:exceed|overflow)/iu
]

export class ModelContextOverflowError extends Error {
  readonly code = 'context_window_exceeded'

  constructor(message: string, readonly providerCode?: string) {
    super(message)
    this.name = 'ModelContextOverflowError'
  }
}

export function modelContextOverflowError(
  message: string,
  code?: string
): ModelContextOverflowError | undefined {
  const normalizedCode = code?.trim().toLowerCase()
  const normalizedMessage = message.replace(/\s+/g, ' ').trim()
  if (
    (normalizedCode && CONTEXT_OVERFLOW_CODES.has(normalizedCode)) ||
    CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(normalizedMessage))
  ) {
    return new ModelContextOverflowError(
      normalizedMessage || 'Model provider rejected the request because its context window was exceeded.',
      normalizedCode
    )
  }
  return undefined
}

export function normalizeModelContextOverflowError(
  error: unknown
): ModelContextOverflowError | undefined {
  if (error instanceof ModelContextOverflowError) return error
  if (error instanceof Error) {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined
    return modelContextOverflowError(error.message, code)
  }
  return modelContextOverflowError(String(error))
}
