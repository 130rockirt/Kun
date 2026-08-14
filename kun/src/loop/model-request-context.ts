import type { ModelRequest } from '../ports/model-client.js'

/**
 * Diagnostic/test projection of all trusted context carried by a request.
 * Native requests use append-only `model_context` history; legacy direct
 * callers may still populate the old request-level fields.
 */
export function modelRequestContextText(request: ModelRequest): string {
  return [
    request.modeInstruction,
    ...(request.contextInstructions ?? []),
    ...request.history
      .filter((item) => item.kind === 'model_context')
      .map((item) => item.text)
  ].filter((value): value is string => Boolean(value?.trim())).join('\n')
}
