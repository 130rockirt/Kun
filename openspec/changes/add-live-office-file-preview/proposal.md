## Why

Office documents created or edited by an agent currently require the user to
find the file and manually open a separate preview. That breaks the feedback
loop for document, spreadsheet, and presentation work and makes it difficult to
verify each completed edit batch.

## What Changes

- Add live, read-only workspace previews for Word, Excel, and PowerPoint files
  when an agent reports a successful Office file change.
- Keep one preview tab per Office file, automatically focusing only the first
  Office file changed in a turn and respecting later user tab or close actions.
- Refresh a preview after stable file writes using a binary-safe workspace file
  watcher, debounce, source hash checks, and latest-result-wins rendering.
- Render OOXML files with the bundled OfficeCLI output in a sandboxed, sanitized
  viewer with document pages, spreadsheet sheets, slide navigation, and zoom.
- Support legacy `.doc`, `.xls`, and `.ppt` through an optional local
  LibreOffice conversion without mutating the source file.

## Capabilities

### New Capabilities

- `live-office-file-preview`: Automatic, safe, and continuously refreshed
  workspace previews for Office files changed by the agent.

### Modified Capabilities

<!-- None. -->

## Impact

- Renderer workbench file-preview state, tool-event projection, and right-panel
  UI.
- Shared preload/main-process workspace file contracts and IPC handlers.
- Main-process OfficeCLI rendering and optional LibreOffice conversion.
- Workspace file-watcher behavior and focused renderer/main-process tests.
