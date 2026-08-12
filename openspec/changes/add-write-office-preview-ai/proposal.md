## Why

Write mode can edit text and inspect PDFs, but Office files are absent from its file tree and cannot participate in selection-based writing assistance. Writers need to read Word, PowerPoint, and spreadsheet material in the same middle pane and discuss either a precise selection or the whole read-only source without leaving their writing workflow.

## What Changes

- Add read-only DOC, DOCX, XLS, XLSX, PPT, and PPTX tabs to the Write workspace using the existing bundled browser renderers and live-refresh behavior.
- Add source-aware mouse selections for Word pages, PowerPoint slides, and spreadsheet cell ranges, then expose those selections to the existing Write inline assistant and quote flow.
- Route every Office selection action to assistant chat instead of attempting an in-place edit.
- Add bounded, workspace-scoped semantic Office reads so the Write assistant can summarize, outline, or answer questions about the active Office file when no precise Office quote is present.
- Keep PDF behavior and all existing Office attachment and Kun Office tool behavior unchanged.

## Capabilities

### New Capabilities

- `write-office-preview-ai`: Read-only Office tabs in Write mode, structured Office selections, assistant quoting, whole-document discussion, and live refresh.

### Modified Capabilities

None.

## Impact

- Write workspace file classification, document sessions, tabs, toolbar, renderer composition, selection contracts, quoted-context serialization, and assistant submission.
- Existing workspace Office preview components and refresh hook gain reusable selection and semantic-loading surfaces.
- Shared/preload/main workspace Office IPC gains a bounded semantic-read contract; existing binary preview, attachment intake, OfficeCLI packaging, and Kun Office edit tools remain compatible.
