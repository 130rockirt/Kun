## Context

Configured model providers live in `AppSettingsV1.provider.providers`. Their credentials and provider identities are already available to the Electron main process, while the renderer owns the Code workbench's far-right rail and tabbed right workspace.

CodexBar demonstrates the useful boundary for this feature: a registry selects a provider-specific, read-only probe; each probe calls a balance or quota endpoint; and provider-specific payloads are normalized before UI rendering. Kun must keep its existing single agent runtime and must not reuse `/v1/usage`, because that route reports local model token usage rather than the upstream account's remaining allowance.

The first phase needs to represent all configured providers while only probing providers whose balance/quota contract and credential source are recognized. API-key providers use protected settings credentials. Subscription providers reuse the login already established by Kun, Claude Code, Codex, Cursor.app, Gemini CLI, or Antigravity. The result must not expose API keys, OAuth tokens, cookies, or arbitrary upstream response bodies to the renderer.

## Goals / Non-Goals

**Goals:**

- Show every configured model provider in a dedicated right-workspace tab opened from the far-right rail.
- Fetch recognized account balance or subscription quota through the Electron main process.
- Normalize currencies, count-based quotas, used/limit ratios, and reset timestamps into one stable contract.
- Preserve explicit `available`, `unsupported`, `missing_credentials`, and `error` states per provider.
- Keep requests bounded, proxy-aware, independently failing, and safe to retry manually.
- Make additional provider probes additive through a small registry.
- Keep long provider lists scrollable by making the quota panel body an explicit overflow owner.

**Non-Goals:**

- Estimating account quota from chat token usage or Kun's `/v1/usage` telemetry.
- Adding runtime diagnostics, provider switching, automated purchasing, quota warnings, or background polling.
- Adding new OAuth/login flows, importing arbitrary browser profiles, or launching interactive provider sessions from the quota panel.
- Sending credentials to the renderer or querying user-authored arbitrary quota URLs.
- Guaranteeing quota visibility when a provider does not expose an API compatible with the configured credential.

## Decisions

### Use a main-process probe registry

A new main-process service will accept normalized settings, preserve stable `presetSource.presetId` for display identity, and classify a configured provider for network probing only when its configured Base URL has an exact recognized hostname. Probe definitions own canonical endpoint URLs, request headers, response parsing, and dashboard links.

This follows CodexBar's provider registry while fitting Kun's TypeScript/Electron boundary. A generic "append `/usage` to baseUrl" implementation was rejected because provider contracts differ and it would create unsafe or misleading requests to arbitrary custom endpoints.

The initial registry covers:

- DeepSeek API balance
- OpenRouter credits and optional key budget
- Moonshot CN/global account balance
- Z.ai and BigModel Coding Plan quota limits
- MiniMax global/China token-plan and legacy coding-plan remains
- OpenAI credit-grants balance for an exact `api.openai.com` profile
- Claude subscription OAuth usage from a configured setup token, Claude Code credentials file, or Claude Code Keychain item
- ChatGPT/Codex subscription rate windows from the protected Codex OAuth credential or ambient Codex CLI credential
- Cursor subscription usage from the signed-in Cursor.app state database
- Google Antigravity and Gemini CLI model quota from their existing local OAuth state and the canonical Code Assist quota API

Unrecognized providers remain visible with `unsupported`.

Subscription classification uses the stable preset ID together with its expected provider kind. It does not derive subscription endpoints from a user-authored Base URL. Local credential readers are read-only, bounded, and parse only the expected record or database key.

### Define a provider-neutral shared contract

`src/shared/provider-quota.ts` will define:

- a provider entry with identity, status, source label, dashboard URL, timestamps, and a sanitized message;
- zero or more metrics containing label, unit, used, limit, remaining, percentage, and reset time;
- a list result with a refresh timestamp.

The contract intentionally models both monetary balances and count/time-window quotas. It does not model raw provider payloads.

