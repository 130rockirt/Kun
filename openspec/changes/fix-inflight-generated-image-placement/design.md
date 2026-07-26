## Context

`ConversationTurn` currently derives all successful generated-file tool blocks and renders one `GeneratedFilesPanel` after assistant content, regardless of whether the turn is active. The same tool blocks also exist in the chronological process timeline, but that timeline renders only their tool summaries and can fold adjacent tools into a single section.

The existing preview component already handles generated image loading, reveal animation, carousel behavior, and file actions. The fix should change placement and lifecycle only, without introducing another preview implementation or changing runtime events.

## Goals / Non-Goals

**Goals:**

- Keep an in-progress generated-media preview anchored to the tool result that produced it.
- Preserve chronological placement even when adjacent tool events would normally be grouped.
- Render exactly one copy of the generated-media preview during an active turn.
- Reuse the existing turn-level generated-files summary after completion.

**Non-Goals:**

- Changing image-generation providers, runtime payloads, attachment storage, or SSE ordering.
- Adding partial-image streaming before a successful tool result exists.
- Redesigning the visual appearance or actions of generated-media tiles.
- Changing completed-turn process expansion behavior.

## Decisions

1. Generated-media tool results are grouping boundaries in the process timeline.

   A tool block carrying `attachments` or `generatedFiles` will occupy its own execution section. This provides a stable chronological anchor and prevents its preview from being hidden inside a collapsed multi-tool batch. Keeping all adjacent tools grouped and placing the preview after the batch was considered, but that loses the precise producing-step location requested by the UI behavior.

2. The existing `GeneratedFilesPanel` is reused with an explicit placement marker.

   The process row renders the panel for its own tool block while the turn is active. Reuse keeps media deduplication, lazy preview loading, carousel behavior, and actions consistent. A placement marker makes active-versus-final behavior directly testable without maintaining separate components.

3. The turn-level panel is gated by turn completion.

   While `isProcessing` is true, `ConversationTurn` omits the bottom panel and the isolated process row owns the only preview. When processing becomes false, the process-row preview is disabled and the existing aggregate panel appears after the final assistant content. This state-driven handoff avoids duplicate images and requires no new persisted state.

## Risks / Trade-offs

- [Generated non-image files also become grouping boundaries] → Use the same metadata predicate as the existing generated-files summary so behavior remains consistent across media types; presentation artifacts remain filtered by their dedicated panel.
- [A tool payload may include both ordinary attachments and generated media] → Reuse the existing merge and deduplication logic instead of interpreting the payload a second time.
- [Placement could regress during future timeline grouping changes] → Cover both grouping boundaries and active/completed render order with focused unit tests.
