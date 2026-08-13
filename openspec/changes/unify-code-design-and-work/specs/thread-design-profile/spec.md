## ADDED Requirements

### Requirement: Design profile is a durable optional contract on a Code thread
Kun SHALL persist at most one locked Design profile per Code-workbench conversation containing its document binding, board target, output medium, Web/App target, resolved style snapshot, full bounded design-context snapshot, and lock turn identity. Once locked, only Design turns may carry or change the profile; Code turns remain valid without a profile and re-entering Design reuses the locked profile.

#### Scenario: First profile lock
- **WHEN** the first valid Design turn supplies a profile to a Code-owned thread with no locked profile
- **THEN** Kun atomically stores that profile with the accepted turn id

#### Scenario: Profile survives reload
- **WHEN** the renderer reloads, reconnects, paginates history, or recovers a queued message
- **THEN** it restores the locked controls and canvas target from runtime data rather than mutable global Design settings

#### Scenario: Conflicting profile
- **WHEN** a later Design turn supplies a different output medium, target, style, or document binding
- **THEN** Kun rejects it with `design_profile_locked` and leaves the existing profile unchanged

#### Scenario: Code turn after profile lock
- **WHEN** a conversation with a locked Design profile submits a Code turn without a Design profile or document target
- **THEN** Kun accepts the Code turn and preserves the locked profile

### Requirement: Design profile is snapshotted on each Design turn
Every Design turn and its user item SHALL record the effective profile and document target needed for audit, replay, and canvas routing.

#### Scenario: Queued retry
- **WHEN** a queued Design message is retried after the user changes global Design settings
- **THEN** it uses the originally queued profile snapshot and document target

#### Scenario: Canvas replay
- **WHEN** missed Design operations replay after a thread or panel switch
- **THEN** only operations whose thread, turn, document, and board target match the active Design task are applied

### Requirement: Fork preserves intent without sharing mutable canvas state
Forking a Design task SHALL preserve its locked profile while assigning the fork an independently writable clone of the bound Design document.

#### Scenario: Design fork
- **WHEN** the user forks a Design task
- **THEN** the fork opens as a locked Design task with equivalent artifacts and a different document binding

#### Scenario: Historical-turn fork without a canvas snapshot
- **WHEN** the user requests a fork from an earlier turn but no document snapshot exists at that turn
- **THEN** the operation fails before cloning with an explicit unsupported-history error instead of pairing truncated chat with a future canvas

### Requirement: Invalid or legacy data is handled safely
Profile parsing SHALL be strict for new writes and tolerant for missing legacy fields, and SHALL never infer a new Design task from an unrelated legacy conversation.

#### Scenario: Legacy record without profile
- **WHEN** an existing thread lacks Design profile metadata
- **THEN** it remains readable and no profile is fabricated until the new Design workflow explicitly creates one

#### Scenario: Invalid submitted profile
- **WHEN** a submitted profile contains an unsupported medium, preset, target, oversized context, or mismatched document id
- **THEN** admission fails before starting a model turn or committing the provisional document
