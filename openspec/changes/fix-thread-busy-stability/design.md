## Context

Kun deliberately serializes writes per thread with a manager-owned execution lease. The current renderer does not recognize the runtime's `thread_busy` code, foreground Bash commands default to a 24-hour ceiling, and thread detail hydration reads and returns every durable item. Together these behaviors can leave a valid long-running turn looking like an unstable, unrecoverable error.

The GUI, TUI, and other clients share the same `kun serve` runtime and durable thread data. Compatibility with callers that do not adopt the new retry and pagination fields is required.

## Goals / Non-Goals

**Goals:**

- Treat the runtime as the authority for active-turn state and recover the GUI without losing or duplicating user intent.
- Make turn-start retries idempotent while preserving the single-writer lease.
- Put a product-appropriate bound on synchronous shell work and guarantee cleanup.
- Bound initial conversation hydration by item count and serialized bytes while preserving SSE replay continuity.
- Provide actionable, sanitized status and diagnostics.

**Non-Goals:**

- Allowing concurrent turns to mutate the same thread.
- Reintroducing legacy runtimes or runtime diagnostics panels.
- Limiting background jobs to the foreground timeout.
- Changing model-history compaction or dropping durable model context.

## Decisions

1. **Keep leases and reconcile on `thread_busy`.** `thread_busy` becomes a shared error code. On receipt, the renderer retains the submitted message in its existing queue, fetches `/state`, rehydrates the active turn, and reconnects SSE. The primary UI uses a localized status rather than the raw owner identifier. Removing or weakening the lease was rejected because it permits two writers to corrupt turn history.

2. **Use client-generated idempotency keys for turn admission.** `StartTurnRequest.clientRequestId` is optional for compatibility and is persisted on the turn. The service checks for an existing matching turn before returning Busy and again inside the thread mutation fence. A repeat returns the deterministic original user item ID. Reusing a key with a materially different prompt returns a conflict. Server-generated retry inference was rejected because identical prompts can be intentional.

3. **Bound foreground Bash at 15 minutes.** Background execution retains the existing 24-hour ceiling. A foreground process with no output emits non-durable liveness every 30 seconds; timeout and cancellation terminate the process tree and produce a terminal tool result. Extending the thread/SSE watchdog was rejected because stream liveness and tool duration are separate concerns.

4. **Introduce an explicit timeline page contract.** `GET /v1/threads/{id}/timeline` returns public items newest-first by page selection but ordered chronologically within each page, capped at 300 items and 4 MiB. `before` is an opaque cursor tied to the earliest item in the current page. The response also freezes `latestSeq`, exposes pending gate IDs and active-turn metadata, and returns `hasMore`. Session stores expose a page read so the route does not need to serialize the complete thread. The existing full-detail endpoint remains unchanged for compatibility.

5. **Hydrate latest state before history.** The renderer uses the timeline endpoint for normal selection, maps the page into existing blocks, then subscribes from the returned `latestSeq`. Older pages are prepended on demand and deduplicated by item ID. State lookup remains the recovery fast path if timeline hydration fails.

6. **Observability stays structured and sanitized.** Logs include thread/turn IDs, owner flavor, lease age, current tool duration, last progress age, request ID, and recovery outcome. Owner instance IDs and request contents are excluded from the user-facing message.

## Risks / Trade-offs

- **Older clients still request full history** → Keep compatibility but migrate the renderer immediately and log oversized legacy responses.
- **A page can contain one oversized item** → Return the item's bounded public preview while retaining its stable ID and terminal metadata.
- **A duplicate request races the first persistence** → Recheck after lease contention; clients retain and retry the same key until the original turn is observable.
- **Shorter foreground timeout affects legitimate builds** → Advertise the limit in the Bash schema and direct long jobs to explicit background execution.
- **Cursor history changes while paging** → Use stable item IDs/order metadata and deduplicate at merge; new events continue solely through SSE after the frozen replay floor.

## Migration Plan

Ship additive contracts first, then switch the bundled renderer to them in the same release. Legacy turns without `clientRequestId` and clients using full thread detail remain readable. Rollback can restore the old renderer calls because the existing endpoints and stored turn fields remain compatible.

## Open Questions

None.