### Bound and isolate network work

The list service will process configured providers with limited concurrency. Every request uses the existing model-request proxy configuration, an abort timeout, a bounded response body, and canonical HTTPS endpoints. One provider failure produces only that provider's `error` result.

The service will use dependency injection for fetches in unit tests. No live credential probes are part of automated validation.

### Reuse local subscription login state

The subscription probes resolve credentials in the Electron main process:

- Claude accepts the configured `sk-ant-oat` setup token first, then the standard Claude Code credentials file or macOS Keychain record.
- Codex parses Kun's protected `codex-oauth` JSON first, then the standard `~/.codex/auth.json` token record.
- Cursor reads only `cursorAuth/accessToken` from Cursor.app's local state database, validates its JWT subject/expiry, and derives the first-party session cookie used by Cursor's read-only usage summary endpoint.
- Antigravity reads only the official app's OAuth state keys; Gemini CLI uses its existing OAuth source. Both call fixed Google Code Assist endpoints.

No resolver writes back, migrates, or copies the source credential. Where the official contract requires token refresh, it happens only in memory for the current quota request. Missing local login state maps to `missing_credentials`; authentication rejection maps to a sanitized provider error.

### Integrate as an existing right-panel contribution

A new built-in contribution ID will participate in the existing Code right-tab state, side rail, contribution registry, and tab metadata. The panel will load quota data on first mount and refresh only when the user requests it.

The panel will render:

- provider name and provider ID;
- balance/quota metrics with a progress bar when a ratio is available;
- reset and last-updated timestamps;
- actionable missing-credential, unsupported, and sanitized request-error states;
- an empty state only when no configured providers exist.

The panel calls one preload method and does not receive provider settings or API keys as props.

The tab panel wrapper clips overflow, and the quota body uses a zero-basis flex item with `overflow-y-auto`, touch panning, stable scrollbar gutter, and contained overscroll. Wheel events stop at the quota body so a parent workbench gesture handler cannot consume them.

### Keep first-phase state ephemeral

Quota snapshots stay in the mounted panel and are not persisted to settings or Kun runtime data. This avoids stale-account migration concerns and credential-scope ambiguity. Closing/reopening a newly mounted panel fetches a fresh snapshot.

## Risks / Trade-offs

- [Provider APIs can change without notice] → Keep each parser isolated, reject malformed payloads, show a per-provider error, and cover reference payloads with tests.
- [A configured or preset provider can point at a gateway] → Require an exact known hostname before sending its credential and always use a canonical provider endpoint.
- [Many configured accounts could create a burst of requests] → Limit concurrent probes and apply per-request timeouts.
- [Some credentials can call models but cannot inspect billing] → Report the provider-specific authorization failure without treating the model connection as broken.
- [Balance and rate-window quotas are not directly comparable] → Render metrics within each provider card and avoid a cross-provider aggregate total.
- [OpenAI's legacy credit endpoint is credential-dependent] → Restrict it to exact OpenAI profiles and preserve authorization/unsupported failures as explicit states.
- [Subscription endpoints and local credential formats can change] → Keep credential readers and parsers isolated, validate expected token shapes, and fail per provider without exposing raw values.
- [macOS Keychain reads can require user consent] → Prefer a configured/file credential and bound the Keychain command; never perform the read in the renderer.
- [Cursor and Antigravity local state is platform-specific] → Return missing credentials on unsupported hosts while preserving other provider results.

## Migration Plan

The change is additive. Existing settings require no migration because probe identity is derived from the current normalized provider profile. Rollback removes the shared API, IPC handler, probe service, built-in panel ID, and renderer panel without changing persisted settings. Stored right-tab state already drops unknown contribution IDs during normalization, so a rollback safely discards a saved quota tab.

## Open Questions

- Should a later phase persist short-lived snapshots for startup speed or add opt-in background refresh and low-quota notifications?
