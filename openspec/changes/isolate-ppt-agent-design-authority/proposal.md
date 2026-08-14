## Why

Kun's dedicated PPT child agent currently receives a model-authored rewrite instead of the user's exact request, while its design guidance is duplicated across prompts and optional guide tools. This lets the routing model invent requirements, drops attachment context, and allows decks to bypass the canonical presentation design rules.

## What Changes

- **BREAKING** Remove free-form presentation instructions (`query`, `workspace`, `deliverable`, and prompt-serialized review context) from the public `ppt_agent` call contract; the host reconstructs an authoritative source envelope from the active turn.
- Forward the exact user request, attachment IDs, file references, and composer context to the PPT child without inheriting parent conversation history.
- Isolate PPT children from workspace/global `AGENTS.md` instructions and shared user memory while retaining their own persisted child history for review continuations.
- Make the repository PPT toolchain resources the single design authority: inject a versioned core policy, require a scenario guide read before generation, and require a complete design plan/style contract before review or export.
- Carry visual-review state as structured host context rather than appending it to user prose, with explicit start, revise, and approve actions.
- Route new presentation requests from both chat and Write through the same native PPTX child workflow. Keep the legacy `$ppt-master` path only for compatibility with already-started work.
- Preserve the Lab feature gate and provide a clear unavailable result when unified presentation generation is disabled.

## Capabilities

### New Capabilities

- `ppt-agent-authoritative-input`: Host-owned capture and exact propagation of the active user turn, attachments, file references, and review action into an isolated PPT child.
- `ppt-agent-design-governance`: Canonical design-policy injection, mandatory scenario-guide selection, design-plan validation, and phase completion gates for PPT generation.
- `unified-presentation-routing`: One dedicated native PPTX workflow for new chat and Write presentation requests, with explicit Lab gating and legacy compatibility boundaries.
- `presentation-review-context`: Structured visual-review context and action handling that does not mutate or impersonate the user's prompt.

### Modified Capabilities

None.

## Impact

- Kun delegation and turn orchestration, PPT agent provider/profile, child executor, PPT local tools, review manifest, and runtime composition.
- Renderer composer and Write presentation entry points, plus shared turn/composer contracts where structured review context is carried.
- Existing tests for PPT delegation, child isolation, PPT guide/tool ordering, review bundles, and Write routing; new adversarial coverage for rewritten prompts and dropped attachments.
- No new external dependency. Existing legacy presentation artifacts remain readable, but new work no longer starts through `$ppt-master`.
