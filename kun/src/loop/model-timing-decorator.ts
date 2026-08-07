import type {
  ModelClient,
  ModelRequest,
  ModelStreamChunk
} from '../ports/model-client.js'

/**
 * Chunks that represent actual model output (as opposed to transport
 * bookkeeping such as retries, usage, completion, or error markers). The
 * first such chunk marks the end of time-to-first-token; pure tool-call
 * rounds fall back to their first tool chunk so they still get a TTFT.
 */
function isContentChunk(chunk: ModelStreamChunk): boolean {
  return (
    chunk.kind === 'assistant_text_delta' ||
    chunk.kind === 'assistant_reasoning_delta' ||
    chunk.kind === 'tool_call_delta' ||
    chunk.kind === 'tool_call_complete' ||
    chunk.kind === 'image_generation_complete'
  )
}

/**
 * Wraps a `ModelClient` so every streamed response carries per-request
 * timing on its `usage` chunk:
 *
 * - `requestTtftMs`: request start -> first content chunk (TTFT).
 * - `requestGenerationMs`: first content chunk -> usage chunk (used with
 *   `completionTokens` to derive tokens-per-second).
 *
 * The wrapper never modifies the underlying provider parsing; it only
 * clones the usage snapshot to attach timing. Streams without a usage
 * chunk (or without any content chunk) pass through unchanged.
 */
export function withModelTiming(
  client: ModelClient,
  options: { now?: () => number } = {}
): ModelClient {
  const now = options.now ?? ((): number => performance.now())
  return {
    ...client,
    stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
      return timedStream(client.stream(request), now)
    }
  }
}

async function* timedStream(
  stream: AsyncIterable<ModelStreamChunk>,
  now: () => number
): AsyncIterable<ModelStreamChunk> {
  const startedAt = now()
  let firstChunkAt: number | null = null
  for await (const chunk of stream) {
    if (firstChunkAt === null && isContentChunk(chunk)) {
      firstChunkAt = now()
    }
    if (chunk.kind === 'usage' && firstChunkAt !== null) {
      const usageAt = now()
      const ttftMs = Math.max(0, Math.round(firstChunkAt - startedAt))
      const generationMs = Math.max(0, Math.round(usageAt - firstChunkAt))
      yield {
        ...chunk,
        usage: {
          ...chunk.usage,
          requestTtftMs: ttftMs,
          requestGenerationMs: generationMs
        }
      }
      continue
    }
    yield chunk
  }
}
