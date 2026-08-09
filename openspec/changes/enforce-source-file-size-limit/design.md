## Context

The initial tracked-file audit found 329 line-oriented text files above 700 physical lines. The violations span application code, Kun runtime code, tests, styles, extension examples, scripts, JSON resources, and documentation, so the work cannot be solved by moving one component or by weakening a linter threshold. The checkout is already ahead of `origin/develop` and contains unrelated untracked work, so refactors must preserve those files and remain organized by non-overlapping repository areas.

The application is an Electron, React, and TypeScript product whose renderer, preload bridge, main process, shared contracts, and bundled Kun runtime have explicit architectural boundaries. File extraction must keep those boundaries intact and must not recreate legacy runtime/provider surfaces. Existing exports, IPC and HTTP contracts, persisted formats, extension manifests, CSS cascade order, and test discovery behavior are compatibility constraints.

## Goals / Non-Goals

**Goals:**

- Bring every applicable tracked text file to 700 physical lines or fewer.
- Replace mixed-responsibility files with cohesive modules organized around features, services, contracts, rendering concerns, fixtures, or test scenarios.
- Preserve existing public module entry points where moving callers would add risk without architectural value.
- Add a deterministic automated guard that prevents new applicable violations.
- Validate refactors with focused tests followed by repository typecheck, test, build, lint, and a final independent line audit.

**Non-Goals:**

- Changing product behavior, provider semantics, serialized data, public APIs, or user-facing workflows.
- Reformatting unrelated files or redesigning features merely because their implementation is being moved.
- Rewriting opaque binary/media assets or package-manager lockfiles, for which physical source lines are not an authored modularity boundary.
- Touching unrelated untracked workspace content.

## Decisions

### 1. Apply the limit to tracked, line-oriented, human-maintained text

The checker will enumerate Git-tracked files, reject applicable files above 700 physical lines, and report all failures in a stable order. It will identify binary/opaque content by bytes rather than filename alone and explicitly exempt recognized package-manager lockfiles. All other tracked text, including source, tests, styles, scripts, JSON resources, and Markdown, is in scope.

This is preferred over an extension allowlist because an allowlist silently misses new languages or configuration formats. Counting only tracked files also prevents unrelated local scratch files from breaking repository validation.

### 2. Use physical lines and an inclusive threshold

An applicable file is valid when it contains at most 700 physical lines. The checker will count a final unterminated line, so the result does not depend on trailing-newline style. Blank and comment lines count because they still affect navigation and review size.

This is preferred over statement counts or complexity scores because the requested constraint is simple, language-independent, and directly auditable.

### 3. Extract by functional seam, retaining compatibility facades

Production TypeScript and JavaScript files will be split by domain responsibility: contracts/types, pure helpers, adapters, lifecycle orchestration, rendering sections, hooks/controllers, and service operations. Existing high-value import paths may become thin facades that re-export focused modules. Shared contracts stay in `src/shared`, system integration stays in `src/main`, renderer behavior stays in `src/renderer/src`, and agent behavior stays in `kun/src`.

Tests will be divided by behavior or scenario group with shared fixtures/builders in dedicated support modules. CSS will be divided by component or surface while preserving import/cascade order. Large data or manifest files will move authored sections into focused inputs and use existing composition mechanisms; if a required standalone artifact is generated, its checked-in representation must itself remain within the line limit. Long documents will become an index plus focused chapters with stable links.

Compatibility facades are preferred over wholesale import churn where they reduce regression risk, but facades must not become new dumping grounds.

### 4. Refactor in independent repository batches

Work will proceed in non-overlapping batches: renderer; Electron main/shared; Kun runtime/TUI; and extensions/packages/scripts/docs. Each batch must reach zero applicable violations in its owned paths and pass its closest tests before the next integration checkpoint.

This reduces merge conflicts and makes failures attributable. The final gate remains repository-wide; batch completion cannot hide violations elsewhere.

### 5. Enforce the contract through a repository script and normal validation

A small dependency-free checker will live under `scripts/`, expose a dedicated package script, and run from the normal lint/validation path. The checker will print the measured line count and path for every violation and exit non-zero if any exist. Tests will cover threshold boundaries, final unterminated lines, binary detection, lockfile exclusion, and deterministic reporting.

A local script is preferred over adding a third-party linter because the rule spans languages and non-code text, while the repository already has a Node-based validation toolchain.

## Risks / Trade-offs

- [Risk] Moving declarations can introduce circular imports or alter module initialization order. → Keep extraction direction acyclic, prefer pure leaf modules, and run focused tests/typecheck after each batch.
- [Risk] Splitting CSS can change cascade order. → Preserve the original declaration order through explicit ordered imports and visually inspect affected high-density surfaces when practical.
- [Risk] Splitting tests can accidentally drop scenarios or change shared setup. → Move complete `describe` groups, centralize only true shared fixtures, and compare test discovery/counts before and after.
- [Risk] JSON/data composition can change key precedence or packaging paths. → Preserve deterministic merge order, assert representative keys/schema validity, and exercise packaging/build checks.
- [Risk] A broad refactor creates review and conflict pressure. → Keep commits/batches domain-focused, avoid unrelated cleanup, and retain compatibility facades where useful.
- [Trade-off] Counting comments and blank lines may encourage compact formatting. → Functional extraction is required for oversized authored modules; minification is reserved for machine-generated standalone artifacts, not source code.

## Migration Plan

1. Add the checker and characterize the baseline without enabling the failing gate in the main validation path.
2. Refactor each repository batch until its applicable files are at or below 700 lines, running focused checks after each extraction.
3. Run the checker repository-wide, resolve remaining text/data/document violations, then enable it in the normal validation path.
4. Run typecheck, relevant unit/integration tests, lint, Kun build, and the top-level build; fix any regressions.
5. Re-run the independent line audit and record zero applicable violations before completing the change.

Rollback is file-local: revert the extraction batch and its import changes together. The size gate should only be enabled after the baseline is zero, so it never lands with a known failing repository.

## Open Questions

None. The 700-line threshold and repository-wide human-maintained text scope are explicit; any newly discovered required generated artifact will be handled without weakening the authored-source rule.
