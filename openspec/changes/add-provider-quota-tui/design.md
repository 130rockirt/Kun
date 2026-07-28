## Context

The GUI provider-quota panel runs in Electron main because protected settings credentials must never enter the renderer. The standalone TUI is a separate client of the shared `kun serve` process and cannot call Electron IPC, so it needs a runtime-owned read-only quota surface. Kun already owns the canonical model-connection registry, protected credential bindings, proxy configuration, authenticated HTTP router, TUI client, and terminal visual system.

The existing `GET /v1/usage` endpoint reports accumulated thread tokens and cost. Provider account allowance is a separate concept and must have a separate contract and `/quota` TUI route. Repository architecture also explicitly forbids restoring a `/usage` runtime-control slash panel.

## Goals / Non-Goals

**Goals:**

- Give standalone and desktop-launched TUI sessions the same provider-account quota visibility.
- Resolve credentials only inside the runtime and return a provider-neutral, sanitized DTO.
- Recognize configured API-key and subscription providers using fixed canonical endpoints.
- Keep one provider failure from hiding successful entries for other providers.
- Match Kun's terminal-native route, color, density, footer, and keyboard conventions.
- Keep long results usable with line scrolling and wide/compact/narrow rendering.

**Non-Goals:**

- Replacing `/v1/usage`, `/context`, or the GUI's existing Electron IPC path in this change.
- Adding background polling, notifications, purchasing, or persisted quota snapshots.
- Adding a new interactive OAuth flow or importing arbitrary browser cookies.
- Sending credentials, cookies, raw upstream bodies, or user-authored quota URLs to TUI clients.

## Decisions

### Add a runtime-owned provider quota service

`ProviderQuotaService` will receive the model-connection registry, a protected credential resolver, proxy settings, and injectable fetch/runtime adapters. It will project configured connections into minimal probe inputs, classify by stable preset/provider identity plus expected transport kind, and query only fixed provider quota URLs.

This is preferred over calling Electron IPC because the TUI must work when the desktop app is closed. It is preferred over implementing probes in the TUI because credentials and raw provider responses must remain server-side.

The service will initially mirror the provider families already recognized by the GUI: DeepSeek, OpenRouter, Moonshot, Z.ai/BigModel, MiniMax, exact OpenAI, Claude subscription, ChatGPT/Codex, Cursor, Antigravity, and Gemini CLI. Unrecognized connections remain visible as `unsupported`.

### Resolve canonical connections and credentials at request time

Every refresh will read the current `ModelConnectionRegistry` snapshot and materialized provider configs. Registry-owned or GUI-migrated credentials will be resolved through the runtime's existing protected credential source. Official-client subscription sources remain read-only: Claude Code, Codex CLI, Cursor.app, Antigravity, and Gemini CLI.

Token refresh may occur in memory when required by an official OAuth contract. Source credentials are never copied or written back by the quota service. Fixed endpoint selection is never derived from a custom Base URL beyond exact host classification for recognized API-key families.

### Publish a dedicated authenticated contract

`kun/src/contracts/provider-quota.ts` will define strict Zod schemas for status, metric, entry, and list response. `GET /v1/provider-quotas` will require the normal runtime bearer token and return only normalized fields:

- provider identity and display name;
- `available`, `unsupported`, `missing_credentials`, or `error`;
- source/dashboard metadata;
- summary, metrics, reset times, sanitized message, and refresh timestamps.

Response reads, timeouts, and concurrency are bounded. Raw provider responses and secrets never cross the route.

### Use a primary TUI route for Provider quota

`/quota` opens a `ProviderQuotaDialog` as an exclusive primary route. `/provider usage` maps to the same command while bare `/provider` keeps opening model connections. The command palette exposes “Show provider quota”.

The dialog follows the generated terminal design:

- `KUN / Provider quota` breadcrumb and refreshed time;
- provider headings with semantic glyph and right-aligned status/plan;
- monetary values or terminal block progress bars with percentages and reset labels;
- inline missing-login, unsupported, and error guidance;
- footer actions for navigation, `r` refresh, and `Esc` back.

Refresh keeps the route open, shows a loading state, and preserves the previous result until replacement succeeds. The component owns its vertical offset and derives the viewport from terminal rows; Up/Down, PageUp/PageDown, Home/End, `j`/`k`, and mouse-wheel-independent terminal scroll controls are bounded.

### Degrade information density by terminal width

Wide layouts align label, progress bar, value, and reset information on one row. Compact layouts shorten the bar and move reset text where necessary. Narrow layouts prioritize provider name, status, numeric value, and percentage, wrapping secondary reset/source information onto indented lines. All untrusted provider strings pass through terminal-control and secret redaction before rendering.

## Risks / Trade-offs

- [Provider private endpoints or official-client storage formats can change] → Isolate each parser/resolver, validate expected shapes, use sanitized per-provider failures, and cover fixed URLs and payloads in tests.
- [Quota probing could delay the TUI route] → Run at most four probes concurrently, bound each request to 12 seconds and 256 KiB, show loading immediately, and keep refresh manual.
- [Credential prompts from OS keychains can be disruptive] → Prefer configured/file credentials, bound platform commands, and never trigger login UI.
- [GUI and runtime probe implementations can drift] → Keep the DTO and behavior aligned in tests now; a later change may extract a shared package once both surfaces stabilize.
- [Many model-level Google buckets create a long page] → Give the quota route explicit line scrolling and show an offset indicator.

## Migration Plan

The change is additive. Existing connection registries and settings require no migration. Rollback removes the route, client method, and command; provider configuration and credentials remain untouched.

## Open Questions

None for the first TUI phase.
