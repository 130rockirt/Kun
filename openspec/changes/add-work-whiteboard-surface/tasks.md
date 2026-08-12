## 1. Work whiteboard domain and persistence

- [x] 1.1 Add typed Work editor items and backwards-compatible layout normalization without pseudo file paths
- [x] 1.2 Add versioned Work whiteboard metadata, hidden workspace persistence, registry loading, and CRUD actions
- [x] 1.3 Bind whiteboard metadata to a durable Write thread and restore the thread when a whiteboard tab is focused

## 2. Central Work canvas

- [x] 2.1 Extract or add shared canvas surface typing and a Work canvas identity helper without exceeding the file-size gate
- [x] 2.2 Implement the central Work whiteboard host with CanvasViewport, PropertiesPanel, persistence guards, and current-document isolation
- [x] 2.3 Enforce one mounted writable Work canvas and provide a safe split-group handoff state
- [x] 2.4 Render, activate, move, close, restore, rename, and delete whiteboard tabs without invoking file watchers or file save paths

## 3. Work creation and navigation UX

- [x] 3.1 Add the persistent sidebar New whiteboard action and hide Kun-owned whiteboard storage from the file tree
- [x] 3.2 Add New whiteboard to the focused editor-group add menu and the Work start page
- [x] 3.3 Add whiteboard titles, status indicators, responsive behavior, and empty-canvas guidance while keeping the Work assistant beside the canvas

## 4. PPT review integration

- [x] 4.1 Replace the Code-only canvas-open signal with a target-bearing Code or Work whiteboard request
- [x] 4.2 Create or reuse a canonical Work whiteboard for a PPT workflow before direction or review projection
- [x] 4.3 Project direction and review bundles into the correct Work board using document-key, thread, workflow, child, revision, and replay guards
- [x] 4.4 Add structured direction adoption, revision, selected-slide repair, QA gating, approval, and linked read-only PPTX navigation
- [x] 4.5 Include active Work whiteboard snapshot, selection, annotations, and PPT references in Work assistant sends

## 5. Verification and documentation

- [x] 5.1 Add unit tests for typed layout migration, whiteboard registry CRUD, thread binding, hidden storage, and single-canvas ownership
- [x] 5.2 Add component tests for sidebar/menu/start-page creation, central canvas and assistant coexistence, split-group handoff, reload, and responsive behavior
- [x] 5.3 Add PPT integration tests for canonical-board reuse, direction/review projection, stale and duplicate replay, QA gating, and final PPTX navigation
- [ ] 5.4 Run renderer typecheck, focused Vitest suites, file-size validation, top-level typecheck, and build; record any unrelated baseline failures
