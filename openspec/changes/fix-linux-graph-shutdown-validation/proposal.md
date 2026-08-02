## Why

The native Linux packaging job currently fails before `dist:linux` because the
Graph scheduler shutdown-recovery test treats durable file-backed cleanup as a
500 ms operation. Under normal Ubuntu CI load the scheduler completes correctly,
but the test reports a timeout and blocks all Linux packaging and release gates.

## What Changes

- Raise the shutdown completion assertion budget to 5 seconds on all platforms,
  matching the existing Windows allowance while retaining the test's 15-second
  overall timeout.
- Keep the late-admission shutdown scenario and durable interrupted-attempt
  assertions unchanged.
- Keep the extension release-gate fixture aligned with the AppImage smoke
  invocation contract by supplying the extracted AppDir and `AppRun` paths.
- Record the Linux Graph CI validation contract in a standalone OpenSpec
  capability.
- Do not change GraphScheduler production behavior, public APIs, packaging
  configuration, or user-facing release notes.

## Capabilities

### New Capabilities

- `linux-graph-ci-validation`: Native Linux Graph tests must tolerate durable
  shutdown persistence latency while still detecting a real shutdown deadlock,
  allowing the downstream Linux package and smoke gates to run.

### Modified Capabilities

None.

## Impact

- Test: `kun/src/graph/graph-scheduler-shutdown-recovery.test.ts`.
- Release-gate validation: `scripts/check-extension-release-gate.mjs` must pass
  the resolved AppImage extraction paths to the final desktop smoke fixture.
- CI/release eligibility: the Graph platform suite can proceed to Linux
  AppImage/deb packaging and native smoke validation.
- No runtime protocol, API, dependency, or packaged application behavior
  changes.
