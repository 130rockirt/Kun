## ADDED Requirements

### Requirement: Code workbench owns Code and Design conversations
The application SHALL expose Code and Work as the only top-level workspace modes. Code and Design conversations SHALL remain in one task list while an empty conversation can select its task mode.

#### Scenario: Shared task list
- **WHEN** a Code conversation contains Code turns, Design turns, or both
- **THEN** it appears once in the Code workbench list without navigating to a standalone Design route

#### Scenario: Top-level navigation
- **WHEN** the user views the workspace-mode selector
- **THEN** it contains Code and Work and does not contain a standalone Design tab

### Requirement: Code and Design are locked conversation modes
The composer SHALL allow Code or Design selection only before the first accepted turn. The first accepted turn SHALL lock the conversation to that mode, the selector SHALL disappear, and Kun admission SHALL reject later mode changes.

#### Scenario: Select before the first message
- **WHEN** an empty conversation has no accepted turn
- **THEN** the user can switch between Code and Design without creating, replacing, deleting, or retagging the thread

#### Scenario: Mode is locked after acceptance
- **WHEN** the first Code or Design turn is accepted
- **THEN** the selector is removed, reload restores the accepted mode without showing a mode button, and a request for the other mode fails with `task_surface_locked`

#### Scenario: Admission failure preserves selection
- **WHEN** local validation or runtime admission rejects the first turn
- **THEN** the draft and selector remain editable and no committed empty Design document is left behind

#### Scenario: Thread ownership remains Code
- **WHEN** a Design turn is accepted in a Code-owned thread
- **THEN** the turn uses the Design capability surface while `thread.agentSurface` remains `code`

### Requirement: Fixed Design execution behavior
Design turns SHALL use the Design agent/tool surface with direct Agent execution while retaining the shared task timeline, model selection, permissions, and workspace controls. The Design composer SHALL NOT expose Plan mode, Graph orchestration, or pursue-goal controls and commands.

#### Scenario: Design task submission
- **WHEN** the user sends any later message in a Design conversation
- **THEN** it targets the same thread and Design document with Design tools and does not create a separate assistant thread

#### Scenario: Shared model selection
- **WHEN** a user changes the conversation model in Design mode
- **THEN** the same composer model control used by Code updates the conversation without consulting a separate Design-model setting

#### Scenario: Design execution controls
- **WHEN** Design is selected for an empty conversation or restored as its locked mode
- **THEN** Plan mode, Graph orchestration, and pursue-goal entries are absent and the submission remains Agent with direct orchestration

### Requirement: Empty task experience is intent-aware
The Code empty state SHALL use one composer with Code/Design selection and type-specific starter actions, and SHALL move that same stateful composer to the conversation dock after execution begins.

#### Scenario: Design starters
- **WHEN** Design is selected on an empty task
- **THEN** the empty state offers Design-oriented starters and Design profile controls without rendering a second independent composer

#### Scenario: Narrow layout
- **WHEN** the workbench is too narrow for full labels
- **THEN** the task/profile controls remain accessible through compact controls or a single responsive drawer
