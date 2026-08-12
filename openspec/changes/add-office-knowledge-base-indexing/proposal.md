## Why

Write workspaces can now preview and discuss Office documents, but Code knowledge-base mounts silently ignore those same files. Users need Word, PowerPoint, and spreadsheet sources to participate in the existing local PageIndex-style retrieval flow with stable, format-aware citations.

## What Changes

- Extend bounded knowledge-base scanning and indexing to `.doc`, `.docx`, `.xls`, `.xlsx`, `.ppt`, and `.pptx` while preserving Markdown, text, and PDF behavior.
- Build Word section/paragraph, presentation slide, and spreadsheet worksheet/range nodes with source-aware locations.
- Extract modern Office structure inside Kun through the existing OfficeCLI runtime and sparse SheetJS parsing; privately convert legacy DOC/PPT through local LibreOffice when available.
- Persist derived Office evidence artifacts keyed by source SHA and extractor version, validate freshness before every read, and rebuild old or stale indexes without modifying sources.
- Surface per-document unavailable/truncated diagnostics and open Office evidence in the existing read-only Write preview.
- Keep knowledge roots outside normal filesystem authority and continue exposing content only through `knowledge_catalog`, `knowledge_browse`, and `knowledge_read`.

## Capabilities

### New Capabilities

- `office-knowledge-retrieval`: Local, bounded Office indexing, structural navigation, format-aware citations, freshness validation, degradation, and source opening for mounted knowledge bases.

### Modified Capabilities

None.

## Impact

- Extends `kun/src/knowledge`, OfficeCLI runtime composition, knowledge tool result contracts, and derived cache schema.
- Adds SheetJS as an explicit Kun runtime dependency and a Kun-owned private LibreOffice conversion path for legacy documents.
- Extends renderer knowledge-base status/source-opening UI and shared runtime mappings without adding filesystem write authority.
- Invalidates schema-v1 derived knowledge indexes; thread mounts and source documents remain unchanged.
