## ADDED Requirements

### Requirement: Review context is not user prose
Visual-review selections SHALL be transported as structured turn context and SHALL NOT be appended to, prefixed to, or represented as the user's prompt.

#### Scenario: User submits a revision with selected slides
- **WHEN** the composer has active PPT visual-review selections
- **THEN** the visible and stored user prompt remains exact while the selections are present in a typed review-context field

### Requirement: Review context is validated and workflow-scoped
The host SHALL validate structured review context and bind it to the identified child/workflow before exposing it to the PPT child.

#### Scenario: Review context targets another workflow
- **WHEN** submitted review context identifies a different workflow or child
- **THEN** the provider rejects it instead of merging it into the active revision

### Requirement: Review actions are explicit
Presentation start, revise, and approve SHALL be represented by explicit tool actions independent of natural-language content.

#### Scenario: User approves a reviewed deck
- **WHEN** the host invokes the approve action with valid scoped review context
- **THEN** the child receives the exact approval request as user content and approve as separate workflow control

### Requirement: Underspecified requests proceed automatically
The PPT child SHALL choose a reasonable category and complete design/review automatically for a short but actionable request, and SHALL request structured input only when a required source fact cannot be inferred safely.

#### Scenario: User asks for a short product introduction deck
- **WHEN** the request supplies a topic but no theme, page count, or layout
- **THEN** the child selects and records a suitable design plan without the parent inventing those details
