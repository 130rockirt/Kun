## Why

Generated images are currently rendered in the turn-level "Generated files" area as soon as the image tool finishes, even while the surrounding turn is still running. This makes an intermediate result appear detached from the tool step that produced it and falsely suggests that the whole response has reached its final output.

## What Changes

- Render generated media inline at the producing tool's chronological position while the turn is still processing.
- Keep generated-media tool results as distinct timeline positions so their previews are not hidden inside an unrelated collapsed tool batch.
- Move generated media to the existing turn-level "Generated files" summary only after the turn has finished.
- Add renderer coverage for active and completed turn placement without duplicating previews.

## Capabilities

### New Capabilities

- `inflight-generated-media-placement`: Defines how generated media moves from an in-progress tool timeline position to the completed turn summary.

### Modified Capabilities

None.

## Impact

- Affects chat timeline section grouping and rendering under `src/renderer/src/components/chat`.
- Reuses the existing generated-media preview and file actions; no runtime, IPC, persistence, or provider contract changes are required.
- Adds focused renderer unit tests for chronological placement and completed-turn finalization.
