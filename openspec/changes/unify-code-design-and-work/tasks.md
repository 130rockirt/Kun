## 1. Runtime Contracts and Persistence

- [x] 1.1 Add strict Design task profile and document-target schemas to Kun thread, turn, create/send, summary, event, renderer client, and mapper contracts.
- [x] 1.2 Atomically lock the first accepted Design profile, reject surface/profile conflicts, preserve snapshots through replay, and copy the contract through thread fork/persistence.
- [x] 1.3 Add focused Kun contract, admission, persistence, and fork tests for legacy, invalid, idempotent, and conflicting requests.

## 2. Renderer Task State and Navigation

- [x] 2.1 Make Code task creation explicitly surface-owned, add Design task creation with provisional document rollback, and list both Code and Design tasks in one Code-workbench collection.
- [x] 2.2 Replace standalone Design navigation with Code/Work top-level navigation and normalize legacy Design route activation without deleting legacy data.
- [x] 2.3 Persist unlocked per-task drafts, restore locked runtime profiles, freeze profile data in queued messages, and show Code/Design task indicators.

## 3. Embedded Design Execution

- [x] 3.1 Extract the full Design document canvas into a reusable right-workspace surface with durable thread binding, focus/narrow presentation, and document-scoped live/replay filtering.
- [x] 3.2 Route Design-task composer submissions through the existing HTML/SVG/motion/multi-page Design pipeline on the same thread, including first-send rollback and internal HTML continuation behavior.
- [x] 3.3 Implement primary HTML and AI-image lanes, runtime capability gating, immutable style/target snapshot injection, and replay-safe automatic image placement.

## 4. Unified Workbench UX

- [x] 4.1 Add the empty-task Code/Design selector, task-specific starters, and a responsive composer profile control for output medium, Web/App, and existing Design presets.
- [x] 4.2 Remove task/profile selectors after the first accepted turn, keep shared model/workspace/permission controls, and omit Code-only Plan/Graph/goal controls from Design.
- [x] 4.3 Remove the standalone Design stage/sidebar/assistant from the active workflow while preserving legacy files and stable extension surface semantics.
- [x] 4.4 Replace the Code/Work segmented control with a compact accessible dropdown that preserves workspace routing and remains readable in narrow sidebars.

## 5. Work Product Rename

- [x] 5.1 Rename user-facing Write workspace, assistant, settings, onboarding, knowledge-base, and empty-state terminology to Work/办公 across all supported locales without changing internal `write*` keys.
- [x] 5.2 Update Work starter content and documentation to describe Markdown editing and Office/PDF preview, quotation, analysis, and generation without claiming native Office editing.

## 6. Verification

- [x] 6.1 Add renderer tests for task-mode locking, shared task lists, profile isolation, HTML/image routing, capability failures, canvas replay, responsive controls, and legacy compatibility.
- [x] 6.2 Run targeted tests, `npm run typecheck`, `npm run test`, `npm run build`, `npm run check:file-lines`, and `git diff --check`; resolve introduced failures and record completion evidence.

  - Evidence (2026-08-12): full typecheck and production build passed; 249 focused renderer/main tests, 40 focused Kun tests, 2 runtime-manifest tests, and 127 focused canvas lifecycle tests passed; changed-file ESLint and `git diff --check` passed.
  - The repository-wide test run was also executed. Changed-feature suites passed; remaining reported failures were verified against `HEAD` as pre-existing ToolStormBreaker, FileSessionStore usage, native ABI/module, TUI timing, and locale-parity baselines.
  - `npm run check:file-lines` reports only two unchanged baseline files: `src/main/claw-runtime.workspace-turn-results.test.ts` at 701 lines and `src/renderer/src/components/WorkspaceOfficeRenderers.test.ts` at 705 lines.

## 7. Review Remediation And Intent Correction

