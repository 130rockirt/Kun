## Context

Kun already owns durable renderer-side queued messages, FIFO draining, pause/failure recovery, and explicit mid-turn guidance. The current queue UI, introduced outside OpenSpec, projects only the first item into a detached strip and exposes the full list through a hover/focus Portal with drag reorder and an overflow Edit action. DeepSeek Harness `master@0a53fb55bea101816fa226bb964ae2bed71c343b` instead uses an attached QueueDock: one row is direct, multiple rows collapse behind a total count, mutations happen inline, and the queue remains visible on failure.

The source checkout contains unrelated Startup UI work, so implementation must start from the committed local `develop` HEAD in a separate worktree and touch only queue/composer/OpenSpec/test files.

## Goals / Non-Goals

**Goals:**

- Match the frozen Harness QueueDock hierarchy, geometry, collapse rules, editing workflow, action order, accessibility, theme behavior, and narrow-width containment.
- Preserve Kun's existing FIFO delivery, image/Plan/Graph guidance eligibility, paused/failed recovery, idempotency, frozen model/provider/routing snapshots, and thread-local persistence.
- Make failed queued messages visible and recoverable.
- Add deterministic component, store, and Electron interaction/visual evidence.

**Non-Goals:**

- Change runtime steering routes, terminal sealing, delivery order, persistence format, send-key preferences, or ordinary busy-turn submission behavior.
- Add DSH's global queue/steer shortcut policy or automatically steer queued messages.
- Expose drag reorder or an overflow menu in the QueueDock; the existing store reorder action may remain for compatibility but is not rendered.
- Restore unrelated turn-section changes from the reverted historical QueueDock experiment.

## Decisions

### Port the attached dock, not the reverted commit

Rebuild the QueueDock from the frozen Harness source and current Kun contracts. Historical commit `8fbb9885c` is implementation evidence only: it mixed the dock with unrelated message-timeline behavior and was fully reverted. Direct cherry-pick is therefore unsafe.

`FloatingComposerAboveInputStack` gains a dedicated `attachedDock` seat before floating statuses. The queue leaves the absolute hover-status stack, so its bottom edge is physically closed by the composer card and never separated by Todo/Graph/Goal overlays.

### Use Harness single/multiple disclosure semantics

Zero visible rows render nothing. One row renders directly without a count header. Two or more rows start collapsed behind a total-count button and expand inline. Editing or an asynchronous action forces the list open and disables collapse. Emptying the queue resets the next multi-row appearance to collapsed.

Starting/in-flight rows stay hidden because their user item is already owned by an admitted turn. Pending, paused, and failed rows stay visible; safely replayable paused/failed rows expose retry plus removal. Provisional `waitForRuntimeAdmission` failures retain removal but disable retry because their original admission waiter has already settled and replay would otherwise disappear during drain.

### Edit the same queued identity safely

Add `editQueuedMessage(id, text)` to the chat store. It is allowed only for pending, plain-text rows whose optional `displayText` is absent or exactly mirrors `text`, and that contain no attachments, file references, extension/write/design/Plan context, or derived structured prompt. The action preserves queue identity, frozen model/provider/reasoning/routing fields, and ordering; because the payload changes, it issues a fresh client request id, replaces mirrored text, and clears stale derived background-runtime/checkpoint payloads before persisting.

Save is rejected for blank text, unsupported payloads, missing ids, or rows already paused/failed/starting/in-flight. The editor remains open on rejection. Enter saves outside IME composition; Escape cancels; Save/Cancel replace the ordinary action set while editing.

### Serialize mutation presentation

The dock keeps one local busy id while Guide/Retry or future asynchronous Edit operations settle. Collapse and all row mutations are disabled during that window. A failed Guide/Retry keeps the authoritative row; existing store error reporting remains the user notification path. Remove stays synchronous but is disabled while another action owns the dock.

### Use Kun semantic tokens with fixed Harness geometry

A CSS module owns the 36px header/row, 28px editor/actions, 10px action spacing, 12px top corners, square bottom, 180px list cap, separators, ellipsis, focus rings, and a 3px tuck beneath the composer top edge. Colors map the Harness tip/border/label semantics to Kun tokens; no literal light-only colors or queue-specific dark branch is introduced.

## Risks / Trade-offs

- [Editing derived prompts could desynchronize visible and runtime text] → Restrict edit to truly plain mirrored text and clear only known derived background payloads.
- [A live queue update removes the row being edited] → Cancel the local editor when its stable id disappears.
- [A second item arrives during edit] → Interaction state forces the newly multi-row dock open.
- [Long queues grow over the composer] → Cap the list at 180px and scroll only the list.
- [Existing hover/reorder tests encode the regressed design] → Replace them with reference-derived dock tests instead of retaining contradictory assertions.
- [Failed items contain long error text] → Keep the row at 36px, show a compact failure indicator/status and expose the full error through accessible title text.
- [A provisional admission failure is retried after its waiter settled] → Disable unsafe retry, retain the row, and direct the user to remove and resubmit.

## Migration Plan

No persisted migration is required. Existing queued records are projected into the new dock immediately. Rollback restores the previous renderer components; store/runtime queue data remains compatible.

## Open Questions

None. The reference commit, geometry, disclosure behavior, edit safety boundary, and preservation of current Kun delivery semantics are fixed.
