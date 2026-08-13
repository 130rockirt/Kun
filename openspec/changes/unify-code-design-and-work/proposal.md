## Why

Kun currently presents Code, Write, and Design as separate top-level workspaces even though Design already shares the Kun runtime and can render inside Code's right-side whiteboard. This fragments conversations, hides the new Office-oriented scope of Write, and forces users to choose an application surface before they can describe the task.

## What Changes

- Replace the top-level `Code | Write | Design` navigation with `Code | Work`; keep the stable internal `write` route, settings, extension, IPC, and persistence identifiers.
- Turn Design into a conversation mode inside the Code workbench. Users choose Code or Design for each turn of a Code conversation; only the Design document, output medium, target, and style snapshot lock with the first accepted Design turn.
- Bind every Code conversation that uses Design to one durable Design document rendered by Code's right-side whiteboard, while preserving the full HTML, SVG, motion, image, multi-screen, and design-system pipeline.
- Add Design-only composer controls for output medium (`HTML` or `AI image`), target (`Web` or `App`), and Kun's existing design-system presets. The complete profile is locked with the task's first accepted Design turn while the Code/Design surface selection remains per-turn.
- Make HTML the default interactive output. AI-image tasks produce raster assets on the whiteboard and never silently fall back to HTML; HTML tasks may still use generated images as supporting assets.
- Remove the standalone Design stage, sidebar, and assistant from the new workflow. Legacy design files remain on disk, and project-owned legacy Design conversations appear in the unified Code task list without rewriting their runtime records or document bindings.
- Redesign the empty task surface around a single intent-aware composer and starter actions inspired by the supplied WorkBuddy interaction structure.

## Capabilities

### New Capabilities

- `unified-code-design-tasks`: One Code workbench surface with a per-turn Code/Design choice, shared navigation, stable thread ownership, and a durable Design profile lock after the first accepted Design turn.
- `thread-design-profile`: Durable per-task Design document binding, output medium, target, style snapshot, runtime validation, replay, and fork behavior.
- `embedded-design-whiteboard`: Full Design artifact generation and editing inside Code's right-side whiteboard, including deterministic AI-image placement.
- `work-product-surface`: User-facing Work naming and Office-oriented task entry points while preserving stable `write` compatibility identifiers.

### Modified Capabilities

None.

## Impact

- Renderer workbench routing, sidebars, empty state, conversation list, composer state, Design controllers, right-panel canvas, localization, and settings entry points.
- Kun thread/turn contracts, admission validation, persistence projections, fork behavior, SSE metadata, and Design tool routing.
- Design document persistence gains an explicit thread binding and immutable profile; queued turns and canvas replay gain a document target.
- Existing `write`, `workbench:write`, `.kun-design`, Design preset, image-generation, and Office read-only contracts remain compatible.
