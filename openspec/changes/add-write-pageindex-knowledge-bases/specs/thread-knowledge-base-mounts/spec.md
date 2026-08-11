## ADDED Requirements

### Requirement: Code threads can mount Write workspaces as knowledge bases
The system SHALL let a user attach up to eight configured or newly selected Write workspace directories to an individual Code thread as read-only knowledge bases.

#### Scenario: Mount a configured Write workspace
- **WHEN** the user selects a configured Write workspace from the Code knowledge-base picker
- **THEN** the system persists a named read-only mount on the active Code thread and starts indexing without blocking the UI

#### Scenario: Add a new knowledge directory
- **WHEN** the user selects a directory that is not yet a configured Write workspace
- **THEN** the system adds it to Write workspaces and mounts it on the active Code thread

#### Scenario: Reject invalid or duplicate mounts
- **WHEN** a requested mount is missing, exceeds the eight-mount limit, duplicates the primary workspace, or overlaps an existing mount
- **THEN** the system rejects the update with a validation error and preserves the prior mounts

### Requirement: Knowledge mounts are durable thread metadata
The system SHALL persist mounts in thread metadata, expose them through thread APIs and renderer mappings, and copy them to forks without making them global defaults.

#### Scenario: Reload a mounted thread
- **WHEN** the app or Kun runtime restarts and the user reopens a mounted thread
- **THEN** the same knowledge-base mounts are restored with their current index statuses

#### Scenario: Fork a mounted thread
- **WHEN** the user forks a thread that has knowledge-base mounts
- **THEN** the fork receives the same mounts while an unrelated new thread starts with none

### Requirement: Knowledge mounts never expand normal tool authority
The system MUST keep knowledge-base roots outside normal workspace and additional-workspace read/write scopes and MUST expose their content only through knowledge retrieval tools.

#### Scenario: Generic file tool targets knowledge content
- **WHEN** a generic read, edit, write, grep, glob, shell, or LSP tool targets a mounted knowledge-base path outside the Code workspace
- **THEN** existing sandbox rules deny the access even though the knowledge base is mounted

### Requirement: Users can inspect and manage index state
The system SHALL show each mount as pending, indexing, ready, stale, unavailable, or failed and SHALL allow removal and explicit rebuild while the thread is idle.

#### Scenario: Rebuild a failed index
- **WHEN** the user requests rebuild for a failed or stale mount
- **THEN** the system discards only the derived cache, starts a new build, and reports updated status

#### Scenario: Modify mounts during an active turn
- **WHEN** the user attempts to add or remove a mount while the thread has a running turn
- **THEN** the UI disables the action and the runtime rejects any racing update

### Requirement: Mount paths migrate without cached indexes
Data migration SHALL rewrite mounted knowledge roots using workspace mappings and SHALL rebuild rather than export or import derived knowledge indexes.

#### Scenario: Import a thread with a remapped Write workspace
- **WHEN** a migration package maps a mounted Write workspace to a new destination
- **THEN** imported thread metadata references the new root and its index starts in a rebuildable pending state
