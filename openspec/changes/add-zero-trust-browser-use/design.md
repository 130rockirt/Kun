## Context

Kun already has three adjacent but incomplete browser surfaces:

- `web_fetch` and `web_search` read public text but do not maintain interactive page state.
- `computer_use` drives the whole desktop through screenshots and coordinates, requires a capable vision model, and intentionally remains top-level only.
- the Renderer has a developer Browser tab while the Extension platform owns a hardened `WebContentsView` implementation with isolated partitions, host allowlists, denied permissions, bounded navigation, and visible embedded presentation.

The product needs Browser Use without introducing a second model loop, exposing the Kun renderer to page automation, relying on user-installed Playwright MCP, or allowing hostile page content to turn model output into an ambient host capability. The Browser Use path crosses Kun, Electron Main, preload, Renderer, settings, runtime events, process launch, and packaging, so security decisions must be enforced below the model and represented by shared contracts.

The first release is deliberately supervised and temporary. It supports useful anonymous browsing and form interaction while excluding persistent login profiles, credentials, payment, MFA, upload, download, clipboard, arbitrary JavaScript, raw selectors, raw CDP, background schedules, Connect/IM execution, and subagent sharing.

## Goals / Non-Goals

**Goals:**

- Add one first-party `browser_use` tool to the existing Kun AgentLoop.
- Let text-only models act on bounded structured accessibility snapshots and let vision models request a screenshot fallback.
- Render only a dedicated, sandboxed Browser Use `WebContentsView`, with background execution by default and an optional in-app floating preview.
- Keep every Browser Use session temporary, thread-bound, manually controllable, bounded, abortable, and deterministically disposable without forcing a visible or focused window for safe public automation.
- Automatically grant policy-vetted public origins while enforcing redirect checks, public-network-only browsing, and a separately approved localhost development mode.
- Automatically execute live-validated low-risk public interactions, while retaining a host-controlled `always-ask` mode and requiring approval at local/restricted boundaries.
- Keep page content, credentials, storage, files, clipboard, runtime tokens, and host APIs on separate trust sides.
- Produce redacted lifecycle, policy, consent, and outcome audit records.
- Fail closed when the browser host, network policy, authenticated bridge, or a required consent surface is unavailable.

**Non-Goals:**

- Running Browser Use as a Browser Use Cloud, Stagehand, Playwright Agent, or other second agent runtime.
- Reusing a daily Chrome profile, an Extension browser partition, the developer preview partition, or Kun's renderer session.
- Automating credentials, password managers, MFA, CAPTCHA, payment, purchase, destructive transactions, upload, or download.
- Providing arbitrary JavaScript, CSS/XPath selectors, Playwright code, raw CDP, Cookie APIs, localStorage APIs, local files, clipboard APIs, or unrestricted browser extensions.
- Supporting scheduled, workflow, IM, CLI-only, headless, or delegated Browser Use in the first release. Those callers receive `interaction_required` or capability-unavailable results.
- Claiming that untrusted internet content or Chromium itself can be made mathematically risk-free.

## Decisions

### 1. Browser Use is one Kun capability and one stable action tool

Kun adds `capabilities.browserUse` and a single stable `browser_use` action-enum schema. Actions are `open`, `snapshot`, `screenshot`, `click`, `type`, `select`, `press`, `scroll`, `wait`, `tabs`, and `close`. The schema does not accept selectors, scripts, CDP methods, storage data, Cookie data, arbitrary headers, file paths, or executable code.

One schema preserves the immutable model prefix and avoids advertising the large dynamic catalog exposed by a generic Playwright MCP server. Browser Use is assembled only into the primary registry, following the existing Computer Use exclusion from `baseToolProviders`.

Alternatives considered:

- Playwright MCP remains a useful experiment but is user-installed, advertises many tools, has a separate browser lifecycle, and cannot enforce the product's protected consent UI.
- Browser Use and Stagehand agents duplicate the Kun AgentLoop and model accounting.
- Multiple first-party tools simplify static approval policies but increase catalog size and still cannot express live target validation.

