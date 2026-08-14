## 1. Contracts and dependencies

- [x] 1.1 Add pinned lazy renderer dependencies and verify package integrity and license metadata
- [x] 1.2 Split the workspace binary preview contract from the unchanged local Office attachment contract
- [x] 1.3 Update preload and renderer bridge typings for the binary request and response

## 2. Main-process source preparation

- [x] 2.1 Implement workspace-scoped regular-file, non-empty, 10 MiB, extension/content, metadata, and SHA validation
- [x] 2.2 Return modern DOCX, XLS/XLSX, and PPTX bytes with source and render metadata
- [x] 2.3 Convert DOC and PPT snapshots to DOCX/PPTX with cleanup, source preservation, and actionable LibreOffice errors
- [x] 2.4 Add main-process tests for boundaries, invalid sources, hash changes, legacy conversion, cleanup, and missing LibreOffice

## 3. Browser renderers

- [x] 3.1 Refactor the Office preview hook to retain binary results and preserve debounce, latest-wins, and last-success behavior
- [x] 3.2 Add the lazy DOCX renderer with safe options, continuous pages, page navigation, controlled links, zoom, and cleanup
- [x] 3.3 Add the lazy PPTX renderer with owned slide navigation, zoom, and destroy cleanup
- [x] 3.4 Add the sparse SheetJS renderer with sheets, formatted/formula values, safe React cells, merges, headings, and 200 by 100 paging
- [x] 3.5 Route Office formats to the new renderers while preserving PDF.js and live editing/refresh status

## 4. Renderer validation and regressions

- [x] 4.1 Add renderer tests for lazy-loader success/failure, navigation, zoom, and unload cleanup
- [x] 4.2 Add spreadsheet tests for range paging, merges, formulas, and markup-like cell text
- [x] 4.3 Extend live-refresh tests for atomic writes, coalescing, stale results, retained previews, and close/switch behavior
- [x] 4.4 Verify Office attachment ingestion, Kun Office tools, OfficeCLI packaging, and PDF preview remain unchanged

## 5. Final validation and delivery

- [x] 5.1 Run typecheck, targeted Vitest, full tests, lint, file-line gate, production build, and diff check
- [x] 5.2 Perform available development-app format checks and document any environment-limited manual cases
- [x] 5.3 Commit the feature, rebase onto the latest local develop, revalidate conflicts, fast-forward merge, and remove the worktree and feature branch

Validation notes:

- Typecheck, targeted Office/PDF/OfficeCLI regressions, lint (zero errors), file-line gate, production build, OpenSpec strict validation, and diff check passed.
- Root Vitest completed with 6,457 passing tests and three failures reproduced unchanged on local `develop`; the full `npm run test` also reached pre-existing Kun failures and a non-terminating worker, so it could not report a green aggregate result.
- Real DOC/DOCX/XLS/XLSX/PPT/PPTX samples passed the main-process read/conversion path without source hash changes. The actual pinned browser libraries rendered two-page Chinese DOCX/PPTX samples and parsed two-sheet XLS/XLSX samples with a merge, formula, and markup-like text in Chromium.
- The available browser automation cannot control the Electron desktop window. Complex chart/image fidelity, encrypted-file UI, oversize-file UI, and end-to-end PDF interaction therefore remain environment-limited manual cases; their contracts and unchanged PDF path are covered by automated tests and production build validation.
