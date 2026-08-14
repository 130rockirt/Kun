## 1. Contracts and binary watching

- [x] 1.1 Add workspace Office preview contracts and signal-only watch mode through shared types, schemas, preload, and IPC.
- [x] 1.2 Implement signal-mode binary watch bootstrap, change emission, and backward-compatible content-mode behavior.
- [x] 1.3 Add IPC and watcher coverage for signal events, atomic replacements, and existing content callers.

## 2. Office rendering service

- [x] 2.1 Extend Office preview classification and service support for sanitized modern OOXML HTML.
- [x] 2.2 Add optional non-destructive LibreOffice conversion for legacy Office formats and actionable failures.
- [x] 2.3 Add service coverage for sanitization, output fallback, legacy conversion, and source preservation.

## 3. Live workbench preview

- [x] 3.1 Preserve structured office-edit metadata in the renderer tool mapper and publish live Office preview events.
- [x] 3.2 Add per-turn auto-preview coordination with background tabs after manual user suppression.
- [x] 3.3 Add latest-wins Office loading, signal-watch refresh, editing state, iframe display, and zoom controls.

## 4. Validation and handoff

- [x] 4.1 Add focused mapper, controller, loader, and panel tests for auto-focus, user suppression, multiple files, coalescing, stale renders, and errors.
- [x] 4.2 Run typecheck, focused tests, file-size gate, and production build; resolve regressions.
