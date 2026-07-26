## Why

Kun does not currently expose Ollama Cloud as a configurable subscription provider, even though Ollama offers account plans, API keys, an OpenAI-compatible chat endpoint, and an account-visible cloud model catalog. Adding a first-party preset lets users bring an Ollama subscription into the existing single Kun runtime without manually reconstructing endpoint settings or model IDs.

## What Changes

- Add an `Ollama Cloud` built-in provider preset in the United States subscription-plan group.
- Preconfigure the official `https://ollama.com/v1` OpenAI-compatible endpoint and Bearer API-key authentication.
- Seed the preset with a usable snapshot of current Ollama Cloud chat models while keeping the official `/v1/models` response authoritative for refreshes.
- Map Ollama Cloud to its models.dev catalog so imported models receive context-window, output-limit, modality, tool-calling, and reasoning metadata when available.
- Verify that users can add the provider, enter an Ollama API key, test the connection, fetch/import models, select one, and route Kun turns through the existing HTTP model client.
- Preserve local Ollama as a separate custom-provider use case; this change does not add another agent runtime or manage a local Ollama installation.

## Capabilities

### New Capabilities

- `ollama-cloud-provider`: Ollama Cloud subscription preset, secure API-key configuration, official model discovery, metadata enrichment, and execution through Kun's OpenAI-compatible provider path.

### Modified Capabilities

None.

## Impact

- Shared provider preset definitions and normalization tests.
- Main-process provider connection/model discovery and models.dev provider mapping tests.
- Provider settings add-dialog, United States plan filtering, model import, and selection tests.
- Kun's existing OpenAI-compatible request path is reused; no new runtime, IPC surface, dependency, or persisted settings schema is required.
