## 1. Shared quota contract

- [x] 1.1 Define provider quota statuses, metrics, entries, and list results in a shared module.
- [x] 1.2 Expose the quota list operation through the typed `window.kunGui` preload API.

## 2. Main-process quota service

- [x] 2.1 Implement provider classification, bounded response handling, request timeouts, proxy use, and isolated concurrent refresh.
- [x] 2.2 Implement and test DeepSeek, OpenRouter, Moonshot, Z.ai/BigModel, MiniMax, and exact OpenAI quota parsers and probes.
- [x] 2.3 Register the trusted IPC handler that loads current settings and returns normalized quota entries.

## 3. Workbench quota surface

- [x] 3.1 Add the built-in quota contribution ID to right-tab normalization, registration, labels, and rendering.
- [x] 3.2 Add the Quota launcher to the far-right rail and cover its interaction/ordering in tests.
- [x] 3.3 Build the provider quota panel with loading, refresh, metrics, progress, timestamp, unsupported, missing-credential, error, and empty states.
- [x] 3.4 Add localized quota labels to every supported renderer locale and keep locale key parity.

## 4. Verification

- [x] 4.1 Run focused provider quota, right-panel, preload/IPC, and locale tests.
- [x] 4.2 Run typecheck, the relevant test suite, build, and `git diff --check`; separate any baseline failures.

## 5. Subscription quota probes

- [x] 5.1 Add credential-aware Claude subscription and ChatGPT/Codex OAuth quota probes and parsers.
- [x] 5.2 Add Cursor.app subscription usage and Google Antigravity/Gemini CLI quota probes using existing local login state.
- [x] 5.3 Cover subscription classification, fixed endpoints, request headers, response normalization, missing credentials, and isolated failures.

## 6. Quota panel scrolling

- [x] 6.1 Make the quota tab body an explicit wheel/touch scroll owner and cover its overflow behavior.

## 7. Verification

- [x] 7.1 Run focused tests, typecheck, build, and diff checks; separate any unrelated baseline failures.
