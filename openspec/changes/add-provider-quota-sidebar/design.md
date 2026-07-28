## Context

Configured model providers live in `AppSettingsV1.provider.providers`. Their credentials and provider identities are already available to the Electron main process, while the renderer owns the Code workbench's far-right rail and tabbed right workspace.

CodexBar demonstrates the useful boundary for this feature: a registry selects a provider-specific, read-only probe; each probe calls a balance or quota endpoint; and provider-specific payloads are normalized before UI rendering. Kun must keep its existing single agent runtime and must not reuse `/v1/usage`, because that route reports local model token usage rather than the upstream account's remaining allowance.

The first phase needs to represent all configured providers while only probing providers whose official balance/quota contract is recognized. The result must not expose API keys or arbitrary upstream response bodies to the renderer.

## Goals / Non-Goals

**Goals:**

- Show every configured model provider in a dedicated right-workspace tab opened from the far-right rail.
- Fetch recognized account balance or subscription quota through the Electron main process.
- Normalize currencies, count-based quotas, used/limit ratios, and reset timestamps into one stable contract.
- Preserve explicit `available`, `unsupported`, `missing_credentials`, and `error` states per provider.
- Keep requests bounded, proxy-aware, independently failing, and safe to retry manually.
- Make additional provider probes additive through a small registry.

**Non-Goals:**

- Estimating account quota from chat token usage or Kun's `/v1/usage` telemetry.
- Adding runtime diagnostics, provider switching, automated purchasing, quota warnings, or background polling.
- Importing browser cookies, invoking provider CLIs, or adding OAuth flows in this phase.
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

Unrecognized providers remain visible with `unsupported`.

### Define a provider-neutral shared contract

`src/shared/provider-quota.ts` will define:

- a provider entry with identity, status, source label, dashboard URL, timestamps, and a sanitized message;
- zero or more metrics containing label, unit, used, limit, remaining, percentage, and reset time;
- a list result with a refresh timestamp.

The contract intentionally models both monetary balances and count/time-window quotas. It does not model raw provider payloads.

### Bound and isolate network work

The list service will process configured providers with limited concurrency. Every request uses the existing model-request proxy configuration, an abort timeout, a bounded response body, and canonical HTTPS endpoints. One provider failure produces only that provider's `error` result.

The service will use dependency injection for fetches in unit tests. No live credential probes are part of automated validation.

### Integrate as an existing right-panel contribution

A new built-in contribution ID will participate in the existing Code right-tab state, side rail, contribution registry, and tab metadata. The panel will load quota data on first mount and refresh only when the user requests it.

The panel will render:

- provider name and provider ID;
- balance/quota metrics with a progress bar when a ratio is available;
- reset and last-updated timestamps;
- actionable missing-credential, unsupported, and sanitized request-error states;
- an empty state only when no configured providers exist.

The panel calls one preload method and does not receive provider settings or API keys as props.

### Keep first-phase state ephemeral

Quota snapshots stay in the mounted panel and are not persisted to settings or Kun runtime data. This avoids stale-account migration concerns and credential-scope ambiguity. Closing/reopening a newly mounted panel fetches a fresh snapshot.

## Risks / Trade-offs

- [Provider APIs can change without notice] → Keep each parser isolated, reject malformed payloads, show a per-provider error, and cover reference payloads with tests.
- [A configured or preset provider can point at a gateway] → Require an exact known hostname before sending its credential and always use a canonical provider endpoint.
- [Many configured accounts could create a burst of requests] → Limit concurrent probes and apply per-request timeouts.
- [Some credentials can call models but cannot inspect billing] → Report the provider-specific authorization failure without treating the model connection as broken.
- [Balance and rate-window quotas are not directly comparable] → Render metrics within each provider card and avoid a cross-provider aggregate total.
- [OpenAI's legacy credit endpoint is credential-dependent] → Restrict it to exact OpenAI profiles and preserve authorization/unsupported failures as explicit states.

## Migration Plan

The change is additive. Existing settings require no migration because probe identity is derived from the current normalized provider profile. Rollback removes the shared API, IPC handler, probe service, built-in panel ID, and renderer panel without changing persisted settings. Stored right-tab state already drops unknown contribution IDs during normalization, so a rollback safely discards a saved quota tab.

## Open Questions

- Which cookie- or OAuth-only provider quotas should be added after the API-key-only first phase?
- Should a later phase persist short-lived snapshots for startup speed or add opt-in background refresh and low-quota notifications?
