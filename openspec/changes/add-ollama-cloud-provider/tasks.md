## 1. Provider Contract

- [x] 1.1 Add the `ollama`/`Ollama Cloud` subscription preset, official cloud Base URL, API-key/docs links, and bootstrap model snapshot.
- [x] 1.2 Add deterministic `ollama` and `https://ollama.com/v1` models.dev mapping to `ollama-cloud` in enrichment-only mode.

## 2. Provider And Settings Verification

- [x] 2.1 Add preset/profile tests for subscription category, United States region, multi-account creation, key requirement, endpoint format, and exact bootstrap model IDs.
- [x] 2.2 Add model-probe tests covering `https://ollama.com/v1/models`, Bearer authentication, and punctuation-preserving Ollama model IDs.
- [x] 2.3 Add models.dev service and import tests proving Ollama metadata enrichment and preventing catalog-only models from being treated as provider availability.
- [x] 2.4 Add settings UI coverage for Ollama visibility in the United States subscription tab and direct provider configuration/model import.
- [x] 2.5 Add runtime configuration projection coverage proving an Ollama model remains on the existing HTTP Chat Completions path with protected credential hydration.

## 3. Validation

- [x] 3.1 Run focused preset, provider probe, models.dev, settings, and runtime projection tests.
- [x] 3.2 Run application typecheck, Kun build, production build, `git diff --check`, and strict OpenSpec validation; distinguish unrelated baseline failures.
- [x] 3.3 Audit every Ollama Cloud specification scenario against source and test evidence and record validation notes.

## Validation Notes

- Official research verified the current Free/Pro/Max/Team plan structure, API-key authentication, primarily United States cloud hosting, OpenAI-compatible `/v1/chat/completions`, and model discovery routes. A live bounded request to `https://ollama.com/v1/models` returned the 18 bootstrap IDs stored in the preset.
- Preset discovery, United States filtering, direct configuration, missing-key state, exact Base URL/format, and repeated-account identity are covered by `app-settings-provider.test.ts` and `settings-section-agents.test.ts`.
- Bearer headers, final `/v1/models` URL, unique model parsing, and colon-preserving IDs are covered by `provider-connection.test.ts`; its existing timeout/status/body-bound tests exercise the shared Ollama failure path.
- Deterministic `ollama-cloud` enrichment-only mapping and exact API-vs-catalog availability behavior are covered by `models-dev-catalog.test.ts`, `provider-model-import.test.ts`, and the settings import test. Unknown API models remain selectable with the existing safe text-chat fallback.
- Protected credential projection, provider/model selection, and Chat Completions routing are covered by `kun-process.test.ts`. Existing compatibility-client suites cover the unchanged streaming/tool loop, while the preset adds no second runtime or local Ollama manager.
- Final checks passed: 230 focused tests; all 4,994 application tests across 609 files; 58 extension-package tests; `npm run typecheck`; `npm run build:kun`; `npm run build`; `git diff --check`; and `openspec validate add-ollama-cloud-provider --strict`.
- Pre-existing dirty-worktree edits in Cursor runtime, FloatingComposer, and `.deepseekgui-images/` were preserved and are unrelated to this change.
