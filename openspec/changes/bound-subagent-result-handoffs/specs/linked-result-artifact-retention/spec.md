## ADDED Requirements

### Requirement: Child result artifacts have linked owners
The Artifact Store SHALL allow newly externalized child results to declare related parent-thread and child-run owners while preserving content-addressed deduplication.

#### Scenario: Identical child results are stored
- **WHEN** multiple related child runs externalize identical Markdown content
- **THEN** they share one artifact payload and all distinct linked owners are retained

### Requirement: Linked artifacts follow related session lifetime
The system SHALL release artifact owners when related child records or parent sessions are deleted and SHALL delete a linked artifact only after its final owner is released.

#### Scenario: One owner remains
- **WHEN** a related child record is deleted but its parent-thread owner still exists
- **THEN** the shared result artifact remains readable

#### Scenario: Final related owner is deleted
- **WHEN** the final child-run or parent-thread owner of a linked result artifact is released
- **THEN** the artifact payload and metadata are removed

#### Scenario: Parent session is deleted
- **WHEN** a parent session with delegated child runs is deleted
- **THEN** related child records and side threads are cleaned up and their result-artifact owners are released idempotently

### Requirement: Existing artifacts are not adopted implicitly
Artifacts created without linked retention metadata MUST retain their current deletion behavior and MUST NOT be garbage-collected merely because they have no linked owners.

#### Scenario: Legacy unlinked artifact has no owner list
- **WHEN** retention cleanup scans or releases linked owners
- **THEN** the legacy artifact is left unchanged