- [x] 7.1 Separate Code-workbench thread ownership from its task mode; allow Code/Design selection before the first turn, then enforce the accepted mode in runtime admission while preserving Design tool routing.
- [x] 7.2 Make first Design-profile admission retry-safe and crash-safe so only an accepted Design turn can lock the profile.
- [x] 7.3 Make Design fork, side-fork, and resume commit/cleanup ordering safe, and expose session-only Design metadata needed to clone a recovery target.
- [x] 7.4 Keep a per-thread pre-send mode draft, restore the locked Code/Design mode from runtime history/profile metadata, and remove the selector after the first accepted turn.
- [x] 7.5 Preserve legacy standalone Design records and document bindings during the initial unified-workbench transition without migrating or deleting their data.
- [x] 7.6 Persist the resolved root `DESIGN.md` style snapshot or deterministic parsed equivalent in the locked profile and identify its source in the composer.
- [x] 7.7 Make Design document cloning replay-safe, prevent historical-turn forks from pairing truncated chat with future canvas state, and add fault-injection coverage.
- [x] 7.8 Place every successful primary AI-image result idempotently even when the same turn also applies ShapeOps.
- [x] 7.9 Add cross-layer regression tests for Code/Design mode locking, admission retry/restart, legacy records, fork/resume failure boundaries, replay receipts, AI placement, and immutable styles.
- [x] 7.10 Re-run focused suites, full typecheck/build/tests, lint, file-line gate, and diff checks; record only verified baseline failures.
- [x] 7.11 Make Design fork/resume/side operations idempotent across response loss and reconcile durable provisional clones without deleting late runtime commits.
- [x] 7.12 Fence queued guidance and extension contributions by the locked task surface, Design profile, and document target rather than mutable pre-send drafts.
- [x] 7.13 Guard asynchronous Design restoration by thread/workspace/document generation and render explicit-document artifacts without mutable global-state bleed.
- [x] 7.14 Open legacy or other-task Design documents read-only by default and require an explicit crash-safe clone before continuing in the current conversation.
- [x] 7.15 Add focused failure-injection and mode-lock tests for operation retries, rejected cross-mode turns, read-only history, async task switches, queue guidance, and task-surface extension routing.
- [x] 7.16 Hide AI-image output choices when runtime diagnostics report image generation disabled, normalize only unlocked stale drafts to HTML, and preserve enabled-but-unavailable and locked-profile behavior.

  - Evidence (2026-08-13): `npm run typecheck`, `npm run build`, `npm run lint`, `npm run check:file-lines`, and `git diff --check` passed. Focused Kun suites passed 46/46 tests; focused renderer/main suites passed 143/143 tests across admission, guidance, Design delivery, fork/resume, Plan recovery, canvas/empty-state, and extracted-file regressions.
  - Full Kun tests passed 4352 tests. Remaining failures were verified baseline/environment failures in ToolStormBreaker/loop recovery, native `node-pty` and `better-sqlite3` ABI loading, TUI/goal timing, and unrelated legacy expectations. The top-level full run passed 6896 tests before focused fixes; remaining unrelated baselines cover locale parity, provider/packaging expectations, dev-preview policy, and settings UI lifecycle.

## 8. Embedded Whiteboard Review Remediation

- [x] 8.1 Preserve a valid acyclic shape tree during reparenting and retain same-document undo history across background hydration.
- [x] 8.2 Make HTML/SVG follow-up generation recoverable when a Design replay is interrupted before asynchronous work finishes.
- [x] 8.3 Scope clipboard and asynchronous image paste operations to the initiating document/workspace and prefer a current system image over stale internal shapes.
- [x] 8.4 Restore image annotation, main-composer actions, focused shortcuts, and all supported drawing/layer controls on the embedded Design route.
- [x] 8.5 Restore Design whiteboard export, including user and agent entry points, without silently omitting rendered artifact previews.
- [x] 8.6 Keep automatic sizing until a resize actually changes geometry, expose the supported resize axes, and mount prototype-flow visualization.
- [x] 8.7 Add focused regression coverage for graph integrity, replay recovery, document races, route gating, export, shortcuts, and resize behavior.
- [x] 8.8 Run focused suites, typecheck, build, lint, file-line gate, and diff checks; record any verified baseline-only failures.

  - Evidence (2026-08-13): 88 focused Design canvas files passed 709/709 tests, including replay recovery, graph integrity, annotation, export, clipboard, shortcuts, resize, and composer routing. Web TypeScript and the production build passed.
  - `npm run lint`, `npm run check:file-lines`, and `git diff --check` passed. Lint retained only existing repository warnings outside this change; the full `npm run typecheck` remained blocked by pre-existing Kun dependency/type baselines, while the affected renderer TypeScript project passed cleanly.

