## ADDED Requirements

### Requirement: Work exposes whiteboard creation where work assets are managed
The Work surface SHALL provide a persistent New whiteboard action below New file, a New whiteboard entry in the focused editor group's add menu, and a whiteboard shortcut on the Work start page.

#### Scenario: Create from the Work sidebar
- **WHEN** a user with a selected workspace activates New whiteboard in the Work sidebar
- **THEN** the system creates a durable untitled whiteboard and opens it in the focused central editor group

#### Scenario: Create in a focused split group
- **WHEN** a user activates New whiteboard from an editor group's add menu
- **THEN** the whiteboard opens in that group without changing the other group's active file

### Requirement: Whiteboards are first-class typed Work tabs
The Work editor SHALL represent whiteboards with durable board identities distinct from workspace file paths and SHALL display them as central tabs beside file tabs.

#### Scenario: Open a whiteboard beside a source document
- **WHEN** a user opens a whiteboard associated with a Markdown document
- **THEN** both items appear as independent tabs and file loading or saving does not process the whiteboard identity as a file path

#### Scenario: Restore an editor layout
- **WHEN** Work reloads a persisted layout containing file and whiteboard tabs
- **THEN** valid tabs, the active item, the focused group, and the split orientation are restored

### Requirement: Work whiteboards persist as hidden workspace assets
The system SHALL persist whiteboard metadata and canvas documents in a Kun-owned workspace directory and SHALL exclude that directory from the ordinary Work file tree.

#### Scenario: Reopen after application restart
- **WHEN** a user restarts the application after editing and naming a whiteboard
- **THEN** its title, shapes, viewport, source relation, and assistant thread binding are restored

#### Scenario: Browse workspace files
- **WHEN** Work renders the workspace file tree
- **THEN** Kun-owned whiteboard metadata and canvas JSON files are not shown as user documents

### Requirement: A Work whiteboard coexists with the Work assistant
The system SHALL render the focused Work whiteboard in the central editor area while retaining the Work assistant in the right panel.

#### Scenario: Open assistant while reviewing a board
- **WHEN** a whiteboard tab is active and the user opens the Work assistant
- **THEN** the whiteboard remains mounted in the center and the assistant opens beside it

### Requirement: Work whiteboards own durable Write threads
Each whiteboard SHALL bind to a Write thread using its board identity and SHALL preserve that thread when the whiteboard is focused without an active file.

#### Scenario: Send a prompt from a whiteboard
- **WHEN** the focused item is a whiteboard and the user sends a Work assistant prompt
- **THEN** the prompt uses the whiteboard's bound Write thread and includes the current canvas context

### Requirement: Writable canvases cannot race across editor groups
Until canvas stores are document-keyed, the application SHALL mount at most one writable Work canvas per window.

#### Scenario: Two groups contain whiteboard tabs
- **WHEN** a split layout references a whiteboard in each editor group
- **THEN** only the focused group owns the writable canvas and the other group presents a safe activation affordance without persisting canvas state
