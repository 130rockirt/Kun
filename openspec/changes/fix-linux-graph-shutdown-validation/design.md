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

## Risks / Trade-offs

- [Risk] A real shutdown deadlock can now take up to 5 seconds to fail at the
  race instead of 500 ms → Mitigated by the existing 15-second test timeout and
  the complete durable-state assertions after the race.
- [Risk] Mac-local tests cannot prove Linux-native AppImage behavior → Mitigated
  by requiring the native Linux PR job to pass before merge and release.

## Migration Plan

No runtime or data migration is needed. Update the test, run the local checks,
align the release-gate fixture with the launcher contract, then rely on the
native Linux PR job for package/smoke evidence. Revert the scoped changes if CI
exposes a new regression.
