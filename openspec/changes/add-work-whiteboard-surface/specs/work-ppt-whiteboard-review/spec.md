## ADDED Requirements

### Requirement: PPT workflows use one canonical Work review whiteboard
The system SHALL create or reuse exactly one Work whiteboard for each PPT workflow and SHALL bind it to the workflow, child, parent Write thread, and source document.

#### Scenario: Start a presentation from Markdown
- **WHEN** a user starts PPT generation from a Work Markdown document
- **THEN** the system creates or reuses the workflow's review whiteboard before projecting governed visual results

#### Scenario: Retry the same PPT workflow
- **WHEN** the PPT child retries or reconnects for the same workflow
- **THEN** the system reuses the existing canonical whiteboard rather than creating another board

### Requirement: Direction bundles are projected and actionable in Work
The system SHALL project each current direction bundle into the bound Work whiteboard and SHALL allow exactly one current direction to be adopted or revised using structured PPT references.

#### Scenario: Direction bundle arrives while the user is waiting
- **WHEN** a current direction bundle arrives and the user has not moved to another active task
- **THEN** Work activates the bound whiteboard and displays exactly three direction choices

#### Scenario: Direction bundle arrives after the user moves away
- **WHEN** a direction bundle arrives after the user has started working in another tab
- **THEN** Work preserves focus, marks the bound whiteboard as requiring attention, and offers an explicit View action

### Requirement: Slide review and QA remain revision-safe
The system SHALL project the latest review bundle, annotations, and QA findings using workflow, child, parent thread, and revision identity and SHALL prevent stale or duplicated bundles from changing the current review.

#### Scenario: Replay the same review bundle
- **WHEN** SSE replay delivers an already-applied review bundle
- **THEN** the whiteboard shape count and current revision remain unchanged

#### Scenario: Receive a newer review revision
- **WHEN** a valid newer review revision arrives
- **THEN** the previous slide previews and QA markers are replaced by the new revision without duplicate shapes

### Requirement: QA gates presentation approval
The Work review whiteboard SHALL prevent final approval while blocking QA errors remain and SHALL expose warnings without silently treating them as errors.

#### Scenario: Blocking error remains
- **WHEN** the current review revision contains at least one blocking error
- **THEN** the approve-and-export action is disabled and repair context can be sent for the affected slide

#### Scenario: Only warnings remain
- **WHEN** the current review revision contains warnings but no blocking errors
- **THEN** approval remains available and the warning summary remains visible

### Requirement: Exported PPTX remains a linked read-only work product
After approval, the system SHALL keep the review whiteboard as an audit and revision entry point and SHALL open the exported PPTX through the existing read-only Work preview.

#### Scenario: Export completes while reviewing
- **WHEN** the governed PPT workflow exports a PPTX
- **THEN** the whiteboard shows completion and an Open PPTX action without pretending that canvas shapes directly edit the PPTX
