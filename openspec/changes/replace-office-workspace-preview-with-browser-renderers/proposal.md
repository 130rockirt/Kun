## Why

Workspace Office previews currently depend on OfficeCLI-rendered HTML in the
main process, which adds latency and a native rendering dependency to a
read-only UI concern. Browser-side renderers can display the same workspace
artifacts directly while retaining the existing safe path boundary and live
refresh behavior.

## What Changes

- Render DOCX, XLS/XLSX, and PPTX workspace previews in the renderer with
  bundled browser libraries; continue using the existing PDF.js viewer for PDF.
- Convert legacy DOC and PPT sources to private DOCX/PPTX snapshots with the
  existing optional LibreOffice path, then render the converted bytes in the
  browser without modifying the source file.
- Replace the workspace Office preview IPC response with a bounded binary
  source contract while preserving source hashes, stable-write refresh,
  latest-result-wins loading, and the last successful preview on failure.
- Add document page controls, presentation slide controls, spreadsheet sheet
  and row/column paging, zoom, and actionable errors for unsupported encrypted
  or unavailable legacy conversions.
- Keep OfficeCLI-backed attachment ingestion and Kun Office agent tools
  unchanged.

## Capabilities

### New Capabilities

- `browser-office-file-preview`: Safe, live, browser-rendered workspace previews
  for modern and legacy Office files without Office editing.

### Modified Capabilities

<!-- None. The existing live-preview change has not been archived into a base spec. -->

## Impact

- Shared Office preview contracts and the constrained preload/main IPC bridge.
- Main-process workspace Office source preparation and legacy conversion.
- Renderer preview loading, format-specific viewers, and associated tests.
- New lazy-loaded `docx-preview`, `pptx-preview`, and SheetJS dependencies;
  existing `pdfjs-dist`, OfficeCLI packaging, and agent tooling remain.
