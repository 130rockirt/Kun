## ADDED Requirements

### Requirement: Configured providers are represented
The provider quota surface SHALL represent every configured model provider exactly once, including providers whose quota cannot be queried.

#### Scenario: Mixed supported and unsupported providers
- **WHEN** the user has both recognized and unrecognized model providers configured
- **THEN** the quota result contains one entry for each provider and marks the unrecognized entries as unsupported

#### Scenario: Multiple accounts of one preset
- **WHEN** multiple configured provider profiles share the same preset identity
- **THEN** the quota result keeps them as separate entries using their configured provider IDs and names

### Requirement: Recognized quota APIs are queried securely
The system SHALL query recognized provider balance or quota APIs from the Electron main process using the configured credential without returning that credential or a raw upstream response to the renderer.

#### Scenario: Supported provider with credentials
- **WHEN** a configured provider matches a supported probe and has a non-empty credential
- **THEN** the main process calls the canonical read-only quota endpoint and returns only normalized quota fields

#### Scenario: Supported provider without credentials
- **WHEN** a configured provider matches a supported probe but has no usable credential
- **THEN** the provider is returned with a missing-credentials status and no network request is made

#### Scenario: Custom unrecognized endpoint
- **WHEN** a custom provider uses a hostname not recognized by the quota registry
- **THEN** the provider is marked unsupported and the system does not derive or request a quota URL from that custom base URL

#### Scenario: Configured subscription provider
- **WHEN** a configured Claude, ChatGPT/Codex, Cursor, Antigravity, or Gemini CLI subscription profile has usable existing login state
- **THEN** the main process calls only that provider's canonical read-only quota endpoint and returns normalized subscription windows

#### Scenario: Subscription provider without local login
- **WHEN** a recognized subscription profile has no usable protected or official-client login state
- **THEN** the provider is returned with a missing-credentials status without launching an interactive login

### Requirement: Quota results are normalized
The system SHALL normalize provider-specific balance and quota payloads into provider entries containing zero or more display metrics with units, ratios, remaining values, and reset times when supplied.

#### Scenario: Monetary balance
- **WHEN** a provider returns total, used, and remaining currency values
- **THEN** the normalized metric preserves the currency unit and exposes a bounded usage percentage

#### Scenario: Subscription window
- **WHEN** a provider returns a count or token allowance with a reset timestamp
- **THEN** the normalized metric exposes used, limit, remaining, percentage, and reset time

#### Scenario: Partial provider response
- **WHEN** a valid provider response omits an optional total, reset time, or secondary quota
- **THEN** the available fields are returned without inventing missing values

### Requirement: Provider failures are isolated
The quota list operation SHALL bound network work and return a per-provider error without failing other provider entries.

#### Scenario: One provider times out
- **WHEN** one provider quota request exceeds its timeout while another succeeds
- **THEN** the timed-out provider is marked error and the successful provider remains available

#### Scenario: Oversized or malformed response
- **WHEN** a provider returns an oversized or malformed payload
- **THEN** that provider is marked error with a sanitized message and no raw response body

#### Scenario: Configured network proxy
- **WHEN** model requests are configured to use a network proxy
- **THEN** supported quota requests use the same resolved proxy setting

### Requirement: Workbench quota entry point
The Code workbench SHALL expose a Quota button in the far-right rail that opens the provider quota surface in the existing tabbed right workspace.

#### Scenario: Open quota panel
- **WHEN** the user activates the Quota rail button
- **THEN** a quota tab opens or becomes active and the right workspace expands

#### Scenario: Restore saved quota tab
- **WHEN** a workspace previously saved the quota tab in its right-tab state
- **THEN** the tab state recognizes and restores the built-in quota contribution

### Requirement: Quota panel communicates freshness and availability
The quota panel SHALL show loading, manual refresh, provider status, available metrics, and updated timestamps without equating local token usage to upstream account quota.

#### Scenario: Initial load
- **WHEN** the quota panel mounts for the first time
- **THEN** it requests the current provider quota list and displays a loading state until the request settles

#### Scenario: Manual refresh
- **WHEN** the user activates Refresh after an earlier result
- **THEN** the panel keeps its provider context, requests a new snapshot, and updates the displayed refresh time

#### Scenario: No configured providers
- **WHEN** the quota service returns no configured providers
- **THEN** the panel shows a dedicated empty state

#### Scenario: Unsupported provider
- **WHEN** a provider entry is unsupported
- **THEN** the panel still shows that provider with an explanation that its quota API is not available in this phase

### Requirement: Long quota lists remain scrollable
The quota surface SHALL own vertical overflow inside the fixed right workspace and SHALL support mouse-wheel, trackpad, touch, and scrollbar navigation.

#### Scenario: Provider cards exceed panel height
- **WHEN** the rendered provider cards are taller than the available right-panel body
- **THEN** the header remains visible and the body can scroll independently to the final provider card

#### Scenario: Wheel input over quota cards
- **WHEN** the user scrolls over a provider card
- **THEN** the quota body consumes the vertical scroll without a parent workbench gesture preventing movement
