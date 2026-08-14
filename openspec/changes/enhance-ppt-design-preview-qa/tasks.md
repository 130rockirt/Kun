## 1. Change Setup

- [x] 1.1 Validate the clean worktree dependency, PPT, Office-preview, Kun-build, and typecheck baseline
- [x] 1.2 Create and validate proposal, design, capability specs, and this task checklist

## 2. Visual Direction Contracts and Governance

- [x] 2.1 Add manifest-v3 direction phases, candidate/bundle schemas, selection state, and legacy manifest compatibility
- [x] 2.2 Add conservative direction-gate classification and persist required/bypass evidence from the exact source request
- [x] 2.3 Add managed tools for creating/revising direction bundles and reading validated direction selection
- [x] 2.4 Require selected candidate equivalence in `ppt_submit_design_plan` and block review/export before required selection
- [x] 2.5 Retain fresh direction bundles separately on child runs and add `select_direction` / `revise_directions` provider actions

## 3. Visual Direction Renderer

- [x] 3.1 Add structured direction composer context and canvas shape references with strict workflow/child/revision identity
- [x] 3.2 Render and update a three-column direction board with summaries, preview triptychs, and one recommendation
- [x] 3.3 Collect selected direction context for follow-up turns and cover selection, fallback, stale, forged, and revision behavior with tests

## 4. Workspace PPTX Presentation

- [x] 4.1 Split PPTX preview coordination into bounded renderer lifecycle, filmstrip, keyboard, and fullscreen helpers
- [x] 4.2 Add the 16-item IntersectionObserver thumbnail cap, static safe clones, current-slide synchronization, and placeholders
- [x] 4.3 Add keyboard navigation, editable-focus exemptions, audience fullscreen, two-second controls, and complete cleanup
- [x] 4.4 Cover long-deck bounds, source replacement, navigation, fullscreen, link hardening, and failure cleanup with renderer tests
- [x] 4.5 Add source-preserving compatibility for singleton theme styles, stale part declarations, and incomplete background inheritance
- [x] 4.6 Adapt single- and multi-slide preview chrome, thumbnail sizing, canvas centering, and fit-to-viewport zoom

## 5. Geometry QA Core

- [x] 5.1 Add the versioned geometry-report schema, normalized issue identity, atomic report persistence, and manifest projection
- [x] 5.2 Extend OOXML parsing for shape classification, bounds, explicit text metrics, grouping, relationships, crop data, and image dimensions
- [x] 5.3 Implement bounds, overflow, overlap, footer, aspect-ratio, and minimum-font rules with exemptions and focused fixtures

## 6. Geometry QA Workflow and Board

- [x] 6.1 Compose geometry QA with existing export checks, block errors, publish warnings, and expose validated QA summaries
- [x] 6.2 Persist bounded QA attempts and return `failed_recoverable` review data after two unsuccessful repairs
- [x] 6.3 Project slide-local QA markers and severity counts onto the review board while replacing stale markers
- [x] 6.4 Cover report replacement, export gating, retry exhaustion, warning publication, and board-marker updates with tests

## 7. Final Verification and Delivery

- [x] 7.1 Run focused PPT/Office/renderer tests and `git diff --check`
- [ ] 7.2 Run `build:kun`, typecheck, full tests, build, lint, and file-line validation
- [ ] 7.3 Merge the latest local `develop`, resolve conflicts manually, and repeat affected validation
- [ ] 7.4 Fast-forward the feature branch into local `develop`, verify the final tree, and remove the worktree safely
