## Context

The workspace preview currently asks the main process to render Office documents
through OfficeCLI and sends sanitized HTML to a scriptless iframe. That path is
safe but makes an interactive, read-only view depend on a native renderer. The
application already has a separate PDF.js viewer and a mature live-preview hook
that watches signal-only file events, debounces stable writes, discards stale
responses, and retains the last successful result while refreshing.

The attachment ingestion and Kun agent tool paths use OfficeCLI for semantic and
visual content. They are separate product capabilities and must remain intact.
Legacy DOC and PPT cannot be rendered by the selected browser libraries, while
XLS is supported by SheetJS, so only DOC and PPT still require optional local
LibreOffice conversion.

The change crosses shared contracts, preload IPC, main-process file validation,
renderer lifecycle management, packaging, and tests. All source data remains
workspace-scoped and subject to the existing 10 MiB limit.

## Goals / Non-Goals

**Goals:**

- Render DOCX, PPTX, XLS, and XLSX from bounded binary data with bundled,
  lazily-loaded browser libraries.
- Render DOC and PPT through private DOCX/PPTX snapshots made by the existing
  LibreOffice conversion path; never modify the source.
- Preserve the existing PDF.js experience and live-preview concurrency model.
- Provide usable page, slide, sheet, row/column window, and zoom controls.
- Keep the workspace boundary, file-type validation, SHA precondition, regular
  file, non-empty, and size checks in the trusted main process.

**Non-Goals:**

- Editing or saving Office documents.
- Bundling LibreOffice or attempting to unlock password-protected documents.
- Replacing OfficeCLI for attachment ingestion, model inputs, or Kun Office
  inspect/edit/preview tools.
- Perfect Microsoft Office layout fidelity for every feature or macro.

## Decisions

### Return structured-clone binary data over the existing IPC bridge

`readWorkspaceOfficePreview` accepts `path`, `workspaceRoot`, and optional
`expectedSha256`. A success returns `Uint8Array`, source and render formats,
viewer kind, source metadata, and the source SHA-256. Page and worksheet
parameters are removed because navigation is a renderer concern. Electron IPC
supports structured-clone typed arrays, avoiding base64 expansion.

The main process resolves the path against the workspace, checks a regular and
non-empty file, verifies the declared extension against file content, enforces
10 MiB, computes the source hash, and rejects an obsolete expected hash. Modern
files return source bytes. DOC and PPT are copied into the existing private
temporary workflow, converted, validated, read, and removed in a `finally`
path.

Alternative: expose a `file://` or custom protocol URL. This was rejected
because it widens the renderer's file access surface and weakens the explicit
workspace and hash boundary.

### Select a renderer by actual render format

DOCX uses `docx-preview@0.4.0` with altChunk HTML disabled. PPTX uses
`pptx-preview@1.0.7` and destroys its instance whenever the source or component
changes. XLS/XLSX use SheetJS 0.20.3 from its official tarball and build React
nodes from cell values. PDF continues through `WorkspacePdfViewer`.

Each Office library is loaded with a dynamic import from a format-specific
component, so normal application startup does not parse those packages. All
packages are bundled locally; no renderer fetches scripts from a CDN.

Alternative: convert every Office file to HTML or PDF in the main process. This
would retain the native renderer dependency, make navigation less semantic,
and add conversion latency to formats that browsers can already parse.

### Bound spreadsheet work independently in both dimensions

SheetJS reads workbooks in sparse mode. The UI renders no more than 200 rows by
100 columns at once and provides independent row and column paging, in addition
to worksheet switching. The used range is clamped to SheetJS-supported bounds
before deriving window positions, preventing a malicious `!ref` from creating
large arrays or DOM trees. Formatted values are rendered as text React children;
merges are intersected with the current window and clipped to a visible anchor,
retaining the original anchor value across row or column pages.

Alternative: `sheet_to_html` was rejected because injected HTML complicates
escaping and can allocate a DOM proportional to the entire worksheet.

### Preserve the established live-preview state machine

The Office hook keeps the last successful binary response in state, combines
signal-only file events with a 250 ms refresh debounce, passes the observed SHA
as a precondition, and uses monotonically increasing request IDs to ignore late
responses. Loading and errors are overlays/statuses, so a failed refresh does
not blank the prior document. The hook never reopens a preview the user closed
or replaces a newer selected file.

### Restrict document interaction

DOCX altChunk rendering is disabled. Spreadsheet values are never HTML.
Document hyperlinks are intercepted and forwarded only through the existing
controlled external-opening bridge. Presentation instances and document DOM
are destroyed or cleared on unmount, source change, and failed initialization.

## Risks / Trade-offs

- [Risk] Browser renderers may differ from Microsoft Office layout. → Keep
  renderer limitations explicit and retain the original file unchanged.
- [Risk] Large or adversarial workbooks can consume memory. → Retain the 10 MiB
  source cap, sparse parsing, range clamping, and a 200 × 100 DOM window.
- [Risk] Third-party viewers can retain charts or DOM after navigation. → Own a
  viewer instance per component and test cleanup/destroy behavior.
- [Risk] Legacy conversion is unavailable on machines without LibreOffice. →
  Return an actionable error naming the optional requirement without affecting
  modern formats.
- [Risk] Dynamic imports can accidentally enter the initial bundle. → Keep them
  inside format components and verify production chunks during build.
- [Risk] `pptx-preview` licensing or integrity changes. → Pin version 1.0.7,
  record the lockfile integrity, and verify the published ISC metadata before
  merging.

## Migration Plan

1. Add the binary contract and main-process source preparation while retaining
   the separate local Office attachment result contract.
2. Add lazy renderer components and switch only the workspace preview route.
3. Add main-process, renderer, live-refresh, and regression tests.
4. Validate the packaged build uses local chunks and preserves OfficeCLI
   resources.
5. Roll back by reverting this single change; stored user data and source files
   require no migration.

## Open Questions

None. Rendering and legacy-conversion boundaries are fixed by the approved
plan; layout limitations are handled as viewer errors rather than fallbacks to
OfficeCLI HTML.