### 2. Electron Main owns the browser and exposes a narrow BrowserController bridge

`BrowserUseManager` owns temporary `WebContentsView` instances, thread/session/tab identity, bounds, navigation state, page epochs, element references, screenshots, fixed interaction operations, and teardown. It shares a small hardened-browser foundation with the Extension external browser but never shares Extension records or partitions.

Kun talks to Main through an authenticated loopback service on a random port. Main creates a 256-bit launch token, passes the URL and token to the managed Kun child through environment variables, binds only to `127.0.0.1`, validates the Host header and strict request schemas, caps request bodies and concurrency, and rotates the token on every application launch. The service exposes fixed session, observation, prepare-action, execute-prepared-action, and close operations; it never exposes a generic Electron or CDP command.

This follows the repository's existing GUI-schedule pattern while keeping Browser Use a dedicated first-party provider rather than a user-managed MCP server.

Alternative considered:

- A global Chromium remote-debugging port would expose the main Kun renderer and every Electron target and is therefore forbidden.
- Launching a separate Playwright Chromium adds a browser binary/profile lifecycle and prevents a native supervised workbench surface.

### 3. Browser views use temporary least-authority sessions

Every Browser Use session uses an unguessable `temp:kun-browser-use-*` partition with Node integration disabled, context isolation and Chromium sandboxing enabled, web security enabled, unsafe content disabled, no preload, no Webview tag, disabled dialogs, denied device/site permissions, blocked downloads, and bounded tabs. Browser Use never attaches to the main renderer, a developer preview Webview, an Extension view, or another thread's WebContents.

The Main process maps exactly one live Browser Use session to a thread and at most three tabs to a session. Sessions are removed on explicit close, thread deletion/archive invalidation, user stop, runtime shutdown, window destruction, app exit, crash, or idle expiry. A renderer reload requires a fresh mount handshake and cannot silently continue an interaction.

Persistent named login profiles are deferred until a later separately reviewed change.

### 4. All traffic passes a fail-closed public-network policy

The Browser Use partition uses a Main-owned loopback proxy with no direct fallback. The proxy validates HTTP, HTTPS, WS, and WSS destinations, normalizes hostnames and IP literals, resolves all A/AAAA records, rejects the destination if any answer is loopback/private/link-local/ULA/multicast/unspecified/metadata/non-public, pins the vetted address for the connection, and revalidates every redirect and connection. File, data top-level, JavaScript, DevTools, Kun protocols, and other schemes are rejected.

QUIC/direct bypass is disabled for Browser Use traffic. Proxy failure closes or blocks the Browser Use session. URL logs retain the origin and bounded path but redact query and fragment.

Local development browsing is a separate explicit mode. It grants one exact loopback origin (`scheme + host + port`) selected by the user, uses a fresh temporary session, cannot mix public and local origins, and cannot be reached by redirect or navigation from a public session.

### 5. Origin authority follows network and approval mode

The host normalizes every top-level destination to an exact origin. In the default `auto-safe` public mode, an origin that passes the fail-closed public-network policy receives an automatic session-only grant before Main loads it. Cross-origin redirects are revalidated and receive the same bounded automatic grant only when they independently pass public policy. Exact localhost/loopback origins always require an explicit Renderer decision, and `always-ask` requires that decision for every new public origin. No wildcard or permanent grant is offered.

Ordinary public subresources may load through the network proxy but do not acquire top-level navigation authority.

### 6. Structured snapshots are bounded, visibly grounded, and untrusted

Main obtains a fixed accessibility/DOM projection using audited internal CDP commands. It emits only visible or near-viewport nodes with bounded role, accessible name, state, value metadata, and geometry. Scripts, styles, comments, hidden/offscreen nodes, unbounded attributes, and complete HTML are excluded. Password, payment, OTP, file, hidden, and other sensitive fields never expose a value.

