## ADDED Requirements

### Requirement: Write is presented as Work without protocol renaming
All user-facing workspace navigation, onboarding, settings, assistant, empty-state, and knowledge-base entry language SHALL present the product surface as Work/办公 while stable internal identifiers remain `write`.

#### Scenario: Existing Work workspace
- **WHEN** a user upgrades with existing Write settings, workspace registry, and assistant threads
- **THEN** Work opens the same data without creating duplicate workspaces or conversations

#### Scenario: Runtime surface
- **WHEN** Work sends a new assistant turn
- **THEN** the renderer and Kun continue to use `agentSurface: 'write'`

#### Scenario: Extension compatibility
- **WHEN** an installed extension contributes to `workbench:write`
- **THEN** it continues to match the Work surface without requiring a new `workbench:work` token

### Requirement: Work language reflects actual Office capability
Work SHALL describe Markdown/text editing and Office/PDF preview, selection, quotation, analysis, and generation flows accurately, and SHALL NOT claim native editing of Office files.

#### Scenario: Office task starters
- **WHEN** Work shows its empty task suggestions
- **THEN** suggestions may offer summarization, PDF questions, spreadsheet analysis, presentation generation, and document discussion without claiming direct Word/Excel/PowerPoint editing

#### Scenario: Office read-only behavior
- **WHEN** a DOC, DOCX, XLS, XLSX, PPT, or PPTX file is opened after the rename
- **THEN** its existing read-only preview, selection, semantic context, and live-refresh behavior remains unchanged

### Requirement: Localized terminology is complete and intentional
Every supported locale SHALL provide Work product labels while retaining writing-specific terms for concrete writing, polishing, formatting, and inline-completion features.

#### Scenario: Locale parity
- **WHEN** localization validation runs
- **THEN** Work labels and interpolation keys are present across all supported locales without renaming the existing `write*` i18n keys
