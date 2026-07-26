# Kun Graph Mode architecture and operations

Graph Mode is a per-turn Kun orchestration strategy, not a second agent
runtime. `direct` keeps the existing chat path. In `graph`, a Lead converts the
request into a host-validated execution graph, Kun schedules constrained
workers in the background, and the Lead supervises material events, reviews
evidence, and produces one final delivery.

The detailed Chinese guide is [graph-mode.md](./graph-mode.md).

## System boundary

Graph Mode has three separable planes:

1. Execution: plans, runs, nodes, attempts, typed edges, budgets, mailbox,
   artifacts, reviews, scheduling, and recovery.
2. Project capability: versioned Agent profiles, Skill and Graph Recipe
   candidates, routing, scores, and evidence.
3. Governance: candidates, probation, promotion, dormancy, archival, merge,
   rollback, deletion, and audit.

The product still has one path:
`Renderer -> preload -> main -> kun serve HTTP/SSE`. The renderer does not run
the scheduler or invent state transitions. Existing direct turns,
`delegate_task`, and the older `task_graph` remain compatible. Workers cannot
delegate recursively, control graphs, govern profiles, or expand parent
authority. Learned assets stay under the Kun data directory unless the user
explicitly exports them.

## Execution lifecycle

```text
Graph turn
  -> Lead calls graph_create_run
  -> host validates and journals GraphPlan
  -> scheduler computes ready nodes
  -> immutable least-authority assignment snapshot
  -> DelegationRuntime child worker
  -> bounded progress/artifact/message/structured result
  -> deterministic, peer, Lead, or human review
  -> dependency release, bounded retry, GraphPatch, or LoopGate
  -> final gates and resource disposition
  -> durable Lead synthesis and completed GraphRun
  -> sanitized Episode and asynchronous learning
```

A GraphRun outlives its source model request. On reconnect the renderer
reconciles an HTTP snapshot, then resumes SSE after its acknowledged cursor.

## Contracts and state

Contracts live in `kun/src/contracts/graph.ts` and `graph-agents.ts`, with
explicit versions. `GraphPlanV1` describes topology and policy;
`GraphRunV1` is the durable projection; `GraphNodeAttemptV1` records an
immutable execution snapshot; `GraphEventEnvelopeV1` supplies monotonic
sequence, revision, command, and idempotency metadata. `GraphPatchV1`,
structured worker results, reviews, messages, artifacts, cleanup, profile
versions, evidence, Episodes, candidates, and audit records are strict schemas.

Edge kinds are:

- `control`: outcome-gated scheduling;
- `data`: authorized artifact/result flow;
- `message`: explicit non-default direct communication.

Run states progress from `draft -> validating -> ready -> running`, with
pause, supervision, and human-review branches, then
`completing -> completed`; `failed` and `cancelled` are terminal. Nodes move
from pending/blocked through ready, queued, running, submitted, reviewing, and
accepted, with repair, failure, cancellation, skip, and supersession branches.
The reducer rejects an event whose declared source state differs from durable
truth. Accepted history is immutable.

## Validation, revisions, and loops

The host validates identity, references, reachability, completion paths, edge
kinds, assignments, scopes, reviews, risk, and every configured budget.
Ordinary dependencies must be acyclic. A logical cycle is valid only inside a
strongly connected component with an explicit bounded LoopGate.

GraphPatch uses compare-and-swap with `baseRevision`, `expectedRevision`, and
`expectedSeq`. A stale request has no partial effect. A valid patch is fully
revalidated and committed as one revision while accepted facts remain as
superseded history.

A LoopGate declares a condition source, continuation, exit and exhaustion
targets, maximum iterations, and optional token budget. Every continuation
writes `loop_iteration_advanced`, resets only the host-computed cycle nodes,
preserves prior attempts, creates attempts at a new iteration, and increments
the run ledger. Exhaustion can never create another attempt. Repeated identical
normalized failures pause or escalate.

## Scheduling, limits, and cancellation

The host scheduler resolves dependencies and failure propagation, applies
priority and retry delay, and enforces:

- maximum concurrent runs;
- global and per-run concurrent nodes;
- attempts and capped exponential retry;
- run and node wall time;
- revisions, loops, tokens, messages, and artifact bytes.

Runs rotate fairly. Node timeout is enforced with a host AbortSignal. Cancel
first fences the run as terminal, aborts and waits for active workers, discards
late results, settles attempts and nodes, releases leases, safely disposes
worktrees, and records cleanup. Repeated cancellation and cleanup are
idempotent.

## Authority and worker context

