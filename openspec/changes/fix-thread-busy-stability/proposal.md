## Why

Long-running foreground tools can retain a thread lease for hours while the GUI misclassifies the server's `thread_busy` response as `unknown`. On large conversations, full-history hydration can also time out and make an active thread look idle, so users can repeatedly submit work, see internal runtime identifiers, and lose confidence in the product.

## What Changes

- Preserve the structured `thread_busy` error across Kun, Electron, and the renderer, then reconcile the GUI with the authoritative active turn instead of rendering a raw error.
- Make turn admission retry-safe with a client request identifier so transport retries cannot create duplicate turns or messages.
- Bound foreground shell execution, expose liveness, and reliably terminate process trees on timeout or cancellation while retaining explicit background execution for long jobs.
- Add a bounded, paginated thread timeline so opening a large conversation does not transfer or materialize its entire history.
- Add structured observability and regression coverage for busy recovery, command liveness, and large-thread hydration.

## Capabilities

### New Capabilities

- `thread-execution-recovery`: Authoritative busy-state reconciliation, queued user intent, and idempotent turn admission.
- `bounded-tool-execution`: Foreground shell duration limits, progress, cancellation, and terminal cleanup semantics.
- `paged-thread-history`: Size- and count-bounded timeline hydration with cursor pagination and SSE continuity.

### Modified Capabilities

None.

## Impact

The change affects Kun turn contracts and routes, thread/session storage, the built-in Bash tool, Electron runtime requests, shared runtime error types, and renderer chat state. Existing clients that omit the new optional request identifier and clients that use the existing full thread endpoint remain compatible.
