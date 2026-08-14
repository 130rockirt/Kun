## ADDED Requirements

### Requirement: Deterministic geometry audit
The PPT exporter MUST audit temporary OOXML output before publication for out-of-bounds content, estimated text overflow, suspicious overlap, footer safety, image aspect ratio, and minimum visible font size.

#### Scenario: Out-of-bounds informational content
- **WHEN** an informational shape extends more than 1pt outside the slide
- **THEN** the report contains an error unless the shape is an allowed full-slide background or decoration

#### Scenario: Confident text overflow
- **WHEN** explicit text metrics without autofit exceed the usable text box height by more than 15%
- **THEN** the report contains an error; marginal or unresolved inherited metrics are warnings or unchecked findings

#### Scenario: Suspicious overlap
- **WHEN** non-exempt informational objects overlap by more than 10% of the smaller object, or later opaque content occludes text
- **THEN** the report contains an error; 3%-10% overlap is a warning

#### Scenario: Footer safety
- **WHEN** non-footer body content enters the larger of the bottom 6% or governed page margin
- **THEN** entry is a warning and actual body/footer intersection is an error, except on the cover

#### Scenario: Distorted image
- **WHEN** effective embedded-image aspect ratio after `srcRect` cropping differs from its frame by more than 3%
- **THEN** the report contains a warning, upgraded to error above 10%; unreadable media dimensions remain non-blocking

#### Scenario: Undersized visible text
- **WHEN** visible non-transparent text is below 8pt
- **THEN** the report contains an error; text from 8pt up to the governed caption size is a warning

### Requirement: Structured and atomic QA report
The exporter SHALL atomically persist `PptGeometryQaReportV1` at `.kun-ppt-review/qa.json` with rule, severity, slide, optional shape identity, normalized bounds, message, repair hint, counts, and attempt number.

#### Scenario: Completed audit
- **WHEN** a temporary PPTX audit finishes
- **THEN** the report is validated, written atomically, and projected into the review manifest without absolute paths

#### Scenario: Repeated audit
- **WHEN** a later repair attempt produces a new report
- **THEN** it replaces the prior report atomically and increments the bounded attempt counter

### Requirement: Export gate and bounded recovery
The exporter MUST NOT publish a PPTX with QA errors and SHALL permit warning-only output while reporting warnings truthfully.

#### Scenario: QA errors remain
- **WHEN** the audit contains one or more errors
- **THEN** the temporary PPTX is not renamed to the final destination and governance is not marked exported

#### Scenario: Warning-only output
- **WHEN** the audit contains warnings but no errors
- **THEN** the PPTX is published and the validated artifact/tool output includes the QA summary

#### Scenario: Repair budget exhausted
- **WHEN** two automatic QA repair continuations fail to clear errors
- **THEN** the workflow becomes `failed_recoverable` and returns a fresh review bundle containing the persisted issues

### Requirement: Slide-local board projection
Slide review bundles SHALL optionally carry QA issues, and the Design canvas SHALL project deterministic issue markers and per-slide severity counts without accumulating stale markers.

#### Scenario: Error and warning markers
- **WHEN** a review bundle contains normalized QA issue rectangles
- **THEN** the corresponding slide frame displays red error markers, amber warning markers, and an error/warning count

#### Scenario: Updated QA bundle
- **WHEN** a newer slide revision removes or changes issues
- **THEN** obsolete markers are deleted and only markers for the current workflow, slide, and revision remain

### Requirement: Existing export checks remain mandatory
Geometry QA SHALL compose with, not replace, package structure, slide count, editability, raster-only rejection, and requested fade-transition checks.

#### Scenario: Geometry passes but editability fails
- **WHEN** a deck passes geometry QA but contains a raster-only slide or misses required transitions
- **THEN** export remains blocked by the existing validation rules
