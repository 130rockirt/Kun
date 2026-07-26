## Why

Kun invokes the official Antigravity CLI to discover subscription models, but its parser currently discards every non-Gemini model and collapses the remaining output to three hard-coded Gemini families. The runtime repeats that Gemini-only restriction, so account-visible Claude and GPT-OSS models cannot be selected or executed and unsupported selections may silently fall back to Gemini.

## What Changes

- Treat the installed Antigravity CLI's `agy models` output as the authoritative account-visible model catalog.
- Preserve every supported Antigravity model family, including Claude and GPT-OSS, while representing reasoning-effort variants through Kun's separate reasoning control.
- Record the effort levels actually advertised for each discovered model instead of assigning the same low/medium/high set to every model.
- Allow the delegated Antigravity runtime to execute every discovered model family and fail closed on an invalid model instead of silently switching to Gemini.
- Keep a safe offline preset fallback without overriding a successfully synchronized account catalog.

## Capabilities

### New Capabilities

- `antigravity-subscription-models`: Defines authoritative Antigravity model discovery, variant grouping, model-specific reasoning capabilities, persistence, and delegated execution.

### Modified Capabilities

None.

## Impact

- Antigravity CLI discovery and tests in `src/main`.
- Provider preset/model-profile construction and settings import in `src/shared` and the renderer provider settings flow.
- Delegated Antigravity execution and tests in `kun/src/runtime/antigravity`.
- Composer model choices for configured Antigravity subscription accounts.
