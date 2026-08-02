## ADDED Requirements

### Requirement: Graph shutdown recovery tolerates durable CI persistence latency

The native Graph platform test SHALL allow up to 5 seconds for
`GraphScheduler.stop()` to finish after an attempt is admitted behind the first
shutdown snapshot, while retaining the test's 15-second overall timeout.

#### Scenario: Late admission is interrupted within the CI budget

- **WHEN** shutdown begins while write-lease admission is paused and admission
  is released after the first shutdown snapshot
- **THEN** the test SHALL wait for `scheduler.stop()` for no more than 5 seconds
  before failing as a possible deadlock
- **AND** the scheduler SHALL persist the late attempt as interrupted with the
  host-shutdown failure and an effective attempt count of zero

### Requirement: AppImage release-gate validation supplies extracted paths

The extension release-gate fixture SHALL invoke the final AppImage desktop
smoke with explicit extracted `appRoot` and `appRun` paths, matching the
packaged smoke launcher contract and avoiding undefined path resolution.

#### Scenario: Final AppImage smoke invocation is validated

- **WHEN** the release gate constructs the final Linux AppImage desktop smoke
- **THEN** it SHALL provide the extracted AppDir and its `AppRun` executable
- **AND** the fixture SHALL validate `APPDIR`/`APPIMAGE` and the `AppRun` command
  without enabling AppImage self-extraction mode

### Requirement: Linux packaging remains gated by the complete Graph platform suite

The Linux PR and release workflows SHALL run the Graph platform suite before
Linux packaging, and SHALL only continue to package and smoke-test Linux
artifacts when that suite passes.

#### Scenario: Graph suite passes and Linux gates continue

- **WHEN** `npm run test:graph:platform` passes on the native Ubuntu/Node 22
  runner
- **THEN** the workflow SHALL continue to `dist:linux` and its deb/AppImage,
  CLI, extension, migration, Chromium/AppImage, and native-evidence checks

#### Scenario: Graph suite fails and packaging is blocked

- **WHEN** any Graph platform test fails
- **THEN** the workflow SHALL stop before `dist:linux` and SHALL not publish
  Linux artifacts
