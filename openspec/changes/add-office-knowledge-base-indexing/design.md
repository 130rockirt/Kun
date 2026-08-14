## Context

Kun owns the existing knowledge-base scanner, derived PageIndex-style hierarchy, freshness checks, and read-only agent tools. It currently scans only Markdown, text, and text-layer PDF. Office preview and Write whole-document discussion run through Electron main, while Kun separately owns the OfficeCLI runner used by `office_inspect`, `office_preview`, and `office_edit`.

Knowledge indexing must remain a Kun capability so GUI, TUI, CLI, API, IM, and extension turns observe the same mounts and authorization. It cannot depend on renderer DOM, preload IPC, or a running Electron client. Office extraction is slower and less naturally line-addressable than text/PDF, so it also needs reusable derived evidence and format-aware locations.

## Goals / Non-Goals

**Goals:**

- Index DOC, DOCX, XLS, XLSX, PPT, and PPTX in mounted Write workspaces without embeddings or source writes.
- Preserve Word section/paragraph, presentation slide, and spreadsheet worksheet/range structure for navigation and citations.
- Reuse Kun's bounded OfficeCLI process runner and parse XLS/XLSX directly with SheetJS.
- Convert legacy DOC/PPT only from private snapshots and clean every conversion product.
- Reuse unchanged extracted evidence, verify exact source SHA before reads, and rebuild schema-v1 or stale caches safely.
- Degrade per document when an extractor or optional local dependency is unavailable.

**Non-Goals:**

- OCR, macro-enabled Office formats, password recovery, embeddings, cloud conversion, or bundling LibreOffice.
- Granting normal read/write/shell tools access to knowledge roots.
- Editing Office sources or replacing the existing Write preview and selection flow.
- Requiring OfficeCLI for XLS/XLSX indexing.

## Decisions

### Keep Office extraction inside Kun behind an extractor registry

`KnowledgeDocumentExtractor` selects a bounded extractor from a validated source descriptor and returns structural nodes plus chunk evidence. Markdown/text/PDF remain built-in extractors; Office formats add Word, presentation, and spreadsheet extractors.

Runtime composition constructs one `OfficeCliRunner` when `KUN_OFFICECLI_BINARY` resolves and passes it both to Office tools and the knowledge extractor. This preserves the existing two-process concurrency cap across interactive tools and background indexing. XLS/XLSX use an explicit Kun `xlsx` dependency and therefore remain available without OfficeCLI.

Alternative: call Electron's semantic IPC. That would make headless Kun clients inconsistent and move index authority outside the runtime.

### Model Office locations by stable authoring structure

The index schema adds `word`, `presentation`, and `spreadsheet` source-location variants and `slide`, `worksheet`, and `cell-range` node kinds. Word citations use paragraph ranges and section breadcrumbs; page numbers are optional hints only because DOCX pagination changes with fonts and rendering. Presentation citations use exact slide numbers. Spreadsheet citations use worksheet names and normalized A1 ranges with formula annotations in evidence.

DOCX extraction uses OfficeCLI annotated output, falling back to bounded paragraph groups when headings cannot be recovered. PPTX outline output is parsed into slide nodes and marks the document unavailable if stable slide markers are missing rather than inventing slide numbers. SheetJS traverses only sparse populated cells and groups them into bounded row/cell blocks.

Alternative: store only a flat 200,000-character semantic string. That weakens tree navigation, biases retrieval toward the beginning, and cannot cite slides or cell ranges.

### Convert legacy documents from immutable private snapshots

DOC and PPT are copied into a mode-0700 temporary directory, converted to DOCX/PPTX through a Kun-owned LibreOffice adapter, validated as the expected OOXML family, extracted, and deleted in `finally`. The original path is never a conversion output. XLS is parsed directly by SheetJS.

LibreOffice resolution follows `KUN_LIBREOFFICE_BINARY` and platform candidates. Missing LibreOffice or OfficeCLI marks only that document unavailable and records a bounded actionable diagnostic.

### Separate structural indexes from reusable Office evidence artifacts

Knowledge index schema version 2 stores format metadata, source SHA, extractor version, node locations, and artifact references. Bounded semantic chunks live beneath `<dataDir>/knowledge-artifacts/<mount-key>/`, keyed by source SHA and extractor version. Successful rebuilds atomically publish the index and prune orphan artifacts; failed or aborted builds leave the previous valid index intact.

Before serving cached Office evidence, `knowledge_read` canonicalizes the source path and recomputes its SHA. A mismatch invalidates the document and returns stale/unavailable evidence instead of cached text. Metadata fingerprints continue to trigger normal lazy rebuilds. Schema-v1 indexes are derived data and rebuild automatically.

Alternative: invoke OfficeCLI on every `knowledge_read`. That makes repeated tree traversal slow and creates avoidable process contention.

### Bound extraction independently from prompt limits

Office sources use the preview-compatible 10 MiB input limit while the mount retains existing file, total-byte, entry, and node budgets. Each Office document contributes at most 1,000,000 evidence characters; a mount contributes at most 64 MiB of Office artifacts. Word is capped at 4,000 paragraph groups, presentations at 500 slides, and spreadsheets at 100 worksheets and 100,000 populated cells. Existing tool response limits remain 8,000 characters per node and 32,000 characters per read.

Truncation is stored on the document and surfaced in status/diagnostics. Oversized, encrypted, malformed, disguised, or archive-bomb sources are unavailable rather than partially trusted.

### Preserve knowledge tool authorization and enrich status/source opening

`knowledge_catalog`, `knowledge_browse`, and `knowledge_read` keep mount/node-only inputs and reload thread mount authorization on every call. Evidence adds format-aware locations, source SHA, and truncation metadata while continuing to label source content untrusted.

Index status adds available, unavailable, and truncated document counts plus bounded diagnostics. Renderer source cards can switch to the matching Write workspace and open the Office file. PPT, spreadsheet, and PDF locations are forwarded as initial slide/sheet/range/page targets; Word opens with its paragraph citation and may best-effort locate rendered text without claiming stable pagination.

## Risks / Trade-offs

- [OfficeCLI output changes across versions] → Parse through versioned adapters, keep fixtures for supported output, and degrade to bounded ranges instead of fabricating structure.
- [Large spreadsheets exhaust memory] → Validate container budgets first, use sparse SheetJS traversal, cap cells/worksheets/evidence, and never call dense conversion helpers.
- [Office extraction makes rebuilds slow] → Share the OfficeCLI runner, build sequentially within bounds, reuse SHA-addressed artifacts, and retain the last valid index until atomic publish.
- [Cached evidence becomes stale] → Revalidate canonical path and exact SHA immediately before every Office evidence read.
- [Legacy conversion is unavailable] → Report a per-document actionable diagnostic and keep modern/spreadsheet sources ready.
- [Word paragraph citations do not match rendered pages] → Treat paragraph/section as canonical and page/scroll positioning as optional UI hints.

## Migration Plan

1. Add compatible location/status fields and the extractor abstraction while retaining schema-v1 reads as cache misses.
2. Add SheetJS and OfficeCLI/LibreOffice extraction, then publish schema-v2 indexes and evidence artifacts atomically.
3. Extend tools and renderer mappings/source cards after runtime contracts are available.
4. On rollback, delete `knowledge-indexes` and `knowledge-artifacts`; thread mounts and workspace sources require no migration.

## Open Questions

None for this change. Macro-enabled formats and OCR remain separate future capabilities.
