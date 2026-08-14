## ADDED Requirements

### Requirement: Conditional direction gate
The governed native PPT workflow SHALL require visual-direction selection for underspecified new presentations and SHALL bypass it for edit/replication work, explicit keep-style or skip requests, supplied templates/design references, or requests that specify font, palette, layout, and imagery.

#### Scenario: Underspecified new deck
- **WHEN** a new-presentation request lacks a template, design reference, explicit bypass, or a complete visual system
- **THEN** the child records a required direction gate and cannot submit an authoritative design plan before selection

#### Scenario: Explicit visual authority
- **WHEN** the request supplies an existing style authority or all four visual-system dimensions
- **THEN** the child records a bypass reason and continues through the existing governed design-plan and slide-review flow

### Requirement: Exactly three comparable candidates
The workflow MUST persist exactly three distinct direction candidates that share audience, purpose, narrative, page count, and slide content while differing materially in visual-system fields.

#### Scenario: Direction bundle creation
- **WHEN** the required direction gate has been recorded after the mandatory guide reads
- **THEN** the child returns three stable direction IDs, one recommendation, complete candidate plans, concise summaries, and exactly three 16:9 previews per candidate

#### Scenario: Duplicate or inconsistent candidates
- **WHEN** candidates differ in content/page strategy, have duplicate visual fingerprints, omit previews, or contain zero/multiple recommendations
- **THEN** the managed tool rejects the bundle without advancing the workflow

### Requirement: Structured and revision-bound selection
The system SHALL accept direction selection only from validated structured composer context for the active workflow and child, or use the persisted recommendation when the user explicitly selects without a card reference.

#### Scenario: Selected canvas card
- **WHEN** one current direction card is selected and `select_direction` resumes the original child
- **THEN** the managed selection reader returns only that persisted candidate plan

#### Scenario: Recommended fallback
- **WHEN** `select_direction` contains no direction-card context
- **THEN** the managed selection reader returns the one persisted recommended candidate

#### Scenario: Invalid selection
- **WHEN** context is stale, forged, cross-workflow, cross-child, or selects more than one candidate
- **THEN** the workflow rejects it and does not modify design governance

### Requirement: Single design authority after selection
The selected candidate SHALL become authoritative only by passing the existing `ppt_submit_design_plan` validation and SHALL retain the selected candidate fingerprint through review and export.

#### Scenario: Exact candidate promotion
- **WHEN** the child submits the plan returned by the validated selection reader
- **THEN** governance records it as the sole current plan and full slide previews may be generated

#### Scenario: Candidate mutation during promotion
- **WHEN** the submitted plan differs semantically from the selected persisted candidate
- **THEN** the design-plan tool rejects it and the workflow remains awaiting selection

### Requirement: Direction revision preserves identity
The workflow SHALL support revising one selected direction or all directions while preserving direction IDs and incrementing revisions.

#### Scenario: One card selected for revision
- **WHEN** `revise_directions` has exactly one valid direction context
- **THEN** only that candidate is regenerated and its revision increments

#### Scenario: No card selected for revision
- **WHEN** `revise_directions` has no direction context
- **THEN** all three candidates are regenerated, remain distinct, and each revision increments

### Requirement: Backward-compatible persistence
The manifest reader MUST continue to accept versions 1 and 2 while version 3 enforces direction-phase and selected-plan invariants.

#### Scenario: Historical review manifest
- **WHEN** a version-1 or version-2 manifest is read
- **THEN** its previous review and export behavior remains valid without synthetic direction state

#### Scenario: Unselected version-3 direction manifest
- **WHEN** a version-3 manifest requires direction selection and has no selected candidate
- **THEN** slide review and export operations are rejected
