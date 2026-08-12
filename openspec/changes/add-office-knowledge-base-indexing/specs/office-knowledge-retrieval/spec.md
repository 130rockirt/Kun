## ADDED Requirements

### Requirement: Mounted knowledge bases index supported Office documents
The system SHALL discover and index DOC, DOCX, XLS, XLSX, PPT, and PPTX files alongside existing Markdown, text, and PDF sources while preserving the current mount authorization and scan budgets.

#### Scenario: Index a mixed Write workspace
- **WHEN** a mounted Write workspace contains supported text, PDF, Word, presentation, and spreadsheet files
- **THEN** the knowledge index contains document nodes for every readable supported source and preserves the existing sources unchanged

#### Scenario: Ignore an unsupported Office family
- **WHEN** the workspace contains a macro-enabled, temporary-lock, encrypted, disguised, or otherwise unsupported Office file
- **THEN** the index records a bounded unavailable diagnostic and does not extract or expose its content

### Requirement: Office indexes preserve format-aware structure
The system SHALL represent Word sections and paragraph groups, presentation slides, and spreadsheet worksheets and bounded cell ranges as navigable nodes with stable source locations.

#### Scenario: Index a Word document
- **WHEN** a DOCX or converted DOC contains headings and paragraphs
- **THEN** the document tree exposes section and paragraph-range nodes with section breadcrumbs and paragraph locations

#### Scenario: Index a presentation
- **WHEN** a PPTX or converted PPT contains readable slides
- **THEN** the document tree exposes one bounded node per readable slide with its exact slide number

#### Scenario: Index a workbook
- **WHEN** an XLS or XLSX contains multiple worksheets, formulas, merged regions, or sparse populated cells
- **THEN** the document tree exposes worksheet and normalized A1-range nodes whose evidence contains formatted values and formula annotations without dense allocation or HTML execution

### Requirement: Office extraction is local, bounded, and read-only
The system MUST perform Office extraction locally inside Kun, MUST NOT upload content, and MUST enforce regular-file, canonical-path, type, archive, byte, node, worksheet, slide, cell, and evidence limits before publishing results.

#### Scenario: Convert a legacy document
- **WHEN** DOC or PPT indexing requires LibreOffice and the local executable is available
- **THEN** the system converts an immutable private snapshot, extracts the converted result, deletes every temporary product, and leaves the original byte-identical

#### Scenario: Optional extractor is unavailable
- **WHEN** OfficeCLI or LibreOffice required by one source is unavailable
- **THEN** that document is marked unavailable with an actionable diagnostic while other readable documents and XLS/XLSX sources remain usable

#### Scenario: Abort or fail during extraction
- **WHEN** indexing is cancelled, times out, exceeds a limit, or an extractor fails
- **THEN** the system cleans temporary state, retains the prior valid derived index, and never publishes a partial artifact as ready

### Requirement: Office evidence caches are exact-source and rebuildable
The system SHALL persist bounded derived Office evidence keyed by source SHA and extractor version, SHALL verify the current source SHA before serving it, and SHALL rebuild incompatible or stale derived caches without migrating source data.

#### Scenario: Reuse an unchanged Office artifact
- **WHEN** a mount rebuild encounters an Office source with the same verified SHA and extractor version
- **THEN** the system reuses its existing structural evidence without invoking the expensive extractor again

#### Scenario: Source changes after indexing
- **WHEN** an Office source no longer matches the SHA recorded for a requested node
- **THEN** `knowledge_read` returns stale or unavailable state, invalidates the old evidence, and does not return cached source text

#### Scenario: Load a schema-v1 knowledge cache
- **WHEN** Kun encounters an older derived knowledge index without Office artifact metadata
- **THEN** it treats the index as rebuildable cache, creates schema-v2 state, and preserves thread mounts and workspace sources

### Requirement: Knowledge tools return bounded Office citations
Kun SHALL expose Office nodes through the existing catalog, browse, and read tools and SHALL return evidence with mount, document, structural path, relative source path, source SHA, truncation state, and format-specific location.

#### Scenario: Read Word evidence
- **WHEN** the agent reads a Word section or paragraph node
- **THEN** the result identifies its section path and paragraph range and frames the text as untrusted evidence

#### Scenario: Read presentation evidence
- **WHEN** the agent reads a presentation node
- **THEN** the result identifies the source presentation and Slide number

#### Scenario: Read spreadsheet evidence
- **WHEN** the agent reads a spreadsheet node
- **THEN** the result identifies the worksheet, A1 range, formatted tabular evidence, and formula annotations

#### Scenario: Attempt path injection
- **WHEN** a knowledge tool receives an arbitrary filesystem path, unknown mount id, or unknown node id
- **THEN** it reads no Office source and returns an authorization or validation error

### Requirement: Users can inspect Office indexing state and open cited sources
The system SHALL expose available, unavailable, and truncated Office document counts with bounded diagnostics and SHALL let users open cited Office sources in the existing read-only Write preview.

#### Scenario: Inspect a partially indexed mount
- **WHEN** a mount contains both readable Office sources and documents that require a missing dependency
- **THEN** the knowledge-base UI reports ready usable content and separately reports unavailable document counts and reasons

#### Scenario: Open an Office citation
- **WHEN** the user opens a Word, presentation, or spreadsheet evidence source
- **THEN** Write activates the matching workspace, opens the source read-only, and carries its paragraph, Slide, or worksheet/range location as far as the renderer supports