Every attempt freezes profile/version/origin, model/provider/reasoning,
system instructions, tools, Skills, MCP servers, approval, sandbox, workspace,
read/write scopes, network, and time/token limits. Effective authority is the
intersection of parent, graph, profile, node, and host policy.

Workers never receive delegation, Graph creation/control/patch/review, or
governance tools. They receive only bounded progress, artifact, mailbox,
help/result functions. Their context contains the objective, completion
contract, authorized dependency summaries and artifacts, addressed messages,
and bounded project context. It excludes the full Lead history, unrelated
nodes, and Lead/user-private artifacts.

Mailbox delivery validates membership, recipients, edge authorization,
artifact visibility, size, rate, count, TTL, and idempotency. Workers may
contact the Lead and dependency neighbors; all other direct communication
needs a message edge. Unresolved blocking messages prevent completion.

## Review, writes, and completion

Review policies can require deterministic, peer, Lead, human, or combined
approval. A peer is a different child instance. Risky writes add Lead review;
critical risk can require a human.

Supervision is event driven for submission, failure, stall, conflict, budget,
help, recovery, completion, and user steering. Normal progress does not poll a
model. Signals coalesce, and `graph_runtime` Lead turns serialize with user
turns.

Write nodes declare normalized repository-relative scopes. `serialize`,
`lease`, and optional Git `worktree` policies prevent unsafe overlap.
Worktrees capture staged binary patches including new, deleted, and empty
files, verify every changed path against the immutable lease, and apply safely
with stale/dirty/conflict checks. Unknown user changes require human
disposition. Unaccepted, conflicted, or orphaned worktrees are preserved.

Completion requires accepted required/completion nodes, no active or
review-pending nodes, all required reviews, no mailbox blocker, safe write
integration, a closed budget ledger, durable cleanup disposition, and one
persisted synthesis with evidence, changed files, checks, risks, and cost.

## Project agents, scoring, and learning

Project identity prefers normalized Git remote identity, then Git common-dir,
then canonical workspace root. Profiles have immutable versions, origins
(`builtin`, `user`, `ephemeral`, `learned`), and lifecycle:

```text
candidate -> probation -> trusted -> dormant -> archived -> deleted
```

Routing first applies hard lifecycle, task, risk, capability, tool, Skill, MCP,
network, sandbox, and scope eligibility. It then recalls a bounded set and
keeps separate task-fit, verified-quality, trust, freshness, efficiency,
confidence, availability, and load dimensions. The aggregate weights are
32/22/14/8/8/10/3/3 percent respectively.

Only `eligible && recalled && !selected` evidence counts as a missed relevant
opportunity and applies a bounded ranking penalty. Irrelevant conversations do
not decay a specialist. Reaching the configured threshold creates a dormant
version with rollback metadata and an auditable reason.

Terminal/checkpoint runs create redacted bounded Episodes without raw
reasoning, credentials, secrets, full source, or unbounded logs. Durable
idempotent consolidation requires minimum verified episodes across distinct
sessions and classifies reusable material as Agent, Skill, or Graph Recipe
candidates. Evidence is untrusted data. Capability synthesis is least
privilege and cannot grant credentials, risky tools, broad writes, network,
MCP trust, provider authority, or sandbox expansion.

Learning modes are `off`, `suggest`, and `auto_candidate`. Automatic processing
never promotes directly to trusted. Agent candidates enter probation and need
cross-run evidence plus explicit user authority for promotion. Rejection,
rollback, merge, dormancy, archive, and deletion remain reversible/audited.

## Storage, recovery, and retention

```text
<dataDir>/graphs/<runId>/events.jsonl
<dataDir>/graphs/<runId>/snapshot.json
<dataDir>/graphs/thread-references.json
<dataDir>/graph-resources/write-coordinator.json
<dataDir>/graph-resources/worktrees/
<dataDir>/project-agents/<projectId>/registry.json
<dataDir>/graph-learning/<projectId>/learning.json
<dataDir>/artifacts/
```

Journals are checksummed append-only JSONL with monotonic sequence. Snapshots
are atomic; replay starts from the latest valid snapshot plus its suffix.
Large event payloads are content-addressed artifacts. Terminal journals compact
after the configured threshold.

Startup validates storage, expires leases, identifies missing worktrees,
reconciles queued/running/waiting attempts with child sessions, turns missing
children into orphaned/interrupted state, completes interrupted pause, and
returns incomplete synthesis to supervision before scheduling resumes.

