## 1. Test fix

- [x] 1.1 Set the Graph shutdown completion assertion budget to 5 seconds for all platforms while preserving the existing 15-second test timeout and durable-state assertions.
- [x] 1.2 Verify the production scheduler, packaging configuration, and release notes remain unchanged.
- [x] 1.3 Update the release-gate AppImage fixture to pass explicit extracted `appRoot` and `appRun` paths to the smoke invocation helper.
- [x] 1.4 Record every validated Windows installation source before old-uninstaller cleanup and cover the no-unknown-content path.
- [x] 1.5 Add opt-in helper diagnostics so the native Windows smoke reports the exact silent installer failure.
- [x] 1.6 Recover the registered source natively in NSIS and remove the failing `ResolveSource` child-process round trip.
- [x] 1.7 Allow the Windows preservation round-trip test 15 seconds for its three native PowerShell helper processes.
- [x] 1.8 Make quoted uninstall-source parsing self-contained during NSIS `customHeader` expansion.
- [x] 1.9 Retire the fixed Kun HKCU registration after validated current-user to all-users cleanup.

## 2. Local verification

- [x] 2.1 Run the shutdown-recovery test serially 10 times and confirm every run passes.
- [x] 2.2 Run `npm run test:graph:platform` and confirm the Kun and renderer Graph suites pass.
- [x] 2.3 Run `npm run build:kun`, `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build`, and `git diff --check`.
- [x] 2.4 Re-run the focused packaging configuration and release-gate checks after the Windows migration fix.

## 3. Native CI and release

- [x] 3.1 Commit the scoped change, push the `codex/fix-linux-graph-shutdown-timeout` branch, and open a PR targeting `develop`.
- [ ] 3.2 Confirm native Ubuntu/Node 22 Graph, Linux packaging, smoke, evidence, macOS, Windows, and general PR checks are green before merge.
- [ ] 3.3 Merge the hotfix into `develop`, wait for release PR #1054 to refresh and pass all gates, then merge it to `master`.
- [ ] 3.4 Verify the automated `v0.2.34` release, cross-platform assets, and R2 stable/latest promotion; stop if the computed version differs.
