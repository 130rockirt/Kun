## Why

Work currently filters its workspace tree to writing, image, PDF, and Office formats, so source files stored beside Office deliverables are invisible even though the existing bounded text reader can display them. Users need to inspect those code and configuration files without leaving the Work workspace.

## What Changes

- Include common text-based source and configuration files in the Work workspace tree, including recognized extensionless files such as `Dockerfile` and `Makefile`.
- Open supported code files in a read-only, syntax-highlighted Work preview with the same size, truncation, tab, workspace-boundary, and live-refresh safeguards as other workspace files.
- Keep unsupported or binary formats filtered out and preserve all existing Office, PDF, image, Markdown, and plain-text behavior.
- Add focused shared-helper and Work file-opening coverage for representative code files and rejected binary files.

## Capabilities

### New Capabilities

- `work-code-file-viewing`: Discovery and safe source viewing of supported code and configuration files inside Work workspaces.

### Modified Capabilities

None.

## Impact

- Shared Work workspace file classification helpers.
- Work workspace tree filtering and existing text-file opening flow.
- Unit tests for shared classification and Work file actions; no new IPC or runtime API is required.
