## 1. Busy Contract And Admission

- [x] 1.1 Preserve `thread_busy` in shared error parsing and expose sanitized structured busy details.
- [x] 1.2 Add optional `clientRequestId` persistence and idempotent turn-start handling with conflict coverage.

## 2. Renderer Recovery

- [x] 2.1 Generate and reuse client request IDs for submitted messages and retain a Busy-rejected submission exactly once in the queue.
- [x] 2.2 Reconcile thread state and active SSE on `thread_busy`, restore busy controls, and replace raw owner errors with localized actionable status.

## 3. Foreground Tool Liveness

- [x] 3.1 Change the foreground Bash default ceiling to 15 minutes while retaining a 24-hour background ceiling and update tool guidance.
- [x] 3.2 Add non-durable silent-command liveness plus shared timeout/cancellation process-tree cleanup and regression tests.

## 4. Bounded Thread Timeline

- [x] 4.1 Add bounded SessionStore page reads and a `/v1/threads/{id}/timeline` contract capped at 300 public items and 4 MiB.
- [x] 4.2 Hydrate the renderer from timeline pages, preserve the SSE replay floor, and prepend older pages without duplicate blocks.

## 5. Verification

- [x] 5.1 Add cross-layer regression tests for Busy recovery, retry idempotency, tool timeout, pagination, ordering, and SSE continuity.
- [x] 5.2 Run focused tests, typecheck, Kun build, application build, and diff hygiene checks.
