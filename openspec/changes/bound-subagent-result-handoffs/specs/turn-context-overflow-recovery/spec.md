## ADDED Requirements

### Requirement: Provider context overflow is classified separately
The model boundary SHALL translate recognized provider context-limit responses into a typed context-overflow failure without misclassifying ordinary provider errors.

#### Scenario: Provider rejects an oversized prompt
- **WHEN** a provider response contains a recognized context-length status, code, or message
- **THEN** the turn receives a typed context-overflow failure

#### Scenario: Provider returns an unrelated error
- **WHEN** an authentication, quota, moderation, or network error does not indicate context overflow
- **THEN** it follows the ordinary provider error path without a compaction retry

### Requirement: Context overflow receives one safe retry
The agent loop SHALL force compaction and retry a context-overflowed model round at most once when no partial model output has been committed.

#### Scenario: First overflow is recoverable
- **WHEN** the initial model request overflows before partial output and forced compaction creates enough room
- **THEN** the retry continues the same turn successfully

#### Scenario: Retry also overflows
- **WHEN** the single compacted retry receives another context-overflow response
- **THEN** the system fails the affected turn without further automatic retries

#### Scenario: Overflow follows partial output
- **WHEN** a provider reports overflow after partial assistant output has been committed
- **THEN** the system does not replay the model round automatically

### Requirement: Unrecoverable overflow is isolated to one turn
An unrecoverable provider context overflow SHALL use the ordinary turn failure path and MUST NOT terminate the runtime or interrupt unrelated active conversations.

#### Scenario: One conversation cannot recover
- **WHEN** a turn exhausts its context-overflow retry
- **THEN** that turn records an actionable error while other conversations continue running
