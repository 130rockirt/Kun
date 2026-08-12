## Context

Work currently models every central editor tab as a workspace file path. Its assistant thread follows the focused file, while the only mounted general-purpose canvas is `CodeCanvasPanel`. PPT direction and review bundles already produce replay-safe ShapeOps with workflow, child, revision, and parent-thread identities, but the automatic-open event only selects the Code right-panel canvas.

The canvas implementation uses singleton Zustand stores for the active document, selection, viewport, undo, and motion state. Mounting two writable `CanvasViewport` instances concurrently would make their persistence subscriptions race and could write one document into another board path. The first implementation must therefore guarantee one mounted writable Work canvas per application window.

## Goals / Non-Goals

**Goals:**

- Make a Work whiteboard a durable workspace asset and a first-class central editor tab.
- Keep the Work assistant visible beside the canvas.
- Reuse the existing canvas and PPT projection contracts without creating a second drawing engine.
- Preserve the correct Work thread when a whiteboard rather than a file is focused.
- Route every PPT workflow to one canonical whiteboard and make bundle replay idempotent.
- Keep internal whiteboard storage hidden from the ordinary workspace file tree.

**Non-Goals:**

- Native editing or round-trip mutation of existing PPTX, DOCX, or XLSX files.
- Multiple writable canvases mounted simultaneously in split editor groups.
- Replacing the governed PPT design plan with freely positioned canvas shapes.
- Importing arbitrary existing PPTX files into editable slide elements.
- Rebuilding Design HTML, Motion, or prototype-player capabilities for Work.

## Decisions

### 1. Represent Work tabs as typed editor items

The editor layout will evolve from file-only `path` tabs to typed items with a stable key:

```ts
type WorkEditorItem =
  | { kind: 'file'; path: string }
  | { kind: 'whiteboard'; boardId: string }
```

Persisted file-only v1 layouts will be normalized into typed items. A whiteboard will not use a pseudo file URL because that would contaminate file loading, watching, save, recent-file, and Office-preview behavior.

Alternative considered: keep the layout unchanged and use `.kun-*` canvas paths as tabs. Rejected because those paths would enter file-centric code and expose internal implementation details.

### 2. Store whiteboard metadata separately from the canvas document

Work whiteboard metadata will be stored in a workspace-local registry under `.kun-write/whiteboards/index.json`; each canvas document will use `.kun-write/whiteboards/<boardId>/canvas.json`. Metadata includes title, source file, Work thread, optional PPT workflow/child, phase, current revision, output path, and timestamps.

Canvas document parsing and persistence remain shared. The workspace file tree will explicitly hide `.kun-write` just as it hides other Kun-owned directories.

### 3. Host one Work canvas in the focused central group

A `WorkWhiteboardSurface` will compose `CanvasViewport`, `PropertiesPanel`, and the existing live ShapeOps projector with `surface="work"`. Only the focused whiteboard tab may mount the writable viewport. Opening another whiteboard activates it; split groups show a non-editable handoff placeholder for a non-focused whiteboard rather than mounting a second store owner.

Alternative considered: render a canvas in every editor group. Rejected until canvas stores become document-keyed instances.

Alternative considered: put the whiteboard in Work's right panel. Rejected because PPT comparison boards are approximately 1,500 logical pixels wide and the assistant must remain available during review.

### 4. Bind assistant threads to Work artifacts

The Write thread registry will gain artifact keys in addition to file keys. A focused whiteboard resolves or creates a thread using `whiteboard:<boardId>` and retains `agentSurface: 'write'`. The active Work context will distinguish `file` and `whiteboard`, while preserving an optional source file for PPT prompts.

### 5. Target canvas-open events instead of opening Code implicitly

The current parameterless canvas-open event will become a target-bearing event. PPT bundle routing will include the parent Work thread and workflow identity. In Work it will atomically find or create the canonical bound board, project the bundle, and activate or notify its tab. In Code it will retain current behavior.

Tool block IDs plus PPT workflow, child, revision, and phase form the replay key. Receiving the same bundle again replaces or confirms the current projection rather than appending duplicates.

### 6. Keep PPT authority outside the whiteboard

Direction cards, slide previews, annotations, and QA markers are projections of the governed PPT workflow. Moving their shapes is visual-only. Direction adoption, revision, page repair, and approval send structured references back to the same PPT child. The exported PPTX remains a read-only Work preview and the board remains as the review record.

### 7. Provide one persistent and two contextual creation entries

The primary entry is a `New whiteboard` row immediately below `New file` in the Work sidebar. The focused group `+` menu and Work start page provide contextual secondary entries. Presentation actions create or reuse a review board rather than creating unbounded duplicate boards.

## Risks / Trade-offs

- [Singleton canvas stores can corrupt concurrently mounted boards] → Mount only the focused writable Work canvas and add tests that split groups never own two viewports.
- [Work currently clears its thread when no file is active] → Resolve the thread from the active typed editor item and persist board-thread binding before mounting the canvas.
- [Bundle handling currently depends on a Code canvas hook being mounted] → Move target resolution ahead of projection and rehydrate pending receipts when the Work board activates.
- [Layout persistence migration can drop tabs] → Accept existing v1 file-only payloads, normalize them, and only persist the new version after successful parsing.
- [Hidden metadata may appear in the tree] → Filter `.kun-write` at the shared workspace-entry boundary and add a regression test.
- [The requested scope is broad] → Deliver creation, persistence, central canvas, assistant binding, and PPT direction/review projection as the first complete vertical slice; defer multi-canvas split editing and advanced comments/version history.

## Migration Plan

1. Add backwards-compatible layout and whiteboard metadata parsing.
2. Ship the new Work surface and creation entries behind the presence of a valid workspace root.
3. Retarget PPT canvas-open events while preserving Code behavior.
4. Validate reload, reconnect, workspace switching, and duplicated SSE bundles.
5. Rollback is safe by removing the Work entries and target routing; existing `.kun-write/whiteboards` data remains isolated and can be re-enabled later.

## Open Questions

- None for the first implementation. Concurrent editable whiteboards remain an explicit later canvas-store refactor.
