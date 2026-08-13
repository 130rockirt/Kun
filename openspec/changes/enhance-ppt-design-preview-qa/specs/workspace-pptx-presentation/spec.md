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

### Requirement: Browser renderer compatibility is source preserving
The viewer SHALL tolerate supported PPTX packages that expose singleton theme line styles or stale missing-part content-type declarations without modifying the workspace file.

#### Scenario: Parser-compatible in-memory retry
- **WHEN** initial browser model loading fails because `pptx-preview` cannot normalize a singleton line-style list or encounters a declared part that is absent from the ZIP
- **THEN** the viewer retries with an in-memory-only compatibility copy and renders the available slides while leaving the source bytes unchanged

#### Scenario: Incomplete inheritance remains unreadable
- **WHEN** the compatibility copy still lacks a usable slide, layout, or master relationship
- **THEN** the viewer reports a bounded presentation error and does not attempt to read an undefined background

### Requirement: Preview layout adapts to content and available space
The viewer SHALL remove redundant chrome for single-slide decks and initially fit the audience slide within the available canvas without unwanted horizontal or vertical overflow.

#### Scenario: Single-slide deck
- **WHEN** a PPTX contains exactly one slide
- **THEN** the viewer omits the thumbnail rail and slide-navigation controls while retaining zoom and fullscreen actions

#### Scenario: Multi-slide deck
- **WHEN** a PPTX contains more than one slide
- **THEN** the viewer shows a compact filmstrip whose static thumbnails fill their 16:9 cards without exposing fixed renderer staging space

#### Scenario: Canvas resize and manual zoom
- **WHEN** the available preview area changes before the user adjusts zoom
- **THEN** the slide remains centered and fitted within both dimensions; explicit zoom persists until reset restores automatic fit
