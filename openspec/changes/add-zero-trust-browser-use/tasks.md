## 1. Contracts and safe defaults

- [x] 1.1 Add shared Browser Use settings, runtime-state, consent, audit, action, and result contracts with strict bounded schemas
- [x] 1.2 Add safe Browser Use settings normalization and preserve existing Computer Use and developer Browser behavior
- [x] 1.3 Add the Browser Use capability manifest entry and environment contract without exposing launch credentials
- [x] 1.4 Add contract and normalization tests for defaults, caps, invalid actions, and sensitive argument rejection

## 2. Electron browser security foundation

- [x] 2.1 Extract reusable WebContents hardening helpers without sharing Browser Use and Extension partitions or ownership records
- [x] 2.2 Implement public-address and exact-origin normalization covering IPv4, IPv6, mapped addresses, metadata, mixed DNS answers, and unsupported schemes
- [x] 2.3 Implement the fail-closed Browser Use loopback policy proxy with vetted-address pinning, redirect enforcement, bounded requests, and no direct fallback
- [x] 2.4 Add an explicit exact-loopback-origin local-development policy that cannot mix with public sessions
- [x] 2.5 Add focused network-policy and proxy tests for rebinding, redirect, WebSocket, proxy failure, and local/public separation

## 3. Main-owned Browser Use sessions

- [x] 3.1 Implement BrowserUseManager lifecycle, temporary thread-bound partitions, bounded tabs, visibility mounts, idle expiry, stop, clear, crash, and shutdown cleanup
- [x] 3.2 Enforce Browser WebContents sandbox preferences, denied permissions/dialogs/downloads/popups, disabled unsafe navigation, and policy-proxy attachment
- [x] 3.3 Implement exact-origin request/grant handling before navigation and on cross-origin redirects or popups
- [x] 3.4 Implement bounded structured snapshots, sensitive-field redaction, screenshots, opaque refs, and document-generation invalidation
- [x] 3.5 Implement fixed observation and navigation actions with action, wait, tab, screenshot, and idle budgets
- [x] 3.6 Implement prepared click/type/select/press actions, target highlighting, sensitive-target rejection, short expiry, single use, and live pre-execution revalidation
- [x] 3.7 Implement manual takeover and agent-return transitions that cancel work and invalidate all prior refs
- [x] 3.8 Add redacted bounded Browser Use audit records for lifecycle, policy, consent, execution, abort, and crash outcomes

## 4. Protected host bridge and consent

- [x] 4.1 Implement a launch-scoped authenticated loopback Browser Use service with strict Host, bearer token, method, content-type, body-size, schema, scope, and concurrency checks
- [x] 4.2 Start and stop the service with the desktop runtime and pass its random URL/token only through the managed Kun child environment
- [x] 4.3 Implement sender-validated preload/Main IPC for mount bounds, state subscription, origin decisions, allow-once action decisions, manual control, stop, and clear
- [x] 4.4 Implement fail-closed pending-decision cancellation on renderer loss, tab hiding, session stop, runtime shutdown, or expiry
- [x] 4.5 Add bridge authentication, IPC sender validation, replay, timeout, and general-approval-bypass regression tests

## 5. Kun runtime integration

- [x] 5.1 Add a strict BrowserController port and authenticated Main bridge adapter with bounded timeouts and typed error mapping
- [x] 5.2 Implement one stable browser_use action-enum provider with structured untrusted snapshots and screenshot tool-result support
- [x] 5.3 Enforce primary-GUI-only registration, per-turn budgets, disabled/unavailable/interaction-required status, and omission from delegated/base registries
- [x] 5.4 Wire Browser Use settings and bridge availability through the runtime composition root without creating a second agent loop or approval system
- [x] 5.5 Add Kun provider, runtime-registration, headless/delegated exclusion, budget, stale-ref, and redaction tests

## 6. Renderer supervision experience

- [x] 6.1 Add the preload Browser Use API and typed renderer declarations without exposing bridge credentials or generic WebContents control
- [x] 6.2 Add an Agent Browser mode to the Code Browser tab while retaining the separate renderer-owned developer preview
- [x] 6.3 Mount and size the host-owned Browser Use view only for its owning active thread and hide it when supervision is inactive
- [x] 6.4 Show sanitized origin/title, loading/error/trust state, control owner, budgets, pending consent, and unavailable reasons
- [x] 6.5 Add exact-origin and target-specific highlighted allow-once consent surfaces with no permanent grant
- [x] 6.6 Add manual takeover/return, Stop, Clear Session, tab controls, and automatic activation for the matching thread
- [x] 6.7 Add Browser Use settings controls, safe limits, public/local mode guidance, and localized copy
- [x] 6.8 Add renderer tests for thread ownership, mount visibility, consent decisions, controls, settings, and localization

## 7. Cleanup and redaction integration

- [x] 7.1 Wire thread archive/delete, runtime restart, window teardown, and app exit to deterministic Browser Use disposal
- [x] 7.2 Ensure model history, SSE/runtime events, logs, Renderer state, and durable audit output omit query/fragment, values, tokens, credentials, screenshots, and absolute paths
- [x] 7.3 Add lifecycle cleanup and cross-layer redaction regression tests

## 8. Validation and delivery

- [x] 8.1 Run focused Browser Use unit and integration tests and resolve newly introduced failures
- [x] 8.2 Run npm run build:kun and npm run typecheck
- [x] 8.3 Run npm run test and npm run build, separating any unrelated baseline failures with evidence
- [x] 8.4 Run security smoke coverage against a controlled public test origin and a local-development origin
- [x] 8.5 Build a packaged desktop artifact and verify mount, observe, allow-once, deny, stop, clear, cleanup, and absence of reusable authority
- [x] 8.6 Complete a final spec/task/diff audit and document the authority limits and rollback path

## 9. Default automatic safe-operation policy

- [x] 9.1 Add `auto-safe` and `always-ask` settings, default Browser Use to enabled `auto-safe`, and preserve a disable switch
- [x] 9.2 Auto-grant policy-vetted public origins while keeping local-development and strict-mode origin approval
- [x] 9.3 Auto-execute live-validated low-risk public interactions while preserving strict prompts and hard sensitive-target blocks
- [x] 9.4 Update Renderer controls, localization, Kun tool guidance, and OpenSpec artifacts for conditional approval
- [x] 9.5 Add regression coverage and rerun focused/full validation

## 10. Background execution and floating preview

- [x] 10.1 Update the proposal, design, and specification for background-first execution, optional floating preview, approval-triggered visibility, and macOS/Windows/Linux portability
- [x] 10.2 Decouple public `auto-safe` navigation and interaction from Renderer preview visibility while keeping approval-required work fail-closed
- [x] 10.3 Add a default-hidden in-app floating Browser Use preview, running indicator, close/reopen behavior, and manual-control handoff
- [x] 10.4 Add regression coverage for background execution, preview lifecycle, approval visibility, and platform-neutral behavior
- [x] 10.5 Run focused and full validation, including the available desktop build/package checks, and document any platform-runtime verification limits

## 11. Landscape picture-in-picture supervision

- [x] 11.1 Update proposal, design, and specification artifacts for the reference landscape picture-in-picture layout
- [x] 11.2 Add a webpage-first compact panel variant and a responsive bottom-right landscape preview
- [x] 11.3 Add a protected close/manual-control rail with on-demand Stop/Clear controls and attention-state presentation
- [x] 11.4 Add Renderer regression tests and rerun focused/type/build validation
- [x] 11.5 Rebuild and verify the available packaged desktop artifact
