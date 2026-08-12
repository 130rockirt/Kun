## 1. Contracts and extraction foundations

- [x] 1.1 Add explicit Kun SheetJS dependency, schema-v2 knowledge document/artifact metadata, Office node kinds, and format-aware source locations
- [x] 1.2 Add a bounded knowledge document extractor registry and dependency-injected OfficeCLI/LibreOffice adapters
- [x] 1.3 Extend knowledge source scanning for six Office extensions with regular-file, canonical-path, type, archive, byte, and temporary-file validation

## 2. Office structural extraction

- [x] 2.1 Implement sparse XLS/XLSX worksheet and A1-range extraction with formatted values, formulas, merged-range normalization, and cell/character budgets
- [x] 2.2 Implement DOCX Word section/paragraph and PPTX Slide extraction through the shared OfficeCLI runner with bounded structural fallbacks
- [x] 2.3 Implement private DOC/PPT LibreOffice conversion, OOXML family verification, abort/timeout handling, and unconditional temporary cleanup
- [x] 2.4 Add fixture-driven extractor tests for Chinese content, headings, slides, sparse sheets, formulas, truncation, encryption, corruption, missing dependencies, and unchanged sources

## 3. Derived artifacts and freshness

- [x] 3.1 Persist Office evidence artifacts atomically by mount, source SHA, format, and extractor version while retaining the prior valid index on failure
- [x] 3.2 Reuse unchanged artifacts, prune orphans after successful publish, and rebuild schema-v1/incompatible caches without changing thread mounts
- [x] 3.3 Revalidate canonical source path and exact SHA before Office evidence reads and reject stale node ids without returning cached text
- [x] 3.4 Share one bounded OfficeCLI runner between Office tools and knowledge indexing in initial and hot-reload runtime composition

## 4. Retrieval tools and user experience

- [x] 4.1 Extend catalog, browse, and read results with Office structure, SHA, truncation, and Word paragraph, Slide, or Sheet/A1 citations while preserving mount/node authorization
- [x] 4.2 Extend thread/runtime/renderer status mappings and the knowledge-base picker with usable, unavailable, truncated, format, and actionable diagnostic summaries
- [x] 4.3 Add Office knowledge source cards/actions that open the matching read-only Write document and forward supported Slide, worksheet/range, paragraph, and PDF page locations

## 5. Verification and delivery

- [x] 5.1 Add scanner, index, artifact reuse, SHA invalidation, tool, status/UI, source-opening, prompt-injection, and Markdown/Text/PDF regression tests
- [x] 5.2 Update knowledge-base architecture documentation and run OpenSpec strict validation, focused/full tests, typecheck, Kun/top-level builds, lint, file-line gate, and diff checks
- [x] 5.3 Commit, rebase onto the latest local develop, resolve code/lock/OpenSpec conflicts, revalidate, fast-forward merge, and remove the worktree and feature branch
