## Why

Kun's GUI has grown many destinations — chat, Write, Design, Schedule, Workflow, Claw, Plugins, Extensions, twenty-five settings sections, per-workspace conversations, skills, and extension Views — but no single way to reach them. Discovery is split across the sidebar, the workbench top bar, the settings sidebar, and the composer slash menu, so reaching a destination requires already knowing which surface owns it.

The only keyboard surface today is a fixed registry of twenty commands in `src/shared/keyboard-shortcuts.ts`, most of which are window-level desktop actions (quit, zoom, devtools) rather than navigation. Conversation search is scoped to one sidebar section and matches only title, preview, and workspace. The TUI already exposes a command surface; the GUI has no equivalent.

A palette binds the existing feature set together without adding new runtime capability: every destination it reaches is already reachable, and every action it runs is already implemented as a store action or a desktop command.

## What Changes

- Add a renderer-owned modal command palette overlay, opened by a new rebindable `command-palette` entry in the shared keyboard-shortcut registry with platform defaults of `Meta+K` on macOS and `Ctrl+K` elsewhere.
- Aggregate palette results from existing sources instead of introducing a second command registry: keyboard-shortcut commands, top-level app routes, settings destinations, conversation threads in scope, recent workspaces, builtin and skill slash commands, and visible extension right-sidebar contributions.
- Add query mode prefixes so users can scope a search: `>` for commands, `@` for conversations, `#` for settings, `/` for slash commands, and unprefixed text for a mixed ranked result set.
- Rank results through a pure, deterministic scorer (exact, prefix, word-boundary, then subsequence match) tie-broken by source priority and per-workspace recency, so ordering is assertable in tests.
- Activate results exclusively through existing store actions and desktop commands. Except for the conversation-content deep search below, the palette adds no preload IPC, Kun HTTP/SSE, or extension manifest surface.
- Keep the composer slash-command menu unchanged and non-overlapping: the palette SHALL NOT open while the composer slash menu is active, and SHALL NOT replace in-composer command entry.
- Keep extension rows fail-closed: render only bounded Host-owned manifest display metadata, never execute extension code to populate a row, and route unreviewed contributions to the existing permission review.
- Persist a bounded per-workspace recent-selection list, bounded in stored workspaces as well as entries, and surface it as the palette's only empty-query content.
- Deep-search conversation message content for unprefixed and `@`-scoped queries through one new local runtime route (`GET /v1/threads/content-search`), spanning every project (each match badged with the project it came from) and bounded in scanned threads, matches, and wall-clock time, rendered as a conversation-matches section with snippets.
- Add a lock-free `searchItemText` session-store capability for that route, so a palette keystroke never takes a thread's write queue or triggers history compaction the way item loading does; stores without it report no matches instead of falling back. The manager session-store proxy carries the capability so the shared runtime the GUI actually uses can serve it.
- Highlight the matched term in result titles and snippets, and show a pending indicator from the keystroke until the search settles so a slow search never reads as an empty one.
- Keep the palette chord alive on the Settings route, which replaces the workbench surface that owns the overlay, by returning to the originating route and opening the palette there.
- Register `command-palette` last in the shortcut registry so first-match resolution gives every other command precedence for a chord a user assigned to it.
- Give the overlay full combobox/listbox accessibility, roving keyboard focus, Escape dismissal, and focus restoration to the previously focused element.

## Capabilities

### New Capabilities

- `gui-command-palette`: Palette invocation, result source aggregation, query scoping, deterministic ranking, activation routing, extension trust handling, recency persistence, and accessibility.

## Impact

- Renderer workbench gains a palette overlay, a palette store slice, pure source-aggregation and ranking modules, and focused tests.
- `src/shared/keyboard-shortcuts.ts` gains one command definition; the existing shortcuts settings section lists and rebinds it with no section-specific changes.
- Locale files gain palette labels, descriptions, mode hints, and empty-state copy.
- Renderer local storage gains one additive versioned key for per-workspace recent selections; absence of the key yields an empty recents list.
- Kun gains one additive local route, `GET /v1/threads/content-search`, and one optional `SessionStore.searchItemText` capability implemented by the file store and delegated through the hybrid and lifecycle-fenced stores. Existing store behavior, including item loading and compaction, is unchanged.
- The Settings surface gains a palette-chord listener; preload IPC, extension manifest schema, the composer slash-command menu, the sidebar conversation search, and Write, Design, and SDD behavior are unchanged.
- The renderer gains a small native-dialog activity tracker so the palette can honor its "native dialog owns input" suppression rule; the workspace picker reports through it.
