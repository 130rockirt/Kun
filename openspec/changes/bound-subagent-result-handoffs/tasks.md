## 1. Bounded Child Result Contract

- [x] 1.1 Add structured child result reference, truncation, and unavailable-reason fields to delegation records, events, and renderer contracts
- [x] 1.2 Select only the final non-empty child assistant answer and materialize a deterministic 4,000-character preview
- [x] 1.3 Externalize results over the byte, line, or approximate-token thresholds before any parent-facing persistence or publication
- [x] 1.4 Make artifact write failure return only a bounded preview and sanitized reason while preserving completed child status

## 2. Artifact Ownership And Session Cleanup

- [x] 2.1 Extend file, memory, and manager-backed artifact stores with linked owner merge and release operations
- [x] 2.2 Attach parent-thread and child-run owners to externalized child results while preserving content-addressed deduplication
- [x] 2.3 Add idempotent child record deletion and parent/child thread cleanup that releases result artifact owners
- [x] 2.4 Verify unlinked legacy artifacts are never deleted by linked-owner cleanup

## 3. Parent Projection And User Experience

- [x] 3.1 Bound lifecycle event text, delegate tool results, and detached/resume completion notices to the normalized projection
- [x] 3.2 Preserve evidence, review bundle, deck artifact, usage, and child-thread navigation behavior
- [x] 3.3 Show truncation/externalization metadata in the existing renderer child-run card

## 4. Context Overflow Isolation

- [x] 4.1 Add conservative provider context-overflow classification and a typed error contract
- [x] 4.2 Force one compaction retry only when no partial model output has been committed
- [x] 4.3 Verify repeated overflow fails only the affected turn without runtime shutdown

## 5. Verification

- [x] 5.1 Add unit coverage for threshold boundaries, final-message selection, artifact success/failure, and linked artifact retention
- [x] 5.2 Add delegation coverage for synchronous, detached, resumed, evidence, review, and presentation results
- [x] 5.3 Add context-overflow retry/isolation coverage and a constrained-memory regression proving unrelated turns continue
- [x] 5.4 Run focused tests, Kun build, typecheck, full unit tests, build, and file-size gate
