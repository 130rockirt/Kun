## ADDED Requirements

### Requirement: Kun opens a global command palette from a rebindable shortcut
Kun SHALL provide a modal command palette overlay in the GUI workbench. Invocation SHALL be a `command-palette` command in the shared keyboard-shortcut registry with a default binding of `Ctrl+K` and a macOS platform default of `Meta+K`. The palette SHALL also be reachable from a workbench top-bar control. The palette MUST be dismissible with Escape and MUST restore focus to the previously focused element on close.

#### Scenario: User opens the palette with the default binding
- **WHEN** the workbench has focus and the user presses the resolved `command-palette` binding
- **THEN** Kun SHALL open the palette overlay with an empty query and focus its input

#### Scenario: User rebinds the palette shortcut
- **WHEN** the user assigns a different chord to `command-palette` in the shortcuts settings section
- **THEN** the new chord SHALL open the palette and the previous default SHALL no longer open it

#### Scenario: Palette binding is already claimed by another command
- **WHEN** a user binding assigns the palette's default chord to a different shortcut command
- **THEN** Kun SHALL run that other command and SHALL NOT open the palette

#### Scenario: User dismisses the palette
- **WHEN** the palette is open and the user presses Escape
- **THEN** Kun SHALL close the overlay without activating a result and SHALL return focus to the element focused before the palette opened

### Requirement: Palette results aggregate existing navigation and command sources
The palette SHALL build results from existing renderer registries and state: keyboard-shortcut commands, top-level app routes, settings destinations, conversation threads in the active scope, recent workspaces, builtin and skill slash commands, and visible extension right-sidebar contributions. Each result MUST carry a stable identity, a localized title, a source-identifying label, and an activation descriptor. The palette MUST NOT define a parallel command registry.

A shortcut command with no assigned chord SHALL still be listed, without a binding badge. A settings section that resolves to a destination another listed section already reaches SHALL be listed once.

#### Scenario: A new settings destination is added
- **WHEN** a settings destination is added to the shared settings route union and given localized copy
- **THEN** it SHALL be reachable from the palette without a separate palette registration

#### Scenario: Command has no keyboard binding
- **WHEN** a shortcut command has no default or user-assigned chord
- **THEN** the palette SHALL list it as an activatable result with no binding badge

#### Scenario: Two settings sections resolve to one destination
- **WHEN** a legacy settings section alias opens the same destination as another listed section
- **THEN** the palette SHALL list that destination once rather than showing two differently-labeled rows for it

#### Scenario: Results identify their source
- **WHEN** the palette displays results drawn from more than one source
- **THEN** each result SHALL display a localized source label distinguishing commands, conversations, settings, workspaces, skills, and extensions

#### Scenario: A source cannot be resolved
- **WHEN** one result source fails to resolve for the active workspace
- **THEN** the palette SHALL omit that source and SHALL continue to display results from every other source

### Requirement: Query prefixes scope palette results
The palette SHALL scope results by leading prefix: `>` SHALL restrict results to commands, `@` to conversations, `#` to settings destinations, and `/` to slash commands. Any other leading character SHALL search all sources. The prefix MUST be stripped before matching and the active scope MUST be indicated in the palette.

#### Scenario: User scopes the query to settings
- **WHEN** the user types `#` followed by a settings term
- **THEN** the palette SHALL return only settings destinations matching that term

#### Scenario: User searches without a prefix
- **WHEN** the user types a term with no recognized prefix
- **THEN** the palette SHALL return ranked results drawn from every available source

#### Scenario: Scoped query has no matches
- **WHEN** a scoped query matches nothing in its source
- **THEN** the palette SHALL display a localized empty state for that scope and SHALL NOT silently widen the scope

### Requirement: Palette ranking is deterministic
Result ordering SHALL be produced by a pure scoring function over the query and the candidate entries, with no dependency on wall-clock time, randomness, or store access. Matching SHALL proceed in tiers — exact title match, title prefix match, word-boundary match against title or keywords, title acronym, then subsequence match — and ties MUST be broken by source priority, then per-workspace frecency, then stable entry identity.

