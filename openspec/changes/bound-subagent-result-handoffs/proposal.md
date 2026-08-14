## Why

Subagent turns can currently copy an unbounded assistant transcript into the parent turn, persisted child-run records, runtime events, and detached notifications. A single verbose child can therefore overflow the parent model context or drive process-wide memory pressure, interrupting unrelated conversations even though the child session itself completed successfully.

## What Changes

- Bound every child-to-parent handoff before it is persisted, published, or returned as a tool result.
- Keep only the child's final non-empty assistant answer as the handoff source instead of concatenating its whole assistant transcript.
- Externalize oversized Markdown results to the existing artifact store and return a short preview plus a structured artifact reference that `read_artifact` can consume incrementally.
- Degrade to a bounded preview with an explicit unavailable reason if artifact persistence fails; never fall back to injecting the raw oversized result.
- Retain externalized results while their related parent/child session exists, deduplicate shared artifacts, and reclaim linked artifacts when the last related owner is deleted.
- Isolate provider context-overflow failures to the affected turn, with one safe compaction retry before reporting an ordinary turn error.
- Expose externalization metadata on existing child-run cards without changing the existing child-thread Open interaction.

## Capabilities

### New Capabilities

- `bounded-subagent-handoff`: Defines bounded child result previews, artifact-backed full results, failure fallback, lifecycle events, detached completion, resume, and UI projection behavior.
- `linked-result-artifact-retention`: Defines ownership, deduplication, and deletion semantics for full child results stored in the artifact store.
- `turn-context-overflow-recovery`: Defines provider context-overflow classification, one compaction retry, and per-turn failure isolation.

### Modified Capabilities

None.

## Impact

The change affects Kun delegation contracts and execution, artifact storage and manager transport, thread deletion cleanup, model error handling, runtime event metadata, renderer child-run mapping/card presentation, and focused tests across synchronous, detached, resume, evidence, and presentation child results. Existing child threads remain the canonical audit trail, and existing unlinked artifacts keep their current retention behavior.
