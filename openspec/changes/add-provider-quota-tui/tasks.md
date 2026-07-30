## 1. Runtime contract and service

- [x] 1.1 Define strict provider quota metric, entry, status, and list response contracts under `kun/src/contracts`.
- [x] 1.2 Implement bounded, proxy-aware API-key provider classification, probes, parsers, concurrency, and sanitized failures.
- [x] 1.3 Implement read-only Claude, ChatGPT/Codex, Cursor, Antigravity, and Gemini CLI credential resolvers and quota probes.
- [x] 1.4 Compose the quota service with current model connections and protected credential resolution in the runtime factory.

## 2. Runtime HTTP and TUI client

- [x] 2.1 Add the authenticated `GET /v1/provider-quotas` route and route/service coverage.
- [x] 2.2 Add the typed `KunTuiClient.providerQuotas()` method and response validation tests.

## 3. Terminal interface

- [x] 3.1 Add `/quota`, `/provider usage`, autocomplete, and command-palette registration while preserving bare `/provider`.
- [x] 3.2 Implement the Provider quota primary route with semantic status, balances, progress bars, reset labels, and responsive density.
- [x] 3.3 Add loading, manual refresh, retained-result error handling, close behavior, and bounded keyboard scrolling.

## 4. Verification

- [x] 4.1 Add focused parser, security, command, client, responsive rendering, refresh, and navigation tests.
- [x] 4.2 Run focused tests, Kun typecheck/build, repository typecheck/build, lint, and `git diff --check`; separate unrelated concurrent changes.

## 5. Release review follow-up

- [x] 5.1 Keep runtime/TUI quota classification aligned with the GUI for Grok and Kimi Code.
- [x] 5.2 Add focused Grok gRPC-web and Kimi Code parser/classification coverage.