#### Scenario: Exact match outranks a prefix match
- **WHEN** the query exactly matches one entry title and is a prefix of another
- **THEN** the exactly matching entry SHALL be ordered first

#### Scenario: Equal-tier results are ordered stably
- **WHEN** two entries match in the same tier with the same source priority and no recency
- **THEN** the palette SHALL order them by stable entry identity and SHALL produce the same order on every evaluation of the same query

#### Scenario: Entry matches on keywords only
- **WHEN** the query matches an entry's keywords but not its title
- **THEN** the entry SHALL be eligible at the word-boundary tier and SHALL rank below entries matching the same query on title

### Requirement: Activating a result reuses existing navigation actions
Palette activation SHALL route through existing store actions and desktop commands. Route entries SHALL set the app route, settings entries SHALL open their settings destination, conversation entries SHALL select that thread, workspace entries SHALL use the existing workspace-selection flow, shortcut-command entries SHALL run the same behavior as the shortcut, slash-command entries SHALL insert the command into the composer without sending it, and extension entries SHALL open or activate the matching right-workspace tab. Activation MUST NOT introduce preload IPC, Kun runtime HTTP or SSE, or extension manifest surface.

#### Scenario: User activates a conversation result
- **WHEN** the user activates a conversation result
- **THEN** Kun SHALL select that thread through the existing thread-selection action and SHALL close the palette

#### Scenario: User activates a skill result
- **WHEN** the user activates a skill slash-command result
- **THEN** Kun SHALL place that command in the composer and SHALL NOT start an agent turn

#### Scenario: Composer already holds a draft
- **WHEN** the composer holds unsent text and the user activates a slash-command result
- **THEN** Kun MUST NOT discard that text
- **AND** for an argument-taking command the draft SHALL become the command's argument
- **AND** for any other command Kun SHALL leave the composer untouched and surface a localized notice

#### Scenario: Result target is no longer available
- **WHEN** the activated entry references a thread, workspace, or contribution that no longer resolves
- **THEN** Kun SHALL close the palette without navigating and SHALL surface a localized unavailable notice

#### Scenario: Entry is disabled in the current context
- **WHEN** an entry is disabled for the active thread, workspace, or route
- **THEN** the palette SHALL render it with its localized disabled reason and activation MUST have no effect

### Requirement: Extension entries remain fail-closed
Extension results SHALL be constructed from bounded Host-owned manifest display metadata and MUST NOT execute extension code, evaluate extension scripts, or create a View Session to populate a palette row. Icons MUST resolve through the existing extension resource protocol, which serves only exact manifest-declared icon paths. Unavailable, disabled, or untrusted contributions MUST be omitted.

#### Scenario: Extension awaits workspace review
- **WHEN** an enabled and compatible extension contributes a right-sidebar View that the active workspace has not reviewed
- **THEN** the palette SHALL show a locked entry containing only bounded manifest display metadata
- **AND** activating it SHALL open the existing permission review without creating a View Session

#### Scenario: Extension is unavailable in the active workspace
- **WHEN** a contribution is not available for the active workspace
- **THEN** the palette SHALL omit it rather than showing an inert entry

#### Scenario: Extension declares no icon
- **WHEN** a contributed View has no valid declared icon
- **THEN** the palette SHALL render a Host-owned fallback icon without executing extension code

### Requirement: The palette does not displace the composer slash-command menu
The composer slash-command menu SHALL retain its existing invocation, filtering, and selection behavior. The palette MUST NOT open while the composer slash-command menu is open, while an IME composition is active, or while a native dialog owns input.

#### Scenario: Slash menu is open when the palette chord is pressed
- **WHEN** the composer slash-command menu is open and the user presses the palette binding
- **THEN** Kun SHALL leave the slash menu open and SHALL NOT open the palette

#### Scenario: IME composition is active
- **WHEN** a text input has an active IME composition and the user presses the palette binding
- **THEN** Kun SHALL NOT open the palette and SHALL NOT consume the key event

