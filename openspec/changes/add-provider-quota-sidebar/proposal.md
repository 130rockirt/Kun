## Why

Kun lets users configure multiple model providers, but it does not show the balance or subscription quota attached to those credentials. Users must leave the app and inspect each provider dashboard separately, even when the provider exposes a read-only balance or quota API.

## What Changes

- Add a provider-quota service that reads configured model providers and queries only recognized, read-only provider balance or quota endpoints.
- Normalize provider-specific responses into a shared result that distinguishes available quota, missing credentials, unsupported providers, and request failures.
- Add a Quota button to the Code workbench's far-right rail and open a provider-quota tab in the existing right workspace.
- List every configured provider in the panel, show available balance/quota metrics and reset times, and retain explicit unsupported/error states instead of hiding providers.
- Support manual refresh with bounded, proxy-aware requests while keeping provider credentials in the Electron main process.
- Cover DeepSeek, OpenRouter, Moonshot, Z.ai Coding Plan, MiniMax, recognized OpenAI API balance contracts, and the existing Claude, ChatGPT/Codex, Cursor, and Google Antigravity subscription login paths.
- Make the quota panel body a dedicated wheel/touch scroll owner so long provider lists remain usable inside the fixed right workspace.

## Capabilities

### New Capabilities

- `provider-quota-monitoring`: Query and display normalized account balance or subscription quota for configured model providers from the workbench right rail.

### Modified Capabilities

None.

## Impact

- Shared contracts and the preload API gain a provider-quota result type and list method.
- Electron main gains a proxy-aware provider-quota registry/service and IPC handler.
- Subscription probes reuse protected settings credentials or read-only local login state from the corresponding official client; no credential is returned to the renderer.
- Renderer right-panel contribution IDs, side rail, tab workspace, localization, and tests gain the Quota surface.
- No Kun runtime route or agent-loop behavior changes; model request endpoints and provider settings persistence remain unchanged.
- No new runtime dependency is required.
