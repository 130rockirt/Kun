## Why

Kun's governed native-PPT workflow can produce editable decks, but underspecified requests commit to one visual system before users can compare alternatives, final PPTX previews are difficult to navigate, and export validation does not catch common layout defects. These gaps make visual iteration expensive and allow avoidable presentation defects to reach the final file.

## What Changes

- Add a governed visual-direction gate for underspecified new presentations. It produces exactly three comparable proposals, persists one recommendation, and requires a validated selection before the selected proposal becomes the existing authoritative design plan.
- Add structured direction-review context and a three-column Design-canvas board without treating candidate directions as final slide reviews or as a second design authority.
- Upgrade workspace PPTX preview with a bounded thumbnail filmstrip, keyboard navigation, and audience-only fullscreen playback while retaining the existing browser renderer and binary-isolation contract.
- Add deterministic OOXML geometry QA for bounds, estimated text overflow, suspicious overlap, footer safety, image aspect ratio, and minimum font size before a PPTX is published.
- Persist QA reports, block export on errors, allow warnings with truthful summaries, and project issue markers onto the corresponding slide review board.
- Keep legacy PPT review manifests readable and preserve the current Presentation Studio and `$ppt-master` compatibility paths.

## Capabilities

### New Capabilities

- `ppt-visual-direction-selection`: Conditional direction gating, candidate persistence, structured selection/revision, and promotion of exactly one candidate into the governed design plan.
- `workspace-pptx-presentation`: Bounded thumbnail navigation, keyboard controls, fullscreen lifecycle, and renderer cleanup for final PPTX previews.
- `ppt-geometry-quality-gate`: OOXML layout auditing, report persistence, export blocking/retry behavior, and slide-level board annotations.

### Modified Capabilities

None. This repository does not currently expose a canonical `openspec/specs` baseline; the new capability specs define additive behavior while preserving existing contracts.

## Impact

- Kun PPT workflow contracts, child-run result retention, design governance, review manifests, managed PPT tools, export validation, and focused runtime tests.
- Renderer composer context, Design-canvas review boards, workspace PPTX preview components, localization, and component tests.
- No new external service, HTTP/SSE route, model provider, runtime, or presentation file format dependency.
