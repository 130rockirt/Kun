## ADDED Requirements

### Requirement: Ollama Cloud subscription preset
The system SHALL expose a built-in `Ollama Cloud` provider preset with ID `ollama`, classify it as a United States subscription plan, and configure the official OpenAI-compatible cloud endpoint.

#### Scenario: Find Ollama in the provider picker
- **WHEN** a user opens the add-provider dialog and selects the United States subscription region
- **THEN** `Ollama Cloud` appears in the subscription-plan group and remains searchable by `ollama`

#### Scenario: Add Ollama provider
- **WHEN** a user adds the Ollama Cloud preset
- **THEN** the provider is initialized with `https://ollama.com/v1`, Chat Completions format, an editable API-key field, and a non-empty bootstrap model list

#### Scenario: Add another Ollama account
- **WHEN** an Ollama Cloud profile already exists and the user adds the preset again
- **THEN** the system creates a distinct subscription account profile without overwriting the existing account

### Requirement: Official Ollama model discovery
The system SHALL retrieve Ollama Cloud model IDs from the official OpenAI-compatible `/v1/models` endpoint through the existing bounded provider-probe path.

#### Scenario: Fetch models with a configured provider
- **WHEN** a user supplies an Ollama API key and chooses Fetch models
- **THEN** the system requests `https://ollama.com/v1/models` with Bearer authentication and presents unique returned model IDs for import

#### Scenario: Preserve Ollama wire model IDs
- **WHEN** Ollama returns model IDs containing punctuation such as `gpt-oss:120b`
- **THEN** the system preserves the exact ID for storage, selection, and model requests

#### Scenario: Discovery fails
- **WHEN** the Ollama model endpoint times out, rejects authentication, exceeds response limits, or returns an invalid response
- **THEN** the system keeps the existing bootstrap/imported list and displays the existing bounded provider error without exposing the API key

### Requirement: Ollama Cloud model metadata
The system SHALL map Ollama Cloud to the `ollama-cloud` models.dev catalog and use matching entries to enrich user-selected models.

#### Scenario: Import a catalog-backed model
- **WHEN** an Ollama model ID exactly matches an `ollama-cloud` catalog entry
- **THEN** the imported profile includes available context-window, output-limit, modality, tool-calling, and reasoning metadata

#### Scenario: Import an Ollama-only or newly released model
- **WHEN** the official Ollama endpoint returns a model missing from models.dev
- **THEN** the model remains importable and usable with the existing safe text-chat defaults

#### Scenario: Do not replace availability with catalog data
- **WHEN** models.dev contains an Ollama Cloud model that the official provider response does not return
- **THEN** the import dialog identifies the sources and does not silently treat metadata enrichment as proof of account availability

### Requirement: Ollama Cloud execution through Kun
The Kun runtime SHALL execute a selected Ollama Cloud model through the existing OpenAI-compatible HTTP model client with the provider's protected API key.

#### Scenario: Select and use an Ollama model
- **WHEN** the user saves an Ollama provider, selects one of its chat models, and sends a Kun turn
- **THEN** runtime configuration resolves provider `ollama`, the selected wire model ID, `https://ollama.com/v1`, and Chat Completions format without creating another agent runtime

#### Scenario: Stream text and tools
- **WHEN** an Ollama model supports streaming and tool calling
- **THEN** Kun processes text deltas and tool calls through its existing Chat Completions loop and approval/sandbox boundaries

#### Scenario: Missing API key
- **WHEN** an Ollama Cloud provider has no hydrated API key
- **THEN** settings mark it as needing configuration and a turn does not silently fall back to another provider

### Requirement: Local Ollama remains a custom-provider use case
The system SHALL distinguish the hosted Ollama Cloud preset from a user-managed local Ollama endpoint.

#### Scenario: Configure local Ollama
- **WHEN** a user wants to connect to `http://localhost:11434/v1`
- **THEN** the user can continue to create or edit a custom OpenAI-compatible provider without the application installing or managing an Ollama daemon