#### Scenario: A native dialog owns input
- **WHEN** a Main-owned native dialog is open and the palette binding is pressed
- **THEN** Kun SHALL NOT open the palette and SHALL NOT consume the key event
- **AND** suppression SHALL apply only to the palette, leaving other shortcut commands resolvable

#### Scenario: No palette surface is mounted
- **WHEN** the palette chord resolves in a surface with no palette to open
- **THEN** Kun SHALL leave the key event unconsumed rather than swallowing it

### Requirement: The palette chord yields to any user-assigned command
`command-palette` SHALL be ordered last in the shared keyboard-shortcut registry so that first-match resolution gives every other command precedence for a chord a user has assigned to it, regardless of that command's position.

#### Scenario: User binds the palette chord to a late-registered command
- **WHEN** a user assigns the palette's chord to a command registered after the palette's previous position, such as a window command
- **THEN** Kun SHALL run that command and SHALL NOT open the palette

### Requirement: The palette chord works on the Settings route
Settings replaces the workbench surface that owns the palette overlay, so the palette MUST remain reachable there. Pressing the palette binding on the Settings route SHALL return to the route Settings was opened from and open the palette.

#### Scenario: User presses the palette chord inside Settings
- **WHEN** the user opens a settings destination from the palette and then presses the palette binding again
- **THEN** Kun SHALL leave Settings for the originating route and SHALL open the palette there

### Requirement: The palette is keyboard accessible
The palette SHALL expose a combobox input associated with a listbox of results, SHALL move the active option with Arrow, Home, End, Page Up, and Page Down, SHALL activate the selected option with Enter, and SHALL communicate the active option through ARIA relationships. Focus MUST be trapped within the overlay while it is open.

#### Scenario: Keyboard user moves through results
- **WHEN** the palette has results and the user presses an arrow key
- **THEN** the active option SHALL move, the list SHALL scroll it into view, and the input SHALL reference the active option through ARIA

#### Scenario: Screen reader announces result count
- **WHEN** the result set changes in response to a query
- **THEN** the palette SHALL expose the current result count through a live region

### Requirement: Recent palette selections are workspace-scoped and bounded
Kun SHALL persist a bounded, ordered list of recent palette selections per normalized workspace under a versioned renderer storage key, and SHALL render that list as the empty-query state. Entries that no longer resolve MUST be dropped on read. An absent, unparsable, or unversioned value MUST yield an empty list rather than an error.

#### Scenario: User reopens the palette after activating results
- **WHEN** the user opens the palette with an empty query after previously activating results in this workspace
- **THEN** the palette SHALL list the most recent selections first, followed by default destinations

#### Scenario: Workspace changes
- **WHEN** the active workspace changes
- **THEN** the palette SHALL load that workspace's recent selections and SHALL NOT show recents from the previous workspace

#### Scenario: Stored recents exceed the bound
- **WHEN** more selections are recorded than the retention bound allows
- **THEN** Kun SHALL retain the most recent entries up to the bound and SHALL discard the oldest

#### Scenario: Selections accumulate across many workspaces
- **WHEN** selections have been recorded in more workspaces than the scope bound allows
- **THEN** Kun SHALL retain the most recently written scopes up to that bound and SHALL discard the least recent

### Requirement: The empty-query state browses the whole capability surface
With no query and no scope prefix the palette SHALL render recent selections, then default destinations, then the remaining catalog grouped into labeled sections, so opening the palette shows everything it can do rather than a curated few. Sections SHALL appear in a stable order.

No entry may appear more than once in one rendered result set: an entry promoted into recents or defaults MUST be omitted from its section below. The catalog MUST be rendered as grouped sections only, never additionally as a flat list beneath them.

Conversations are content rather than capability and MAY be previewed rather than listed in full, since typing reaches the rest including message content.

#### Scenario: User opens the palette
- **WHEN** the user opens the palette and has typed nothing
- **THEN** the palette SHALL render recents, then default destinations, then labeled sections covering commands, navigation, settings, models, conversations, projects, and extensions
- **AND** no entry SHALL be rendered twice

