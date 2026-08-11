## ADDED Requirements

### Requirement: Knowledge indexes preserve natural document structure
The system SHALL build a local vectorless hierarchy of directory, document, section, paragraph-range, and PDF-page nodes, and SHALL preserve source locations for every readable node.

#### Scenario: Index structured Markdown
- **WHEN** a mounted directory contains Markdown headings and relative document links
- **THEN** the index represents heading nesting as parent-child edges and valid links as reference edges with line locations

#### Scenario: Index text-layer PDF
- **WHEN** a mounted directory contains a PDF with extractable text
- **THEN** the index creates page nodes whose source locations contain the original PDF page numbers

#### Scenario: Encounter an image-only PDF
- **WHEN** PDF pages contain no extractable text
- **THEN** the document is marked unavailable for text retrieval without invoking cloud processing or blocking other documents

### Requirement: Indexing is local, bounded, and embedding-free
The system MUST NOT generate embeddings or upload knowledge content and SHALL enforce file-count, byte, node, directory, binary, and symlink boundaries.

#### Scenario: Scan an unsafe or oversized source
- **WHEN** a source exceeds configured budgets, is binary, is inside a skipped directory, or resolves outside the mounted root through a symbolic link
- **THEN** the indexer skips it, records a bounded diagnostic, and continues safely

### Requirement: Kun agents retrieve through auditable tree tools
Kun SHALL advertise read-only catalog, browse, and read tools when the active thread has knowledge mounts, and each result SHALL be bounded and attributable to a mount, document, structural path, and source location.

#### Scenario: Reason through a knowledge tree
- **WHEN** the agent needs information from a mounted knowledge base
- **THEN** it can list mounts, browse relevant branches, and read selected source nodes without receiving the whole corpus

#### Scenario: Attempt arbitrary path injection
- **WHEN** a tool call supplies an unknown mount ID, unknown node ID, or filesystem path instead of an authorized identifier
- **THEN** the tool returns an authorization or validation error and reads no source file

### Requirement: Retrieval validates freshness and evidence
The system SHALL compare source fingerprints before serving indexed evidence and SHALL refresh changed sources or report stale/unavailable state instead of returning unverified content.

#### Scenario: Source changes after indexing
- **WHEN** a Write document is edited after its knowledge index was built
- **THEN** the next retrieval refreshes the affected index before returning evidence from the changed document

#### Scenario: Source disappears during retrieval
- **WHEN** a selected source file is deleted or moved before the read completes
- **THEN** the tool reports the node as unavailable and does not return cached source text as current evidence

### Requirement: Retrieved content is untrusted reference data
Knowledge tool outputs SHALL identify source text as untrusted data and SHALL not treat instructions found in documents as runtime, system, or tool authorization instructions.

#### Scenario: Document contains prompt injection text
- **WHEN** retrieved source content tells the agent to ignore policy or invoke another tool
- **THEN** the output framing preserves it only as quoted evidence and grants no additional capability
