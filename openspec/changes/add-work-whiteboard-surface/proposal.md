## Why

Work can launch the governed PPT workflow, but its visual-direction and slide-review bundles are only projected through the Code canvas host. Work users therefore cannot complete the required direction selection, annotation, QA review, and approval loop without leaving Work, even though Work is the product surface that owns the source document and final PPTX preview.

## What Changes

- Add a durable whiteboard asset to Work and render it as a first-class central editor tab alongside Markdown, PDF, Office, and PPTX tabs.
- Add a persistent `New whiteboard` entry below `New file`, a contextual entry in the focused editor group's `+` menu, and a Work start-page shortcut.
- Keep the Work assistant in the right panel while the central whiteboard is open.
- Reuse the existing canvas document, ShapeOps, direction-board, review-board, and QA projection capabilities through a Work-specific canvas surface.
- Create or reuse one canonical review whiteboard for each PPT workflow and open or notify that whiteboard when direction, review, repair, or export results arrive.
- Bind whiteboards to durable Work threads and workspace-local storage without exposing internal board files in the normal workspace tree.
- Preserve the existing Office contract: the whiteboard is a planning and review surface, while exported PPTX files remain read-only previews in Work.

## Capabilities

### New Capabilities

- `work-whiteboard-surface`: Work whiteboard creation, central-tab hosting, persistence, thread ownership, navigation, and assistant coexistence.
- `work-ppt-whiteboard-review`: Canonical PPT workflow binding, direction selection, slide review, QA feedback, revision-safe projection, approval, and final PPTX navigation.

### Modified Capabilities

None.

## Impact

- Renderer Work workspace stores, editor-group/tab models, sidebar/start-page actions, document panes, and Work assistant thread selection.
- Shared canvas host, canvas surface typing, document persistence, selection isolation, and replay-safe ShapeOps projection.
- PPT bundle routing and Work composer context; no new model-provider or Kun PPT agent contract is required.
- New focused renderer unit/integration tests plus existing Work, canvas, and PPT regression coverage.
