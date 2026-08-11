## ADDED Requirements

### Requirement: Canonical core design policy
The PPT child SHALL receive the versioned core design policy from the repository PPT toolchain as trusted control context, and copied profile prose SHALL NOT be a second design authority.

#### Scenario: PPT child is constructed
- **WHEN** the provider builds the PPT child profile
- **THEN** it injects the canonical policy version/content and only a short workflow protocol in addition to the base runtime prompt

### Requirement: Mandatory category-guide selection
The PPT workflow SHALL require the child to read the category index and one matching detailed category guide before it can create a review bundle or export a deck.

#### Scenario: Child skips the category guides
- **WHEN** the child requests review or export without reading both required guide levels
- **THEN** the tool rejects the request with the missing guide steps

#### Scenario: Child reads a matching category guide
- **WHEN** the child reads the index and then a supported detailed category guide
- **THEN** the workflow records the selected category for the active child/workflow

### Requirement: Complete validated design plan
The child SHALL submit a design plan covering category, audience and purpose, page strategy, typography roles, color roles, type scale, spacing rhythm, layout system, imagery strategy, and user-backed policy exceptions before review or export.

#### Scenario: Design plan is incomplete
- **WHEN** one or more required design-plan fields are empty or malformed
- **THEN** the plan tool rejects it and reports every missing field

#### Scenario: Plan claims an anti-pattern exception
- **WHEN** the design plan uses a normally forbidden visual pattern
- **THEN** it is accepted only when the exact source request contains evidence for that exception

### Requirement: Phase completion gates
Start and revise actions SHALL complete only with a fresh valid review bundle, and approve SHALL complete only with a validated native PPTX artifact produced after the current design gates.

#### Scenario: Review bundle predates the current plan
- **WHEN** a design plan changes after the most recent review bundle
- **THEN** start or revise cannot complete until a new bundle is created

#### Scenario: Approve has no validated PPTX
- **WHEN** approve ends without a successful current export validation
- **THEN** the provider returns an incomplete workflow result rather than success

### Requirement: Governed design state persists across continuation
The selected category and validated design plan SHALL be stored in the review manifest and restored for the same child/workflow continuation.

#### Scenario: Revision resumes after review
- **WHEN** the same child and workflow resume for revision
- **THEN** the prior category and design plan remain active until explicitly replaced by another valid plan
