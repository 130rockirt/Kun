## 1. Discovery Contract

- [x] 1.1 Add a shared structured Antigravity model catalog contract for stable IDs and supported efforts
- [x] 1.2 Parse mixed-family CLI output into stable model entries with exact effort sets and safe validation

## 2. Provider Synchronization

- [x] 2.1 Return the structured catalog through main-process IPC and preload
- [x] 2.2 Persist authoritative discovered model IDs and model-specific profiles from both Antigravity synchronization flows
- [x] 2.3 Preserve preset fallback behavior and existing settings compatibility

## 3. Delegated Runtime

- [x] 3.1 Accept safe non-Gemini Antigravity model slugs and remove silent Gemini fallback
- [x] 3.2 Pass stable model IDs and selected efforts to the CLI with actionable invalid-model failures

## 4. Validation

- [x] 4.1 Add discovery, provider synchronization, and delegated-runtime regression tests for Gemini, Claude, GPT-OSS, partial efforts, and invalid input
- [x] 4.2 Run targeted tests, typecheck, build Kun, inspect the final diff, and record validation evidence
