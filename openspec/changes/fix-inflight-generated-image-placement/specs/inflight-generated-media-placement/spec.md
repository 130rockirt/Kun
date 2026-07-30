## ADDED Requirements

### Requirement: Active generated media stays at its producing timeline position
The conversation UI SHALL render generated media from a completed tool result at that tool result's chronological position while the surrounding turn is still processing.

#### Scenario: Image generation completes before the turn
- **WHEN** an image-generation tool result contains generated image media and the turn remains in progress
- **THEN** the image preview is rendered inline with that tool result in the process timeline
- **AND** the image preview is not also rendered in the turn-level generated-files summary

#### Scenario: Generated media occurs between other process events
- **WHEN** a generated-media tool result occurs between earlier and later process events in an active turn
- **THEN** the generated-media result retains a distinct timeline position between those events
- **AND** it is not hidden inside an unrelated collapsed tool batch

### Requirement: Completed generated media moves to the turn summary
The conversation UI SHALL render generated media in the turn-level generated-files summary after the turn is no longer processing.

#### Scenario: Turn completes after generating an image
- **WHEN** a turn containing a successful generated image result transitions from processing to completed
- **THEN** the inline process-timeline preview is no longer rendered
- **AND** the generated image is rendered once in the turn-level generated-files summary after the final assistant content
