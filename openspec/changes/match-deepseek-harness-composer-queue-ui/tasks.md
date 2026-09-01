## 1. Queue State and Contracts

- [x] 1.1 Add a pure safe-inline-edit policy that accepts only pending mirrored plain text, preserves stable queue/routing fields, and clears stale derived background payloads.
- [x] 1.2 Add and persist `editQueuedMessage(id, text)` without changing queue id/order or unrelated records, while rotating the client request id for the changed payload.
- [x] 1.3 Wire Edit through Workbench and composer props, and project failed/error queue metadata required for visible recovery.

## 2. Harness QueueDock Renderer

- [x] 2.1 Add a dedicated composer `attachedDock` seat so queue UI physically joins the composer and remains separate from floating status overlays.
- [x] 2.2 Replace QueueStrip/hover Portal/reorder/overflow UI with single-row direct and multi-row collapsed/expanded QueueDock disclosure.
- [x] 2.3 Implement same-ID inline Save/Cancel/Enter/Escape/IME behavior, mutation single-flight, failure retention, and paused/failed Retry presentation.
- [x] 2.4 Port Harness geometry into a scoped CSS module, map semantic Kun theme tokens, add all-locale copy, and remove obsolete strip styling/component.

## 3. Verification

- [x] 3.1 Add focused safe-edit/store tests for identity/routing preservation, derived-field clearing, invalid edits, persistence, and unrelated-row stability.
- [x] 3.2 Replace contradictory strip/popover/reorder tests with reference-derived QueueDock component tests for disclosure, live updates, editing, IME, action locking, failure states, and accessibility.
- [x] 3.3 Add a deterministic Electron QueueDock smoke covering single/multi disclosure, inline edit, failure/retry, 36/28/12/180 geometry, attachment to composer, narrow layout, and light/dark screenshots.
- [x] 3.4 Run focused tests, `npm run typecheck`, `npm run build:kun`, `npm run build`, changed-file ESLint, file-line/OpenSpec/diff checks, and separate existing baseline failures.
- [x] 3.5 Commit, rebase onto latest local `develop`, rerun affected checks, fast-forward merge without overwriting source changes, prove containment, and remove the worktree/branch.

## 4. Multi-row Ordering Follow-up

- [x] 4.1 Wire the existing persisted `reorderQueuedMessage` action through every composer variant to the attached QueueDock.
- [x] 4.2 Add expanded-list drag handles, midpoint before/after drop indicators, keyboard ArrowUp/ArrowDown ordering, and live drag-state cleanup without changing DSH disclosure geometry.
- [x] 4.3 Add focused component/store and Electron smoke coverage for drag, keyboard order, persistence, action locking, collapsed/single states, and race-safe no-ops.
- [x] 4.4 Run validation, commit, rebase onto latest local `develop`, fast-forward merge, prove containment, and remove the worktree/branch.
