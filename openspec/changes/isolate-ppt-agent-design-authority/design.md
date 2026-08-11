## Context

Kun currently has three presentation paths: a dedicated Lab `ppt_agent` child that produces PPTD/PPTX, the legacy Write `$ppt-master` skill, and the main-agent Presentation Studio HTML extension. The dedicated child starts in a fresh side thread and therefore does not copy parent history, but its only user message is a free-form `query` written by the parent model. Attachments are not forwarded, workspace/global instructions and optional shared memory are still injected, and design knowledge is split between a copied profile prompt and guides that the model may choose not to read.

The target is the dedicated native PPTX workflow. It remains Lab-gated. Presentation Studio remains an independent HTML authoring surface, while `$ppt-master` remains available only to settle previously-started legacy work.

## Goals / Non-Goals

**Goals:**

- Make the active user turn and its attachment/context metadata the sole content authority for a PPT child.
- Keep routing/control metadata host-authored and structurally separate from user prose.
- Make versioned repository resources the sole presentation-design authority and enforce tool ordering with executable gates.
- Isolate the child from parent history, `AGENTS.md`, and shared memory while preserving the child's own continuation history.
- Route new Chat and Write presentation work through one PPTD-to-PPTX child workflow.
- Make review/revision/approval context structured, replayable, and independently testable.

**Non-Goals:**

- Migrating Presentation Studio `.kun-ppt.html` projects to PPTX.
- Deleting legacy `$ppt-master` code or historical artifacts in this change.
- Replacing the PPTD renderer/export toolchain.
- Making the PPT agent a core always-on feature.
- Giving the child unrestricted access to the skill catalog or arbitrary user-input prompts.

## Decisions

### 1. The host reconstructs a typed source envelope from the active turn

`ppt_agent` accepts only workflow control (`action`, optional child/workflow identifiers, and an optional display title). The provider reads the active turn through `TurnService` and creates a `PptSourceEnvelope` containing the exact prompt, attachment IDs, file references, composer contexts, and structured visual-review context. The source prompt is not summarized, supplemented, or replaced by the parent model.

The child executor receives the prompt and attachment/context fields as separate start-turn fields and propagates the active product surface (`code`, `write`, or `design`) instead of falling back to `code`. Host workflow instructions live in the child system/control prompt, never in the child user message. On continuation, the same child thread retains only its own past turns and receives a new exact source envelope from the active parent turn.

Alternative considered: retain `query` as a lower-priority planning hint. It was rejected because model-generated hints still consume attention and create an ambiguous authority order.

### 2. PPT child isolation is explicit per run

Delegation input gains explicit instruction and memory policies plus `agentSurface` and attachment/context propagation. The PPT provider always disables instruction-runtime injection and shared memory for this child. The base Kun safety/runtime prompt remains, but the long duplicated PPT design prompt is replaced by a short phase protocol and a trusted design-policy block. The child remains a fresh side thread on start and reuses only that child thread on resume.

Alternative considered: remove instruction runtime and memory globally from all child agents. It was rejected because research and coding specialists may intentionally rely on workspace instructions or memory.

### 3. Repository resources are the design authority

A new versioned core presentation policy in `resources/ppt-toolchain/reference/` defines non-negotiable typography, color, density, layout, evidence, and anti-pattern rules. The provider loads and injects that policy as trusted child control context. Detailed category guides remain retrievable through `ppt_read_guide`.

The local PPT tool provider records per-child workflow state. Before any preview/review/export success, the child must read `slides_categories.md`, read exactly one matching category guide, and submit a complete design plan. The plan includes category, audience/purpose, page strategy, font roles, color roles, type scale, spacing rhythm, layout system, imagery strategy, and explicit user-backed exceptions. Generation/review tools reject missing or stale gates with actionable errors. The review manifest persists the validated plan so resume/revision cannot silently discard it.

Alternative considered: trust prompt instructions to read guides. It was rejected because the existing failure occurred even though the prompt mentioned guides.

### 4. Review context is transport metadata

Renderer visual-review selections are sent through a dedicated structured composer-context entry. They are not appended to the visible prompt. The provider validates and copies them into `PptSourceEnvelope.reviewContext`. `start`, `revise`, and `approve` remain explicit tool actions, and completion contracts remain phase-specific: start/revise require a fresh review bundle, approve requires a validated deck artifact.

### 5. New Write requests use the dedicated child

Write presentation actions flush the active document and send an exact user-facing request that explicitly routes through `ppt_agent`; they no longer bootstrap or invoke `$ppt-master`. Chat continues to rely on system routing guidance. If the Lab feature is disabled, the tool/provider returns a stable unavailable result and the UI keeps user content intact for retry. Existing legacy workflows are not rewritten or deleted.

## Risks / Trade-offs

- **[Turn lookup fails or the active turn is already compacted]** -> Fail closed with a source-unavailable error; never fall back to the model-authored tool arguments.
- **[Attachment propagation changes child tool visibility]** -> Reuse `StartTurnRequest` attachment binding and add end-to-end tests for IDs, file references, and local paths.
- **[Strict guide gates initially reject otherwise valid decks]** -> Return deterministic remediation details and retain gate state per child/workflow so a corrected continuation can proceed.
- **[Core policy and category guides drift]** -> Keep the core policy minimal, version it, and test resource loading plus policy hash/version in review manifests.
- **[Write prompt routing still depends on a parent model tool call]** -> Shrink the callable schema so the parent cannot supply presentation content, and add adversarial tests proving extra tool fields cannot override the source envelope.
- **[Legacy and new workflows coexist temporarily]** -> Label the compatibility boundary in code and tests; do not auto-migrate in-flight legacy tasks.

## Migration Plan

1. Add source-envelope and child isolation plumbing while accepting only the new tool schema.
2. Add design resources, guide/design-plan tools, workflow-state gates, and review manifest compatibility defaults.
3. Switch Write entry points and structured review-context transport.
4. Run focused tests, Kun build, root typecheck/build, and file-size checks.
5. Rollback is a normal code revert; legacy artifacts and `$ppt-master` implementation remain present throughout.

## Open Questions

None. The product choices are fixed for this change: exact current-turn input, automatic design/review for underspecified requests, core policy plus scenario guide, no `AGENTS.md` or shared memory, native PPTX unification, and Lab gating.
