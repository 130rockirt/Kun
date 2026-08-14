## ADDED Requirements

### Requirement: Child result projection is bounded before parent publication
The system SHALL derive a child handoff from the final non-empty assistant answer in the child turn and SHALL bound it before writing a child-run record, publishing a parent lifecycle event, formatting a detached notice, or returning a delegation tool result.

#### Scenario: Multi-message child turn completes
- **WHEN** a child turn contains multiple assistant text items
- **THEN** the handoff source is the last non-empty assistant text item rather than their concatenation

#### Scenario: Inline child answer stays below every limit
- **WHEN** the final answer is at most 50 KiB, 2,000 lines, and approximately 8,000 tokens
- **THEN** the complete answer is returned inline with no result artifact reference

### Requirement: Oversized child results are externalized
The system SHALL store the full Markdown result as an artifact when any handoff limit is exceeded and SHALL expose at most 4,000 inline characters plus structured artifact metadata.

#### Scenario: Dense result exceeds byte limit
- **WHEN** a child final answer exceeds 50 KiB without exceeding 2,000 lines
- **THEN** the parent receives a bounded preview and a `text/markdown` artifact reference containing byte and line counts

#### Scenario: Line-heavy result exceeds line limit
- **WHEN** a child final answer exceeds 2,000 lines
- **THEN** it is externalized even if its UTF-8 byte size is below 50 KiB

#### Scenario: Parent needs more detail
- **WHEN** a parent receives an externalized child result reference
- **THEN** it can use `read_artifact` with bounded offsets and limits instead of injecting the entire result

### Requirement: Externalization failure never restores raw output
The system MUST keep the child completed and return only a bounded preview with an explicit unavailable reason when result artifact persistence fails.

#### Scenario: Artifact quota or I/O failure
- **WHEN** a child result exceeds a handoff limit and the artifact store rejects the write
- **THEN** no raw oversized result is stored in parent-facing records or events and the completed child thread remains available as the canonical result

### Requirement: All delegation completion modes share the same projection
Synchronous, detached, resumed, evidence-returning, review, and presentation child runs SHALL preserve their auxiliary structured outputs while using the same bounded text handoff.

#### Scenario: Detached child completes with oversized text
- **WHEN** a detached child completes after the parent turn has moved on
- **THEN** its lifecycle event and injected completion notice contain only the bounded preview and artifact reference

#### Scenario: Evidence or presentation child completes
- **WHEN** a child includes evidence, a review bundle, or a deck artifact
- **THEN** those fields remain available without embedding the full oversized text result

### Requirement: Child card reports externalization without changing navigation
The renderer SHALL show that a child result was truncated or externalized and SHALL retain the existing Open action for the child thread.

#### Scenario: Externalized child lifecycle event is rendered
- **WHEN** the renderer receives child metadata with a result reference
- **THEN** the child card shows bounded result metadata and Open continues to navigate to the child thread
