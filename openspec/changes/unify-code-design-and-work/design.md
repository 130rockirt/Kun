## Context

Code, Write, and Design currently share Kun HTTP/SSE but are projected as three renderer routes. Design owns a separate sidebar, stage, thread registry, compact composer, and per-document conversation. Code already has a tabbed right workspace whose Canvas panel can display a Design document, but that branch is transient and does not run the full HTML/ShapeOps pipeline. Write now covers Markdown, PDF, images, and six Office formats, so its product name no longer describes the workspace.

The redesign must preserve one Kun runtime, stable extension and persisted `write` identifiers, existing Design artifact files under `.kun-design`, image-provider capability checks, and the 700-line authored-file gate.

## Goals / Non-Goals

**Goals:**

- Present Code and Work as the two top-level workspaces.
- Choose Code or Design before the first message from one Code-workbench composer, then keep that mode fixed for the conversation.
- Run full Design HTML/SVG/motion/image behavior in Code's right whiteboard without a second conversation surface.
- Persist and validate a Design task's document, output medium, target, and style snapshot across reload, queue recovery, replay, and fork.
- Keep all internal `write` contracts compatible while changing user-facing product language to Work.

**Non-Goals:**

- Migrating or deleting legacy Design conversations or `.kun-design` files.
- Renaming `write` route values, IPC channels, settings keys, extension tokens, storage keys, directories, or Kun agent surfaces.
- Adding native editing for DOC/DOCX/XLS/XLSX/PPT/PPTX.
- Creating another agent runtime or a separate image-model picker in the composer.

## Decisions

### Keep workbench ownership separate from the locked task mode

New conversations created from the Code workbench always persist `thread.agentSurface: 'code'`; `write` remains owned by Work and legacy standalone Design records may retain `thread.agentSurface: 'design'`. Before the first message, the composer stores a per-thread draft mode. The first accepted Code or Design turn locks the task mode. Code turns send `agentSurface: 'code'`; Design turns send `agentSurface: 'design'` plus the Design flags and document target. Admission must not retag an explicitly Code-owned thread when it accepts a Design turn.

This preserves one task list and one timeline while still allowing the runtime to select the correct instructions, subagents, and tools. The draft mode is renderer state until submission; after admission, the first turn surface and optional Design profile become durable runtime authority for reload, queue recovery, extension routing, and audit. Later turns requesting the other mode fail with `task_surface_locked`. Design uses Agent/Direct.

### Lock a structured Design profile at first accepted turn

Kun gains a strict `DesignTaskProfile` contract containing the Design document id, board artifact id, output medium, Web/App target, selected preset, and a bounded snapshot of the full design context. A Code-workbench thread has no locked profile until its first accepted Design turn. That turn atomically stores the profile and `lockedAtTurnId`; subsequent Design turns must match it or fail with `design_profile_locked`. A Design conversation cannot later submit Code turns, and a Code conversation cannot later submit Design turns.

The accepted turn and user item also retain the submitted profile/document target so queue recovery and canvas replay never re-read mutable global settings. Renderer local storage is only a pre-send draft/cache, not the authority. Fork copies the locked profile and clones the bound Design document before the fork is activated.

### Use one canonical Design document per Design task

Each Code conversation that enters Design binds to exactly one `DesignDocument`, which may contain multiple HTML, SVG, image, board, and motion artifacts. The Code right workspace mounts this document through a reusable full Design canvas surface rather than the existing read-only transient Design-document branch. Conversations that never enter Design continue to use the lightweight per-thread `.kun-canvas` whiteboard.

Every Design canvas mutation is scoped by thread, turn, document, and board artifact. Closing the right panel changes presentation only; it does not clear the binding. Durable replay applies missed operations idempotently when the panel reopens.

### Keep legacy Design conversations in the unified task list

Project-owned legacy conversations identified by `agentSurface: 'design'` or the persisted Design thread registry remain first-class entries in the Code task list. Their existing registry document binding is authoritative, so selecting the owning conversation restores its original writable `.kun-design` document through the same full canvas surface used by Code-owned Design tasks. This changes presentation and navigation only: no thread ownership, profile, registry, or artifact data is migrated or duplicated.

One task classifier is shared by the list, icon, navigation, return-memory, and canvas restoration paths. Durable `lockedTaskSurface` takes precedence over an optional profile for Code-owned conversations, while explicit legacy ownership remains Design. If a Design task target is still hydrating, the right panel stays in the Design loading state instead of mounting the lightweight Code canvas.

### Treat HTML and AI image as primary output lanes

`html` is the default and uses the existing screen factory and linked HTML continuation. The continuation is rendered as progress within the originating turn rather than another user message. `image` requires the runtime image-generation capability, advertises the raster lane, and prohibits HTML-screen fallback.

After a successful `generate_image`, the renderer deterministically fills the selected empty holder or inserts an image at the recommended whiteboard slot. Tool-result identity prevents duplicate placement during SSE replay. HTML tasks may call image generation for supporting assets, but their primary artifact remains HTML.

### Seed style once, then honor the document's design system

The composer reuses the existing `DesignSystemPreset` catalog and Design context fields. Before the first send, `Auto` resolves in this order: a valid root `DESIGN.md`, the workspace Design default, then `none`. The resolved context is snapshotted into the locked profile. Once generated, the document's persisted design system becomes authoritative and later global-setting changes cannot restyle it implicitly.

### Keep Work as a presentation alias

Only user-facing mode, workspace, assistant, onboarding, settings, and documentation language changes to Work/办公. Stable code identifiers and persisted thread titles remain `write`/`Write Assistant`; the renderer maps them to localized product labels. Specific verbs such as writing, polishing, and formatting remain unchanged when they describe an actual feature.

## Risks / Trade-offs

- **[Risk] Full Design canvas controls are too dense for the existing right-panel width.** → Add focus/expand presentation and a single-panel narrow layout; never change task/profile state when resizing or collapsing.
- **[Risk] First-send races lock different profiles or create duplicate documents.** → Use client request idempotency plus atomic runtime admission and a provisional document rollback path.
- **[Risk] Shape operations replay onto the wrong document.** → Persist document/board target on each Design turn and require it in live and replay filters.
- **[Risk] Image generation disappears after an AI-image profile is locked.** → Keep the profile locked, preserve the draft, block Design submission with the runtime capability reason, and link to Image Generation settings; never switch to HTML silently.
- **[Risk] Existing extensions depend on `workbench:design` or `workbench:write`.** → Derive Design context from the active task surface and keep the stable Write token unchanged.
- **[Risk] Old Design conversations become inaccessible.** → Include project-owned legacy Design conversations in the unified task list and restore their existing registry document without migrating or deleting runtime records or files.

## Migration Plan

1. Add tolerant optional runtime/profile contracts and renderer mapping; old records load with no profile.
2. Make all newly created Code/Design threads explicit and update the shared Code-task filter before removing old navigation.
3. Mount the full Design document surface in the Code right workspace and route locked Design-task turns through it.
4. Ship the unified composer/list/empty state and remove standalone Design entry points from the new flow.
5. Apply Work display aliases without rewriting saved settings or threads.
6. Include legacy Design conversations in the shared list and bind both legacy and Code-owned Design tasks to the reusable full Design canvas.

Rollback removes the new UI entry points while leaving optional thread/turn metadata and `.kun-design` content readable by the previous version.

## Open Questions

None. Product defaults and legacy-data behavior are fixed by the approved plan.
