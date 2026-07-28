## 1. Window and security boundary

- [x] 1.1 Add and test a display-aware tray-popover positioning helper.
- [x] 1.2 Add a dedicated tray-quota preload contract and renderer build entry.
- [x] 1.3 Register sender-validated quota, context, action, and external-dashboard IPC handlers.
- [x] 1.4 Create the lazy frameless popover window with navigation guards, blur/close lifecycle, and tray anchoring.
- [x] 1.5 Route left click to the quota popover and preserve the native session menu on right click.

## 2. CodexBar-inspired quota interface

- [x] 2.1 Build the provider switcher with Overview, provider status indicators, wrapping layout, and selection persistence.
- [x] 2.2 Build overview and provider detail views for balances, limits, progress, reset times, source, and unavailable states.
- [x] 2.3 Add loading, refresh, retained-result errors, scrolling, Escape, dashboard, New Chat, and Open Kun interactions.
- [x] 2.4 Add light/dark popover styling that remains usable without platform blur effects.

## 3. Tests and verification

- [x] 3.1 Add focused positioning, preload/IPC security, provider switching, rendering, refresh, scrolling, and action tests.
- [x] 3.2 Run focused tests, typecheck, build, lint, and `git diff --check`; separate unrelated concurrent work.
- [x] 3.3 Commit only the tray-quota popover and OpenSpec files to local `develop`.
