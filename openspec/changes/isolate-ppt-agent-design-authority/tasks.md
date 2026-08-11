## 1. Authoritative Source Handoff

- [x] 1.1 Replace free-form `ppt_agent` content arguments with host-owned workflow control and resolve the exact active turn through `TurnService`.
- [x] 1.2 Define and propagate a typed PPT source envelope containing prompt, attachments, file references, composer contexts, and structured review context.
- [x] 1.3 Extend child execution to propagate attachment/context fields and the active product surface while preserving fresh-start and same-child resume history semantics.
- [x] 1.4 Disable instruction-runtime and shared-memory injection specifically for PPT child runs and add isolation tests.

## 2. Design Governance

- [x] 2.1 Add a versioned canonical PPT core design-policy resource and inject it through the host-owned child control prompt.
- [x] 2.2 Add workflow-scoped guide-read tracking and require the category index plus one supported detailed category guide.
- [x] 2.3 Add a validated complete design-plan tool, including source-backed policy-exception checks.
- [x] 2.4 Persist design policy/category/plan data in the review manifest and gate review/export on current governed state.
- [x] 2.5 Replace the duplicated long PPT profile prompt with a short phase/workflow protocol.

## 3. Unified Product Routing

- [x] 3.1 Update main-agent presentation routing guidance so the parent passes workflow control only.
- [x] 3.2 Route new Write presentation actions through `ppt_agent` without bootstrapping or invoking `$ppt-master`.
- [x] 3.3 Transport PPT visual-review data as structured composer context without mutating the stored user prompt.
- [x] 3.4 Preserve the Lab gate and legacy continuation compatibility while keeping new requests on the native PPTX path.

## 4. Verification

- [x] 4.1 Add adversarial provider tests for exact prompt authority, missing source failure, attachment/context propagation, and scoped action handling.
- [x] 4.2 Add child-executor tests for presentation surface, instruction/memory isolation, first-run history, and continuation history.
- [x] 4.3 Add PPT tool tests for mandatory guide order, complete design plan, policy exceptions, manifest persistence, and phase gates.
- [x] 4.4 Add renderer tests for unified Write routing and non-mutating structured review context.
- [x] 4.5 Run focused tests, Kun build, root typecheck/build, file-size gate, and `git diff --check`.