## 9. First Design Send Race Remediation

- [x] 9.1 Add a renderer regression test that activates a newly created Code-owned conversation before `createThread` resolves and verifies the pending Design intent and provisional document survive.
- [x] 9.2 Preserve the pending Design task surface across first-thread activation, then run focused tests, renderer typecheck/build, lint, the file-line gate, and diff checks.

  - Evidence (2026-08-13): the focused task-surface and Design-prompt suites passed 19/19 tests, including the new activation-before-return regression. The production build, lint, file-line gate, and `git diff --check` passed; lint retained only 25 existing warnings outside this change.
  - The full typecheck was run in both the fix worktree and the unchanged local `develop` worktree. Both reported the same existing errors in `FloatingComposer.queue-commands.test.ts` and `settings-section-model-routes-support.tsx`, confirming no new typecheck failure from this remediation.

## 10. Design Task Presentation And Whiteboard Delivery Remediation

- [x] 10.1 Add sidebar regression tests for Code-owned Design conversations restored through `lockedTaskSurface` and `designProfile`, while preserving Code and legacy Design behavior.
- [x] 10.2 Render the task icon and accessible label from the durable locked task mode.
- [x] 10.3 Add a Code-whiteboard regression for renderer tool output that completes before the thread document is ready, including idempotent remount behavior.
- [x] 10.4 Bind live replay to the expected Code document and durably replay missed tool results, then run focused tests, typecheck/build, lint, the file-line gate, OpenSpec validation, and diff checks.

  - Evidence (2026-08-13): 96 focused Design canvas, embedded-canvas, shared-task-list, and task-surface files passed 773/773 tests. The production build, lint, file-line gate, strict OpenSpec validation, and `git diff --check` passed; lint retained only 25 existing warnings. Full typecheck was run in both the fix worktree and unchanged local `develop`; both reported the same existing errors in `FloatingComposer.queue-commands.test.ts` and `settings-section-model-routes-support.tsx`.

## 11. Design Session List And Canvas Restoration Remediation

- [x] 11.1 Revise the unified task-list and embedded-whiteboard contracts so project-owned legacy and Code-owned Design conversations share the list and restore the full Design surface without data migration.
- [x] 11.2 Centralize Design task classification and apply it to sidebar filtering, task icons, navigation, selection memory, and Code-workbench return behavior.
- [x] 11.3 Restore legacy registry and Code-owned profile targets through the full Design document canvas, keeping a Design loading state while the target hydrates.
- [x] 11.4 Add focused regressions and run targeted tests, typecheck, full tests, lint, build, file-line gate, strict OpenSpec validation, and diff checks.

  - Evidence (2026-08-13): 8 focused sidebar, navigation, task-surface, canvas, and store files passed 92/92 tests. `npm run build`, `npm run lint`, `npm run check:file-lines`, strict OpenSpec validation, and `git diff --check` passed; lint retained only existing warnings outside this change.
  - Full renderer/main tests passed 7133 tests with 11 failures, and full Kun tests passed 4386 tests with 21 failures. Every renderer/main failure file was reproduced on unchanged local `develop`; the remaining baselines cover Design's existing 701-line boundary, locale parity, provider/settings/packaging expectations, dev-preview policy, worktree admission, ToolStormBreaker/loop recovery, native ABI loading, and unrelated timing/overlay expectations.
  - Kun TypeScript passed. Full typecheck was run in both the fix worktree and unchanged local `develop`; both reported only the same existing DOM-versus-React `KeyboardEvent` errors in `settings-section-model-routes-support.tsx`.

## 12. Per-Turn Surface Correction

