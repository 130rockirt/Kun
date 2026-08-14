# Oversized File Baseline

- Base branch: local `develop`
- Base commit: `33576f5334268c3ae97803a47e67945754fdb250`
- Audit command: `npm run check:file-lines`
- Maximum: 700 physical lines
- Applicable tracked text files inspected: 3,891
- Oversized applicable files: 327
- Excluded opaque binary/media files: 90
- Excluded package-manager lockfiles: 2

## Violations by repository area

| Area | Files |
| --- | ---: |
| Repository root | 2 |
| `build` | 1 |
| `examples` | 34 |
| `kun` | 121 |
| `packages` | 5 |
| `resources` | 3 |
| `scripts` | 10 |
| `src` | 151 |

## Violations by file type

| Extension | Files |
| --- | ---: |
| `.cjs` | 8 |
| `.css` | 8 |
| `.json` | 17 |
| `.md` | 3 |
| `.mjs` | 3 |
| `.ps1` | 1 |
| `.py` | 1 |
| `.ts` | 241 |
| `.tsx` | 45 |

The unrelated untracked `kun-intro-deck/` directory remains only in the original `develop` worktree and is not part of this change.
