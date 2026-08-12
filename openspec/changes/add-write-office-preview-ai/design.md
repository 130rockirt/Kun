## Context

Write mode has shared per-path document sessions, at most two visible editor groups, source-aware text/PDF selections, and a sidebar assistant that serializes quoted selections into prompts. Workspace preview already renders Office bytes with lazy browser libraries and maintains safe live refresh, but its state and renderer callbacks are not integrated with Write. Whole-document Office discussion also needs semantic content without making Office source files writable.

## Goals / Non-Goals

**Goals:**

- Open all six supported Office extensions as read-only Write tabs while preserving shared-session and two-group behavior.
- Reuse the existing binary preview validation, browser renderers, and live-refresh guarantees.
- Turn Word, presentation, and spreadsheet selections into stable, location-aware Write quotes.
- Let the assistant discuss an exact Office quote or, when no Office quote is supplied, a bounded semantic snapshot of the active Office file.

**Non-Goals:**

- Editing or saving Office files from Write, converting assistant answers into drafts, or bundling LibreOffice.
- Replacing PDF selection behavior, Office attachment ingestion, or Kun's Office inspect/edit/preview tools.
- Persisting binary or semantic Office payloads across application restarts.

## Decisions

### Store Office preview state in the shared Write document session

`WriteActiveFileKind` gains `office`, and each Office session owns the latest successful binary result plus loading, refresh-error, editing, and semantic-cache fields. Opening a path loads its first result before adding the tab. A single controller watches the unique active Office paths across visible groups and writes refresh results back to the shared session, so the same file displayed twice never opens competing watchers.

The controller retains the existing 250 ms debounce, expected-SHA check, request generations, last-success retention, and agent editing events. Workspace preview continues to use its existing hook, while both paths share small target/event matching helpers rather than sharing React state.

Alternative: mount `useWorkspaceOfficePreview` inside every Office pane. This is simpler but duplicates reads and watches when one document is visible in both editor groups and does not preserve a session across tab switches.

### Make renderer selection output neutral and source-aware

The Office renderers accept an optional `onSelectionChange` callback using a shared Office selection shape, independent of Write. Word and PowerPoint translate DOM selections to text, an anchor rectangle, and page/slide location. Spreadsheet uses pointer-driven rectangular cell selection and produces a normalized A1 range plus formatted TSV, including formulas as annotations without injecting HTML.

Write adapts that shape to its existing selection state. Changing source SHA, page/slide, worksheet, or row/column window clears the selection; focusing the assistant preserves the committed snapshot. This keeps the reusable Workspace preview free of Write-store dependencies.

Alternative: forward only `window.getSelection().toString()`. That loses provenance and produces unstable ordering for tables.

### Treat Office actions as read-only chat

Office selections expose quote, personas, chat-mode quick actions, and the free-form composer. Stored quick actions marked `edit` are projected to chat for Office. Formatting, block changes, direct inline replacement, infographic insertion, and other write operations are hidden. The Write prompt explicitly identifies the active Office source as read-only and forbids `edit`, `write`, and `office_edit` against it.

### Add a workspace-scoped semantic snapshot IPC

`readWorkspaceOfficeSemantic` accepts `path`, `workspaceRoot`, and optional `expectedSha256`; success returns source format, SHA-256, bounded text, and a truncation flag. The main process resolves the same workspace boundary and reuses binary preview validation. DOC/PPT use the existing private LibreOffice conversion before OfficeCLI extraction, DOCX/PPTX use OfficeCLI directly, and XLS/XLSX use sparse SheetJS extraction. Temporary snapshots and conversions are removed in `finally` paths.

The renderer caches semantic text against the session SHA. A Write send with Office quotes includes only those quotes. Otherwise the active Office session loads semantic text on demand, restores the user's prompt on failure or source drift, and embeds the bounded context in a dedicated collapsible prompt block.

Alternative: ask the model to call `office_inspect`. That tool excludes legacy formats and cannot guarantee the UI's exact SHA or read-only prompt contract.

## Risks / Trade-offs

- [Third-party Office DOM changes can break selection mapping] → Limit queries to stable rendered containers and cover extraction with renderer tests.
- [Large worksheets can create expensive selections] → Restrict selection to the current 200 by 100 window and serialize only the normalized rectangle.
- [Semantic extraction can be slow] → Load only on send, cache by SHA, abort stale work, and retain the user's composer text on failure.
- [Legacy conversion is unavailable] → Surface the existing actionable LibreOffice message while leaving modern formats operational.
- [Office context may dominate prompts] → Retain the 200,000 character semantic cap, flag truncation, and omit whole-document context whenever an Office quote exists.

## Migration Plan

1. Add compatible shared types and IPC without removing existing preview or attachment contracts.
2. Extend Write sessions and file discovery, then add the Office pane and unique-path refresh controller.
3. Add neutral renderer selections and adapt them into Write quotes and assistant prompts.
4. Validate regressions and merge as one reversible feature commit; rollback requires no stored-data migration.

## Open Questions

None.
