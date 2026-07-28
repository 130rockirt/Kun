## Why

Kun's desktop GUI can now show configured providers' account balances and rate-limit windows, but the standalone TUI can only show per-thread token usage. Terminal users need the same read-only provider quota visibility without opening the desktop application or confusing account allowance with conversation usage.

## What Changes

- Add a sanitized Kun runtime contract and authenticated HTTP endpoint for configured provider quota snapshots.
- Reuse the existing canonical provider configuration and credential sources; keep API keys, OAuth tokens, cookies, and raw upstream payloads out of TUI responses.
- Add a terminal-native Provider quota route opened by `/quota`, with `/provider usage` as a compatibility shortcut.
- Render provider status, balances, usage bars, reset times, missing-login guidance, errors, and unsupported states with wide, compact, and narrow layouts.
- Support keyboard scrolling, manual refresh, loading, empty, and partial-failure states while preserving `/context` as thread token usage.

## Capabilities

### New Capabilities

- `provider-quota-tui`: Read-only provider quota retrieval through the shared Kun runtime and terminal-native quota inspection in the TUI.

### Modified Capabilities

None.

## Impact

- Adds quota DTOs under `kun/src/contracts`, a provider-quota service/adapter boundary, and an authenticated `GET /v1/provider-quotas` route.
- Extends `KunTuiClient`, TUI commands, application routing, keyboard handling, and terminal rendering.
- Reuses existing model connection configuration and official-client login state without adding an interactive OAuth flow or another runtime.
- Adds focused provider service, route, client, command, and TUI rendering tests; no new runtime dependency is expected.
