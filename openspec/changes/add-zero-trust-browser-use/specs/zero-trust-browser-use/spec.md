## ADDED Requirements

### Requirement: Browser Use remains inside the single Kun runtime
Kun SHALL expose Browser Use through the existing `kun serve` AgentLoop and SHALL NOT start a second agent runtime, model loop, approval system, thread store, or usage ledger. The model-visible catalog SHALL contain one stable first-party `browser_use` action tool rather than a dynamically expanding browser tool set.

#### Scenario: Primary agent discovers Browser Use
- **WHEN** Browser Use is enabled, the host bridge is available, and a GUI-supervised primary turn builds its tool catalog
- **THEN** Kun SHALL advertise one `browser_use` tool with the canonical action schema

#### Scenario: Delegated or headless caller requests Browser Use
- **WHEN** a delegated child, schedule, workflow, IM, CLI-only, or other unsupervised caller attempts to use Browser Use
- **THEN** Kun SHALL omit the tool or return a structured interaction-required/unavailable result without launching or controlling a page

### Requirement: Browser sessions are temporary, isolated, background-capable, and thread-bound
The Electron Main process MUST create Browser Use pages only in dedicated sandboxed `WebContentsView` instances using unguessable temporary partitions. Browser Use MUST NOT attach to or share storage with the Kun renderer, developer preview, Extension views, Computer Use, another Browser Use thread, or a user's external browser profile.

#### Scenario: Model opens a Browser Use session
- **WHEN** an eligible primary turn opens an authorized origin
- **THEN** Main SHALL create at most one temporary Browser Use session for that thread and load it in a fixed-size hidden background viewport
- **AND** it SHALL NOT open, focus, or resize an operating-system window

#### Scenario: Session owner changes or exits
- **WHEN** the session is closed, cleared, stopped, invalidated, idle-expired, crashed, its thread is removed, its window is destroyed, the runtime stops, or the app exits
- **THEN** Main SHALL cancel pending work, destroy every owned WebContents and temporary partition, revoke refs and grants, and publish a terminal redacted state

#### Scenario: Browser target identity is forged
- **WHEN** a request names another thread, another session, a developer preview Webview, an Extension WebContents, or the main renderer
- **THEN** Main SHALL reject the request without exposing or controlling the target

### Requirement: Browser WebContents use a mandatory sandbox baseline
Every Browser Use WebContents MUST disable Node integration in every frame and worker, enable context isolation and Chromium sandboxing, enable web security, disable insecure mixed content, omit preload and Webview capabilities, disable unsafe dialogs and drag navigation, deny site/device permissions, and block downloads by default. Page content SHALL receive no Electron, IPC, Kun bridge, runtime token, filesystem, or host object.

#### Scenario: Page requests a protected browser capability
- **WHEN** a Browser Use page requests camera, microphone, geolocation, notifications, MIDI, USB, Bluetooth, clipboard, filesystem, download, popup, or another protected capability
- **THEN** the Browser host SHALL deny it unless a future explicitly specified capability replaces the first-release prohibition

### Requirement: Browser networking is public-only and fail-closed
All Browser Use traffic MUST traverse a host-owned network policy with no direct fallback. The policy SHALL allow only validated HTTP, HTTPS, WS, and WSS traffic, resolve and pin destinations, reject any hostname or IP result that is non-public, and revalidate every connection and redirect. It MUST reject loopback, private, link-local, ULA, multicast, unspecified, metadata, IPv4-mapped private addresses, local files, JavaScript URLs, DevTools, Kun protocols, and unsupported schemes.

#### Scenario: Public destination resolves only to public addresses
- **WHEN** an authorized HTTPS destination and all of its resolved addresses pass the public-network policy
- **THEN** the proxy MAY connect to a pinned vetted address while preserving end-to-end TLS

#### Scenario: Destination resolves to a private or mixed address set
- **WHEN** any DNS answer or normalized IP literal is loopback, private, link-local, ULA, multicast, unspecified, metadata, or otherwise non-public
- **THEN** the proxy SHALL reject the destination before connection and record a redacted policy denial

#### Scenario: Proxy is unavailable
- **WHEN** the policy proxy fails, stops, or cannot validate a destination
- **THEN** Browser Use SHALL fail closed and SHALL NOT retry through a direct network path

