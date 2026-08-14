## ADDED Requirements

### Requirement: Workspace Office sources are returned through a bounded binary contract
The system SHALL expose DOC, DOCX, XLS, XLSX, PPT, and PPTX workspace preview
sources as `Uint8Array` data with source format, render format, viewer kind,
size, modification time, and source SHA-256 metadata. The request SHALL accept
only a path, workspace root, and optional expected source SHA-256.

#### Scenario: Modern Office source is accepted
- **WHEN** a supported modern Office file is a regular, non-empty file inside the workspace and passes content validation and the 10 MiB limit
- **THEN** the system returns its bytes and metadata without native Office rendering

#### Scenario: Source precondition is obsolete
- **WHEN** the caller supplies an expected SHA-256 that differs from the validated source
- **THEN** the system rejects the request as a source change without returning stale bytes

#### Scenario: Unsafe or invalid source is rejected
- **WHEN** the source escapes the workspace, is not a regular file, is empty, exceeds 10 MiB, or its content does not match the declared Office extension
- **THEN** the system returns a typed actionable failure and no preview bytes

### Requirement: Legacy documents use private conversion snapshots
The system SHALL convert DOC and PPT workspace sources into private DOCX and
PPTX snapshots respectively, SHALL render the converted bytes, and SHALL leave
the source file unchanged. XLS SHALL be passed directly to SheetJS without
LibreOffice conversion.

#### Scenario: Legacy source converts successfully
- **WHEN** LibreOffice is available and a valid DOC or PPT is requested
- **THEN** the system returns validated converted bytes with distinct source and render formats

#### Scenario: Conversion resources are cleaned
- **WHEN** legacy conversion succeeds or fails
- **THEN** all private source snapshots and converted outputs are removed after their bytes or error are captured

#### Scenario: LibreOffice is unavailable
- **WHEN** a DOC or PPT preview is requested and no supported LibreOffice executable is available
- **THEN** the system returns an actionable installation message and does not modify the source

### Requirement: Format renderers load only when used
The renderer SHALL dynamically load `docx-preview` for DOCX render data,
`pptx-preview` for PPTX render data, and SheetJS 0.20.3 for XLS/XLSX render
data. These libraries SHALL be packaged locally and SHALL NOT be loaded from a
runtime CDN. PDF SHALL continue through the existing PDF.js viewer.

#### Scenario: Viewer is selected from render metadata
- **WHEN** a successful Office source response reaches the renderer
- **THEN** only the matching document, presentation, or spreadsheet renderer is initialized

#### Scenario: Viewer initialization fails
- **WHEN** a lazy import or file parser rejects the source
- **THEN** the UI displays an actionable preview error while remaining responsive

#### Scenario: Viewer is replaced or closed
- **WHEN** the selected file changes or the preview component unmounts
- **THEN** the document DOM and presentation instance are cleared and presentation `destroy()` is invoked

### Requirement: Word previews provide safe page navigation
The system SHALL render DOCX data with altChunk HTML disabled and SHALL provide
continuous pages, current page status, previous/next navigation, and zoom.
Document links SHALL open only through the existing controlled external-link
bridge.

#### Scenario: User navigates a document
- **WHEN** a rendered DOCX contains multiple pages and the user changes page or zoom
- **THEN** the viewer scrolls to the requested page, updates current page status, and scales the document

#### Scenario: Document contains embedded altChunk HTML
- **WHEN** a DOCX includes an altChunk HTML part
- **THEN** the viewer does not render that HTML

### Requirement: Presentation previews provide owned slide navigation
The system SHALL render PPTX data with application-owned current slide,
previous/next, and zoom controls and SHALL destroy the presentation renderer
when its lifecycle ends.

#### Scenario: User navigates a presentation
- **WHEN** a PPTX contains multiple slides and the user changes slide or zoom
- **THEN** the viewer renders the selected slide and reports the correct slide count

#### Scenario: Presentation renderer is unloaded
- **WHEN** the presentation source changes, fails initialization, or unmounts
- **THEN** its charts, event handlers, and DOM are cleaned through `destroy()` and container clearing

### Requirement: Spreadsheet previews use bounded React rendering
The system SHALL parse XLS/XLSX workbooks sparsely and render cell content as
React text nodes. It SHALL support worksheet selection, formatted values,
formula display, merged cells, row and column headings, and independent paging
through windows no larger than 200 rows by 100 columns.

#### Scenario: User navigates a large worksheet
- **WHEN** a sheet's used range exceeds either window dimension
- **THEN** row and column paging reaches the remaining cells without rendering more than 200 rows or 100 columns at once

#### Scenario: Worksheet contains merges and formulas
- **WHEN** visible cells include merged ranges or formulas
- **THEN** the table represents visible merges and displays formatted values with a formula fallback when no cached display value exists

#### Scenario: Cell contains markup-like text
- **WHEN** a cell value contains HTML or script syntax
- **THEN** the exact value is displayed as inert text without HTML injection

#### Scenario: Worksheet declares an extreme range
- **WHEN** workbook metadata declares a range beyond supported worksheet bounds
- **THEN** navigation and rendering clamp the range without constructing an unbounded array or DOM tree

### Requirement: Live Office previews preserve the latest successful content
The system SHALL continue to consume signal-only workspace file events, wait
250 ms after change bursts, ignore obsolete loads, and retain the last
successful preview during refresh or refresh failure.

#### Scenario: File is written repeatedly
- **WHEN** multiple change events arrive during a continuous or atomic write
- **THEN** the system coalesces them and loads the stable latest source once the debounce settles

#### Scenario: Older request finishes last
- **WHEN** an earlier source request resolves after a later request or after the user selects another file
- **THEN** the earlier result is ignored and does not replace content or steal focus

#### Scenario: Refresh fails after a successful preview
- **WHEN** a watched file becomes temporarily unreadable, corrupt, or fails rendering during refresh
- **THEN** the viewer keeps the last successful content visible and shows the refresh error

#### Scenario: Agent is editing the open file
- **WHEN** runtime activity reports that an agent is modifying the selected Office path
- **THEN** the viewer indicates active modification while retaining its current content

### Requirement: Existing Office and PDF capabilities remain independent
The system SHALL leave local Office attachment extraction, model visual
attachments, Kun `office_inspect`, `office_edit`, and `office_preview` tools,
OfficeCLI packaged resources, and the existing PDF.js preview behavior intact.

#### Scenario: Office attachment is added to a conversation
- **WHEN** a supported Office file is processed as a model attachment
- **THEN** the existing OfficeCLI semantic and visual attachment flow is used

#### Scenario: Agent invokes an Office tool
- **WHEN** Kun invokes an existing Office inspect, edit, or preview operation
- **THEN** the OfficeCLI provider executes with its existing contract

#### Scenario: User opens a PDF workspace file
- **WHEN** a PDF is selected for workspace preview
- **THEN** the existing PDF.js pages, search, text layer, and zoom behavior are used
