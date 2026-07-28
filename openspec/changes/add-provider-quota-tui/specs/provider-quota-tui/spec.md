## ADDED Requirements

### Requirement: Runtime returns sanitized provider quota snapshots
The Kun runtime SHALL expose an authenticated read-only provider quota operation that lists every configured model connection with normalized quota metrics and a per-provider status.

#### Scenario: Mixed provider results
- **WHEN** configured providers include successful, unsupported, missing-login, and failing quota probes
- **THEN** the response contains one isolated entry for every provider and successful entries remain available

#### Scenario: Unauthorized request
- **WHEN** a client requests provider quotas without valid runtime authorization
- **THEN** the runtime rejects the request without starting provider probes

### Requirement: Quota probes use canonical identities and endpoints
The runtime SHALL classify supported quota probes using stable provider or preset identity, expected transport kind, and exact recognized API hostnames, and SHALL call only canonical read-only provider endpoints.

#### Scenario: Recognized API-key provider
- **WHEN** a configured API-key connection has an exact supported hostname and a protected credential
- **THEN** the runtime calls the fixed balance or quota endpoint for that provider and normalizes the response

#### Scenario: Recognized subscription provider
- **WHEN** a configured Claude, ChatGPT/Codex, Cursor, Antigravity, or Gemini CLI subscription has usable existing login state
- **THEN** the runtime calls the corresponding fixed subscription usage endpoint and returns normalized allowance windows

#### Scenario: Custom provider hostname
- **WHEN** a custom connection uses an unrecognized hostname
- **THEN** it is returned as unsupported and no quota URL is derived from its Base URL

### Requirement: Provider credentials stay server-side
The quota service MUST keep API keys, OAuth tokens, cookies, official-client credentials, and raw upstream response bodies inside the Kun process.

#### Scenario: Successful quota response
- **WHEN** a provider quota probe succeeds
- **THEN** the client response contains only normalized display fields and no credential material

#### Scenario: Provider rejection
- **WHEN** a provider rejects or cannot parse a quota request
- **THEN** the entry contains a bounded sanitized message without raw response content or credential values

### Requirement: TUI opens a dedicated provider quota route
The TUI SHALL expose a terminal-native Provider quota page through `/quota`, the command palette, and the `/provider usage` compatibility shortcut while preserving `/context` for thread token usage.

#### Scenario: Open quota page
- **WHEN** the user runs `/quota`
- **THEN** the TUI immediately opens the Provider quota route, loads the runtime snapshot, and renders provider status and metrics

#### Scenario: Provider usage shortcut
- **WHEN** the user runs `/provider usage`
- **THEN** the TUI opens Provider quota instead of the connection editor

#### Scenario: Bare provider command
- **WHEN** the user runs `/provider`
- **THEN** the existing model connection route still opens

### Requirement: TUI presents quota states and refresh
The Provider quota route SHALL render monetary balances, percentage windows, reset times, summaries, missing credentials, unsupported providers, errors, loading, empty results, and a manual refresh action.

#### Scenario: Refresh succeeds
- **WHEN** the user presses `r` on the Provider quota route
- **THEN** the TUI requests a fresh snapshot and replaces the displayed entries without closing the route

#### Scenario: Refresh fails
- **WHEN** the quota list request itself fails
- **THEN** the TUI keeps the route usable and shows a sanitized request error

### Requirement: TUI quota results remain navigable
The Provider quota route SHALL adapt to wide, compact, and narrow terminal widths and SHALL support bounded vertical navigation when the rendered result exceeds available terminal rows.

#### Scenario: Long provider list
- **WHEN** provider metrics exceed the available terminal height
- **THEN** Up/Down, PageUp/PageDown, Home/End, and `j`/`k` navigate to the final rendered line and the page shows its current range

#### Scenario: Narrow terminal
- **WHEN** terminal width cannot fit label, bar, value, and reset time on one row
- **THEN** the TUI prioritizes provider identity and quota values and moves secondary information to indented lines without horizontal overflow