Retention removes only expired terminal unreferenced runs. It compacts Episode,
job, reference, and audit history. `artifactDays` deletes only expired objects
that have no GraphRun/Episode reference and whose complete ownership history
shows Graph-only origins. Content shared through deduplication with Web or
ordinary tools, and legacy metadata with unknown owners, is retained
conservatively. Forks copy immutable high-water references without sharing live
execution. Archive pauses; delete fences, cancels, waits, records cleanup, then
removes thread references.

## HTTP and UI

All routes use the existing runtime Bearer authentication:

```text
POST /v1/graphs/validate
GET|POST /v1/graphs
GET /v1/graphs/diagnostics
GET /v1/graphs/:id
GET /v1/graphs/:id/events
GET /v1/graphs/:id/artifacts/:artifactId?offset=N|start_line=N
POST /v1/graphs/:id/start|pause|resume|cleanup
POST /v1/graphs/:id/cancel|retry|steer|patch|reviews

GET /v1/graph-projects/identity
GET|POST /v1/graph-projects/:projectId/agents...
GET /v1/graph-projects/:projectId/evidence|scores|routing
GET /v1/graph-projects/:projectId/candidates|episodes|jobs|audit
POST /v1/graph-projects/:projectId/candidates/:candidateId/action
POST /v1/graph-projects/:projectId/consolidate|explore
```

Mutations use command/idempotency keys and applicable expected sequence and
revision. Responses return persisted post-command truth. `graph_event` also
flows through the existing RuntimeEventRecorder/SSE thread cursor.

When enabled, the composer exposes `Direct | Graph`. The Graph workbench tab
renders phases, typed edges, loops, revisions, minimap/navigation, state and
budget summaries, phase collapse and an accessible list fallback. Node detail
includes the immutable assignment, permissions, tools/Skills, attempts, child
session, bounded paged artifacts, checks, reviews, writes, worktrees, and
errors. Run controls include rebind and versioned CAS GraphPatch operations in
addition to the ordinary lifecycle controls.

Artifact preview uses only the authenticated, run-scoped bounded-read route:
the server verifies that the reference belongs to the GraphRun and the
renderer retains only the current byte/line page. Every mutation reconciles
persisted server truth. Status is not color-only; keyboard, ARIA, screen
reader, localization, and reduced-motion behavior are supported.

## Configuration, rollout, and safe disable

Configuration is under `agents.kun.graph`, grouped into `scheduler`, `context`,
`mailbox`, `supervision`, `writeIsolation`, `routing`, `learning`, and
`retention`. Compatibility defaults are:

```text
enabled=false
defaultStrategy=direct
rolloutStage=experimental
learning.mode=off
writeIsolation.mode=serialize
writeIsolation.allowWorktrees=false
```

The host enforces the rollout stages: `experimental` permits explicit validated
DAGs only; `alpha` enables automatic Lead supervision when both supervision
and `autoStart` are enabled; `beta` admits host-bounded LoopGates;
`learning-preview` enables suggest mode and clamps `auto_candidate` to suggest;
and `stable` may materialize reversible, non-executable candidate profiles.
Promotion still requires evidence and user authority.

Safe disable sets `enabled=false` and `defaultStrategy=direct`. It stops new
creation, automatic supervision, and automatic learning, fences and pauses
nonterminal runs, and waits for active workers to settle. Existing runs and
learned data remain inspectable; do not delete the data directory as a rollback
mechanism.

Missing Graph settings migrate to compatibility defaults, so old workspaces,
threads, and ordinary child sessions are untouched. Before downgrading, disable
Graph and ensure no live worker remains.

For backup, pause/stop Kun and copy `graphs`, `graph-resources`,
`project-agents`, `graph-learning`, and referenced `artifacts` together.
Restore their relative layout and let startup recovery reconcile them. Never
restore a snapshot without its journal suffix or a registry without referenced
learning/artifact data.

## Incident triage

Start with `GET /v1/graphs/diagnostics`; it exposes sanitized aggregates, not
paths, prompts, secrets, or raw patches.

- Creation failure: check enablement, orchestration, and plan validation.
- Stuck blocked node: inspect required outcomes, data artifacts, loop back-edge,
  and terminal predecessor failure.
- Worker does not stop: cancel and inspect worker/lease/worktree cleanup state.
- Write conflict: preserve the worktree and resolve through review/human merge.
- Corrupt journal: preserve the directory and restore a trusted snapshot plus
  suffix; never truncate the only copy.
- Orphan after restart: let recovery persist orphan/retry/supervision before
  manual retry.
- Bad learned candidate: reject or roll back and inspect provenance plus audit;
  do not edit registry JSON manually.

Cleanup is idempotent. Only accepted worktrees are automatically removed.
Unaccepted, conflicted, and orphaned worktrees stay `preserved` until their
contents are backed up or integrated.