Every snapshot carries `untrustedContent: true`, the sanitized URL/title, tab ID, document/page generation, truncation metadata, and at most the configured node/text caps. Page strings remain structured data and are not interpolated into system instructions.

Element refs are opaque and bind session, tab, document generation, backend node identity, and a host-computed fingerprint. Navigation invalidates all refs. DOM mutation advances the generation used for prepared interactions. The model cannot supply a selector in place of a ref.

Screenshots reuse the existing tool-result image pipeline, are downscaled, retained only in bounded recent model history, and are not persisted to disk by default.

### 7. Main classifies live actions and applies conditional approval

Observation (`snapshot`, `screenshot`, `tabs`, bounded `wait`) and local view operations (`scroll`) may execute after origin grant. In default `auto-safe` public mode, `click`, `type`, `select`, and `press` may execute without a prompt only after Main prepares and validates a low-risk, non-sensitive live target. In local-development or `always-ask` mode, Main returns a target-specific preview and waits for a protected allow-once decision.

The Renderer displays the live target preview and sends a decision through sender-validated IPC. No "always allow" option exists. Headless callers receive `interaction_required`.

Immediately before every automatic or approved execution Main verifies the prepared action has not expired, is unused, belongs to the same thread/session/tab/origin, and still matches document generation, backend node, fingerprint, visibility, enabled state, geometry, and hit target. Any change cancels the action and requires a fresh snapshot.

The Browser approval mode is host-owned and independent from general `approvalPolicy`. Tool prose, model output, Skills, MCP trust, and subagent policy cannot broaden `auto-safe`, manufacture consent, or cross a blocked boundary.

Sensitive targets (password, payment, OTP, CAPTCHA, file input) and forbidden commit/transaction actions are rejected before execution or prompting. The user handles login and other sensitive interactions through manual control.

### 8. Background execution is the default and manual takeover remains explicit

Public `auto-safe` navigation and live-validated low-risk interactions may execute in a fixed-size hidden background viewport without opening or focusing a browser surface. The Renderer shows a small running indicator for the owning thread. Selecting it opens a fixed-position in-app floating preview around the same host-owned `WebContentsView`; closing it detaches only the preview and does not terminate eligible background work or discard page state.

If an origin or action requires approval, Main enters `mount-required` and the matching Renderer opens the floating preview before presenting protected consent. Closing the preview while consent is pending denies that request fail-closed. The preview shows current origin, loading state, trust state, agent/manual control mode, pending consent, navigation controls, Stop, and Clear Session.

When the user selects manual control, agent actions return `manual_control_active`; the user can interact directly with the isolated page. Closing the preview during manual takeover returns control to Kun and invalidates element refs. Stop aborts pending bridge calls and consent. Clear Session destroys the temporary partition/session.

The normal preview is a bottom-right landscape picture-in-picture surface rather than a tall side panel. The live webpage occupies almost all of the surface. Close and manual takeover live in a narrow Renderer-owned control rail outside the native page bounds so they remain visible and clickable above Electron's `WebContentsView`; secondary safety actions may be revealed on hover or keyboard focus without permanently covering the page. Origin, status, errors, and protected approval details appear only when they require attention. The preview keeps a responsive 16:9-class footprint, stays within the workbench viewport, and falls back to the compact running indicator when space is insufficient.

The floating surface is a React overlay inside the existing main window, not an always-on-top operating-system window. The implementation therefore uses the same Electron `WebContentsView` and renderer layout path on macOS, Windows, and Linux without platform-specific focus or transparent-window behavior.

### 9. Browser audit data is redacted and bounded

Main records append-only Browser Use audit entries for session lifecycle, origin grants, blocked destinations, prepared actions, consent decisions, execution outcomes, aborts, and crashes. Records include thread/session/tab IDs, sanitized origin/path, action/risk, decision, bounded target label, timestamps, and error code. They exclude complete page content, HTML, screenshot bytes, query/fragment, form values, Cookies, storage, headers, tokens, credentials, and absolute paths.

