## 1. Thread contracts and persistence

- [x] 1.1 Add shared Kun schemas/types for read-only knowledge-base mounts, index status, validation, and thread projections
- [x] 1.2 Persist, normalize, update, event-project, and fork knowledge-base mounts without changing additional-workspace sandbox authority
- [x] 1.3 Extend renderer runtime contracts, thread mapping, provider operations, and migration path metadata for mounted roots

## 2. Vectorless knowledge index

- [x] 2.1 Implement bounded local directory scanning, canonical-path safety, source fingerprints, and persistent derived index storage
- [x] 2.2 Build directory/document/Markdown/text/PDF hierarchy nodes with source locations and Markdown reference edges
- [x] 2.3 Implement index lifecycle status, shared in-flight builds, freshness checks, rebuild, and unavailable/error degradation

## 3. Kun retrieval tools and routes

- [x] 3.1 Add read-only knowledge catalog, browse, and source-read tools gated to authorized mount/node identifiers
- [x] 3.2 Register the knowledge service/tools in the Kun composition root and add dynamic mounted-knowledge context instructions
- [x] 3.3 Add thread knowledge status and reindex HTTP routes with runtime-busy mutation guards

## 4. Code-mode user experience

- [x] 4.1 Add thread/store actions for mounting, removing, refreshing, and rebuilding knowledge bases
- [x] 4.2 Add a Code composer knowledge-base picker sourced from Write workspaces, including directory add and idle-thread guards
- [x] 4.3 Show mount/index states and provide source-opening integration that switches to the matching Write workspace

## 5. Verification and documentation

- [x] 5.1 Add contract, persistence, fork, migration, sandbox-isolation, index, freshness, tool, and route tests
- [x] 5.2 Add renderer mapper/action/picker tests and bilingual UI strings
- [x] 5.3 Document the knowledge-base architecture, security boundary, supported formats, and vectorless retrieval flow
- [x] 5.4 Run focused tests, typecheck, Kun build, top-level build, lint/file-line gates, and resolve introduced failures
