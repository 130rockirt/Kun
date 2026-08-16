## Context

The renderer already owns every mechanism a palette needs, but none of them are joined. `KEYBOARD_SHORTCUT_COMMANDS` in `src/shared/keyboard-shortcuts.ts` defines commands as `{ id, labelKey, descriptionKey, defaultBindings, platformDefaultBindings }` and `resolveKeyboardShortcutBindings` already merges user bindings with platform defaults. `useWorkbenchKeyboardShortcuts` maps a matched command id either to a workbench callback or to a window-level `DesktopCommand`. Navigation is expressed as `AppRoute` and `SettingsRouteSection` in `chat-store-types.ts`, driven by the `setRoute`, `openSettings`, `selectThread`, and `chooseWorkspace` store actions. The composer already models user-invocable actions as `SlashCommand` objects carrying `title`, `description`, `keywords`, `icon`, `badge`, `scopeLabel`, and `disabled`, and already represents skills as `skill:<id>` command ids.

Two constraints shape the design. First, extension right-sidebar contributions are Host-owned, workspace-scoped, and permission-gated; a palette row must not become a path that renders extension-controlled content or activates a View before workspace review. Second, the composer slash menu is an existing, heavily used command surface with its own key handling, so a second global command surface must be additive rather than competing.

## Goals / Non-Goals

**Goals:**

- Give the GUI one keyboard-first entry point that reaches any existing route, settings destination, conversation, workspace, command, or skill.
- Reuse the existing command, route, and slash-command registries as the palette's sources so a new destination appears in the palette by construction.
- Make invocation a normal rebindable shortcut command rather than a hardcoded key.
- Keep ranking pure and deterministic so result ordering is unit-testable.
- Preserve extension trust, workspace scoping, and permission review unchanged.

**Non-Goals:**

- Searching message content, memory entries, artifacts, or workspace file contents. The palette indexes entity metadata only, with one later extension: a bounded conversation-content deep search (see the `gui-command-palette` spec) for unprefixed and `@`-scoped queries via a dedicated local runtime route.
- Replacing, absorbing, or restyling the composer slash-command menu or the sidebar conversation search.
- Running agent turns, sending prompts, or mutating threads from the palette.
- Adding preload IPC, Kun runtime routes, or extension manifest surface.
- Fuzzy-matching across locales beyond the existing localized label and keyword text.

## Decisions

### 1. The palette aggregates existing registries instead of defining its own

A palette source is a pure function from renderer state to a `PaletteEntry` list, where an entry carries a stable id, a source kind, localized title and subtitle, optional keywords, an optional badge, a `disabled` reason, and an activation descriptor. Sources are: shortcut commands, app routes, settings sections, in-scope threads, recent workspaces, builtin and skill slash commands, and visible extension right-sidebar contributions.

This keeps one registry per concept. Adding a settings section to `SettingsRouteSection` or a command to `KEYBOARD_SHORTCUT_COMMANDS` makes it reachable from the palette without a second edit, which is the property that keeps a palette from decaying into a stale subset of the app.

Alternative considered: a dedicated palette command registry that each feature registers into. Rejected because it duplicates existing enums and guarantees drift the first time a contributor adds a route and forgets the registration.

### 2. Invocation is a registry command, not a hardcoded key

The palette adds `command-palette` to `KEYBOARD_SHORTCUT_COMMANDS` with `defaultBindings: ['Ctrl+K']` and `platformDefaultBindings: { darwin: ['Meta+K'] }`. `useWorkbenchKeyboardShortcuts` gains one callback that opens the palette.

This inherits three behaviors for free: the settings shortcuts section lists and rebinds it, `normalizeKeyboardShortcuts` validates it against `COMMAND_IDS`, and platform key normalization is already handled. Because `findKeyboardShortcutCommand` resolves the first command whose bindings match, a user who has already bound the same chord to another command keeps that command's behavior; the palette does not special-case itself ahead of user configuration.

Alternative considered: a hardcoded `Ctrl+K`/`Meta+K` listener in the palette component. Rejected because it bypasses the settings UI, cannot be rebound or disabled, and would silently shadow a user's existing binding.

### 3. Sources are lazily evaluated with a synchronous fast path

Route, settings, shortcut, and slash-command sources are derived synchronously from in-memory state and are always available on open. The thread and workspace sources read from already-loaded store state, are capped at a bounded scan, and are recomputed on query change rather than on every keystroke of unrelated state. Any source that cannot resolve is omitted rather than blocking the palette.

Alternative considered: eagerly materializing all entries on open. Rejected because thread lists grow without bound over a project's life and the palette must open instantly.

### 4. Query prefixes scope the search

A leading `>` restricts results to commands, `@` to conversations, `#` to settings, and `/` to slash commands; anything else searches all sources. The prefix is stripped before matching. An empty query renders the recent-selection list, then a small default set of high-frequency destinations.

Prefixes are a learned convention from comparable palettes and cost nothing when unknown, since unprefixed search still reaches everything.

Alternative considered: a tab-based filter row. Rejected because it requires a pointer or an extra keystroke for the common case and adds chrome to a surface whose value is speed.

### 5. Ranking is a pure, deterministic scorer

Matching runs in tiers — exact title match, title prefix, word-boundary match on title or keywords, then subsequence match — and each tier is tie-broken first by source priority, then by per-workspace recency, then by stable entry id. Scoring takes a query and an entry list and returns an ordered list with no access to stores, timers, or randomness.

Determinism is the point: ordering is the part of a palette users build muscle memory around, and a pure scorer lets tests assert exact result order rather than mere membership.

