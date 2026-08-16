## 1. Shortcut registration and invocation

- [x] 1.1 Add the `command-palette` command definition to the shared keyboard-shortcut registry with `Ctrl+K` default bindings and a `darwin` platform default of `Meta+K`, plus its label and description keys
- [x] 1.2 Wire the workbench shortcut hook to an open-palette callback, suppressing invocation while the composer slash menu is open, an IME composition is active, or a native dialog owns input
- [x] 1.3 Add the workbench top-bar palette control for pointer discovery

## 2. Entry model, sources, and ranking

- [x] 2.1 Define the pure `PaletteEntry` model and activation descriptor union covering routes, settings destinations, threads, workspaces, shortcut commands, slash commands, and extension contributions
- [x] 2.2 Implement the shortcut-command, app-route, settings-destination, and slash-command sources derived from the existing shared registries
- [x] 2.3 Implement the conversation and recent-workspace sources against loaded store state with a bounded scan cap
- [x] 2.4 Implement the extension right-sidebar source from bounded Host-owned manifest metadata, omitting unavailable, disabled, and untrusted contributions and marking unreviewed ones locked
- [x] 2.5 Implement the pure tiered scorer with source-priority, recency, and stable-identity tie-breaking, and the prefix-based scope parser for `>`, `@`, `#`, and `/`

## 3. Overlay and activation

- [x] 3.1 Build the palette overlay with combobox/listbox semantics, roving active-option movement, live-region result counts, focus trapping, Escape dismissal, and focus restoration
- [x] 3.2 Implement the single activation dispatcher routing each descriptor through the existing store actions and desktop commands, closing the palette on success
- [x] 3.3 Render disabled entries with their localized reason, make their activation inert, and surface a localized notice when an activated target no longer resolves
- [x] 3.4 Route locked extension entries to the existing permission review without creating a View Session

## 4. Persistence and copy

- [x] 4.1 Add the versioned per-workspace recent-selection store with bounded retention, drop-on-read of unresolvable entries, and empty-list fallback for absent or unparsable values
- [x] 4.2 Render the empty-query state as recents followed by default destinations, and reload recents when the active workspace changes
- [x] 4.3 Add English and Simplified Chinese palette copy for labels, source labels, scope hints, disabled reasons, and empty states, leaving remaining locales on English fallback until translated

## 5. Verification

- [x] 5.1 Add focused tests for the scorer covering tier ordering, tie-breaking determinism, keyword-only matches, and scope parsing
- [x] 5.2 Add focused tests for source aggregation, extension fail-closed behavior, disabled entries, and unresolvable activation targets
- [x] 5.3 Add focused tests for invocation suppression, accessibility semantics, focus restoration, and recents persistence including workspace switching and bound overflow
- [x] 5.4 Confirm the composer slash-command menu, sidebar conversation search, Write, Design, and SDD behavior are unchanged
- [x] 5.5 Run focused Vitest, typecheck, lint, build, and strict OpenSpec validation

## 6. Conversation content deep search

- [x] 6.1 Add the local runtime route `GET /v1/threads/content-search` scanning bounded recent thread message content and returning one snippet per match
- [x] 6.2 Add the renderer runtime client method and debounced hook integration for unprefixed and `@`-scoped queries with duplicate suppression against the regular thread source
- [x] 6.3 Render the conversation-matches section in the overlay and add localized copy in all seven locales
- [x] 6.4 Add runtime route tests, palette mapping/dedupe tests, and strict OpenSpec validation

## 7. Review remediation

- [x] 7.1 Stop the empty-query state from rendering the whole catalog beneath the curated groups, and add the missing `useWorkbenchCommandPalette` coverage that let it through
- [x] 7.2 Add the lock-free `SessionStore.searchItemText` capability, implement it in the file store, delegate it through the hybrid and lifecycle-fenced stores, and move the content-search route onto it so a keystroke never takes a write queue or triggers compaction
- [x] 7.3 Scope content search to the active workspace and bound it by wall-clock time as well as thread count
- [x] 7.4 Keep the palette chord working on the Settings route by returning to the originating route before opening
- [x] 7.5 Preserve a pending composer draft on slash activation: feed it to argument-taking commands and otherwise decline with a localized notice
- [x] 7.6 List unbound shortcut commands without a badge, and list one row per settings destination instead of one per alias
- [x] 7.7 Register `command-palette` last so any user-assigned chord wins, consume the chord only when a palette exists, and suppress invocation while a native dialog owns input
- [x] 7.8 Bound stored recents by workspace count, ignore synthetic pointer moves during keyboard navigation, memoize per-entry word splitting, bound thread preview keywords, and report extension activation that could not act
- [x] 7.9 Re-run focused Vitest, typecheck, and lint across the runtime and renderer

## 8. Deep search delivery

- [x] 8.1 Allowlist `searchItemText` in the manager session-store proxy, its operation union, and the remote store, so shared-runtime deep search reaches a store that implements it instead of silently reporting no matches
- [x] 8.2 Highlight the matched term in result titles and snippets with literal, case-insensitive segmentation
- [x] 8.3 Surface a pending indicator from the keystroke through the debounce and request, and never render the empty state while a search is still running
- [x] 8.4 Add manager-proxy, highlighting, and pending-state coverage; verify the whole feature against the running app with Playwright

## 9. Scope trim for review

- [x] 9.1 Revert the unrelated runtime build-id flavor change in `resolve-kun-binary`, its test, and its `kun-adapter` call site; the latent development-flavor mismatch on `master` belongs in its own change
- [x] 9.2 Drop an unused test-only helper and narrow internal-only constants and helpers to module scope

## 10. Matching and recall depth

- [x] 10.1 Add an acronym tier so title initials reach a multi-word destination, ranked below word-boundary and above loose subsequence
- [x] 10.2 Extend highlighting to scattered acronym and subsequence hits so every result shows why it matched
- [x] 10.3 Replace pure recency with frecency, migrating stored recents from version 1 without reshuffling them, and keep activation stamps strictly increasing so same-millisecond bursts still order correctly
- [x] 10.4 Offer an unmatched query as a composer prompt instead of dead-ending, suppressed while a draft is pending or a deep search is still running
- [x] 10.5 Cover each with focused tests and re-verify the whole feature against the running app with Playwright

## 11. Cross-project recall

- [x] 11.1 Drop the workspace filter from the content-search route so a term is findable from any project
- [x] 11.2 Badge each conversation match with its project and make that project name searchable, so a result from elsewhere is never mistaken for a local one
- [x] 11.3 Update route, source, and hook coverage for cross-project results

## 12. Direct actions

- [x] 12.1 List every configured model with its provider and mark the one in use, switching the composer model on activation
- [x] 12.2 Offer reversible actions on the active conversation (pin/unpin, archive), re-checking the target before applying and deliberately excluding delete
- [x] 12.3 Cover both sources, their dispatch, and the stale-target path with focused tests, and verify each against the running app

## 13. Browsable opening view

- [x] 13.1 Render the empty-query state as recents, then quick actions, then the remaining catalog grouped into labeled sections in a stable order
- [x] 13.2 Keep the duplication guard that the original defect required: an entry promoted into recents or quick actions is omitted from its section below
- [x] 13.3 Preview conversations rather than listing every one, since typing reaches the rest including message content
- [x] 13.4 Give the result list room to browse, and add section-heading copy in all seven locales
