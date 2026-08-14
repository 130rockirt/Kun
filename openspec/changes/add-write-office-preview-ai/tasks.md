## 1. Contracts and document sessions

- [x] 1.1 Extend Write file classification, active kinds, persisted layouts, and document sessions for six Office formats and cached binary/semantic state
- [x] 1.2 Add the workspace-scoped Office semantic IPC request/result contract and preload bridge
- [x] 1.3 Add location-aware Office selection and quoted-selection types with backward-compatible prompt serialization and display parsing

## 2. Office loading and read-only Write UI

- [x] 2.1 Load Office sessions through the existing binary preview IPC and render them in Write tabs with Office-specific read-only toolbar behavior
- [x] 2.2 Watch unique visible Office paths with debounce, SHA preconditions, latest-result wins, last-success retention, and agent editing status
- [x] 2.3 Preserve Office sessions across tabs/groups and handle restore, rename, delete, and lifecycle behavior without entering save queues

## 3. Office selections and assistant actions

- [x] 3.1 Add neutral Word and PowerPoint DOM selection callbacks with page/slide metadata, anchor geometry, cleanup, and committed highlighting
- [x] 3.2 Add pointer-driven rectangular spreadsheet selection with worksheet/A1 metadata, TSV/formulas, merged-cell normalization, and window cleanup
- [x] 3.3 Adapt Office selections to the Write inline assistant, force all quick actions to chat, and hide every write-only action
- [x] 3.4 Render Office quote locations in assistant chips and collapsed prompt history while preserving text/PDF parsing

## 4. Whole-document Office discussion

- [x] 4.1 Implement validated semantic extraction for DOC/DOCX/PPT/PPTX through private snapshots/conversion and OfficeCLI, and XLS/XLSX through sparse SheetJS
- [x] 4.2 Load and cache semantic context by SHA during Write sends, omit it when Office quotes exist, restore prompts on failure, and enforce a read-only instruction

## 5. Verification and delivery

- [x] 5.1 Add main-process, renderer, state, selection, prompt, refresh, and regression tests for the new behavior
- [x] 5.2 Run OpenSpec validation, typecheck, relevant and full tests, lint, file-line gate, build, and diff checks; record environment-limited manual cases
- [x] 5.3 Commit, rebase onto the latest local develop, revalidate conflicts, fast-forward merge, and remove the worktree and feature branch

Verification note: strict OpenSpec validation, typecheck, the relevant Office /
Write tests, the production build, ESLint, and diff checks pass. The root Vitest
run completed with 878 files passing, two skipped, and seven unrelated baseline
files failing (11 tests); none of the failing files is changed by this feature.
The combined `npm run test` also reaches unrelated failures in the unchanged Kun
suite. The `npm run lint` wrapper and `npm run check:file-lines` stop only on the
unchanged develop baseline file
`src/main/claw-runtime.workspace-turn-results.test.ts` (701 lines). The
development Electron build starts successfully, but this headless verification
environment does not provide the real seven-format Office fixtures or access to
the preload-backed desktop window, so the fixture-by-fixture visual exercise is
left as an environment-limited manual case; renderer interactions are covered by
automated tests.
