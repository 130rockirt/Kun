## Context

The native PPT path is a governed Kun child workflow. It persists a design-plan fingerprint, produces structured slide review bundles for the Design canvas, exports editable PPTD through a local WASM exporter, and validates the resulting OOXML package before publication. The workspace renderer separately previews bounded PPTX bytes with `pptx-preview@1.0.7`.

This change crosses the child workflow, delegation result retention, persisted review manifests, renderer composer context, Design-canvas projection, Office preview UI, and export validation. It must preserve exact current-turn input, single-runtime routing, workspace confinement, legacy manifest readability, and the existing validated-export fingerprint boundary.

## Goals / Non-Goals

**Goals:**

- Delay design-plan authority for underspecified new decks until the user compares exactly three visual directions.
- Keep candidate plans untrusted and non-authoritative until one persisted candidate is selected and resubmitted through the existing governed-plan gate.
- Make long PPTX files navigable without unbounded renderer DOM growth and provide reliable audience-only fullscreen playback.
- Detect deterministic geometry defects before publication, persist actionable reports, and surface slide-local issues on the existing review board.
- Keep all new persisted and renderer contracts backward-compatible.

**Non-Goals:**

- Speaker notes, timers, dual-window presenter mode, display selection, or remote presentation control.
- A second design-plan authority, runtime, provider, HTTP/SSE route, or PPT file format.
- Replacing `pptx-preview`, the local PPTD exporter, Presentation Studio, or historical `$ppt-master` flows.
- Perfect text shaping or semantic inference from arbitrary Office content; uncertain checks remain warnings or unchecked findings.

## Decisions

### 1. Candidate directions are a pre-review state, not design authority

Review manifest version 3 adds `awaiting_direction` and `revising_directions` phases plus a persisted direction set. Each direction contains a stable ID, revision, complete `PptDesignPlanInput`, concise visual summary, exactly three preview images, and one recommendation flag. A version-3 manifest in a direction phase may omit the governed snapshot; after selection it must contain a governed snapshot whose plan fingerprint matches the selected candidate.

The child may return a `directionBundle` or a normal `reviewBundle` on `start`. A direction bundle is retained independently on the child record with a parent-turn freshness fence. This keeps direction cards out of slide-review contracts and prevents stale bundles from satisfying a later turn.

Alternative considered: submit all candidates as design-plan revisions. Rejected because it would create multiple apparent authorities and make review/export fingerprints ambiguous.

### 2. Selection is structured, revision-bound, and promoted through the existing gate

Canvas direction cards carry `pptDirectionRef`; selected cards become `kind: "ppt-direction"` composer context. `select_direction` resumes the same PPT child. A managed read tool validates workflow, child, direction ID, and revision against the persisted manifest; when no card is selected it may return only the persisted recommended candidate. The subsequent `ppt_submit_design_plan` call must byte-semantically match that candidate before it becomes authoritative.

`revise_directions` regenerates a selected direction when exactly one valid card is referenced, otherwise all three. The manifest preserves stable direction IDs and increments revisions. Multiple selections, stale revisions, forged IDs, or cross-workflow context are rejected.

Alternative considered: infer selection from user prose. Rejected because prose does not provide stable identity or revision fencing.

### 3. Direction gating is conservative and recorded

The child records whether direction selection is required after reading the category index and one category guide. Existing/edit/replication work, explicit keep-style/skip requests, supplied templates or design references, or a source that specifies font, palette, layout, and imagery all bypass the direction phase. Other new-deck requests require three directions. The managed direction/design-plan tools enforce that a required direction cannot be bypassed.

The exact source request and attachment/file-reference metadata remain host-owned. Candidate content cannot alter audience, purpose, narrative, page count, or factual slide content; candidate distinctness is validated across font, palette, layout, background, imagery, and effect fields.

### 4. PPTX thumbnails use a second renderer with bounded static clones

The main `pptx-preview` instance continues to render the selected slide. A hidden second instance loads the same bytes and serially renders requested thumbnail pages. Each visible thumbnail receives a sanitized, non-interactive static DOM clone. An `IntersectionObserver` admits at most 16 mounted thumbnails and replaces off-screen slides with 16:9 placeholders.

Both instances, clones, observers, queues, timers, and fullscreen listeners are source-hash scoped and destroyed on source replacement or unmount. Keyboard handling ignores editable controls. The Fullscreen API targets the preview shell; fullscreen hides the filmstrip and toolbar and shows a transient navigation overlay that disappears after two seconds of pointer inactivity.

Alternative considered: render all slides in list mode. Rejected because it creates unbounded DOM and media memory for long decks.

### 5. Geometry QA is a deterministic OOXML audit after export and before rename

The temporary PPTX is parsed once for package validation, editable-content checks, transitions, geometry, relationships, and embedded media metadata. A dedicated audit module emits `PptGeometryQaReportV1` with stable rule IDs, severity, zero-based slide index, optional shape identity, normalized rectangle, message, and repair guidance.

Checks use explicit thresholds from the capability spec. Background/decoration, connectors, grouped content, hidden/transparent content, text-on-carrier composition, cropped images, cover footers, and unknown inherited styles have explicit exemptions. Text overflow is an estimate: confident violations can block, marginal or unresolvable cases cannot become false-positive errors.

The report is atomically written to `.kun-ppt-review/qa.json`. Errors prevent the temporary file from being published; warnings permit publication but remain in the manifest, validated artifact, tool output, and board. The child receives at most two QA repair continuations per approval cycle; exhaustion returns `failed_recoverable` with a fresh review bundle carrying issues.

Alternative considered: visual-only image comparison. Rejected because it is nondeterministic, cannot reliably identify editable shapes, and would add an OCR/model dependency.

### 6. Board annotations are projections of persisted reports

`PptReviewBundleV1.slides[].qaIssues` is optional. Existing review frames remain authoritative for slide identity. Board projection adds deterministic issue markers and a per-slide error/warning summary keyed by workflow, slide, revision, rule, and issue ordinal. Reapplying a bundle replaces obsolete markers instead of accumulating duplicates.

## Risks / Trade-offs

- [Direction generation triples early image-generation work] → Generate only three representative pages per direction, require the gate only for underspecified new decks, and reuse stable IDs during revision.
- [Model-produced candidates may be insufficiently distinct] → Validate structural differences across design-plan fields and reject duplicate candidate fingerprints.
- [Third-party preview DOM can change] → Isolate DOM extraction behind a helper, retain the current main-render fallback, and cover lifecycle behavior with mocked component tests.
- [Text overflow estimation can be wrong for complex scripts or inherited fonts] → Block only when explicit metrics exceed the confident threshold; downgrade marginal or unresolved cases.
- [Overlap checks can flag intentional composition] → Exempt background, groups, connectors, carriers, and small intersections; report stable coordinates for review.
- [Persisted version-3 state can outlive a rollback] → Readers retain versions 1 and 2, version-3 fields are additive, and rollback leaves workspace artifacts intact even if older code ignores them.

## Migration Plan

1. Introduce version-3 parsers and additive runtime/renderer contracts before producing new bundles.
2. Enable direction generation and selection through the existing Lab-gated native PPT provider.
3. Ship preview UI changes independently of persisted PPT workflow state.
4. Enable export QA after report persistence and recovery paths are covered by tests.
5. Rollback is a normal code revert; existing PPTX/PPTD files and manifests remain on disk, and versions 1/2 continue to parse throughout.

## Open Questions

None. Direction gating, three candidates, 16-thumbnail cap, two-second fullscreen controls, QA thresholds, two repair attempts, and local-only Git delivery are fixed for this change.