#### Scenario: A destination is also a recent or a default
- **WHEN** an entry appears in recents or default destinations
- **THEN** it MUST NOT appear again in its own section further down

#### Scenario: The workspace holds many conversations
- **WHEN** more conversations exist than the preview bound allows
- **THEN** the palette SHALL show the most recent up to that bound rather than every one

#### Scenario: User types after opening
- **WHEN** the user types a query into the freshly opened palette
- **THEN** the palette SHALL replace the curated groups with ranked results from every available source

### Requirement: The palette deep-searches conversation content
Kun SHALL extend unprefixed and `@`-scoped palette queries with a deep search over the message content of recent conversations, served by a dedicated local runtime route, and SHALL render each matching conversation under a distinct section with a snippet around the matched text. Deep search MUST NOT run for command, settings, or slash scopes, MUST be debounced, and MUST be bounded in scanned threads, returned matches, and wall-clock duration.

Deep search SHALL span every project rather than only the active one, because recalling a discussion rarely comes with recalling which project it happened in. Every match MUST carry the workspace it belongs to, and each rendered row MUST show that project, so a result from elsewhere is never mistaken for one in the current project. The bounds above are shared across all projects, so a busy project can crowd out a quieter one.

#### Scenario: Query matches a conversation in another project
- **WHEN** a term appears in the message content of a conversation belonging to a different project
- **THEN** the palette SHALL list that conversation
- **AND** the row SHALL identify the project it belongs to

#### Scenario: Matches come from several projects
- **WHEN** conversations in more than one project match a term
- **THEN** the palette SHALL order them by recency across all projects

#### Scenario: Scan exceeds its time budget
- **WHEN** scanning the candidate conversations reaches the route's wall-clock budget
- **THEN** the route SHALL return the matches found so far rather than continuing

### Requirement: The palette acts, not only navigates
The palette SHALL offer actions the user can complete without leaving it: switching the composer's model, and reversible actions on the active conversation. Every configured model SHALL be listed with its provider, and the model in use MUST be marked rather than hidden. Conversation actions SHALL be offered only while an unarchived conversation is active, and MUST re-check that the target still exists before applying, reporting it unavailable otherwise.

Destructive actions MUST NOT be offered. Deleting a conversation from a fuzzy-matched row is a trap that a mistyped query can spring, and the sidebar already offers deletion behind an explicit confirmation.

#### Scenario: User switches model from the palette
- **WHEN** the user activates a model result
- **THEN** the composer SHALL send with that model and provider
- **AND** reopening the palette SHALL mark that model as the active one

#### Scenario: User pins the conversation they are in
- **WHEN** an unarchived conversation is active and the user activates the pin action
- **THEN** Kun SHALL pin that conversation
- **AND** the action SHALL read as unpin while it stays pinned

#### Scenario: No conversation is active
- **WHEN** no conversation is active, or the active one is archived
- **THEN** the palette SHALL offer no conversation actions

#### Scenario: Action target disappeared
- **WHEN** an activated conversation action targets a conversation that no longer resolves
- **THEN** Kun SHALL apply nothing and SHALL surface a localized unavailable notice

#### Scenario: User searches for a destructive action
- **WHEN** the user types a term that would match deleting a conversation
- **THEN** the palette SHALL NOT offer any destructive action

### Requirement: Title initials reach a destination
Matching SHALL include an acronym tier that accepts a query matching the initials of a multi-word title, ranked below word-boundary matches and above loose subsequence. A single-word title MUST NOT produce an acronym match, because its initial is already covered by the prefix tier.

#### Scenario: User types the initials of a destination
- **WHEN** the user types the initials of a multi-word destination, such as `ks` for a two-word settings title
- **THEN** that destination SHALL match at the acronym tier

#### Scenario: A word-boundary match competes with an acronym match
- **WHEN** one entry matches a query on a word boundary and another only on its initials
- **THEN** the word-boundary match SHALL rank first

