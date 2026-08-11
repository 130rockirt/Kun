## ADDED Requirements

### Requirement: Bounded thumbnail filmstrip
The workspace PPTX viewer SHALL expose a clickable 16:9 thumbnail rail while mounting no more than 16 rendered thumbnail DOM trees at once.

#### Scenario: Long deck scrolling
- **WHEN** a 50-slide PPTX is previewed and the user scrolls the filmstrip
- **THEN** near-viewport slides render as static non-interactive clones, off-screen slides use fixed placeholders, and mounted clones never exceed 16

#### Scenario: Thumbnail activation
- **WHEN** the user selects a thumbnail
- **THEN** the main preview renders that slide, updates the current-page state, highlights the thumbnail, and keeps it visible

### Requirement: Keyboard presentation controls
The viewer SHALL provide deterministic previous, next, first, last, and fullscreen keyboard controls without intercepting input in editable elements.

#### Scenario: Navigation keys
- **WHEN** focus is outside an input, textarea, select, or contenteditable element
- **THEN** arrows/PageUp/PageDown/Space/Home/End navigate within slide bounds and `F` toggles fullscreen

#### Scenario: Editable focus
- **WHEN** an editable control owns focus
- **THEN** the viewer does not prevent or reinterpret the keystroke

### Requirement: Audience-only fullscreen
Fullscreen playback SHALL show only the current audience slide and transient navigation controls, excluding the toolbar and filmstrip.

#### Scenario: Fullscreen inactivity
- **WHEN** fullscreen is active and the pointer is idle for two seconds
- **THEN** the navigation overlay hides until the pointer moves or navigation occurs

#### Scenario: Fullscreen failure or escape
- **WHEN** the Fullscreen API rejects entry or the user exits with Escape
- **THEN** the viewer remains usable, reports a bounded error when appropriate, and restores normal preview chrome

### Requirement: Source-scoped renderer lifecycle
The viewer MUST destroy all renderer instances, observers, static clones, queues, listeners, and timers when the source changes or the component unmounts.

#### Scenario: Source hash replacement
- **WHEN** refreshed PPTX bytes have a new source hash
- **THEN** both prior previewers and all thumbnail state are disposed before the new source becomes active

#### Scenario: Rendering failure
- **WHEN** either renderer fails while loading or producing a thumbnail
- **THEN** partial staging DOM is removed, safe main-preview error handling remains available, and fullscreen can still be exited

### Requirement: Preview security remains intact
The main slide and every thumbnail clone MUST retain the existing external-link hardening and MUST not expose a renderer-readable workspace file URL.

#### Scenario: Linked slide content
- **WHEN** PPTX content contains a hyperlink
- **THEN** rendered main and thumbnail DOM uses the existing safe external-link handling rather than direct untrusted navigation
