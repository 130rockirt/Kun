## Why

Telegram Bot traffic currently relies only on Electron's system network configuration. Users on networks where `api.telegram.org` is blocked, or where the desktop process does not inherit a usable system proxy, cannot verify or run a Telegram connection even though they have an HTTP or SOCKS proxy available.

## What Changes

- Add an optional, per-Telegram-connection proxy toggle and URL to the Connect phone settings.
- Validate supported HTTP, HTTPS, SOCKS, SOCKS4, and SOCKS5 proxy URLs before verifying and saving a Telegram bot.
- Route bot-token verification, long polling, outbound messages, inbound file downloads, and outbound file uploads through the configured proxy.
- Keep existing behavior for disabled or absent Telegram proxy settings by continuing to use Electron's network stack and system proxy.
- Restart only the affected Telegram channel when its proxy configuration changes and preserve compatibility with existing saved credentials.

## Capabilities

### New Capabilities

- `telegram-proxy-routing`: Configure, validate, persist, and consistently apply an optional proxy to a Telegram Bot connection.

### Modified Capabilities

None.

## Impact

- Shared settings and renderer/main IPC contracts for Telegram credentials and token verification.
- Connect phone settings UI and localized user guidance.
- Electron main-process Telegram transport and shared proxy-aware HTTP helper.
- Settings normalization/schema coverage, Telegram runtime tests, IPC tests, and renderer tests.
- No new runtime, daemon, external service, or package dependency is introduced; the existing `proxy-agent` dependency is reused.
