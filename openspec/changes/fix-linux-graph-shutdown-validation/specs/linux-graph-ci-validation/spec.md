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

### Requirement: Windows fallback cleanup uses a validated preparation record

The Windows migration helper SHALL record each existing installation source
after validating its safe root, application identity, recognized payload, and
reparse-point boundaries, even when that source has no unknown content to
preserve.

#### Scenario: Old uninstaller removes the identity executable

- **WHEN** preparation validates a registered source and the old uninstaller
  subsequently removes its identity executable
- **THEN** fallback cleanup SHALL accept that exact source through its matching
  preparation record
- **AND** the helper SHALL remove only recognized application payload

#### Scenario: Unprepared source is presented for fallback cleanup

- **WHEN** fallback cleanup receives a source without a matching preparation
  record
- **THEN** it SHALL reject a source that differs from the install target or no
  longer contains an application identity executable

### Requirement: Windows migration smoke exposes helper failures

The Windows migration smoke SHALL opt into bounded helper diagnostics and print
them when an installer exits with an unexpected code.

#### Scenario: Silent installer helper fails

- **WHEN** a helper action fails inside a silent NSIS migration scenario
- **THEN** the smoke log SHALL identify the failed action and its caught error
- **AND** normal installer runs without the diagnostic environment variable
  SHALL not create that log

### Requirement: Windows registered source recovery is process-local

The Windows installer SHALL recover the parent directory from its quoted
registered uninstaller path inside NSIS before resolving the canonical target.

#### Scenario: InstallLocation is empty but UninstallString is valid

- **WHEN** a current-user registration has an empty `InstallLocation` and a
  quoted `UninstallString` under the legacy installation directory
- **THEN** NSIS SHALL recover that directory with installer-local quoted-path
  and parent-directory parsers available during `customHeader` expansion
- **AND** target resolution SHALL receive the non-empty recovered source without
  depending on a child-process result file
- **AND** compilation SHALL not depend on macros loaded later by
  electron-builder's `installUtil.nsh`

### Requirement: Windows preservation validation tolerates native process startup

The Windows migration test SHALL allow up to 15 seconds for its three
synchronous PowerShell helper processes to prepare, clean, and restore preserved
content on a native runner.

#### Scenario: Native helper startup exceeds the default unit-test budget

- **WHEN** the preservation round trip is correct but three native PowerShell
  startups take longer than the default 5-second unit-test timeout
- **THEN** the test SHALL continue for no more than 15 seconds
- **AND** all preparation, cleanup, restoration, and journal assertions SHALL
  remain unchanged

### Requirement: Windows scope migration retires old user shell state

The Windows installer SHALL remove the fixed Kun current-user install/uninstall
registration keys and application shortcuts after validated cleanup succeeds
during a current-user to all-users migration.

#### Scenario: Current-user installation is migrated for all users

- **WHEN** an all-users install successfully retires the validated current-user
  application payload
- **THEN** the exact Kun `INSTALL_REGISTRY_KEY` and `UNINSTALL_REGISTRY_KEY`
  entries under `HKEY_CURRENT_USER` SHALL be removed
- **AND** the registered, canonical Kun, and legacy DeepSeek GUI current-user
  desktop/start-menu shortcuts SHALL be removed
- **AND** registration cleanup SHALL occur only after fail-closed payload cleanup
  succeeds

### Requirement: Supervision liveness validation tolerates native runner load

The deterministic Graph supervision-liveness fixture SHALL retain its bounded
state checks while allowing the complete multi-checkpoint scenario the existing
60-second Vitest test budget.

#### Scenario: A loaded native runner completes deterministic supervision

- **WHEN** the fixture redelivers two parked prose-only Lead episodes and
  completes the reviewed run
- **THEN** each scheduler-state wait SHALL remain bounded at 10 seconds
- **AND** the test-level timeout SHALL be 60 seconds
- **AND** the Lead episode, worker start, accepted node, and resolved obligation
  assertions SHALL remain unchanged

### Requirement: Root Windows tests allow native process startup

The root Vitest configuration SHALL give Windows tests a bounded 15-second
per-test budget while retaining the existing two-worker concurrency.

#### Scenario: Native migration checks run under Windows runner load

- **WHEN** root migration tests perform synchronous filesystem operations or
  launch the Windows PowerShell migration helper
- **THEN** Vitest SHALL allow the test up to 15 seconds to return
- **AND** non-Windows platforms SHALL retain the default timeout
- **AND** migration assertions and helper exit validation SHALL remain unchanged

### Requirement: Desktop smoke app data is explicitly isolated

The Electron main bootstrap SHALL bind the `appData` special path to the
pre-created isolated desktop-smoke directory only when the dedicated desktop
smoke environment is active.

#### Scenario: Windows Known Folder discovery is unavailable after installer smoke

- **WHEN** a desktop smoke launches with
  `KUN_PACKAGED_EXTENSION_DESKTOP_SMOKE=1` and a non-empty `APPDATA`
- **THEN** main bootstrap SHALL call `app.setPath('appData', APPDATA)` before the
  first `app.getPath('appData')`
- **AND** an isolated smoke without `APPDATA` SHALL fail closed
- **AND** an ordinary application launch SHALL not override Electron's `appData`
  path
