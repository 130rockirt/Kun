## ADDED Requirements

### Requirement: Tray click opens provider quota
The application SHALL toggle an anchored provider-quota popover when the user normally clicks the enabled Kun tray icon.

#### Scenario: Open quota popover
- **WHEN** the user left-clicks the tray icon while the popover is hidden
- **THEN** the application shows the provider-quota popover anchored to that tray icon

#### Scenario: Toggle quota popover closed
- **WHEN** the user left-clicks the tray icon while the popover is visible
- **THEN** the application hides the popover

#### Scenario: Retain native tray actions
- **WHEN** the user right-clicks the tray icon
- **THEN** the application hides the quota popover and opens the existing native session and application menu

### Requirement: Popover remains on screen
The application SHALL position the provider-quota popover inside the work area of the display containing the tray icon.

#### Scenario: Space is available below
- **WHEN** the tray icon has enough work-area space below it for the popover
- **THEN** the popover is centered under the tray icon and clamped within the display work area

#### Scenario: Space is available only above
- **WHEN** the tray icon does not have enough work-area space below it
- **THEN** the popover is placed above the tray icon and clamped within the display work area

#### Scenario: Windows notification area is on a secondary display
- **WHEN** the Windows tray icon is on a display with a positive or negative desktop origin
- **THEN** the application resolves that display from the tray rectangle and places the popover above the taskbar inside its work area

#### Scenario: Tray bounds are temporarily empty
- **WHEN** Electron reports a zero-sized tray rectangle after a tray click
- **THEN** the application uses a small pointer-centered rectangle as the anchor and still clamps the popover to the selected display

### Requirement: Provider switcher exposes configured providers
The popover SHALL provide an overview and a selectable item for every configured provider returned by the quota service.

#### Scenario: Select a provider
- **WHEN** the user selects a provider item
- **THEN** the detail region displays that provider's status, summary, source, metrics, and dashboard action

#### Scenario: Inspect overview
- **WHEN** the user selects Overview
- **THEN** the popover displays a compact status and quota summary for every returned provider without inventing an aggregate allowance

#### Scenario: Many providers
- **WHEN** provider items do not fit on one row
- **THEN** the switcher wraps while the quota detail region remains independently scrollable

### Requirement: Popover renders normalized quota states
The popover SHALL render balances, rate limits, reset times, and explicit non-available states from the existing normalized provider-quota result.

#### Scenario: Percentage metric
- **WHEN** a metric includes `usedPercent`
- **THEN** the popover displays a bounded progress bar, percentage, and any returned reset time

#### Scenario: Monetary or count metric
- **WHEN** a metric includes remaining, used, or limit values
- **THEN** the popover displays those values with their returned unit

#### Scenario: Provider cannot return quota
- **WHEN** a provider status is unsupported, missing credentials, or error
- **THEN** the popover keeps the provider selectable and displays the corresponding actionable state

### Requirement: Refresh preserves useful state
The popover SHALL refresh when first mounted, whenever it is shown again, and when the user requests a manual refresh.

#### Scenario: Successful refresh
- **WHEN** a quota refresh succeeds
- **THEN** the popover replaces its snapshot and updates its refresh time

#### Scenario: Refresh fails after data exists
- **WHEN** a refresh fails after a snapshot has been displayed
- **THEN** the popover retains the prior snapshot and shows an inline refresh error

### Requirement: Popover actions remain accessible
The popover SHALL expose refresh, New Chat, Open Kun, provider dashboard, and close interactions.

#### Scenario: Open a new chat
- **WHEN** the user activates New Chat
- **THEN** the application hides the popover, reveals Kun, and dispatches the existing new-chat tray action

#### Scenario: Open Kun
- **WHEN** the user activates Open Kun
- **THEN** the application hides the popover and reveals the main window

#### Scenario: Close with keyboard or blur
- **WHEN** the user presses Escape or focus leaves the popover
- **THEN** the popover hides without discarding its selected provider

### Requirement: Popover uses a constrained security boundary
The tray renderer SHALL receive only quota and tray-popover capabilities through a dedicated preload bridge.

#### Scenario: Invoke quota operation
- **WHEN** the trusted tray renderer requests provider quota
- **THEN** main returns the normalized quota result without exposing provider credentials or raw upstream responses

#### Scenario: Reject another renderer
- **WHEN** a renderer other than the tray popover main frame invokes a tray-only IPC handler
- **THEN** main rejects the request

#### Scenario: Block renderer navigation
- **WHEN** tray content attempts to open a new window or navigate away from its bundled entry
- **THEN** Electron denies that navigation

### Requirement: Windows presentation remains usable
The popover SHALL remain visually clear on Windows without requiring macOS-style compositor blur.

#### Scenario: Standard Windows presentation
- **WHEN** the tray renderer reports the Windows platform
- **THEN** the shell uses a solid Fluent-style surface, Windows-appropriate radius and shadow, and the same independently scrollable content layout

#### Scenario: Windows forced-colors presentation
- **WHEN** the operating system activates forced-colors mode
- **THEN** the popover uses system colors and visible control outlines without relying on gradients, transparency, or status color alone

### Requirement: Configured subscription providers use supported read-only quota sources
The quota service SHALL recognize configured ChatGPT/Codex, Kimi Code, Grok, and OpenCode Go subscription presets and query their supported read-only sources with existing provider or local CLI state.

#### Scenario: ChatGPT preset omits HTTP kind
- **WHEN** a configured ChatGPT/Codex preset has no explicit provider `kind`
- **THEN** the service still recognizes it and requests the Codex usage endpoint

#### Scenario: Kimi Code has an API key
- **WHEN** a configured Kimi Code provider has an API key
- **THEN** the service requests the official Kimi Code usages endpoint and returns its weekly and five-hour limits

#### Scenario: Grok has existing OAuth state
- **WHEN** a configured Grok subscription has an existing Kun or Grok CLI OAuth bearer
- **THEN** the service requests the fixed grok.com billing gRPC-web endpoint without exposing the credential

#### Scenario: Grok billing rejects bearer-only access
- **WHEN** grok.com requires a browser session that is not available to Kun
- **THEN** the service reports an actionable provider authentication error instead of marking Grok unsupported

#### Scenario: OpenCode Go has local usage history
- **WHEN** the OpenCode database contains assistant cost rows for the `opencode-go` provider
- **THEN** the service returns locally estimated 5-hour, weekly, and monthly usage windows and labels their local source

#### Scenario: OpenCode Go has no local usage history
- **WHEN** the OpenCode database is missing or has no `opencode-go` usage rows
- **THEN** the service reports that OpenCode Go must be used locally first instead of marking the provider unsupported
