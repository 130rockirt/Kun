## Context

The workbench already has a tabbed file-preview panel, a parent-directory
watcher that survives atomic renames, and an OfficeCLI-backed OOXML reader.
Office files are currently rendered as a single compressed image, cannot be
watched as binary files, and require manual preview selection. The Office
editing tool commits changes atomically and emits structured `file_change`
events with a source path and post-write SHA.

## Goals / Non-Goals

**Goals:**

- Open and refresh a safe, read-only Office preview from structured agent
  events without stealing focus after the user takes control of the preview.
- Preserve compatibility for existing text and image watcher consumers.
- Render modern OOXML with sanitized HTML, and provide a local optional
  conversion path for legacy Office files.

**Non-Goals:**

- Editing Office content from the preview panel.
- Bundling LibreOffice or uploading documents to a remote converter.
- Replacing the existing attachment/document ingestion path.

## Decisions

- Add an optional `mode: 'content' | 'signal'` to workspace file watches.
  `content` remains the default and its payload stays unchanged; `signal`
  resolves and stats a file without reading binary content. The renderer owns
  the 250 ms trailing render debounce and latest-result-wins cancellation.
- Add `readWorkspaceOfficePreview`, which resolves a workspace-bounded path in
  the main process before invoking the Office renderer. This avoids exposing a
  general local-file read route to the workbench.
- Return a sanitized, bounded OfficeCLI HTML document in the Office preview
  result. The renderer displays it in a scriptless, no-referrer sandboxed
  iframe and falls back to the existing semantic text/image representation when
  HTML is unavailable. `parse5` performs structural stripping rather than the
  less complete regex sanitizer used for static workspace HTML.
- Detect Office preview activity from `file_change`, `filePath`, `status`,
  `turnId`, and `meta.toolName`; preserve `office_edit` SHA/invalidated fields
  as structured metadata. A workbench-local controller opens the first target
  in a turn, opens later targets in the background, and records manual
  selection/close actions as a per-turn focus suppression.
- For `.doc`, `.xls`, and `.ppt`, locate an explicitly configured/PATH/common
  local LibreOffice executable, convert into a private temporary directory,
  preview the converted OOXML, and delete the temporary result. Source files
  remain untouched. Missing LibreOffice returns a stable actionable error.

## Risks / Trade-offs

- [OfficeCLI HTML is large or malformed] → enforce output bounds, sanitize it,
  and retain the semantic/image fallback.
- [Rendering races with repeated atomic writes] → use source SHA plus a
  monotonically increasing render request id; only the latest request updates
  the panel.
- [LibreOffice is unavailable or conversion fails] → report a non-destructive
  local dependency error and keep any previous preview visible.
- [User intent conflicts with auto-open] → auto-focus only once per turn and
  treat preview tab selection/closure as an explicit suppression signal.

## Migration Plan

The change is additive. Existing watcher callers omit `mode` and retain content
payloads. Preview consumers progressively use the new Office route; no stored
data migration or rollout flag is required. Reverting removes the new route
and restores the previous image/text Office preview without changing files.
