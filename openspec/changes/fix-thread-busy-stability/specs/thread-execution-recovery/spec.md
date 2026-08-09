## ADDED Requirements

### Requirement: Busy responses remain structured across application layers
The system SHALL preserve `thread_busy` as a typed runtime error from Kun through Electron to the renderer and SHALL NOT expose runtime owner instance identifiers in the primary user-facing message.

#### Scenario: Active thread rejects a distinct turn
- **WHEN** a client starts a distinct turn while another turn owns the thread lease
- **THEN** the runtime returns HTTP 409 with code `thread_busy` and safe active-turn details
- **AND** the renderer presents an actionable running-state status instead of `unknown`

### Requirement: The renderer reconciles authoritative active-turn state
The renderer SHALL recover the active turn and SSE subscription when a start request receives `thread_busy`, and SHALL retain the submitted user intent exactly once in the queued-message list.

#### Scenario: Locally idle thread is busy on the server
- **WHEN** the GUI submits from stale local idle state and receives `thread_busy`
- **THEN** it restores busy controls and the authoritative active turn
- **AND** it queues the submitted message once for delivery after the active turn settles

### Requirement: Turn admission is idempotent
The runtime SHALL accept an optional client request identifier, persist it on the admitted turn, and return the original start response for a retry with the same identifier and request.

#### Scenario: Accepted response is lost and retried
- **WHEN** a client retries a turn-start request with the same `clientRequestId`
- **THEN** the runtime returns the original turn and user-message identifiers
- **AND** no additional turn or user item is created

#### Scenario: Identifier is reused for different content
- **WHEN** a client reuses a persisted `clientRequestId` with a different prompt
- **THEN** the runtime returns a conflict without changing the existing turn

### Requirement: Single-writer execution remains enforced
The runtime MUST continue to allow at most one active writer per thread across GUI and TUI runtime flavors.

#### Scenario: Different clients submit concurrently
- **WHEN** two different requests target the same thread concurrently
- **THEN** only one is admitted and the other receives `thread_busy`
