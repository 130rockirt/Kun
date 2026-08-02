## Context

The Linux PR/release packaging job runs `npm run test:graph:platform` before
`npm run dist:linux`. The shutdown-recovery test deliberately pauses write-lease
admission, calls `GraphScheduler.stop()`, then verifies that an attempt admitted
after the first shutdown snapshot is interrupted and excluded from effective
attempt counts. The scheduler's existing double snapshot and active-promise
drain are durable and correct, but file-backed persistence can exceed 500 ms on
loaded Ubuntu runners.

## Goals / Non-Goals

**Goals:**

- Keep the late-admission shutdown scenario deterministic and retain its durable
  state assertions.
- Allow normal Linux filesystem/lease persistence latency while still failing a
  genuinely hung shutdown within the test's overall timeout.
- Unblock the native Linux package and smoke gates without changing runtime code.
- Keep the native Windows migration gate fail-closed while allowing a validated
  source to be cleaned after its old uninstaller removes the identity executable.

**Non-Goals:**

- No changes to `GraphScheduler`, graph contracts, persistence format, or
  Electron/electron-builder configuration.
- No suppression or removal of the intentionally logged synthesis failure
  fixture.
- No cross-compilation claim for local macOS; native Linux evidence remains a PR
  CI responsibility.

## Decisions

- **Use a 5-second stop assertion budget on every platform.** This matches the
  existing Windows allowance and accommodates durable file-backed cleanup on
  Ubuntu. Keeping the `Promise.race` preserves an explicit no-deadlock guard.
  Removing the race entirely was rejected because a future scheduler deadlock
  should still fail at the assertion boundary.
- **Change only the test constant.** The scheduler already sets the stopping
  fence, takes a second active-attempt snapshot, aborts late admissions, and
  awaits active promises. Adding new production checkpoints would alter the
  audited shutdown behavior without evidence of a runtime defect.
- **Use PR CI for native Linux verification.** The current host is macOS arm64
  and its Docker daemon is unavailable; Ubuntu CI already runs the exact Node 22
  packaging dependencies and all downstream Linux smoke/evidence gates.
- **Keep the release-gate fixture explicit about extracted AppImage paths.**
  The desktop smoke launcher now runs the verified extracted `AppRun` with
  `APPDIR`/`APPIMAGE` set. The release-gate fixture must provide those paths so
  it validates the same invocation shape instead of calling `resolve(undefined)`.
- **Use the preparation journal as the fallback-cleanup authorization record.**
  `Prepare` already validates source identity, safe roots, reparse points, and
  recognized payload before the old uninstaller runs. It now records every
  validated source, including sources with no unknown content, because the old
  uninstaller legitimately removes `Kun.exe` before fallback cleanup. Cleanup
  without a matching record remains rejected unless the source still equals the
  target and retains a valid identity executable.
- **Make native installer failures observable only when the smoke opts in.**
  The helper appends action boundaries and caught error messages to a path
  supplied through `KUN_INSTALLER_DIAGNOSTIC_PATH`. The Windows smoke sets that
  path inside its disposable root and prints it only after an unexpected exit;
  diagnostic write failures are ignored so production behavior is unchanged.
- **Recover registered sources natively in NSIS.** electron-builder parses its
  quoted `UninstallString` before launching the old uninstaller, but its
  `installUtil.nsh` is loaded after `customHeader`. Kun therefore owns equivalent
  quoted-path and parent-directory functions inside `customHeader`, avoiding
  both the late macro dependency and the environment-variable/UTF-16 result-file
  round trip that returned an empty source. PowerShell still normalizes the
  resulting source and enforces all target, identity, payload, journal, and
  reparse-point checks.
- **Budget the full Windows preservation round trip explicitly.** The focused
  test synchronously starts PowerShell for `Prepare`, `FallbackCleanup`, and
  `Restore`. Native runner startup can put the correct round trip just beyond
  Vitest's 5-second default, so that one test receives a 15-second ceiling while
  keeping every behavioral assertion intact.
- **Finish the cross-scope registration transition in the custom callback.**
  electron-builder invokes `customUnInstallCheckCurrentUser` only when an
  all-users install retires a current-user copy. Because Kun's callback replaces
  the default result handler to support validated fallback cleanup, it also
  removes the exact Kun HKCU install/uninstall keys after that cleanup succeeds.
  No dynamic or parent registry path is deleted.

## Risks / Trade-offs

- [Risk] A real shutdown deadlock can now take up to 5 seconds to fail at the
  race instead of 500 ms → Mitigated by the existing 15-second test timeout and
  the complete durable-state assertions after the race.
- [Risk] Mac-local tests cannot prove Linux-native AppImage behavior → Mitigated
  by requiring the native Linux PR job to pass before merge and release.
- [Risk] A preparation record could authorize the wrong Windows directory →
  Mitigated by writing it only after the existing safe-root, application
  identity, recognized-payload, and reparse-point checks all pass.

## Migration Plan

No runtime or data migration is needed. Update the tests and release-gate
fixtures, run the local checks, then rely on native Linux and Windows PR jobs
for package/smoke evidence. Revert the scoped changes if CI exposes a new
regression.
