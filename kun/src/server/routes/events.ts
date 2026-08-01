import { encodeSseEvent } from '../sse.js'
import type { EventBus } from '../../ports/event-bus.js'
import type { SessionStore } from '../../ports/session-store.js'
import type { RuntimeEvent } from '../../contracts/events.js'
import type { ThreadEventStreamRegistry } from '../thread-event-stream-registry.js'

export const HEARTBEAT_INTERVAL_MS = 15_000
export const DEFAULT_MAX_PERSISTED_REPLAY_EVENTS = 256
export const DEFAULT_MAX_PERSISTED_REPLAY_BYTES = 512 * 1024
// Must accommodate the bounded 1 MiB model tool argument plus JSON escaping
// and the surrounding item-created event envelope.
export const DEFAULT_MAX_PERSISTED_REPLAY_RECORD_BYTES = 4 * 1024 * 1024
export const DEFAULT_MAX_LIVE_EVENTS_DURING_REPLAY_BYTES = 512 * 1024
/**
 * Events published while a slow persisted replay is in flight. If this fills,
 * closing the stream is safer than retaining an unbounded in-memory backlog:
 * every event is already durable and the client can reconnect from its cursor.
 */
export const MAX_LIVE_EVENTS_DURING_REPLAY = 1_024

/**
 * Build an SSE response for `GET /v1/threads/{id}/events`.
 *
 * The handler subscribes before it replays persisted events, buffering live
 * updates until replay is complete. That closes the otherwise permanent gap
 * between a store snapshot and EventBus subscription. The stream closes when
 * the request's `AbortSignal`
 * fires (the client disconnects) or the server stops publishing.
 *
 * Delivery is deduplicated per connection: an event whose seq is at or
 * below the connection's high-water mark is dropped, so an event that
 * lands in both the persisted backlog and the live subscription (the
 * recorder persists before publishing) is delivered exactly once.
 * Heartbeats reuse the high-water mark instead of allocating fresh
 * seqs — after a runtime restart the in-memory seq counter starts
 * over, and stamping heartbeats with those low seqs used to rewind
 * client cursors, which made the next subscription replay the entire
 * thread history into the live transcript.
 */
