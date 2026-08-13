## ADDED Requirements

### Requirement: Design tasks use the full Design surface in the Code right workspace
The Code right workspace SHALL mount the bound Design document with the existing HTML, SVG, motion, multi-screen, design-system, prototype, selection, undo, and export capabilities.

#### Scenario: HTML design task
- **WHEN** an HTML Design task requests a page or application screen
- **THEN** the right whiteboard creates and previews a linked interactive HTML artifact instead of a plain Code-canvas frame

#### Scenario: Panel presentation changes
- **WHEN** the user collapses, focuses, resizes, or reopens the whiteboard
- **THEN** the task, locked profile, selected document, and artifact state remain unchanged

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