#### Scenario: Public page targets local development
- **WHEN** a public session navigates, redirects, opens a popup, fetches, or connects to localhost or a private destination
- **THEN** the Browser host SHALL block the request without offering an in-session bypass

### Requirement: Local development browsing is separately authorized
Kun SHALL support localhost Browser Use only through an explicit local-development mode that grants one exact loopback origin selected by the user. A local-development session MUST be temporary and MUST NOT mix public and local origins, reuse a public session, or be entered by a public redirect.

#### Scenario: User grants an exact development origin
- **WHEN** the user explicitly grants `http://127.0.0.1:<port>` or `http://localhost:<port>` in local-development mode
- **THEN** the host SHALL restrict that temporary session to the normalized exact scheme, host, and port

#### Scenario: Local session navigates to the public internet
- **WHEN** a local-development Browser Use session attempts a public-origin navigation
- **THEN** Main SHALL block it and require a separate public session

### Requirement: Origin authority follows network and approval mode
The Browser host MUST require a current-session grant for the exact normalized top-level origin before loading it. In default `auto-safe` public mode, Main SHALL automatically add that session-only grant only after fail-closed public-network validation succeeds. Local-development origins and each new origin in `always-ask` mode MUST obtain a protected user decision. Grants SHALL remain temporary, non-wildcard, non-transferable, and bound to one Browser Use session.

#### Scenario: Policy-vetted public origin is not granted
- **WHEN** `browser_use.open` targets a public origin absent from session grants in `auto-safe` mode
- **THEN** the host SHALL independently validate it, automatically add a session-only grant, and load it without an approval prompt

#### Scenario: Redirect leaves an authorized public origin
- **WHEN** a top-level redirect changes scheme, hostname, or port in `auto-safe` public mode
- **THEN** the host SHALL pause the original navigation and independently validate the new origin before any automatic grant

#### Scenario: Local or strict origin request has no protected GUI
- **WHEN** local-development or `always-ask` origin approval is required without an authenticated visible Renderer
- **THEN** the host SHALL return `interaction_required` and SHALL NOT synthesize consent

#### Scenario: Public auto-safe origin has no visible preview
- **WHEN** a public origin passes network policy in `auto-safe` mode while the floating preview is hidden
- **THEN** the host SHALL grant and load it in the background without waiting for a renderer mount

### Requirement: Browser observation is structured, bounded, and untrusted
`browser_use.snapshot` SHALL return a bounded structured projection of visible or near-viewport page accessibility and interaction state. The result MUST carry `untrustedContent: true`, sanitized page identity, document generation, truncation metadata, and opaque element references. It MUST exclude complete HTML, scripts, styles, hidden or unbounded content, unsafe attributes, and sensitive field values.

#### Scenario: Page contains visible interactive elements
- **WHEN** the agent requests a snapshot of an authorized background or mounted page
- **THEN** Main SHALL return bounded role, name, state, geometry, and opaque refs for eligible visible elements

#### Scenario: Page hides instructions from the user
- **WHEN** content is hidden, offscreen beyond the configured observation margin, non-rendered, script/style content, or available only through unsafe attributes
- **THEN** the snapshot SHALL exclude it from model-visible page state

#### Scenario: Page contains a sensitive field
- **WHEN** the page contains password, payment, OTP, file, hidden, or another host-classified sensitive field
- **THEN** the snapshot SHALL identify only the bounded field role/state needed for manual handling and SHALL NOT expose its value

#### Scenario: Snapshot exceeds a configured cap
- **WHEN** eligible nodes or text exceed the snapshot limits
- **THEN** Main SHALL truncate deterministically, report truncation, and SHALL NOT emit an unbounded tool result

### Requirement: Element references are opaque and stale-safe
Every model-visible element reference MUST bind the Browser session, tab, document generation, backend node identity, and host-computed target fingerprint. The model SHALL NOT supply a selector, XPath, script, coordinate, or raw backend node as a substitute. Navigation, control handoff, or relevant DOM mutation SHALL invalidate affected refs.

#### Scenario: Agent uses a current ref
- **WHEN** a ref matches the current session, tab, origin, document generation, node, visibility, and fingerprint
- **THEN** Main MAY prepare the corresponding fixed action

