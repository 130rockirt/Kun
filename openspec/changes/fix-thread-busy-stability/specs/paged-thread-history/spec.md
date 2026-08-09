## ADDED Requirements

### Requirement: Initial thread hydration is bounded
The runtime SHALL provide a timeline endpoint whose page contains at most 300 public items and at most 4 MiB of serialized item data.

#### Scenario: Large thread is opened
- **WHEN** a thread contains substantially more than one page of history
- **THEN** the initial response contains the latest bounded page and reports that older history is available

#### Scenario: A single item exceeds the byte budget
- **WHEN** one public item exceeds the page byte limit
- **THEN** the response contains a bounded preview with stable identity and terminal metadata

### Requirement: Timeline pagination preserves order and identity
The runtime SHALL expose an opaque cursor for older pages, and the renderer SHALL merge pages chronologically while deduplicating item identifiers.

#### Scenario: User loads older history while new events arrive
- **WHEN** the renderer prepends an older page during an active SSE subscription
- **THEN** existing and newly streamed items remain ordered and appear exactly once

### Requirement: Timeline hydration preserves replay continuity
Each timeline response SHALL include a replay floor and active interaction identifiers captured consistently with its projection.

#### Scenario: Event is appended after the page snapshot
- **WHEN** a runtime event is appended after the timeline replay floor is captured
- **THEN** subscribing from that floor delivers the event without losing or duplicating projected state

### Requirement: Full-detail compatibility is retained
The existing full thread detail endpoint SHALL remain available for clients that have not adopted timeline pagination.

#### Scenario: Legacy client loads a thread
- **WHEN** a client requests the existing full-detail endpoint
- **THEN** it receives the compatible response shape and behavior
