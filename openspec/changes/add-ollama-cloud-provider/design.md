## Context

Ollama now provides both local model execution and a hosted Ollama Cloud service. The hosted service has Free, Pro, Max, and planned Team subscription tiers; its official pricing page currently lists Pro at USD 20/month or USD 200/year, Max at USD 100/month with new sign-ups temporarily paused, and usage/concurrency allowances that vary by plan. Ollama states that cloud compute is hosted primarily in the United States, with Europe and Singapore used for additional capacity.

For programmatic cloud access, Ollama issues revocable API keys and accepts `Authorization: Bearer <key>`. The official cloud API exposes the native `/api/chat` and `/api/tags` routes. Ollama also exposes an OpenAI-compatible surface at `https://ollama.com/v1`, including streaming chat completions, tools, image input, reasoning controls, and `GET /v1/models`.

Kun already has the complete cross-layer machinery required by the OpenAI-compatible surface:

- provider presets and United States subscription grouping;
- protected provider API-key persistence and runtime hydration;
- main-process `GET /v1/models` probing through the configured proxy;
- a model import dialog and models.dev metadata enrichment;
- an OpenAI chat-completions model client with streaming and tool calling.

The implementation must preserve the single Kun runtime and must not confuse hosted Ollama Cloud with a managed local Ollama process.

Official sources used for the design:

- [Ollama pricing](https://ollama.com/pricing)
- [Ollama Cloud API and authentication](https://docs.ollama.com/cloud)
- [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)
- [Ollama model listing](https://docs.ollama.com/api/tags)

## Goals / Non-Goals

**Goals:**

- Make Ollama Cloud discoverable as a United States subscription provider.
- Give users a ready-to-edit official cloud Base URL, API-key field, endpoint format, and usable initial model snapshot.
- Refresh the model list from Ollama's official cloud model endpoint instead of treating the snapshot as permanently authoritative.
- Enrich imported model IDs with the existing `ollama-cloud` models.dev catalog.
- Route selected Ollama models through the existing Kun OpenAI-compatible client, including streaming and tool calls.
- Cover preset, categorization, model discovery, metadata mapping, settings persistence, and runtime projection with tests.

**Non-Goals:**

- Installing, launching, signing into, or monitoring a local Ollama daemon.
- Adding a native `/api/chat` codec when the official OpenAI-compatible endpoint already satisfies Kun's contract.
- Hardcoding plan prices, quotas, concurrency, or availability into UI strings, because those commercial details change independently of the API contract.
- Guaranteeing that every listed model supports identical modalities or tool behavior; imported per-model metadata remains authoritative.
- Adding a second agent/runtime selector or changing the `agents.kun` settings boundary.

## Decisions

### Add an `ollama` HTTP preset categorized as a United States subscription

The preset ID is `ollama`, the display name is `Ollama Cloud`, `category` is `subscription`, and `subscriptionRegion` is `united-states`. This places Ollama beside other hosted account plans in the existing provider picker and retains multi-account behavior already implemented for subscription presets.

The classification describes Ollama's hosted plan and primary compute region; it does not promise that every request is processed only in the United States. The UI will not embed volatile pricing or Max-plan availability.

Alternative considered: classify Ollama as a generic pay-as-you-go API. Rejected because the current hosted offering is account-plan based and the user explicitly needs it discoverable among subscription suppliers.

### Use the official OpenAI-compatible cloud root

The preset uses `baseUrl: https://ollama.com/v1` and `endpointFormat: chat_completions`. Existing URL construction therefore resolves chat to `/v1/chat/completions` and discovery to `/v1/models`. Existing provider headers send the API key as a Bearer token.

Alternative considered: add a new `ollama` endpoint format for `/api/chat` and `/api/tags`. Rejected because it would duplicate request, streaming, tool, image, reasoning, usage, diagnostic, and retry logic without increasing supported capability.

### Seed a current model snapshot and refresh through `/v1/models`

The preset includes the bounded, unique cloud model IDs returned by Ollama's official `/v1/models` endpoint during implementation. This makes a newly added provider immediately selectable after the user supplies a valid key. “Fetch models” continues to call the official endpoint and presents additions through the existing import dialog, so the snapshot is only an offline/bootstrap catalog.

No secret is required by the current public model-list response, but the normal settings flow still requires an API key before testing or importing for this preset. This keeps “ready” state honest because chat generation requires the key, and it avoids creating provider-specific keyless probe semantics.

Alternative considered: ship an empty model list and require the first fetch. Rejected because it prevents direct model selection immediately after adding the preset and provides a poor offline/error fallback.

### Map the preset to models.dev `ollama-cloud`

`ModelsDevCatalogService` gains a deterministic ID and exact-URL mapping from Kun's `ollama` provider to models.dev's `ollama-cloud` provider entry in `enrichment-only` mode. The provider API remains authoritative for currently available model IDs; models.dev supplies optional context windows, output limits, modalities, tool-calling flags, and reasoning flags only for matching imported IDs.

Alternative considered: infer metadata by matching each upstream model family to its original vendor. Rejected because models.dev already has an Ollama Cloud aggregate whose limits describe this specific serving surface.

### Reuse protected credentials and Kun runtime projection unchanged

Ollama API keys use the same protected provider-account store and opaque runtime credential binding as other HTTP presets. The renderer never receives model-request credentials from the runtime, and connection failures continue through existing bounded/sanitized diagnostics.

No settings migration is required. New users add the preset explicitly; existing settings normalize unchanged. Removing the preset in a rollback leaves an already-saved profile usable as a custom OpenAI-compatible provider.

## Risks / Trade-offs

- [The seeded cloud catalog becomes stale] → Keep `/v1/models` authoritative for refresh and test that returned IDs are imported without rewriting their wire names.
- [Ollama changes or removes part of its OpenAI compatibility] → Use only documented chat-completions/models features and surface final request URL/status through existing sanitized diagnostics.
- [A model's advertised capability differs from the cloud deployment] → Enrich from the Ollama Cloud-specific catalog and let users edit model profiles; do not apply one universal vision/reasoning profile.
- [Subscription pricing or regional routing changes] → Store only the stable subscription/United States classification and link to official live documentation instead of duplicating commercial copy.
- [A local-Ollama user selects the cloud preset] → Name the preset `Ollama Cloud`, use the hosted URL, and leave local endpoints to the existing custom-provider flow.

## Migration Plan

1. Add the shared preset and model snapshot.
2. Add deterministic models.dev mapping.
3. Add provider, discovery, import, settings, and runtime-projection regression tests.
4. Run focused tests, typecheck, Kun build, application build, and strict OpenSpec validation.

Rollback removes the built-in preset and catalog mapping. Persisted profiles remain structurally valid HTTP providers and can still be edited or deleted by the user.

## Open Questions

None for the initial Ollama Cloud integration.
