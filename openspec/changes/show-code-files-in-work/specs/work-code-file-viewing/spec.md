## ADDED Requirements

### Requirement: Work discovers supported code files
Work SHALL include common text-based source, script, markup, data, and configuration files in its workspace tree, including supported extensionless filenames, while continuing to exclude unsupported and binary formats.

#### Scenario: Common source files are present
- **WHEN** a Work workspace directory contains files such as `app.tsx`, `service.py`, `config.json`, and `styles.css`
- **THEN** those files appear in the Work file tree and can be selected

#### Scenario: Well-known extensionless files are present
- **WHEN** a Work workspace directory contains a supported name such as `Dockerfile` or `Makefile`
- **THEN** that file appears in the Work file tree and can be selected

#### Scenario: Unsupported binary remains excluded
- **WHEN** a Work workspace directory contains an unsupported binary such as `archive.zip`
- **THEN** that file does not appear as a viewable Work document

### Requirement: Work previews code without enabling code editing
Work SHALL open supported code files in a read-only source preview with line numbers and syntax highlighting when a bundled grammar is available. It MUST NOT enable save, writing inline completion, rich Markdown editing, or document export for the code preview.

#### Scenario: User opens a code file
- **WHEN** the user selects a supported code file from the Work tree
- **THEN** Work opens it in the current editor group as a read-only code preview and keeps the file eligible for Work tab and split-group navigation

#### Scenario: Highlight grammar is unavailable
- **WHEN** a supported text-based code file has no bundled syntax grammar
- **THEN** Work displays its escaped content as inert plain text with line numbers

### Requirement: Code previews retain workspace safety and freshness
Work SHALL use the existing workspace-confined bounded text-read contract for code files and SHALL refresh an open code preview after a watched external change. It MUST keep truncated code previews read-only and MUST surface read or binary-decoding failures without interpreting file content as markup.

#### Scenario: Open code file changes on disk
- **WHEN** an open code file receives a stable external write
- **THEN** its displayed content, size, and truncation state refresh to the latest text snapshot without a save-conflict prompt

#### Scenario: Code file exceeds the text preview bound
- **WHEN** a supported code file exceeds the bounded text-read limit
- **THEN** Work displays only the returned truncated content and indicates that the preview is truncated

#### Scenario: Code-like file is binary
- **WHEN** the bounded reader rejects a selected code-like path as binary
- **THEN** Work shows the read failure and does not render or mutate the file

### Requirement: Existing Work document behavior remains stable
Work SHALL preserve editable Markdown/plain-text documents and the existing read-only image, PDF, and Office preview paths when code viewing is enabled.

#### Scenario: Existing writing document is opened
- **WHEN** the user opens a supported Markdown or plain-text writing document
- **THEN** its existing editing, save, preview, and inline-assistance behavior remains available

#### Scenario: Existing Office document is opened
- **WHEN** the user opens a supported Office document
- **THEN** its existing read-only browser preview and selection behavior remains unchanged