Tool results expose enough typed metadata for Kun history and GUI explanation without carrying host credentials or reusable consent material. Browser audit storage follows the current runtime data-directory ownership and retention conventions.

### 10. Runtime limits and availability are host-owned

Settings expose only safe product controls: enable/disable, `auto-safe` versus `always-ask`, public versus explicit local-development mode, maximum tabs/actions, snapshot caps, screenshot dimension, and idle timeout. The preview starts hidden and is reopened from live session state rather than a persistent OS-window preference. Bridge URL/token, partitions, consent state, and allowlists are not editable user settings.

The runtime manifest reports Browser Use as disabled, available, unavailable, or interaction-required with a bounded reason. Text-only models can use structured snapshots. Browser Use is not advertised when Electron/Main supervision is unavailable, for delegated child runs, or for callers without an interactive GUI surface.

## Risks / Trade-offs

- [Automatic interaction can create unintended page effects] → Limit automation to policy-vetted public origins and low-risk live targets; keep sensitive/transaction targets blocked, preserve immediate revalidation, bounded budgets, an observable running indicator and optional preview, manual takeover, Stop, and an `always-ask` option.
- [Accessibility text can contain prompt injection] → Treat it as untrusted structured data, remove hidden/offscreen content, expose no ambient secrets, enforce origin and action gates below the model, and never rely on prompt wording as the sole defense.
- [Chromium pages may perform activity during load] → Use empty temporary profiles, exact origins, public-network filtering, denied permissions/downloads, no persistent authentication, bounded background execution, a live running indicator, and Stop/Clear controls.
- [A browser or Electron vulnerability remains possible] → Retain Chromium sandbox/web security, keep Electron current, disable high-risk APIs, isolate partitions, and never claim mathematical zero risk.
- [A loopback bridge token could leak through logs or process inspection] → Generate per-launch entropy, pass only through the managed child environment, redact it everywhere, use narrow endpoints, and rotate on restart.
- [A custom network proxy may break sites] → Fail closed with actionable diagnostics; test HTTP CONNECT, WebSocket, redirect, IPv4/IPv6, proxy failure, and common CDN flows before enabling by default.
- [DOM mutation makes element refs frequently stale] → Return structured stale-reference outcomes and let the agent take a new snapshot; never fall back to coordinates or selectors silently.
- [Cross-platform floating windows can steal focus or behave differently] → Use an in-app renderer overlay backed by the host-owned `WebContentsView`, and avoid platform-specific always-on-top/transparent BrowserWindow behavior.
- [The existing developer Browser tab is renderer-owned] → Preserve manual Dev Preview behavior and never treat the developer preview Webview as an automatable target.

## Migration Plan

1. Add contracts, settings defaults, and the Browser Use manifest entry without exposing host authority.
2. Add Main browser/network/bridge infrastructure and complete security tests.
3. Add the Kun provider, runtime wiring, tool-result projection, Browser consent flow, and primary-agent-only enforcement.
4. Add the default-hidden floating Browser preview, running indicator, mount/state/consent IPC, localization, manual takeover, stop, and clear controls.
5. Enable temporary anonymous Browser Use by default in `auto-safe` public mode, while preserving an off switch and `always-ask`.
6. Run typecheck, unit/integration suites, Kun build, desktop build, packaged smoke, and the security regression matrix.

Rollback consists of disabling `browserUse.enabled`, omitting the provider from the runtime registry, stopping the Main bridge, and disposing every Browser Use view/session. Existing settings normalization adds the enabled `auto-safe` default only when Browser Use settings are absent; no durable browser profile or user data migration is required.

## Open Questions

- Persistent origin-bound login profiles, secret-vault insertion, uploads/downloads, scheduled/headless browsing, and isolated read-only subagent sessions require separate future proposals.
- Platform packaging smoke tests will determine whether proxy integration needs platform-specific socket handling; direct network fallback remains forbidden regardless of platform.
