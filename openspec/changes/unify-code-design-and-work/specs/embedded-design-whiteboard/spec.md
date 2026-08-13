## ADDED Requirements

### Requirement: Design tasks use the full Design surface in the Code right workspace
The Code right workspace SHALL mount the bound Design document with the existing HTML, SVG, motion, multi-screen, design-system, prototype, selection, undo, and export capabilities.

#### Scenario: HTML design task
- **WHEN** an HTML Design task requests a page or application screen
- **THEN** the right whiteboard creates and previews a linked interactive HTML artifact instead of a plain Code-canvas frame

#### Scenario: Panel presentation changes
- **WHEN** the user collapses, focuses, resizes, or reopens the whiteboard
- **THEN** the task, locked profile, selected document, and artifact state remain unchanged

#### Scenario: Code-owned Design task restoration
- **WHEN** a Code-owned conversation is classified as Design by its locked task surface or Design profile
- **THEN** selecting it restores the profile document and board in the full Design surface instead of the lightweight Code canvas

#### Scenario: Legacy Design task restoration
- **WHEN** the user selects a legacy Design conversation that owns an existing registry document binding
- **THEN** the right whiteboard opens that original writable `.kun-design` document in the full Design surface
- **AND** cross-task document previews retain their existing read-only continuation behavior

#### Scenario: Design target hydration
- **WHEN** a Design conversation is active before its document target finishes hydrating
- **THEN** the right whiteboard renders a Design loading state and never falls back to the lightweight Code canvas

### Requirement: HTML and AI image are distinct primary lanes
HTML SHALL be the default primary medium; AI-image tasks SHALL generate raster assets on the whiteboard and SHALL NOT silently create HTML screens.

#### Scenario: HTML with supporting image
- **WHEN** an HTML task needs a visual asset and image generation is available
- **THEN** it may generate and embed the asset while keeping HTML as the primary artifact

#### Scenario: AI-image output
- **WHEN** an AI-image task completes `generate_image`
- **THEN** the generated workspace image is placed on the active whiteboard and no HTML artifact is created as a fallback

### Requirement: AI-image placement is deterministic and replay-safe
The renderer SHALL idempotently place successful primary AI-image results by filling the selected empty holder when one exists or using the current recommended slot otherwise.

#### Scenario: Fill selected holder
- **WHEN** an AI-image result completes while one empty image holder is selected
- **THEN** that holder receives the generated path without changing its bounds

#### Scenario: SSE replay
- **WHEN** the same successful image tool result is observed again after reconnect
- **THEN** the renderer recognizes its completion identity and does not insert a duplicate image

### Requirement: Whiteboard surfaces generation progress and failure
The renderer SHALL represent an in-flight AI-image generation with a persistent placeholder, replace it in place on success, and render an actionable error state on failure or abort.

#### Scenario: Generation starts a placeholder
- **WHEN** an image tool enters pending on a bound Design document
- **THEN** the whiteboard creates a generating placeholder at the recommended slot and persists it through reload and replay

#### Scenario: Success replaces the placeholder
- **WHEN** the pending image tool completes
- **THEN** the placeholder is replaced in place by the generated image without duplicating it

#### Scenario: Failure or abort is actionable
- **WHEN** the pending image tool fails or the turn is aborted before completion
- **THEN** the placeholder becomes an error state showing the reason, elapsed time, and a retry action, and never returns to blank

#### Scenario: Delivery wording tracks completion
- **WHEN** the assistant says an image will be placed on the whiteboard
- **THEN** the delivery status stays in progress until the tool reports success, then becomes delivered

### Requirement: Whiteboard supports focus and generation-aware layout
The Code right whiteboard SHALL open on generation start, fit content after the first successful placement, and provide a focus/full-width presentation with a minimum usable width.

#### Scenario: Auto-open on generation
- **WHEN** an image generation begins for a bound Design document
- **THEN** the whiteboard opens automatically

#### Scenario: First fit-to-content
- **WHEN** the first successful image is placed
- **THEN** the viewport performs one fit-to-content

#### Scenario: Focus and full width
- **WHEN** the user activates focus or full-width mode
- **THEN** the whiteboard expands to a usable minimum width without changing the bound document or canvas state

### Requirement: Image capability failures do not alter task intent
The composer SHALL use runtime image-generation diagnostics as the authority for AI-image availability and SHALL never switch a locked Design conversation to HTML because the provider is unavailable.

#### Scenario: Image generation disabled before first send
- **WHEN** runtime diagnostics report that image generation is not enabled before the first Design turn is accepted
- **THEN** AI image is absent from the output choices and any unlocked stale AI-image draft falls back to HTML

#### Scenario: Unconfigured provider before first send
- **WHEN** image generation is enabled but unavailable before the first Design turn is accepted
- **THEN** AI image is disabled with the runtime reason and an Image Generation settings action while HTML remains available

#### Scenario: Provider removed after lock
- **WHEN** a locked AI-image conversation loses its image provider
- **THEN** submission is blocked with the draft preserved and a configuration action, and the conversation remains AI image

### Requirement: Style is resolved and locked from existing Design contracts
The Design composer SHALL reuse Kun's supported DesignSystemPreset catalog, resolve Auto deterministically, and seed the bound document without overwriting its later persisted design-system state.

#### Scenario: Explicit preset
- **WHEN** the user chooses iOS/Apple before the first Design turn
- **THEN** the locked profile stores `ios` and both HTML and image prompts receive its defined visual guidance

#### Scenario: Project DESIGN.md
- **WHEN** Auto is selected and a valid root `DESIGN.md` exists
- **THEN** the UI identifies the project style and the profile follows that source instead of layering a conflicting preset
