## 1. Governance and Baseline

- [x] 1.1 Add a dependency-free tracked-text line counter with binary and lockfile classification
- [x] 1.2 Add focused tests for 700/701 boundaries, unterminated final lines, exclusions, and stable diagnostics
- [x] 1.3 Expose the dedicated package command without enabling the repository-wide gate until baseline violations are zero
- [x] 1.4 Record the current violation inventory by repository area and preserve unrelated working-tree content

## 2. Renderer Refactors

- [x] 2.1 Split oversized renderer settings components and their tests by settings domain
- [x] 2.2 Split oversized chat composer and timeline components and their tests by rendering/controller responsibility
- [x] 2.3 Split oversized workbench, sidebar, subagent, schedule, workflow, write, SDD, and preview components by feature
- [x] 2.4 Split oversized renderer agent runtime, mapper, contract, and associated tests by protocol concern
- [x] 2.5 Split oversized Zustand store actions, reducers, helpers, and tests by operation group
- [x] 2.6 Split oversized renderer design, graph, write-preview, extension contribution, and associated tests
- [x] 2.7 Split oversized renderer CSS by component/surface while preserving cascade order
- [x] 2.8 Split oversized localization resources by namespace while preserving lookup keys and fallback behavior
- [x] 2.9 Run renderer-focused typecheck and tests and confirm zero renderer violations

## 3. Electron Main and Shared Refactors

- [x] 3.1 Split oversized Electron entrypoint and IPC registration modules by lifecycle/handler domain
- [x] 3.2 Split oversized Claw, schedule, Telegram, Weixin, workflow, browser-use, updater, and process modules by service responsibility
- [x] 3.3 Split runtime data migration, recovery, storage relocation, and data migration modules and tests by migration phase/scenario
- [x] 3.4 Split oversized main services and tests by operation group
- [x] 3.5 Split oversized shared settings contracts, normalizers, presets, API contracts, UI plugin, migration, and tests by domain
- [x] 3.6 Run main/shared-focused typecheck and tests and confirm zero main/shared violations

## 4. Kun Runtime Refactors

- [x] 4.1 Split oversized Kun TUI application, controller, client, state, and tests by command/view/runtime concern
- [x] 4.2 Split runtime factory, server routes, and HTTP/server tests by route/composition concern
- [x] 4.3 Split agent loop, model-step, outcome, compaction, and related tests by loop phase
- [x] 4.4 Split model, tool, file, and hybrid adapters and tests by request/tool/persistence concern
- [x] 4.5 Split Kun services and tests by cohesive service operation
- [x] 4.6 Split agent SDK, Cursor, Antigravity, delegation, graph, and associated tests by lifecycle concern
- [x] 4.7 Split Kun extensions, manager, CLI, config, contracts, skills, benchmark, PPT, and associated tests by feature
- [x] 4.8 Split remaining top-level Kun tests by behavior with shared fixtures in support modules
- [x] 4.9 Run Kun typecheck/build and focused tests and confirm zero Kun violations

## 5. Extensions, Packages, Scripts, Data, and Documentation

- [x] 5.1 Split Kun video editor host and engine sources by media/tool operation
- [x] 5.2 Split Kun video editor webview sources, styles, manifests, and tests by UI feature
- [x] 5.3 Split presentation studio sources and oversized extension data by project/webview concern
- [x] 5.4 Split extension API/test packages and schemas by contract domain
- [x] 5.5 Split oversized smoke, release, packaging, and migration scripts and their tests by workflow phase
- [x] 5.6 Split oversized PPT toolchain source/reference files and other authored resources by function/chapter
- [x] 5.7 Split oversized design documents into navigable focused chapters while preserving entry links
- [x] 5.8 Confirm zero applicable violations across extensions, packages, scripts, resources, and docs

## 6. Enforcement and Full Validation

- [x] 6.1 Run the repository-wide line checker and resolve every remaining applicable violation
- [x] 6.2 Enable the line checker in the normal lint/validation workflow and document the 700-line rule in AGENTS.md
- [x] 6.3 Run git diff checks, typecheck, lint, relevant unit suites, `build:kun`, and the top-level build
- [x] 6.4 Run a final independent tracked-file audit and record zero applicable files above 700 lines