#### Scenario: Agent reuses a stale or foreign ref
- **WHEN** a ref belongs to another session/tab/document, expired after mutation/navigation, or no longer matches the live target
- **THEN** Main SHALL return a structured stale-reference denial and SHALL NOT fall back to coordinates or selectors

### Requirement: Browser actions use host-owned conditional approval
Observation actions and scrolling MAY execute inside a granted origin. In default `auto-safe` public mode, `click`, `type`, `select`, and `press` MAY execute automatically only for a live-validated low-risk, non-sensitive target. Local-development and `always-ask` modes MUST obtain protected target-specific allow-once consent. Approval mode SHALL remain independent from runtime `approvalPolicy`, Skills, MCP trust, profile policy, and model output. No permanent or wildcard action grant SHALL be available.

#### Scenario: Safe public action is automatic
- **WHEN** `approvalMode` is `auto-safe` and the agent requests a low-risk action against a current non-sensitive target on a policy-vetted public page
- **THEN** Main SHALL execute it without a prompt only after immediate prepared-target revalidation

#### Scenario: Strict-mode user denies an action
- **WHEN** the user denies or closes the Browser consent prompt
- **THEN** the prepared action SHALL be revoked and the page SHALL remain unmodified by that action

#### Scenario: Approval-required action has no authenticated Renderer
- **WHEN** a local or `always-ask` interaction is requested without the protected Renderer surface
- **THEN** the action SHALL return `interaction_required` and SHALL NOT execute

#### Scenario: Safe public action has no visible preview
- **WHEN** a low-risk public action passes live validation in `auto-safe` mode while the preview is hidden
- **THEN** Main SHALL execute it in the background without requesting a preview mount

### Requirement: Consent previews are live and target-specific
Before requesting action consent, Main MUST prepare the action against the live page and provide the user with the sanitized origin, page title, action type, target role/name, risk classification, relevant bounded text, and a highlighted target preview. Automatic actions MUST use the same opaque, single-use, short-lived prepared-action validation but SHALL NOT create a pending consent request.

#### Scenario: User reviews a click
- **WHEN** a click reaches the Browser consent surface
- **THEN** the prompt SHALL identify and visually highlight the live target and offer only deny or allow-once

#### Scenario: Target changes while consent is pending
- **WHEN** document generation, origin, node identity, fingerprint, visibility, enabled state, geometry, or hit target changes before execution
- **THEN** Main SHALL expire the consent and require a new snapshot and decision

#### Scenario: Prepared action is replayed
- **WHEN** an already used, expired, foreign, or malformed prepared-action ID is submitted
- **THEN** Main SHALL reject it without executing a browser action

### Requirement: Sensitive and ambient host capabilities are forbidden
The first Browser Use release MUST reject credential entry, password-manager access, payment data, OTP/MFA/CAPTCHA automation, file upload, download, clipboard access, Cookie/storage export, arbitrary headers, local files, arbitrary JavaScript, raw selectors, Playwright code, raw CDP, browser extensions, and system permission escalation. The user MAY perform allowed manual page interaction inside the isolated visible Browser surface, but the agent SHALL not observe protected values.

#### Scenario: Agent targets a password or payment field
- **WHEN** the agent requests type, select, press, or extraction against a sensitive field
- **THEN** Main SHALL return `manual_interaction_required` without showing the protected value to the model

#### Scenario: Agent attempts executable browser input
- **WHEN** tool arguments contain JavaScript, selector, XPath, Playwright code, CDP method, Cookie/storage data, header injection, or a filesystem path
- **THEN** strict schema validation SHALL reject the request before it reaches WebContents

#### Scenario: Page initiates a download
- **WHEN** an authorized page attempts any download
- **THEN** the Browser session SHALL cancel it and report a bounded denial

### Requirement: Manual takeover is explicit and revokes agent refs
The Browser panel SHALL let the user take manual control, return control to Kun, stop the current browser operation, and clear the session. Agent actions MUST NOT execute while manual control is active. Returning control SHALL invalidate prior refs and require a fresh snapshot.

#### Scenario: User takes manual control
- **WHEN** the user activates manual control
- **THEN** pending agent interactions SHALL be cancelled or denied and subsequent agent actions SHALL return `manual_control_active`

#### Scenario: User returns control
- **WHEN** the user returns control to Kun
- **THEN** Main SHALL advance the page generation, invalidate old refs, and require a new snapshot before interaction

