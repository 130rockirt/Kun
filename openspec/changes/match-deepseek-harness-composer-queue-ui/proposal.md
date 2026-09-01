## Why

Kun's current busy-turn queue presentation shows only the first message plus a `+N` badge and hides the authoritative list in a hover Portal. This differs from the frozen DeepSeek Harness QueueDock, makes multiple pending inputs hard to discover and control, and currently turns Edit into a destructive dequeue-to-draft operation while hiding failed messages entirely.

## What Changes

- Replace the first-message QueueStrip and hover Portal with a composer-attached QueueDock matching DeepSeek Harness `master@0a53fb55bea101816fa226bb964ae2bed71c343b`.
- Render one queued item directly; render two or more as a collapsed total-count header that expands the complete FIFO list in place.
- Add same-ID inline text editing with Save/Cancel, Enter/Escape/IME handling, and blank-save prevention while preserving frozen routing/model fields.
- Keep Remove and current-turn Guide explicit, serialize queue mutations while one action is pending, and retain rows on failure.
- Surface failed and paused queue entries with retry/removal actions instead of filtering them out.
- Match the reference 36px rows, 28px actions/editor, 12px attached top corners, 180px internal scroll budget, semantic light/dark colors, and narrow-layout containment.
- Remove queue-specific hover opening, `+N` preview, fixed popover, overflow Edit menu, and drag-reorder UI; the existing store/runtime queue and steering contracts remain authoritative.

## Capabilities

### New Capabilities

- `composer-queue-dock`: Composer-attached presentation and safe management of queued follow-up messages during an active turn.

### Modified Capabilities

None.

## Impact

- Renderer queue components, composer stack integration, Zustand queue actions/types, localized queue copy, and focused renderer/store tests.
- Deterministic Electron layout/interaction smoke for the attached dock.
- No new HTTP, IPC, persistence format, runtime provider, or dependency; existing mid-turn guidance and ordinary FIFO delivery semantics are preserved.
