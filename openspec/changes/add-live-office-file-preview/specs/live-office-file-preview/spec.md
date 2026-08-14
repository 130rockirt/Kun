## ADDED Requirements

### Requirement: Agent Office edits open a live preview without overriding user choice
The workbench SHALL detect Office file changes from structured agent tool-event
fields and SHALL create one preview tab per changed Office file. It MUST focus
only the first Office file of a turn and MUST not steal focus after the user
closes the preview or selects another preview target in that turn.

#### Scenario: First Office change in a turn
- **WHEN** an agent emits a `file_change` for an Office file in the active chat turn
- **THEN** the workbench opens the File Preview panel and focuses that file once

#### Scenario: Later Office change after user interaction
- **WHEN** the user has selected or closed a file preview during the turn and another Office file changes
- **THEN** the workbench adds or refreshes the file tab without changing the selected panel or target

### Requirement: Office previews refresh after stable binary writes
The system SHALL support signal-only workspace file watches for Office binaries
and SHALL refresh an open Office preview after a debounced stable write. It
MUST keep the last successful preview visible while an update is loading and
MUST ignore stale render results.

#### Scenario: Atomic Office edit completes
- **WHEN** an Office file is atomically replaced after a validated edit batch
- **THEN** the watch event causes the preview to render the new source SHA after the debounce period

#### Scenario: Refresh fails
- **WHEN** a new Office preview cannot be rendered
- **THEN** the last successful preview remains visible and the panel reports the refresh error

### Requirement: Previewed Office content is sandboxed and source-preserving
The system SHALL render OfficeCLI HTML only after stripping executable and
network-capable content, and SHALL display it in a scriptless sandboxed iframe.
Legacy Office files SHALL be converted only to private temporary files using a
locally available LibreOffice executable; the source file MUST not be modified.

#### Scenario: Sanitized Office HTML is displayed
- **WHEN** OfficeCLI returns HTML with scripts, event attributes, forms, or remote resources
- **THEN** the preview result removes those capabilities and the iframe cannot run scripts or make network requests

#### Scenario: LibreOffice is unavailable
- **WHEN** a user opens a legacy `.doc`, `.xls`, or `.ppt` file and LibreOffice is not available
- **THEN** the preview displays an actionable local-installation error without changing the source file
