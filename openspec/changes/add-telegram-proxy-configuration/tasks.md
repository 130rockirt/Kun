## 1. Settings and IPC contracts

- [x] 1.1 Add the optional Telegram proxy type, URL validation/normalization, backward-compatible settings normalization, and settings schema coverage
- [x] 1.2 Extend the typed preload/main token-verification IPC contract to carry the proxy configuration and return actionable invalid-proxy errors

## 2. Telegram transport

- [x] 2.1 Route token verification and every Telegram channel HTTP operation through the selected per-channel proxy while preserving Electron/system routing when disabled
- [x] 2.2 Include the effective proxy in channel reconciliation and sanitize Telegram transport failures so bot/proxy credentials are not disclosed
- [x] 2.3 Extend the existing explicit-proxy fetch helper to encode Blob and FormData request bodies with correct generated headers

## 3. Renderer experience

- [x] 3.1 Add proxy toggle, URL fields, validation feedback, credential editing, and English/Chinese plus fallback-locale copy to Connect phone settings

## 4. Verification

- [x] 4.1 Add focused settings, IPC, proxy-helper, Telegram runtime, and renderer tests for validation, persistence, routing, multipart uploads, and proxy-change reconciliation
- [x] 4.2 Run targeted tests, typecheck, lint, build, and diff hygiene checks; document any unrelated baseline failures
