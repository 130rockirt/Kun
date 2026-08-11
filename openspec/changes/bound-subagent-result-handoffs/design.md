## Context

Kun executes delegated work in independent side threads, then projects a `ChildRunRecord` back into the parent thread. Today the projection source concatenates every assistant message from the child turn. That unbounded string is copied into the delegation store, child lifecycle event text, detached completion notice, and delegate tool output before generic tool-output offloading can run. The renderer displays cumulative child usage, which can be very large without itself proving a large return payload, but the unbounded projection path can still overflow a parent request or amplify heap usage.

Kun already has a content-addressed file Artifact Store and a `read_artifact` tool. The solution must reuse those facilities, preserve child threads as the canonical transcript, keep evidence/review/presentation payloads working, and stay compatible with both in-process and manager-backed artifact stores.

## Goals / Non-Goals

**Goals:**

- Bound the child result before any parent-facing persistence, event publication, notification, or tool result.
- Preserve full oversized Markdown results outside model context and make them incrementally readable.
- Make artifact-store failure safe: completion remains completion and raw oversized text is never reintroduced.
- Couple only newly linked child-result artifacts to related session lifetime while leaving existing artifacts unchanged.
- Recover once from recognized provider context overflow and otherwise fail only the affected turn.
- Keep the current child card and Open-child-thread interaction, adding only useful externalization status.

**Non-Goals:**

- Replacing child side threads or the existing Artifact Store.
- Automatically reading full externalized results into the parent context.
- Treating cumulative token usage as returned-result size.
- Removing the process memory-pressure shutdown guard.
- Retrofitting ownership semantics onto unrelated existing artifacts.

## Decisions

### Normalize the handoff at the child execution boundary

The child executor will select the last non-empty `assistant_text` item for the completed child turn. It will pass that string through a dedicated result materializer before returning to the delegation runtime. This is the earliest common point for synchronous, detached, and resumed execution, so downstream stores and events never see the raw oversized string.

An answer is oversized when any fixed limit is exceeded: 50 KiB UTF-8, 2,000 physical lines, or an approximate 8,000-token estimate. These independent guards cover dense minified output, line-heavy output, and Unicode/text cases. Inline summaries are capped at 4,000 characters.

Alternative considered: rely only on generic tool-output offloading. That runs after the delegation record and lifecycle event are produced, so it cannot protect those copies and does not cover detached notices.

### Return a structured bounded projection

`ChildRunRecord` and child executor results gain `summaryTruncated`, optional `resultRef`, and optional `resultUnavailableReason`. `resultRef` contains only `artifactId`, UTF-8 byte size, line count, and Markdown MIME type. The existing `summary` remains the inline preview for compatibility. Evidence, review bundles, deck artifacts, usage, and child identity remain separate fields.

Child lifecycle events will carry only the bounded preview/error in text and mirror the structured fields in child metadata. Detached notices and delegate tool results use the same bounded projection. The renderer maps the metadata to the existing child card; Open still navigates to the child thread.

### Use linked owners for result-artifact retention

Artifact inputs gain optional linked owner IDs. Content-addressed deduplication merges owners on an existing artifact. A release operation removes one owner and physically deletes an artifact only when it is marked linked and has no owners left. Unlinked artifacts preserve current behavior.

Each oversized result is linked to both the child run and parent thread. Child-record deletion releases the child owner; parent deletion releases its owner and cascades deletion of related child records/side threads. This allows deduplicated content to survive until the last related owner is gone.

Alternative considered: age-based cleanup. It can delete a result while a session still references it and does not satisfy conversation-scoped retention.

### Make artifact failure a bounded successful handoff

If `put` fails because of quota, I/O, or manager availability, materialization returns the capped preview with `summaryTruncated=true` and a sanitized `resultUnavailableReason`. It never returns the raw source as a fallback. The child remains completed because its independent thread still contains the canonical transcript.

### Retry provider context overflow once before turn failure

Provider errors will be classified centrally into a typed context-overflow error using status/body/message signals. If no partial assistant output has been committed, the turn lifecycle will request one forced compaction and retry the model round once. A repeated overflow, or an overflow after partial output, follows the normal per-turn failure path. It must not request runtime shutdown; the existing critical memory monitor remains a last-resort process guard.

## Risks / Trade-offs

- [Approximate token estimation differs from provider tokenizers] → Byte and line thresholds provide deterministic parallel safeguards and tests cover Unicode/dense text.
- [Owner updates race across manager clients] → Owner merging and release occur inside Artifact Store operations and manager RPC serializes each mutation.
- [Old child records lack new fields] → All fields are optional with schema defaults compatible with existing JSON files.
- [Thread deletion recursion can leave partial cleanup] → Abort child execution first, make release/delete idempotent, and test parent and direct child deletion paths.
- [Provider error strings vary] → Keep classification conservative and combine known status/code/message patterns; ordinary errors are not retried.
- [A preview may omit the key conclusion] → Use a deterministic head/tail preview and keep the full child thread accessible through Open.

## Migration Plan

1. Deploy additive schemas and manager transport support for linked owners and child result references.
2. Enable bounded materialization in the child executor so new records are safe immediately.
3. Add cleanup hooks and renderer metadata projection.
4. Existing child records and unlinked artifacts continue to load without migration.
5. Rollback is safe because new fields are optional; linked result files remain readable as ordinary artifacts.

## Open Questions

None. Thresholds and session-linked retention are intentionally fixed for this change; future settings can expose them without changing the contract.
