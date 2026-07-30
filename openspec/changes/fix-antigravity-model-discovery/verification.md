## Verification

- `npx vitest run src/main/antigravity-cli.test.ts src/shared/antigravity-provider-settings.test.ts src/renderer/src/components/settings-section-agents.test.ts`
  - Passed: 3 files, 42 tests.
- `npm --prefix kun test -- src/runtime/antigravity/antigravity-cli-runtime.test.ts`
  - Passed: 1 file, 7 tests.
- `npm run typecheck`
  - Passed.
- `npm run build:kun`
  - Passed.
- `npm run build`
  - Passed in the primary worktree.
- `npx eslint` over the changed TypeScript source and test files
  - Passed.
- Applied the staged patch to a detached clean worktree at the current `HEAD` and reran the targeted tests, typecheck, and Kun build
  - Passed without relying on unrelated primary-worktree changes.
- Ran the structured discovery against the installed, authenticated Antigravity CLI
  - The 11 raw account entries resolved to six stable families: three Gemini families with exact effort sets, Claude Sonnet, Claude Opus Thinking, and GPT-OSS 120B.
- `git diff --cached --check`
  - Passed.