#### Scenario: User clears the session
- **WHEN** the user selects Clear Session
- **THEN** Main SHALL destroy tabs, revoke origins and prepared actions, remove temporary storage, and publish the closed state

### Requirement: Browser Use has hard resource and runaway limits
The host MUST bound sessions, tabs, observation actions, interaction actions, waits, snapshots, screenshots, bridge requests, pending consent, idle time, and retained history. Limits SHALL be enforced independently of model instructions and SHALL not reset silently during an active turn.

#### Scenario: Turn exhausts an action budget
- **WHEN** a turn reaches its configured observation or interaction limit
- **THEN** `browser_use` SHALL return `action_budget_exhausted` and SHALL NOT execute another action

#### Scenario: Session reaches the tab limit
- **WHEN** a page attempts to create a tab beyond the configured cap
- **THEN** Main SHALL deny the popup/tab and retain the existing bounded set

#### Scenario: Turn or session is aborted
- **WHEN** the user interrupts the turn, stops Browser Use, or the idle deadline expires
- **THEN** pending waits, network work, prepared actions, and consent SHALL be cancelled promptly

### Requirement: Browser Use state has a background indicator and floating preview
The workbench SHALL expose a non-blocking Browser Use running indicator and a default-hidden bottom-right landscape picture-in-picture preview. In its normal state, the live webpage SHALL occupy the dominant visual area and the Renderer SHALL keep close and manual-takeover controls in a protected compact rail outside the native page bounds. Sanitized origin/title, loading/error/trust state, navigation state, Stop, Clear Session, and pending consent SHALL remain available but SHALL expand or appear only when relevant instead of permanently reducing the page to a tall toolbar-heavy panel. The host-owned Browser Use view SHALL remain separate from the renderer-owned developer preview.

#### Scenario: Agent creates a background session for the active thread
- **WHEN** Main publishes an active Browser Use session that does not require approval
- **THEN** the Renderer SHALL show the running indicator without opening the preview or changing the active right-panel tab

#### Scenario: User opens and closes the floating preview
- **WHEN** the user selects the running indicator and later closes the preview
- **THEN** the Renderer SHALL mount and then detach the same host-owned view without destroying the Browser Use session or invalidating current refs

#### Scenario: User watches ordinary automatic browsing
- **WHEN** the preview is open and no approval or error requires detailed UI
- **THEN** the Renderer SHALL present a responsive landscape picture-in-picture surface at the workbench's lower-right edge
- **AND** the live webpage SHALL fill the available page area without permanent navigation, title, budget, or status toolbars
- **AND** close and manual takeover SHALL remain visible and operable without overlapping the native `WebContentsView`

#### Scenario: Approval requires visibility
- **WHEN** Main publishes `mount-required` or a pending origin/action decision
- **THEN** the Renderer SHALL open the matching thread's floating preview and complete the bounds/mount handshake before showing the protected decision controls

#### Scenario: User needs secondary safety controls
- **WHEN** the user hovers or keyboard-focuses the compact control rail, or the session requires attention
- **THEN** Stop and Clear Session SHALL become available without permanently covering the live page

#### Scenario: User closes an approval or manual-control preview
- **WHEN** the user closes the preview while a decision is pending or manual control is active
- **THEN** Main SHALL deny pending consent or return control to Kun before detaching the view

#### Scenario: Renderer attempts to control another thread
- **WHEN** Browser IPC identifies a session not owned by the active authenticated thread/window binding
- **THEN** Main SHALL reject the request

### Requirement: Browser bridge is authenticated, narrow, and launch-scoped
The Main-to-Kun Browser bridge MUST bind only to loopback, use a per-launch high-entropy token delivered to the managed Kun child without persisting it in user settings, validate Host/authentication/content type/size and strict schemas, enforce bounded concurrency, and expose only fixed Browser Use operations. It MUST NOT expose generic Electron, WebContents, JavaScript, Playwright, CDP, filesystem, or proxy administration.

#### Scenario: Authenticated managed Kun invokes a fixed operation
- **WHEN** a request presents the current launch token, valid Host, supported endpoint, bounded body, and valid schema
- **THEN** the bridge MAY route it to the matching Browser Use session policy

