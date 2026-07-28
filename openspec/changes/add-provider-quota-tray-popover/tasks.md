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

## 4. Windows hardening

- [x] 4.1 Pass platform context to the tray renderer and add a solid Fluent/forced-colors presentation for Windows.
- [x] 4.2 Harden tray anchoring for bottom/top taskbars, secondary-display origins, and temporarily empty tray bounds.
- [x] 4.3 Add Windows-focused geometry, renderer, typecheck, build, and 420×660 visual verification; commit only this follow-up to local `develop`.

## 5. Subscription quota source compatibility

- [x] 5.1 Correct ChatGPT/Codex preset recognition and honor the Codex CLI `CODEX_HOME` auth location.
- [x] 5.2 Add and test Kimi Code weekly and five-hour quota parsing from the official usages endpoint.
- [x] 5.3 Add and test Grok bearer-authenticated gRPC-web billing parsing with Grok CLI auth fallback and actionable upstream errors.
- [x] 5.4 Run focused tests, typecheck, build, lint, and `git diff --check`; commit the compatibility follow-up to local `develop`.

## 6. OpenCode Go local quota compatibility

- [x] 6.1 Add a shared, cross-platform, read-only OpenCode SQLite quota reader matching CodexBar's local cost windows.
- [x] 6.2 Register OpenCode Go in both Electron GUI and Kun/TUI quota services with an actionable missing-history state.
- [x] 6.3 Add focused local-reader, GUI-service, and Kun-service regression tests.
- [x] 6.4 Run focused tests, typecheck, build, lint, and `git diff --check`; commit only the OpenCode Go follow-up to local `develop`.
