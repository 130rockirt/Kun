## ADDED Requirements

### Requirement: Account-visible Antigravity models are discovered authoritatively
The system SHALL invoke the installed official Antigravity CLI model-list command and SHALL return every safe account-visible model family, including non-Gemini families, without supplementing availability from a public catalog.

#### Scenario: Mixed-family account catalog
- **WHEN** `agy models` returns Gemini, Claude, and GPT-OSS model variants
- **THEN** discovery returns stable model entries for all three families

#### Scenario: Diagnostic output
- **WHEN** CLI output contains status text, empty lines, paths, or malformed identifiers
- **THEN** discovery ignores those lines and persists only bounded safe model slugs

### Requirement: Reasoning variants are represented separately from model identity
The system SHALL group trailing low, medium, and high variants under a stable model ID and SHALL retain the exact advertised effort levels in that model's profile.

#### Scenario: Multiple Gemini effort variants
- **WHEN** the CLI returns `gemini-3.6-flash-low`, `gemini-3.6-flash-medium`, and `gemini-3.6-flash-high`
- **THEN** the provider contains one `gemini-3.6-flash` model whose supported efforts are low, medium, and high

#### Scenario: Partial effort set
- **WHEN** the CLI returns only low and high variants for a model
- **THEN** the model profile exposes only low and high and selects a valid advertised default

#### Scenario: Non-standard suffix
- **WHEN** the CLI returns a slug ending in a non-standard suffix such as `-thinking`
- **THEN** the suffix remains part of the model ID rather than being treated as a Kun reasoning effort

### Requirement: Successful synchronization replaces the Antigravity account catalog
The system SHALL persist a successfully discovered Antigravity catalog as the authoritative models and model profiles for that configured account while retaining shipped preset models as an offline fallback before synchronization.

#### Scenario: Synchronizing a preset-based account
- **WHEN** a configured Antigravity account synchronizes a non-empty catalog
- **THEN** its saved models and profiles reflect the discovered catalog instead of remaining limited to the preset entries

#### Scenario: Discovery failure
- **WHEN** the CLI is missing, unauthenticated, times out, or returns no safe models
- **THEN** synchronization reports an error and does not erase the account's existing fallback configuration

### Requirement: Delegated execution honors every valid discovered model
The Antigravity delegated runtime SHALL pass the selected stable model and selected supported effort to the CLI for every discovered model family and SHALL NOT silently substitute a Gemini model.

#### Scenario: Claude model execution
- **WHEN** a turn selects a discovered Claude model
- **THEN** the runtime launches `agy` with that Claude slug in `--model`

#### Scenario: GPT-OSS model execution
- **WHEN** a turn selects a discovered GPT-OSS model and its advertised effort
- **THEN** the runtime launches `agy` with that GPT-OSS slug and effort

#### Scenario: Invalid persisted model
- **WHEN** a turn contains an empty or unsafe Antigravity model identifier
- **THEN** the turn fails with an actionable validation error before the CLI is launched instead of falling back to Gemini
