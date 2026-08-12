## ADDED Requirements

### Requirement: Write mode opens Office files as read-only tabs
The system SHALL list and open DOC, DOCX, XLS, XLSX, PPT, and PPTX workspace files in Write editor groups using the bundled browser Office renderers, and SHALL never expose Office save or in-place editing controls.

#### Scenario: Open a modern Office file
- **WHEN** a writer selects a supported modern Office file from the Write tree or quick-open list
- **THEN** the system opens a read-only tab with the format-specific browser preview, navigation, scrolling, and zoom controls

#### Scenario: Open a legacy Office file
- **WHEN** a writer opens DOC or PPT and LibreOffice is available
- **THEN** the system previews a private converted snapshot without modifying the source file

#### Scenario: Legacy conversion is unavailable
- **WHEN** a legacy Office preview requires LibreOffice and it is unavailable
- **THEN** the system displays an actionable installation message and leaves the source unchanged

### Requirement: Office previews refresh safely
The system SHALL watch each unique visible Office path once, debounce refreshes by 250 milliseconds, ignore stale results, and retain the last successful preview when a refresh fails.

#### Scenario: Office file changes while visible
- **WHEN** a visible Office file is atomically replaced or receives multiple consecutive writes
- **THEN** the system renders only the latest stable SHA and does not blank the previous preview while loading

#### Scenario: Office tab is closed or switched
- **WHEN** a writer closes or switches away from an Office tab before a pending read completes
- **THEN** the late result does not reopen the tab, change focus, or replace a newer document

### Requirement: Office content can be selected with source location
The system SHALL turn pointer selections in Office previews into text plus stable source-location metadata suitable for assistant quoting.

#### Scenario: Select Word content
- **WHEN** a writer drags across rendered Word text
- **THEN** the selection contains the visible text, anchor geometry, and starting and ending page numbers

#### Scenario: Select PowerPoint content
- **WHEN** a writer selects rendered text on a slide
- **THEN** the selection contains the visible text, anchor geometry, and slide number, and changing slides clears it

#### Scenario: Select spreadsheet cells
- **WHEN** a writer drags from one visible spreadsheet cell to another
- **THEN** the system highlights the normalized rectangular range and provides the worksheet name, A1 range, formatted TSV, and formula annotations

### Requirement: Office selections use read-only writing assistance
The system SHALL expose Office selections to the existing Write inline assistant while routing every quick action and free-form instruction to assistant chat instead of a file mutation.

#### Scenario: Explain an Office selection
- **WHEN** a writer chooses Explain or enters a question for an Office selection
- **THEN** the assistant receives the selected text with its page, slide, or worksheet range and answers without editing the Office source

#### Scenario: Invoke an edit-mode custom action
- **WHEN** a stored Write quick action is marked as edit mode and is invoked on an Office selection
- **THEN** the system treats it as a chat action and does not call inline editing or `office_edit`

### Requirement: Active Office files support whole-document discussion
The system SHALL load a bounded semantic snapshot of the active Office file when a Write assistant request contains no Office quote, cache it by source SHA, and present it as collapsed source context in the conversation.

#### Scenario: Summarize the active Office file
- **WHEN** a writer asks for a summary, outline, or answer without quoting Office content
- **THEN** the assistant receives up to 200,000 characters of semantic content with source path, format, SHA, and truncation status under a read-only instruction

#### Scenario: Exact Office quote is present
- **WHEN** a request includes one or more Office quoted selections
- **THEN** the system sends the exact quotes and omits the whole-document semantic snapshot

#### Scenario: Semantic source changes or cannot be read
- **WHEN** the semantic read fails or no longer matches the expected preview SHA
- **THEN** the system restores the unsent composer text and shows an actionable error instead of sending stale context

### Requirement: Office boundaries and existing integrations remain intact
The system MUST apply workspace containment, regular-file, extension/content, non-empty, encryption, 10 MiB, and SHA checks to semantic reads while preserving existing PDF, Office attachment, Workspace preview, and Kun Office tool behavior.

#### Scenario: Unsafe semantic read
- **WHEN** a semantic request is outside the workspace, disguised, empty, encrypted, oversized, or SHA-stale
- **THEN** the trusted main process rejects it before returning semantic content

#### Scenario: Existing Office integration is used
- **WHEN** a user uploads an Office attachment or Kun runs an existing Office inspect, edit, or preview tool
- **THEN** the existing OfficeCLI-backed behavior and packaging remain unchanged
