## Context

The Antigravity provider is a delegated whole-turn transport backed by the pinned official `agy` binary. Model availability is account-specific and already exposed by `agy models`, but the current main-process parser returns only Gemini identifiers and removes low/medium/high suffixes without retaining the supported-effort information. Provider settings persist that reduced string list, while the Kun delegated runtime independently rejects every non-Gemini identifier and silently substitutes a default Gemini model.

Kun already models reasoning effort separately from model identity through `ModelProviderModelProfileV1.reasoning`, and the Antigravity CLI accepts a stable `--model` slug plus a separate `--effort` argument. The discovery boundary therefore needs to preserve both dimensions instead of flattening or discarding them.

## Goals / Non-Goals

**Goals:**

- Discover all account-visible Antigravity model families from the official CLI.
- Group standard `-low`, `-medium`, and `-high` variants under one stable model ID while retaining the exact supported effort set.
- Persist model-specific profiles so the composer offers only efforts advertised for the selected model.
- Execute non-Gemini Antigravity models without fallback substitution.
- Keep malformed diagnostic output and unsafe identifiers out of settings and process arguments.

**Non-Goals:**

- Exposing every effort variant as a duplicate model row when Kun already has a separate reasoning control.
- Treating models.dev as proof of account availability.
- Changing the separate Gemini CLI API provider or the generic HTTP `/models` import behavior.
- Adding an Antigravity-native streaming or tool protocol; turns remain delegated to `agy --print`.

## Decisions

1. **Return a structured account catalog from the Antigravity IPC.** Discovery returns ordered model entries with a stable model ID and supported efforts rather than a bare string array. The renderer persists the IDs and derives full text/vision delegated profiles from the same authoritative result. This keeps availability and capability data together and avoids guessing after suffixes have been removed.

2. **Group only the CLI's standard effort suffixes.** A trailing `-low`, `-medium`, or `-high` becomes a reasoning capability on the base ID. Other suffixes, including `-thinking`, remain part of the model ID because they may identify a distinct backend route. A model with no standard effort suffix receives a single `medium` effort, matching Kun's existing Antigravity default and ensuring the CLI always gets a supported value.

3. **Accept all safe discovered model families at runtime.** The delegated runtime accepts normalized alphanumeric model slugs containing dots and hyphens, strips an optional legacy `models/` prefix, and passes the stable slug to `agy`. It no longer applies a Gemini-only regular expression and no longer substitutes the default when a non-empty invalid identifier is supplied. Invalid identifiers fail the turn before process launch with an actionable error.

4. **Keep preset models as an offline fallback.** The shipped preset remains usable before the CLI is installed or synchronized. Successful authoritative synchronization replaces the account provider's model list and profiles with the discovered catalog, so stale preset entries do not mask account availability.

5. **Use the existing separate reasoning picker.** The composer continues to render one row per stable model ID and reads `supportedEfforts` from the discovered profile. This avoids eleven near-duplicate rows while preserving every effective model/effort combination exposed by the account.

## Risks / Trade-offs

- **[Risk] A future CLI introduces a non-standard effort suffix.** → Preserve unknown suffixes as part of the stable model ID instead of guessing.
- **[Risk] A model rejects the default medium effort despite not advertising variants.** → Keep the behavior covered by runtime tests and update the structured discovery contract if the CLI begins exposing explicit metadata.
- **[Risk] Existing settings contain collapsed Gemini IDs without synchronized profiles.** → Preset backfill remains valid; the next sync replaces them with authoritative model-specific profiles.
- **[Risk] Arbitrary persisted model text reaches process arguments.** → Validate the slug with a bounded safe-character grammar and spawn without a shell.

## Migration Plan

No settings schema version change is required because discovered data fits the existing provider `models` and `modelProfiles` fields. Existing accounts continue to show the preset fallback until the user synchronizes models. Rollback restores the old string-only IPC and Gemini-only runtime, while already persisted non-Gemini profiles remain valid data but would no longer be executable.

## Open Questions

None.