#### Scenario: Request lacks valid bridge authority
- **WHEN** a request has a wrong/missing token, non-loopback Host, unsupported method/path, oversized body, malformed schema, stale session scope, or excessive concurrency
- **THEN** the bridge SHALL reject it without disclosing session or browser state

#### Scenario: Application restarts
- **WHEN** the GUI restarts and creates a new Browser bridge
- **THEN** all prior launch tokens and scoped browser authorities SHALL be invalid

### Requirement: Browser audit and model history are redacted
Kun and Main SHALL record bounded Browser Use lifecycle, origin-policy, prepared-action, consent, execution, abort, and crash metadata sufficient for explanation and diagnostics. Persisted events, logs, Renderer projections, and model-visible tool results MUST exclude complete HTML/page text beyond bounded snapshots, screenshot bytes unless explicitly returned to the current model call, URL query/fragment, form values, Cookies, storage, headers, runtime/bridge tokens, credentials, consent authority, and absolute paths.

#### Scenario: Browser action completes
- **WHEN** an observation or approved interaction completes
- **THEN** the audit record SHALL include bounded IDs, sanitized origin/path, action/risk, decision/outcome, timestamps, and error code without protected content

#### Scenario: Sensitive data appears in a page or URL
- **WHEN** credentials, tokens, form values, query parameters, fragments, or sensitive field contents are present
- **THEN** logs, audit records, SSE events, Renderer state, and durable history SHALL redact or omit them

### Requirement: Settings and capability status are safe by default
Browser Use settings SHALL default to enabled `auto-safe` public browsing with temporary anonymous sessions. User settings MAY configure enabled state, `auto-safe` versus `always-ask`, public versus explicit local-development mode, hard budgets, snapshot caps, screenshot dimension, and idle timeout, but SHALL NOT configure bridge credentials, partitions, persistent profiles, arbitrary allowlists, unsafe schemes, or raw browser arguments. Runtime capability status SHALL distinguish disabled, available, unavailable, and interaction-required states with bounded reasons.

#### Scenario: Existing settings are normalized
- **WHEN** an installation without Browser Use settings loads or saves settings
- **THEN** normalization SHALL add enabled `auto-safe` defaults without changing Computer Use or developer Browser behavior

#### Scenario: Browser Use is enabled but host supervision is absent
- **WHEN** Kun starts without the authenticated Browser host or interactive GUI
- **THEN** the capability manifest SHALL report Browser Use unavailable or interaction-required and the tool SHALL not advertise

### Requirement: Browser Use ships with security and packaged regression coverage
The repository MUST cover Browser Use contracts, URL/IP normalization, DNS rebinding resistance, proxy fail-closed behavior, exact origins, WebContents hardening, target refs, mutation races, consent bypass attempts, sensitive fields, bridge authentication, sender validation, session cleanup, action limits, event redaction, runtime registration, Renderer supervision, localization, and packaged desktop behavior.

#### Scenario: Repository validation runs
- **WHEN** Browser Use implementation is complete
- **THEN** relevant focused tests, `npm run build:kun`, `npm run typecheck`, `npm run test`, `npm run build`, and security/package smoke checks SHALL pass or any unrelated baseline failure SHALL be explicitly separated with evidence

#### Scenario: Packaged app exercises Browser Use
- **WHEN** the packaged desktop smoke opens a policy-vetted public test origin, mounts the Agent Browser, observes a page, automatically executes a safe target action, verifies a local or `always-ask` approval path, stops, and clears the session
- **THEN** the smoke SHALL prove the packaged app uses only the isolated Browser Use WebContents and leaves no live session or reusable authority

### Requirement: Background preview behavior is cross-platform
Browser Use background execution and the responsive landscape picture-in-picture preview MUST use platform-neutral Electron and Renderer APIs supported by the product's macOS, Windows, and Linux desktop targets. The feature MUST NOT depend on a platform-specific always-on-top, transparent, or focus-stealing operating-system window.

#### Scenario: Preview is shown on a supported desktop platform
- **WHEN** the user opens or closes the Browser Use preview on macOS, Windows, or Linux
- **THEN** the Renderer SHALL toggle an in-app overlay and Main SHALL attach or detach the existing `WebContentsView`
- **AND** the Browser Use page SHALL not take focus unless the user explicitly enters manual control
- **AND** the preview SHALL remain within the workbench viewport and preserve a usable landscape page area across supported window sizes
