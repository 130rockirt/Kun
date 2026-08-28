## 1. Baseline and contracts

- [x] 1.1 Add anonymous multilingual retrieval fixtures and a deterministic baseline scorer for Recall@K, Precision@K, reciprocal rank, scope leaks, selected context size, and latency
- [x] 1.2 Extend the memory Zod contracts with version, type, reference authority, importance, temporal validity, bounded source evidence, index diagnostics, and retrieval-trace schemas
- [x] 1.3 Add a compatibility normalizer that maps every supported legacy `MemoryRecord` to V2 without eagerly rewriting canonical JSON
- [x] 1.4 Add pure, bounded helpers for freshness, lifecycle state, Latin/CJK search tokens, ranking features, stable ordering, and prompt-size accounting
- [x] 1.5 Add contract and pure-function tests for malformed evidence, legacy defaults, time boundaries, CJK limits, FTS input escaping, and deterministic scores

## 2. Hybrid canonical store and SQLite projection

- [x] 2.1 Add focused `HybridMemoryStore` modules that write canonical JSON atomically before projecting mutations into a dedicated memory SQLite index
- [x] 2.2 Add versioned SQLite schema/migrations for memory rows, source summaries, FTS5 search tokens, index metadata, and reconciliation state
- [x] 2.3 Implement bounded startup backfill and id/hash/update-time reconciliation that yields to the event loop and never deletes malformed canonical files
- [x] 2.4 Implement degraded-state detection and filesystem/n-gram fallback for missing modules, FTS5 absence, open/migration/query failure, corruption, and stale indexes
- [x] 2.5 Keep create, createWithId, update, disable/restore, supersede, delete, purge, list, retrieve, and diagnostics contract-equivalent while converging every projection
- [x] 2.6 Add direct adapter tests for crash windows, index deletion/rebuild, corruption, migration failure, CJK FTS, lifecycle mutations, exact-path protection, and concurrent reads/writes

## 3. Manager ownership and runtime composition

- [x] 3.1 Refactor Manager shared-data memory ownership to one logical repository per data root instead of one physical store per serialized capability configuration
- [x] 3.2 Extend Manager operation contracts and `ManagerRemoteMemoryStore` for V2 records, policy-aware retrieval, diagnostics, and bounded traces
- [x] 3.3 Select the hybrid adapter in local and Manager runtime composition while preserving `FileMemoryStore` as an explicit degraded/rollback path
- [x] 3.4 Verify hot memory-config reload changes enablement, scopes, and limits without changing repository identity or losing last-injected diagnostics
- [x] 3.5 Run one shared MemoryStore contract suite against direct hybrid, degraded file, and Manager remote implementations

## 4. Retrieval and context assembly

- [x] 4.1 Implement scope/lifecycle-first indexed candidate selection with safely bound FTS5 queries and bounded generated Latin/CJK tokens
- [x] 4.2 Replace confidence decay with independent relevance, freshness, confidence, importance, and scope/type ranking features plus stable tie-breakers
- [x] 4.3 Remove unconditional user-scope injection and honor the minimum of caller limit and live `maxInjectedRecords`
- [x] 4.4 Add deterministic context-size budgeting, duplicate suppression, bounded evidence labels, and exclusions/truncation reporting
- [x] 4.5 Frame injected memory as untrusted reference evidence outside the immutable system prefix and preserve exact selected ids
- [x] 4.6 Persist a bounded privacy-safe retrieval trace and extend diagnostics without adding a general runtime control surface

## 5. Existing surfaces and compatibility

- [x] 5.1 Extend existing memory HTTP routes, TUI schemas/client, renderer runtime mappings, settings state, and import/export normalization without changing CRUD semantics
- [x] 5.2 Show index health, backfill/degraded state, independent ranking metadata, source evidence, and last-retrieval explanation in the existing Memory settings surface
- [x] 5.3 Add actionable sanitized errors for native SQLite/FTS5 failures and preserve local memory use through fallback
- [x] 5.4 Update `kun/README.md`, architecture, data-layout, diagnostics, migration, and user-facing memory documentation in the existing bilingual pattern
- [x] 5.5 Retain explicit memory tool approval and verify that imported/tool/web/inference content never gains user or system instruction authority

## 6. Verification and delivery

- [x] 6.1 Add legacy JSON, damaged JSON, scope-path, migration, restart, Manager serialization, deletion cleanup, prompt-injection, and retrieval-regression integration tests
- [ ] 6.2 Verify FTS5 and native `better-sqlite3` behavior in packaged Windows x64, macOS arm64/x64, Linux x64, and Linux ARM64 artifacts while retaining measured fallback behavior
- [x] 6.3 Compare baseline and hybrid retrieval metrics, record ranking weights and accepted trade-offs, and block semantic/vector follow-ups until the report is reproducible
- [ ] 6.4 Run focused tests, `npm run build:kun`, `npm run check:file-lines`, `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`, and `git diff --check`
- [ ] 6.5 Manually verify create/edit/disable/restore/delete/import/export, cross-workspace isolation, retrieval explanation, runtime restart, and SQLite-degraded Memory UI flows
- [ ] 6.6 Rebase the implementation branch onto latest `develop`, rerun affected validation, complete the PR template and CLA checkbox, and attach UI video/GIF evidence when the settings surface changes
