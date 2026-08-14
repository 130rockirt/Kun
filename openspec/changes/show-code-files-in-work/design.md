## Context

Work's file tree and open-file action share `src/shared/write-text-file.ts` as an allowlist. That contract intentionally admits editable Markdown/plain-text files plus read-only image, PDF, and Office files. A separate workspace preview surface already has a mature Shiki-based code highlighter and the main process already exposes a bounded, workspace-confined text reader, but Work currently filters code paths before that reader is reached.

## Goals / Non-Goals

**Goals:**

- Make common source, script, markup, data, and configuration files visible in Work's directory tree.
- Display admitted code files in Work tabs as inert, syntax-highlighted text with line numbers.
- Preserve the existing 1.5 MiB bounded text-read contract, binary rejection, file watching, tab restoration, and workspace confinement.
- Preserve existing editable behavior for Markdown and plain-text writing files.

**Non-Goals:**

- Adding code editing, language servers, execution, formatting, or inline code completion to Work.
- Showing arbitrary unknown extensions or binary files.
- Replacing Code mode or changing Office/PDF/image preview behavior.

## Decisions

### Classify code separately from editable writing text

The shared Work file helper will expose explicit code extension and well-known filename checks. `isWriteWorkspaceFilePath` and `isWriteWorkspaceEntry` will admit both categories, while `isWriteTextFilePath` remains limited to the existing editable Markdown/text formats. This prevents source files from inheriting auto-save, diff review, inline writing completion, export, and rich Markdown modes.

An alternative was to append code extensions to `WRITE_TEXT_FILE_EXTENSIONS`. That is smaller mechanically but silently makes every admitted source file editable and conflicts with the requested viewing behavior.

### Reuse the bounded text IPC and renderer highlighter

The Work open-file action will read code through `readWorkspaceFile`, store it as a distinct `code` document kind, and render it through the existing `code-highlighting` utility. No new preload or main-process surface is needed. The preview will use existing file-preview code CSS primitives for inert escaped/highlighted HTML and line numbers.

An alternative was embedding the full right-panel `WorkspaceFilePreviewPanel`. That panel owns unrelated tab, pin, edit, media, Office, and right-panel behavior, so embedding it would duplicate Work's tab ownership and introduce unnecessary coupling.

### Refresh open code previews without making them writable

Work's existing file watcher will watch `code` documents as text snapshots. Code snapshots replace the displayed content directly because no local dirty state exists for a read-only preview. Markdown/text conflict and save coordination remain unchanged.

## Risks / Trade-offs

- [Extension allowlists can drift from the general workspace preview list] → Cover representative families and well-known filenames in tests, keep the set explicit, and reuse the same syntax-language resolver at render time.
- [A file with a code-like extension may contain binary data] → Continue relying on the main-process null-byte rejection and bounded decoding before displaying content.
- [Large files can make highlighting expensive] → Reuse the highlighter's 250,000-character fallback and the reader's 1.5 MiB truncation; truncated previews remain read-only and visibly bounded.
- [New files can appear while Work is open] → Preserve the existing manual refresh and active-file watcher semantics; no recursive workspace watcher is introduced.

## Migration Plan

No data migration is required. Existing saved Work layouts continue to deserialize; newly admitted code paths can be restored after upgrade. Rolling back removes code entries from the tree again without modifying source files or persisted content.

## Open Questions

None.
