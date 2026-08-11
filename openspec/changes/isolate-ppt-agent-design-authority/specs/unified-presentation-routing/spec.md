## ADDED Requirements

### Requirement: One native PPTX workflow for new requests
New native or format-unspecified presentation requests from Chat and Write SHALL route through the dedicated `ppt_agent` PPTD-to-PPTX workflow.

#### Scenario: User requests a presentation in Chat
- **WHEN** a user asks the chat agent to create, revise, or approve a presentation
- **THEN** the routing guidance selects `ppt_agent` and the parent supplies only workflow control

#### Scenario: User starts presentation work from Write
- **WHEN** the user invokes the Write presentation action
- **THEN** Write flushes its source and submits a request for `ppt_agent` without loading or invoking `$ppt-master`

#### Scenario: User explicitly requests Presentation Studio HTML
- **WHEN** the user explicitly requests Presentation Studio or a `.kun-ppt.html` artifact and its direct extension tools are advertised
- **THEN** routing keeps that HTML workflow separate and does not reinterpret it as a native PPTX request

### Requirement: Lab feature gate remains authoritative
The dedicated PPT workflow SHALL remain controlled by the PPT Agent Lab setting.

#### Scenario: PPT Agent Lab is disabled
- **WHEN** a new Chat or Write presentation request attempts to use `ppt_agent`
- **THEN** the runtime returns a stable unavailable response without mutating the user's source content

### Requirement: Legacy workflow compatibility boundary
Existing `$ppt-master` workflows and artifacts SHALL remain usable for compatibility, but new product routing SHALL NOT start them.

#### Scenario: Existing legacy task resumes
- **WHEN** a persisted legacy `$ppt-master` task is resumed directly
- **THEN** its existing continuation service remains available

#### Scenario: New Write task starts
- **WHEN** there is no persisted legacy presentation workflow to settle
- **THEN** the UI does not download, activate, or prompt for `$ppt-master`

### Requirement: Native deliverable location
Approved workflows SHALL produce a validated `.pptx` deliverable in the workspace presentations directory while retaining working PPTD/review artifacts in the managed PPT workspace.

#### Scenario: Approved deck exports successfully
- **WHEN** the current workflow passes export validation
- **THEN** the result identifies the native `.pptx` deliverable and the associated managed review workspace
