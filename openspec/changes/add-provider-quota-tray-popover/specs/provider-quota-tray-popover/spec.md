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