### Requirement: Recall improves with use
Recent selections SHALL be ordered by frecency, combining how often an entry has been activated in the workspace with how recently, so a frequently used destination outranks a once-used newer one until its weight decays. Stored recents from the previous version MUST migrate without reordering what the user already recognizes, and repeated activations within the same millisecond MUST still order deterministically by activation sequence.

#### Scenario: A habit outranks a one-off
- **WHEN** one entry has been activated many times and another once more recently
- **THEN** the frequently used entry SHALL be listed first until its weight decays below the newer one

#### Scenario: Stored recents predate frecency
- **WHEN** recents stored by the previous version are read
- **THEN** they SHALL migrate in place and keep their existing order

### Requirement: Deep search reports its own progress
While a conversation deep search is debouncing or in flight, the palette SHALL show a pending indicator and MUST NOT render its empty state. The pending state SHALL begin at the keystroke rather than at the request, so the debounce window is covered, and MUST clear whether the search succeeds or fails.

#### Scenario: Results have not arrived yet
- **WHEN** the user types a term long enough to trigger deep search and no results have arrived
- **THEN** the palette SHALL show a searching indicator
- **AND** it MUST NOT state that there are no matching results

#### Scenario: Some results are already visible
- **WHEN** ranked results are already rendered while deep search is still running
- **THEN** the palette SHALL keep a searching indicator visible so the user knows more may arrive

#### Scenario: Deep search fails
- **WHEN** the conversation content search rejects
- **THEN** the palette SHALL clear the pending indicator and fall back to its normal empty or result state

### Requirement: Matched terms are highlighted in results
The palette SHALL visually emphasize occurrences of the searched term in result titles and snippets. Matching SHALL be literal and case-insensitive so a query containing regex metacharacters highlights exactly what the user typed, and the rendered text MUST remain byte-identical to the source text.

#### Scenario: Term appears in a conversation snippet
- **WHEN** a conversation content match is rendered for a query
- **THEN** each occurrence of the term within the snippet SHALL be emphasized

#### Scenario: Query contains regex metacharacters
- **WHEN** the query contains characters such as `.`, `$`, or `+`
- **THEN** the palette SHALL highlight those literal characters and MUST NOT treat them as a pattern

#### Scenario: Query carries a scope prefix
- **WHEN** the query is scoped, such as `@checkout`
- **THEN** highlighting SHALL match the stripped term rather than the prefix

### Requirement: Deep search never blocks conversation writes
Content search SHALL read item history through a store capability that takes no per-thread write queue and performs no history compaction, so a palette keystroke cannot contend with an in-flight turn or rewrite a thread log. Search SHALL read only user and assistant message text, excluding tool payloads and reasoning. A store without that capability MUST report no matches rather than falling back to the blocking item-load path.

#### Scenario: Store exposes only the blocking item-load path
- **WHEN** the runtime's session store provides no lock-free search capability
- **THEN** the route SHALL return no matches and MUST NOT call the blocking item-load path

#### Scenario: Thread log is large enough to trigger compaction
- **WHEN** a candidate thread's item history exceeds the compaction threshold
- **THEN** the search SHALL read it without rewriting it and the log SHALL be unchanged afterwards

#### Scenario: Query matches a tool payload
- **WHEN** the query appears only inside tool call arguments or tool output
- **THEN** the search SHALL NOT report that thread as a match

#### Scenario: User types a word that only appears inside a message
- **WHEN** the user opens the palette and types a term that appears in a conversation's message content but not in its title or preview
- **THEN** the palette SHALL list that conversation in a conversation-matches section with a snippet around the matched text
- **AND** activating it SHALL select that thread

#### Scenario: Match already surfaced by the regular thread source
- **WHEN** a conversation matches both the regular thread source and the content search
- **THEN** the palette SHALL show the conversation once, without a duplicate content-match row

#### Scenario: Deep search has no matches
- **WHEN** the query matches no conversation content
- **THEN** the palette SHALL show no conversation-matches section and SHALL leave the existing empty state unchanged

#### Scenario: Scoped queries skip deep search
- **WHEN** the query carries a `>`, `#`, or `/` scope prefix
- **THEN** Kun SHALL NOT run the conversation content search