export function buildEventStreamResponse(input: {
  request: Request
  threadId: string
  eventBus: EventBus
  sessionStore: SessionStore
  /** Runtime-owned registry used to close streams after a thread is deleted. */
  streamRegistry?: ThreadEventStreamRegistry
  sinceSeq?: number
  /** Internal test/runtime tuning; the HTTP cursor contract remains unchanged. */
  replayLimits?: {
    maxEvents?: number
    maxBytes?: number
    maxRecordBytes?: number
    maxLiveEvents?: number
    maxLiveBytes?: number
  }
}): Response {
  const sinceSeq = input.sinceSeq ?? parseEventCursor(input.request) ?? 0
  const encoder = new TextEncoder()
  let unsubscribe: (() => void) | undefined
  let unregisterStream: (() => void) | undefined
  let closeStream: (() => void) | undefined
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  let closed = false
  const replayLimits = {
    maxEvents: normalizeReplayLimit(input.replayLimits?.maxEvents, DEFAULT_MAX_PERSISTED_REPLAY_EVENTS),
    maxBytes: normalizeReplayLimit(input.replayLimits?.maxBytes, DEFAULT_MAX_PERSISTED_REPLAY_BYTES),
    maxRecordBytes: normalizeReplayLimit(
      input.replayLimits?.maxRecordBytes,
      DEFAULT_MAX_PERSISTED_REPLAY_RECORD_BYTES
    ),
    maxLiveEvents: normalizeReplayLimit(input.replayLimits?.maxLiveEvents, MAX_LIVE_EVENTS_DURING_REPLAY),
    maxLiveBytes: normalizeReplayLimit(
      input.replayLimits?.maxLiveBytes,
      DEFAULT_MAX_LIVE_EVENTS_DURING_REPLAY_BYTES
    )
  }
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const close = () => {
        if (closed) return
        closed = true
        input.request.signal.removeEventListener('abort', close)
        closeStream = undefined
        unsubscribe?.()
        unsubscribe = undefined
        unregisterStream?.()
        unregisterStream = undefined
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer)
          heartbeatTimer = undefined
        }
        try {
          controller.close()
        } catch {
          // Already closed; ignore.
        }
      }
      closeStream = close
      input.request.signal.addEventListener('abort', close)
      if (input.request.signal.aborted) {
        close()
        return
      }
      unregisterStream = input.streamRegistry?.register(input.threadId, close)
      try {
        let lastDeliveredSeq = sinceSeq
        let replaying = true
        const frameFor = (event: RuntimeEvent): Uint8Array => encoder.encode(encodeSseEvent(event))
        const deliver = (event: RuntimeEvent, frame = frameFor(event)): boolean => {
          if (typeof event.seq === 'number' && event.seq <= lastDeliveredSeq) return false
          // During persisted replay the reader has not necessarily attached yet,
          // so backpressure is not meaningful. Once live, retaining arbitrary
          // events for a stalled client is worse than closing it: the client can
          // replay the durable gap from its last cursor.
          if (!replaying && controller.desiredSize !== null && controller.desiredSize <= 0) {
            close()
            return false
          }
          if (typeof event.seq === 'number') {
            lastDeliveredSeq = event.seq
          }
          controller.enqueue(frame)
          return true
        }
        const liveDuringReplay: Array<{ event: RuntimeEvent; bytes: number }> = []
        let liveDuringReplayBytes = 0
        let replayOverflowed = false
        unsubscribe = input.eventBus.subscribe(input.threadId, (event: RuntimeEvent) => {
          if (closed) return
          if (replaying) {
            const bytes = frameFor(event).byteLength
            if (
              liveDuringReplay.length >= replayLimits.maxLiveEvents ||
              bytes > replayLimits.maxLiveBytes ||
              liveDuringReplayBytes + bytes > replayLimits.maxLiveBytes
            ) {
              replayOverflowed = true
              return
            }
            liveDuringReplay.push({ event, bytes })
            liveDuringReplayBytes += bytes
            return
          }
          try {
            deliver(event)
          } catch {
            close()
          }
        })
        let replayEventCount = 0
        let replayBytes = 0
        let replayPageHasMore = false
        for await (const event of iteratePersistedEvents(
          input.sessionStore,
          input.threadId,
          sinceSeq,
          replayLimits.maxRecordBytes
        )) {
          if (closed) return
          const frame = frameFor(event)
          const bytes = frame.byteLength
          // Permit one bounded record larger than the page byte target, so a
          // valid event cannot cause an endless reconnect loop at the same
          // cursor. `maxRecordBytes` still places the hard memory ceiling.
          if (
            replayEventCount > 0 &&
            (replayEventCount >= replayLimits.maxEvents || replayBytes + bytes > replayLimits.maxBytes)
          ) {
            replayPageHasMore = true
            break
          }
          if (deliver(event, frame)) {
            replayEventCount += 1
            replayBytes += bytes
          }
          if (closed) return
        }
        // Deletion/client cancellation can close the response while an async
        // persisted replay is awaiting I/O. Do not create a heartbeat timer
        // after that response has already been released.
        if (closed) return
        if (replayOverflowed) {
          controller.enqueue(encoder.encode(
            'event: error\ndata: {"message":"SSE replay overflow; reconnect from the last event cursor."}\n\n'
          ))
          close()
          return
        }
        // A normal EOF intentionally pages durable history. The client keeps
        // the last delivered cursor and reconnects, rather than resetting to a
        // thread snapshot that may not yet contain in-flight text deltas.
        if (replayPageHasMore) {
          close()
          return
        }
        // Publishing is synchronous, so no new event can slip between this
        // drain and switching the subscriber into direct-delivery mode.
        for (const entry of liveDuringReplay.sort((a, b) => a.event.seq - b.event.seq)) {
          deliver(entry.event)
          if (closed) return
        }
        replaying = false
        if (input.sessionStore.watchEventsSince) {
          void (async () => {
            for await (const event of input.sessionStore.watchEventsSince!(
              input.threadId,
              lastDeliveredSeq,
              input.request.signal
            )) {
              if (closed) return
              deliver(event)
            }
          })().catch(() => close())
        }
        heartbeatTimer = setInterval(() => {
          if (closed) return
          // Heartbeats are subject to the same backpressure policy as live
          // events. Without this guard, an idle reader that stops consuming
          // receives a new frame every interval forever and keeps its SSE
          // subscription/timer alive indefinitely.
          if (controller.desiredSize !== null && controller.desiredSize <= 0) {
            close()
            return
          }
          try {
            controller.enqueue(
              encoder.encode(
                encodeSseEvent({
                  kind: 'heartbeat',
                  seq: lastDeliveredSeq,
                  timestamp: new Date().toISOString(),
                  threadId: input.threadId
                })
              )
            )
          } catch {
            close()
          }
        }, HEARTBEAT_INTERVAL_MS)
      } catch (error) {
        // A deletion can close the response while persisted replay is still
        // awaiting I/O. Do not try to enqueue an error onto that closed stream.
        if (closed) return
        try {
          controller.enqueue(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify({
                message: error instanceof Error ? error.message : String(error)
              })}\n\n`
            )
          )
        } catch {
          // The consumer may have closed between the guard and enqueue.
        }
        close()
      }
    },
    cancel() {
      closed = true
      if (closeStream) input.request.signal.removeEventListener('abort', closeStream)
      closeStream = undefined
      unsubscribe?.()
      unsubscribe = undefined
      unregisterStream?.()
      unregisterStream = undefined
      if (heartbeatTimer) clearInterval(heartbeatTimer)
    }
  })
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive'
    }
  })
}

/** Query cursor takes precedence over Last-Event-ID, including an explicit 0. */
export function parseEventCursor(request: Request): number | null {
  const url = new URL(request.url)
  const query = url.searchParams.get('since_seq')
  const raw = query === null ? request.headers.get('Last-Event-ID') : query
  if (raw === null || raw.trim() === '') return 0
  if (!/^\d+$/.test(raw.trim())) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function normalizeReplayLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  return Math.max(1, Math.floor(value))
}

async function* iteratePersistedEvents(
  sessionStore: SessionStore,
  threadId: string,
  sinceSeq: number,
  maxRecordBytes: number
): AsyncIterable<RuntimeEvent> {
  if (sessionStore.iterateEventsSince) {
    for await (const event of sessionStore.iterateEventsSince(threadId, sinceSeq, { maxRecordBytes })) {
      yield event
    }
    return
  }
  // Compatibility fallback for custom/test stores. Built-in persistent stores
  // implement the forward-only path above.
  const events = await sessionStore.loadEventsSince(threadId, sinceSeq)
  for (const event of events) yield event
}