Alternative considered: an off-the-shelf fuzzy matcher. Rejected because the repository ships no such dependency, tier boundaries would become implicit, and localized labels in the seven shipped locales need predictable word-boundary behavior more than they need aggressive fuzziness.

### 6. Activation routes through existing store actions only

Each entry's activation descriptor is a discriminated union resolved by a single dispatcher: `route` calls `setRoute`, `settings` calls `openSettings(section)`, `thread` calls `selectThread`, `workspace` calls `chooseWorkspace`, `shortcut-command` invokes the same callback or `DesktopCommand` that the shortcut handler would, `slash-command` inserts the command into the composer without sending it, and `extension-view` uses the existing right-workspace tab controller.

No activation path introduces a new mutation. The palette is a router over existing behavior, which keeps its blast radius to the overlay itself.

### 7. Extension rows are fail-closed and never execute extension code

Extension entries are built from bounded Host-owned manifest display metadata already used by the launcher rail. Icons resolve through the existing extension resource protocol, which serves only exact manifest-declared icon paths. A contribution whose workspace review is pending renders as a locked entry whose activation opens the existing permission review rather than the View, and unavailable, disabled, or untrusted contributions are omitted.

### 8. The palette yields to the composer slash menu

The palette does not open while the composer slash-command menu is open, while an IME composition is active, or while a native dialog owns input. Slash-command entries in the palette insert text into the composer and leave sending to the user, so the two surfaces stay complementary: the slash menu is the in-composer path and the palette is the global path.

Alternative considered: routing the composer slash menu through the palette. Rejected because it would move command entry out of the composer's typing flow and change an established interaction for no discovery gain.

### 9. Curated groups and ranked results are mutually exclusive

The overlay renders `results` followed by `groups`, so the two must never describe the same rows. With no query and no scope the hook emits curated groups and an empty result list; with any query it emits ranked results and, at most, a conversation-matches group. The scorer still treats an empty query as "everything matches", which is what makes a scoped empty query such as `#` a browsable settings list.

Alternative considered: letting the overlay ignore `results` whenever `groups` is present. Rejected because the conversation-matches group must render *alongside* ranked results, so the overlay cannot decide this on its own — the hook is the only place that knows which state it is in.

### 10. Content search uses a lock-free store capability, not item loading

`SessionStore.loadItems` takes the per-thread write queue and compacts item history past the compaction threshold. Both are correct for the agent loop and wrong for a keystroke: a search would contend with an in-flight turn and could rewrite a multi-megabyte log as a side effect of typing (#621). Search therefore gets its own optional capability, `searchItemText`, which reads the tail of `messages.jsonl` under a byte budget, pre-filters raw lines before parsing, verifies the hit against real item text, and never writes.

A store that cannot honor those guarantees leaves the capability undefined, and the route reports no matches. Degrading the feature is strictly better than degrading the runtime.

Alternative considered: keeping `loadItems` and lowering the thread cap. Rejected because it reduces the frequency of the hazard without removing it — a single large active thread is enough.

### 11. Settings keeps the chord by leaving Settings

AppShell renders Settings *instead of* the workbench, so the palette overlay and its sources are unmounted there. Rather than build a second reduced palette for one route, the Settings surface listens for the chord and uses the existing `closeSettings` action, which restores the route Settings was opened from, before opening the palette.

Alternative considered: hoisting the palette to AppShell. Rejected because its sources and activation handlers are workbench-owned; lifting them would mean threading most of the workbench through the shell for one route.

## Risks / Trade-offs

- **Binding collision.** `Ctrl+K` is currently unused in the renderer, but a future editor binding could want it. Mitigated by shipping it as a rebindable registry command and by honoring an existing user binding ahead of the palette default.
- **Two search surfaces.** The palette and the sidebar conversation search can both find a thread. Accepted: the sidebar stays scoped to its section and ordering, the palette is global and keyboard-first, and neither changes the other's behavior.
- **Large thread histories.** Unbounded scanning would make the palette feel slow exactly where it matters most. Mitigated by a bounded scan cap, recency-first ordering, a per-thread byte budget, and a wall-clock budget for the whole scan.
- **Tail-window search misses old content.** Reading the tail of a thread log bounds the work but means a term that appears only early in a very long conversation is not found. Accepted: the alternative is unbounded reads on the typing path, and recent content is what a palette query is usually after.
- **Localized matching quality.** Word-boundary matching is weaker for locales without spaces, notably Simplified Chinese, Japanese, and Thai. Mitigated by keeping the subsequence tier and by matching against keywords in addition to titles; further tuning is deferred rather than guessed at.
- **Discovery of the palette itself.** A keyboard-only surface is invisible to pointer users. Mitigated by a workbench top-bar entry point alongside the shortcut.

## Migration Plan

No existing persisted state changes shape. The recent-selection store is a new versioned key scoped by normalized workspace; an absent or unparsable key yields an empty list and the palette falls back to its default entry set. Entries referencing a thread, workspace, or extension contribution that no longer resolves are dropped on read rather than repaired.

Adding `command-palette` to the shortcut registry is additive: `normalizeKeyboardShortcuts` already discards unknown ids, so settings written by an older build load unchanged, and settings written by a newer build load in an older build with the unknown binding discarded.

## Open Questions

- Should the palette eventually index message content, memory entries, and artifacts? That is the more valuable search product but requires a persistent index and is deliberately out of scope here.
- Should activating a skill entry prefill the composer or start the turn immediately? This change prefills, on the reasoning that a palette should never send an agent request the user has not seen.
- Should the palette expose an extension contribution point so extensions can register their own entries? Deferred until the built-in source set is proven.
