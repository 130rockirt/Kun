## ADDED Requirements

### Requirement: QueueDock uses reference disclosure behavior
Kun SHALL render pending composer messages in a QueueDock attached to the composer: zero messages render no dock, one message renders its row directly, and two or more messages render a collapsed total-count header that expands the complete FIFO list in place.

#### Scenario: One queued message
- **WHEN** exactly one pending, paused, or failed queued message is visible
- **THEN** its complete row is shown directly without a count header or Portal

#### Scenario: Multiple queued messages
- **WHEN** two or more queued messages are visible and no queue interaction is active
- **THEN** the dock initially shows only the total count and expands or collapses all rows from the header button

#### Scenario: Interaction keeps rows visible
- **WHEN** inline editing or a queue mutation is active and the queue contains multiple messages
- **THEN** the list remains expanded and the collapse header is disabled until the interaction settles

#### Scenario: Queue resets disclosure
- **WHEN** the visible queue becomes empty and later receives multiple messages
- **THEN** the new queue starts collapsed again

### Requirement: Inline editing preserves queued identity
Kun SHALL edit eligible plain-text queued messages in place without dequeuing them or changing their delivery order, queue identity, or frozen routing/model settings; an edited payload SHALL receive a fresh client request identity.

#### Scenario: Save plain text
- **WHEN** the user edits an eligible pending text row and saves non-blank text
- **THEN** the same queued id remains in the same position with updated mirrored text, a fresh client request id, preserved routing fields, cleared stale derived background payloads, and persisted queue state

#### Scenario: Keyboard editing
- **WHEN** an inline editor is active
- **THEN** Enter saves outside IME composition, Escape cancels, and an IME-composing Enter does not save

#### Scenario: Invalid edit
- **WHEN** the edit is blank, the row is no longer pending, or the payload contains structured or non-mirrored content
- **THEN** Save is unavailable or rejected and the original queued record remains unchanged

### Requirement: Queue actions are lossless and serialized
Kun SHALL expose Edit, Remove, and current-turn Guide in reference order for ordinary pending rows, and SHALL keep paused or failed rows visible with Remove plus Retry only when replay is safe.

#### Scenario: Guide in flight
- **WHEN** one queued row is being guided or retried
- **THEN** duplicate and competing queue mutations are disabled until the request settles

#### Scenario: Guide fails
- **WHEN** current-turn guidance or retry is rejected
- **THEN** the row remains queued and the existing localized error path reports the failure

#### Scenario: Failed delivery remains actionable
- **WHEN** a queued submission reaches the failed state
- **THEN** the QueueDock keeps it visible with failure status and Remove, and enables Retry when the active turn is idle and the row is not tied to a settled provisional admission waiter

#### Scenario: Delivery owns the row
- **WHEN** a row transitions to starting or in-flight delivery
- **THEN** the QueueDock stops rendering it so the admitted user item is not duplicated

### Requirement: QueueDock matches reference geometry and accessibility
Kun SHALL use the frozen Harness QueueDock dimensions and interaction semantics while mapping colors to Kun semantic theme tokens.

#### Scenario: Desktop geometry
- **WHEN** the QueueDock is rendered above the main composer
- **THEN** headers and rows are 36px, editors and actions are 28px, action gaps are 10px, top corners are 12px, the bottom is square and attached to the composer, and the list scrolls internally above 180px

#### Scenario: Narrow composer
- **WHEN** the composer is narrow
- **THEN** the dock remains within composer side insets, preview text ellipsizes, actions remain reachable, and no fixed queue Portal overflows the viewport

#### Scenario: Keyboard and screen reader
- **WHEN** a user navigates the QueueDock without a pointer
- **THEN** the disclosure exposes `aria-controls` and `aria-expanded`, every action has an accessible name and disabled explanation, focus remains in the inline workflow, and Escape cancels editing

#### Scenario: Theme behavior
- **WHEN** light, dark, custom-theme, or reduced-motion preferences are active
- **THEN** the dock uses semantic surfaces/borders/text, preserves readable state contrast, and does not require motion to communicate queue state

### Requirement: Existing queue delivery contract remains compatible
The QueueDock SHALL reuse Kun's current renderer queue, persistence, FIFO drain, and mid-turn guidance contracts without changing runtime or disk schemas.

#### Scenario: Existing persisted queue
- **WHEN** a thread restores pending, paused, failed, starting, or in-flight queued records created before this UI change
- **THEN** the renderer safely projects each state using the new visibility rules without rewriting stored records

#### Scenario: Ordinary busy-turn send
- **WHEN** the user submits a new message during a running turn and does not activate Guide
- **THEN** it remains queued for ordinary next-turn FIFO delivery exactly as before