- [x] 12.1 Replace session-level Code/Design mutual exclusion with per-turn surface selection: keep `thread.agentSurface: 'code'`, persist each turn's `agentSurface`, and scope `lockedTaskSurface` to legacy `write`/`design` records only.
- [x] 12.2 Make runtime admission accept Code→Design→Code→Design, reject only Design-profile mismatches with `design_profile_locked`, and stop rejecting Code turns with `task_surface_locked`.
- [x] 12.3 Register `task_surface_locked` and `design_profile_locked` in the shared runtime-error contract and make deterministic 4xx rejections fail exactly once instead of entering the unknown-result recovery loop.
- [x] 12.4 Add queue failure governance: terminal `failed` delivery state, explicit retry/delete, and backoff/circuit-breaking for unknown errors.
- [x] 12.5 Split renderer task state into next-turn surface, profile lock, and Design-document presence so the whiteboard binding follows the document, not the next-turn choice.
- [x] 12.6 Carry the full whiteboard host target (`surfaceKind + workspace + threadId + documentId + boardArtifactId`) and render a Code icon with a Design artifact badge for mixed conversations.
- [x] 12.7 Add generation placeholder, in-place success replacement, actionable failure/abort state with retry, and delivery-wording gating to the embedded whiteboard.
- [x] 12.8 Add generation-aware open, first-success fit-to-content, and focus/full-width presentation with a usable minimum width.
- [x] 12.9 Add focused regressions for admission, error codes, queue governance, renderer state split, whiteboard lifecycle, replay, and focus layout; then run targeted tests, typecheck, build, lint, file-line gate, strict OpenSpec validation, and diff checks.

  - Evidence (2026-08-13): strict OpenSpec validation passed for `unify-code-design-and-work`. Focused renderer suites passed 39/39 tests across workbench task surface, sidebar mixed badge, image-generation progress, shared runtime-error codes, and queue governance; Kun admission suites passed 12/12 tests including the new `design_profile_locked` and Code-with-profile conflict cases; the previously failing store admission/guidance/classification suites were updated to per-turn semantics and pass 60/60. The renderer TypeScript project passes cleanly; the only remaining error is the pre-existing `settings-section-model-routes-support.tsx` DOM-versus-React `KeyboardEvent` baseline documented in section 11. Every changed file is at or below the 700-line gate; `git diff --check` passes; lint retained only pre-existing warnings outside this change.

## 13. Mode-Neutral Conversation Presentation

- [x] 13.1 Remove conversation-level Code/Design icons and Design artifact badges while preserving the single shared task list, per-turn composer selector, and Design document restoration.
- [x] 13.2 Add focused sidebar regressions, replace the stale Kun session-lock expectation with a Code→Design→Code→Design same-thread regression, and run targeted tests, renderer typecheck, the file-line gate, strict OpenSpec validation, and diff checks.

  - Evidence (2026-08-14): focused sidebar and renderer per-turn task-surface suites passed 19/19 tests; focused Kun admission/profile suites passed 21/21 tests; renderer and Kun TypeScript plus changed-file ESLint passed; strict OpenSpec validation and `git diff --check` passed. Every file changed by this correction is below 700 lines. The repository-wide file-line gate was run and reported only two files outside this correction: `useWorkbenchComposerSubmitController.ts` at 705 lines and `chat-store-thread-send-direct.ts` at 701 lines.

## 14. First Design Whiteboard Delivery Race

- [x] 14.1 Keep the full Design host active from provisional intent through profile hydration, including a board-scoped cached surface.
- [x] 14.2 Prevent live and durable Code-canvas replay from consuming turns that carry an immutable Design document target.
- [x] 14.3 Add focused regressions and run renderer typecheck, build, lint, the file-line gate, strict OpenSpec validation, and diff checks.

  - Evidence (2026-08-14): 7 focused renderer files passed 55/55 tests across provisional Design activation, host-target isolation, live/durable replay, and Code whiteboard delivery. The production build, changed-file ESLint, strict OpenSpec validation, and `git diff --check` passed. Renderer typecheck was run and reported only existing worktree errors outside this correction in `settings-section-model-routes-support.tsx` and `canvas-receipt-sender.test.ts`; the repository-wide file-line gate likewise reported only the separately modified `design-task-profile.test.ts` and `useWorkbenchComposerSubmitController.ts`.
