## Why

Kun can currently read web pages and control the whole desktop through Computer Use, but it lacks a first-party browser automation surface that can inspect structured page state, preserve a supervised browser session, and perform browser interactions without relying on pixel grounding or a separately installed MCP server. A native Browser Use capability is valuable only if hostile page content cannot silently gain access to host data or cause external side effects, so the feature must be designed around host-enforced least authority from its first release.

## What Changes

- Add a first-party `browser_use` capability to the existing Kun runtime rather than a second agent runtime.
- Add an Electron-owned, sandboxed Browser Use surface with isolated temporary sessions, bounded tabs, background-first execution, optional floating preview, manual takeover, and deterministic teardown.
- Expose structured, bounded accessibility snapshots and short-lived element references to text or vision models, with screenshot fallback for visual inspection.
- Add an authenticated loopback bridge between Kun and the Electron browser host without exposing arbitrary Electron, JavaScript, Playwright, or CDP execution.
- Add automatic session grants for policy-vetted public origins, redirect validation, private-network blocking, fail-closed network policy, and explicit approval/separation for localhost development browsing.
- Default to automatic execution of live-validated low-risk public interactions, with an `always-ask` mode for exact-origin and per-action consent that cannot be bypassed by runtime `approvalPolicy`.
- Block secrets, cookies, browser storage export, clipboard access, file URLs, upload, download, arbitrary script, payments, credentials, MFA, and subagent/browser sharing in the first release.
- Add a bottom-right landscape picture-in-picture Browser preview and non-blocking running indicator. The live webpage owns the visual surface, while a narrow protected control rail exposes close/manual takeover and reveals exceptional consent, stop, and clear-session controls only when needed.
- Persist redacted lifecycle and policy audit events without persisting complete page text, query strings, form values, cookies, credentials, or screenshots.
- Add unit, integration, security-regression, packaged-app, and cross-platform validation for the complete capability.

## Capabilities

### New Capabilities

- `zero-trust-browser-use`: First-party supervised browser automation, structured page observation, isolated browser sessions, conditional approval, exact-origin/network enforcement, renderer supervision, and redacted auditing.

### Modified Capabilities

None.

## Impact

- `kun/src/contracts`, `kun/src/ports`, `kun/src/adapters`, `kun/src/loop`, and `kun/src/server` gain browser capability contracts, the first-party tool provider, host bridge adapter, risk/consent handling, events, budgets, and runtime manifest integration.
- `src/main` gains an isolated Browser Use manager, network policy, authenticated internal bridge, IPC handlers, lifecycle ownership, and packaging/runtime wiring.
- `src/preload`, `src/shared`, and `src/renderer/src` gain typed browser state/control contracts, a cross-platform renderer-owned floating preview around the host view, protected consent UI, settings, localization, and runtime-event mapping.
- Existing Computer Use, web fetch/search, extension browsers, and optional Playwright MCP remain available but do not become alternate runtimes or inherit Browser Use sessions.
- Packaging and validation must continue to use Electron's bundled Chromium and must not add a separately downloaded browser, Python runtime, cloud Browser Use provider, or unrestricted automation endpoint.
