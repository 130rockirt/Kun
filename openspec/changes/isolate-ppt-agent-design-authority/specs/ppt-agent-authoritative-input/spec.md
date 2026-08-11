## ADDED Requirements

### Requirement: Exact active-turn source authority
The PPT agent host SHALL derive presentation content from the exact active parent turn and SHALL NOT accept model-authored presentation prose as a tool argument.

#### Scenario: Parent attempts to invent presentation requirements
- **WHEN** the parent model invokes `ppt_agent` for a turn whose prompt contains only a short presentation request
- **THEN** the child user message equals that short request and contains no parent-authored theme, outline, page count, or content

#### Scenario: Active turn cannot be resolved
- **WHEN** the provider cannot load the active turn identified by the tool host context
- **THEN** it fails closed with a source-unavailable result and does not synthesize a fallback prompt

### Requirement: Complete source-envelope propagation
The host SHALL forward attachment IDs, file references, composer contexts, and structured review context from the active turn as typed child-turn fields.

#### Scenario: User supplies attachments and file references
- **WHEN** the active turn includes attachment IDs and file references
- **THEN** the child turn receives the same identifiers and references through its attachment/context contract

### Requirement: Presentation-child context isolation
The PPT child SHALL start without parent conversation history, workspace/global agent instructions, or shared memory and SHALL retain only its own history on continuation.

#### Scenario: First PPT child run
- **WHEN** a new PPT child starts from a parent turn with history, AGENTS instructions, and enabled memory
- **THEN** its history contains only the exact active-turn request and its model context contains neither AGENTS instructions nor shared-memory recall

#### Scenario: PPT child continuation
- **WHEN** a review action resumes an existing PPT child
- **THEN** the child receives its own prior turns plus the new exact active-turn request and no parent history

### Requirement: Product surface propagation
The child turn SHALL retain the active host product surface instead of falling back to the default code surface.

#### Scenario: Child turn starts
- **WHEN** `ppt_agent` starts or resumes a child from Write or Design
- **THEN** turn context resolution observes `agentSurface` as `write` or `design` respectively rather than the default code surface
