## ADDED Requirements

### Requirement: Code workbench owns Code and Design conversations
The application SHALL expose Code and Work as the only top-level workspace modes. Code and Design conversations SHALL remain in one task list while an empty conversation can select its task mode.

#### Scenario: Shared task list
- **WHEN** a Code conversation contains Code turns, Design turns, or both
- **THEN** it appears once in the Code workbench list without navigating to a standalone Design route

#### Scenario: Shared task list identifies Design conversations
- **WHEN** a Code-owned conversation has a locked Design profile
- **THEN** the task list renders the Code icon with a Design artifact badge instead of a single Design icon

#### Scenario: Legacy Design conversation remains visible
- **WHEN** a project-owned conversation is identified by `agentSurface: 'design'` or the persisted Design thread registry
- **THEN** it appears once in the Code workbench task list with the Design icon and accessible Design label
- **AND** its runtime ownership and persisted Design document binding are not rewritten

#### Scenario: Returning to a Design conversation
- **WHEN** the user selects a Design conversation, reloads the workbench, or returns from another workspace mode
- **THEN** the conversation remains an eligible Code-workbench return target and restores its Design task identity

#### Scenario: Code whiteboard receives completed renderer tool results
- **WHEN** a canvas tool result completes before the Code whiteboard document finishes loading
- **THEN** the renderer replays the result into the matching conversation whiteboard after that document becomes active
- **AND** durable replay receipts prevent an already delivered result from being applied twice

#### Scenario: Top-level navigation
- **WHEN** the user views the workspace-mode selector
- **THEN** it contains Code and Work and does not contain a standalone Design tab

### Requirement: Code and Design are per-turn task surfaces
The composer SHALL allow Code or Design selection for every turn of a Code conversation. The first accepted Design turn SHALL lock the Design document, output medium, target, and style snapshot, but the Code/Design surface selection SHALL remain available for later turns.

#### Scenario: Select before the first message
- **WHEN** an empty conversation has no accepted turn
- **THEN** the user can switch between Code and Design without creating, replacing, deleting, or retagging the thread

#### Scenario: Select every turn
- **WHEN** a Code conversation has accepted turns
- **THEN** the composer still offers Code and Design selection for each new turn

#### Scenario: Code turn after a Design turn
- **WHEN** a conversation with a locked Design profile submits a Code turn
- **THEN** the Code turn is accepted without carrying a Design profile or document target and without failing with `task_surface_locked`

#### Scenario: Re-enter Design reuses the profile
- **WHEN** a conversation that already locked a Design profile selects Design again
- **THEN** the composer reuses the locked document, output medium, target, and style without re-locking or changing them

#### Scenario: Mixed conversation identity
- **WHEN** a Code conversation contains both Code and Design turns
- **THEN** the task list renders the Code icon with a Design artifact badge instead of deciding identity from the first turn

#### Scenario: Whiteboard binding follows the document
- **WHEN** a Code turn is selected after a Design turn
- **THEN** the bound Design document stays mounted and referenceable, driven only by `designProfile.documentTarget`, not the next-turn selection

#### Scenario: Admission failure preserves selection
- **WHEN** local validation or runtime admission rejects a turn
- **THEN** the draft and selector remain editable and no committed empty Design document is left behind

#### Scenario: First Design send activates a new conversation
- **WHEN** the empty workbench sends its first Design turn and the new Code-owned conversation becomes active before thread creation returns
- **THEN** the pending Design selection and provisional document remain active until the draft is bound to the new conversation

#### Scenario: Thread ownership remains Code
- **WHEN** a Design turn is accepted in a Code-owned thread
- **THEN** the turn uses the Design capability surface while `thread.agentSurface` remains `code`

### Requirement: Fixed Design execution behavior
Design turns SHALL use the Design agent/tool surface with direct Agent execution while retaining the shared task timeline, model selection, permissions, and workspace controls. The Design composer SHALL NOT expose Plan mode, Graph orchestration, or pursue-goal controls and commands.

#### Scenario: Design task submission
- **WHEN** the user sends a Design turn in a Code conversation
- **THEN** it targets the same thread and Design document with Design tools and does not create a separate assistant thread

#### Scenario: Shared model selection
- **WHEN** a user changes the conversation model in Design mode
- **THEN** the same composer model control used by Code updates the conversation without consulting a separate Design-model setting

#### Scenario: Design execution controls
- **WHEN** Design is selected for a turn
- **THEN** Plan mode, Graph orchestration, and pursue-goal entries are absent and the submission remains Agent with direct orchestration

### Requirement: Empty task experience is intent-aware
The Code empty state SHALL use one composer with Code/Design selection and type-specific starter actions, and SHALL move that same stateful composer to the conversation dock after execution begins.

#### Scenario: Design starters
- **WHEN** Design is selected on an empty task
- **THEN** the empty state offers Design-oriented starters and Design profile controls without rendering a second independent composer

#### Scenario: Narrow layout
- **WHEN** the workbench is too narrow for full labels
- **THEN** the task/profile controls remain accessible through compact controls or a single responsive drawer
