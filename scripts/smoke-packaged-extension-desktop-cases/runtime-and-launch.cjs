'use strict'

const assert = require('node:assert/strict')
const { mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { mkdtemp, readFile } = require('node:fs/promises')
const { createServer } = require('node:net')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const test = require('node:test')
const { parse: parseYaml } = require('yaml')
const {
  EXTENSION_ID,
  PACKAGED_EXTENSION_SMOKE_SUCCESS_MARKER,
  assertPackagedSmokeChildResult,
  createPackagedExtensionSmokeReexecEnvironment,
  installSmokeExtensionFixture,
  packagedResourceCandidates,
  resolvedPackagedResourceCandidates,
  smokeWebviewCsp
} = require('../smoke-packaged-extensions.cjs')
const {
  CdpConnection,
  CONTRIBUTION_ID,
  WEBVIEW_MARKER,
  assertGuestSecurityResult,
  createDesktopLaunchPlan,
  createIsolatedEnvironment,
  desktopApplicationEntry,
  desktopResourceCandidates,
  desktopSmokeSettings,
  desktopSmokeWorkspaceParent,
  desktopUserDataCandidates,
  findUnexpectedPopupTargets,
  hasWorkbenchContribution,
  WORKBENCH_DISCOVERY_RETRY_DELAYS_MS,
  runGuestAsyncInspection,
  sendToGuestSession,
  synchronizeWorkbenchContributionDiscovery,
  waitForSuccessfulGuestInspection,
  isExtensionGuestTarget,
  isWorkbenchTarget,
  isVerifiedIsolatedKunCommand,
  platformDesktopArguments,
  resolvedDesktopResourceCandidates,
  resolveDesktopLaunchSelection,
  runPackagedKun,
  terminateProcessTree,
  waitForPortsClosed
} = require('../smoke-packaged-extension-desktop.cjs')
const {
  withTimeout: withGraphWorkbenchTimeout
} = require('../smoke-development-graph-workbench.cjs')

const root = resolve(__dirname, '../..')
const linuxUserNamespaceStepName = 'Prepare and verify Linux user namespace sandbox'
const linuxUserNamespaceSetup = [
  'if [[ -e /proc/sys/kernel/unprivileged_userns_clone ]]; then',
  '  sudo sysctl -w kernel.unprivileged_userns_clone=1',
  'fi',
  'if [[ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]]; then',
  '  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0',
  'fi',
  'unshare --user --map-root-user /bin/true'
].join('\n')

function readDesktopSmokeSource() {
  return [
    'smoke-packaged-extension-desktop.cjs',
    'smoke-packaged-extension-desktop-runtime.cjs',
    'smoke-packaged-extension-desktop-cdp.cjs',
    'smoke-packaged-extension-desktop-guest.cjs',
    'smoke-packaged-extension-desktop-media.cjs',
    'smoke-packaged-extension-desktop-process.cjs'
  ].map((name) => readFileSync(join(root, 'scripts', name), 'utf8')).join('\n')
}

test('forces headless packaged runtime smokes onto the encrypted file-key fallback', () => {
  const environment = createPackagedExtensionSmokeReexecEnvironment({
    PATH: '/usr/bin',
    KUN_DISABLE_OS_CREDENTIAL_STORE: '0'
  })
  assert.equal(environment.PATH, '/usr/bin')
  assert.equal(environment.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(environment.KUN_DISABLE_OS_CREDENTIAL_STORE, '1')
  assert.equal(environment.KUN_PACKAGED_EXTENSION_SMOKE_REEXEC, '1')
})

test('bounds Graph workbench browser operations', async () => {
  assert.equal(
    await withGraphWorkbenchTimeout(Promise.resolve('completed'), 100, 'running fixture'),
    'completed'
  )
  await assert.rejects(
    withGraphWorkbenchTimeout(
      new Promise(() => undefined),
      10,
      'running a stalled fixture'
    ),
    /Timed out while running a stalled fixture/
  )
})

test('stops the isolated Graph runtime before reporting smoke success', () => {
  const source = readFileSync(
    join(root, 'scripts', 'smoke-development-graph-workbench.cjs'),
    'utf8'
  )
  const stopCall = source.indexOf('stopIsolatedSharedRuntime(repositoryRoot, profile)')
  const removeCall = source.indexOf('rm(temporaryRoot')
  const successWrite = source.indexOf('process.stdout.write(`${JSON.stringify(result')
  assert.ok(stopCall > 0, 'Graph smoke must stop its data-dir scoped shared Runtime')
  assert.ok(removeCall > stopCall, 'Graph smoke must stop its shared Runtime before removing its profile')
  assert.ok(successWrite > removeCall, 'Graph smoke must report success only after cleanup completes')
  assert.match(source, /stopIsolatedServiceManager\(home, profile\)/u)
})

test('only recognizes data-dir scoped Kun smoke Runtime and Manager commands', () => {
  const profile = join(root, '.tmp', 'kun-packaged-smoke', 'home', '.kun', 'data')
  const unrelatedProfile = join(root, '.tmp', 'another-kun-smoke', 'home', '.kun', 'data')
  assert.equal(isVerifiedIsolatedKunCommand({
    command: `Kun Helper /app/kun/dist/cli/serve-entry.js serve --data-dir ${profile}`,
    kind: 'runtime',
    expectedDataDir: profile
  }), true)
  assert.equal(isVerifiedIsolatedKunCommand({
    command: `/app/kun/dist/cli/serve-entry.js serve --data-dir ${unrelatedProfile}`,
    kind: 'runtime',
    expectedDataDir: profile
  }), false)
  assert.equal(isVerifiedIsolatedKunCommand({
    command: '/app/kun/dist/manager/manager-entry.js',
    kind: 'manager',
    expectedDataDir: profile,
    discoveryDataDir: profile
  }), true)
  assert.equal(isVerifiedIsolatedKunCommand({
    command: '/app/kun/dist/manager/manager-entry.js',
    kind: 'manager',
    expectedDataDir: profile,
    discoveryDataDir: unrelatedProfile
  }), false)
})

test('stops the isolated packaged Runtime before reporting desktop smoke success', () => {
  const source = readDesktopSmokeSource()
  const stopCall = source.indexOf('stopIsolatedSharedRuntime(unpackedRoot, profile)')
  const removeCall = source.indexOf('rm(path')
  const successWrite = source.indexOf('process.stdout.write(successMessage)')
  assert.ok(stopCall > 0, 'packaged desktop smoke must stop its data-dir scoped shared Runtime')
  assert.ok(removeCall > stopCall, 'packaged desktop smoke must stop its shared Runtime before removing its profile')
  assert.ok(successWrite > removeCall, 'packaged desktop smoke must report success only after cleanup completes')
  assert.match(source, /await stopSharedRuntime\(profile\)/u)
  const gracefulRuntimeExitWait = source.indexOf('await waitForPidExit(owner.pid, 5_000)')
  const runtimeTerminationFallback = source.indexOf("kind: 'runtime'")
  assert.ok(gracefulRuntimeExitWait > stopCall, 'desktop smoke must allow its Runtime to exit after shutdown')
  assert.ok(runtimeTerminationFallback > gracefulRuntimeExitWait, 'desktop smoke must only force-stop a Runtime after the exit wait')
  assert.match(source, /stopIsolatedServiceManager\(home, profile\)/u)
  assert.match(source, /Refusing to terminate unverified PID/u)
})

test('keeps the packaged desktop smoke isolated from networked GUI update checks', () => {
  const source = ['index.ts', 'main-lifecycle.ts']
    .map((name) => readFileSync(join(root, 'src', 'main', name), 'utf8'))
    .join('\n')
  assert.match(
    source,
    /function isPackagedExtensionDesktopSmoke\(\): boolean \{\s+return process\.env\.KUN_PACKAGED_EXTENSION_DESKTOP_SMOKE === '1'\s+\}/u
  )
  assert.match(
    source,
    /if \(isPackagedExtensionDesktopSmoke\(\)\) return import\('\.\/gui-updater'\)/u
  )
})

test('selects host-native packaged resources and never launches desktop Electron as Node', () => {
  assert.deepEqual(platformDesktopArguments('linux'), [
    '--disable-gpu',
    '--disable-dev-shm-usage'
  ])
  assert.equal(platformDesktopArguments('linux').includes('--disable-setuid-sandbox'), false)
  assert.equal(platformDesktopArguments('linux').includes('--no-sandbox'), false)
  assert.deepEqual(platformDesktopArguments('darwin'), [])
  assert.deepEqual(desktopResourceCandidates('darwin', 'arm64'), ['dist/mac-arm64/Kun.app/Contents/Resources'])
  assert.deepEqual(desktopResourceCandidates('darwin', 'x64'), ['dist/mac/Kun.app/Contents/Resources'])
  assert.deepEqual(desktopResourceCandidates('win32', 'x64'), ['dist/win-unpacked/resources'])
  assert.deepEqual(desktopResourceCandidates('linux', 'x64'), ['dist/linux-unpacked/resources'])
  assert.deepEqual(packagedResourceCandidates('darwin', 'arm64'), ['dist/mac-arm64/Kun.app/Contents/Resources'])
  assert.deepEqual(packagedResourceCandidates('darwin', 'x64'), ['dist/mac/Kun.app/Contents/Resources'])
  const workspaceRoot = resolve('/workspace')
  const macArm64Resources = resolve(
    workspaceRoot,
    'dist/mac-arm64/Kun.app/Contents/Resources'
  )
  assert.deepEqual(resolvedPackagedResourceCandidates('darwin', 'arm64', workspaceRoot), [
    macArm64Resources
  ])
  assert.deepEqual(resolvedDesktopResourceCandidates('darwin', 'arm64', workspaceRoot), [
    macArm64Resources
  ])
  assert.equal(desktopApplicationEntry('/packaged/Resources', '/packaged/Kun', '/packaged/Kun'), undefined)
  assert.equal(
    desktopApplicationEntry('/packaged/Resources', '/host/Electron', '/packaged/Kun'),
    join('/packaged/Resources', 'app.asar')
  )
  const smokeSettings = desktopSmokeSettings(
    43123,
    '/isolated-home/.kun/default_workspace',
    '/isolated-home/.kun/data'
  )
  assert.equal(smokeSettings.workspaceRoot, '/isolated-home/.kun/default_workspace')
  assert.equal(smokeSettings.agents.kun.dataDir, '/isolated-home/.kun/data')
  assert.throws(
    () => desktopSmokeSettings(43123, '/workspace', '~/.kun/data'),
    /dataDir must be absolute/
  )
  assert.equal(
    desktopSmokeWorkspaceParent('/source-checkout'),
    join('/source-checkout', 'dist', '.kun-desktop-smoke')
  )
  assert.deepEqual(
    desktopUserDataCandidates({
      platform: 'linux',
      home: '/isolated-home',
      appData: '/isolated-app-data',
      explicitUserData: '/isolated-user-data'
    }),
    [
      '/isolated-user-data',
      join('/isolated-app-data', 'Kun'),
      join('/isolated-home', '.config', 'Kun')
    ]
  )

  const native = createDesktopLaunchPlan({
    executable: '/packaged/Kun',
    applicationArguments: ['--remote-debugging-port=12345'],
    environment: { ELECTRON_RUN_AS_NODE: '1', HOME: '/isolated' },
    platform: 'darwin',
    hasDisplay: false
  })
  assert.equal(native.command, '/packaged/Kun')
  assert.deepEqual(native.args, ['--remote-debugging-port=12345'])
  assert.equal(native.args.includes('--no-sandbox'), false)
  assert.equal(native.env.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(native.wrappedByXvfb, false)

  const linux = createDesktopLaunchPlan({
    executable: '/packaged/kun',
    applicationArguments: ['--remote-debugging-port=12345'],
    environment: {
      ELECTRON_RUN_AS_NODE: '1',
      KUN_DISABLE_OS_CREDENTIAL_STORE: '1'
    },
    platform: 'linux',
    hasDisplay: false,
    xvfbExecutable: '/usr/bin/xvfb-run'
  })
  assert.equal(linux.command, '/usr/bin/xvfb-run')
  assert.deepEqual(linux.args, ['-a', '-s', '-screen 0 1280x900x24', '/packaged/kun', '--remote-debugging-port=12345'])
  assert.equal(linux.env.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(linux.env.KUN_DISABLE_OS_CREDENTIAL_STORE, '1')
  assert.equal(linux.wrappedByXvfb, true)

  const isolated = createIsolatedEnvironment(
    {
      PATH: '/system/bin',
      ELECTRON_RENDERER_URL: 'http://localhost:5173',
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: '--require=/tmp/inject.cjs',
      KUN_RUNTIME_TOKEN: 'inherited-token',
      KUN_RUNTIME_PROVIDER_KIND: 'agent-sdk',
      KUN_CLAUDE_BINARY: '/tmp/claude',
      KUN_DISABLE_OS_CREDENTIAL_STORE: '0',
      DEEPSEEK_API_KEY: 'inherited-secret',
      DEEPSEEK_GUI_STARTUP_TRACE: '1'
    },
    {
      home: '/isolated-home',
      appData: '/isolated-app-data',
      localAppData: '/isolated-local-app-data',
      temporaryDirectory: '/isolated-tmp'
    }
  )
  assert.equal(isolated.PATH, '/system/bin')
  assert.equal(isolated.HOME, '/isolated-home')
  assert.equal(isolated.NODE_ENV, 'production')
  assert.equal(isolated.KUN_PACKAGED_EXTENSION_DESKTOP_SMOKE, '1')
  assert.equal(isolated.KUN_DISABLE_OS_CREDENTIAL_STORE, '1')
  assert.equal(isolated.NO_AT_BRIDGE, '1')
  for (const key of [
    'ELECTRON_RENDERER_URL',
    'ELECTRON_RUN_AS_NODE',
    'NODE_OPTIONS',
    'KUN_RUNTIME_TOKEN',
    'KUN_RUNTIME_PROVIDER_KIND',
    'KUN_CLAUDE_BINARY',
    'DEEPSEEK_API_KEY',
    'DEEPSEEK_GUI_STARTUP_TRACE'
  ]) {
    assert.equal(isolated[key], undefined, `desktop environment retained override ${key}`)
  }
})

test('selects an explicit self-contained desktop executable without replacing the CLI runtime', async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'kun-desktop-executable-selection-test-'))
  t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }))
  const resourcesDir = join(temporaryRoot, 'resources')
  const runtimeExecutable = join(temporaryRoot, 'host-electron')
  const packagedRuntimeExecutable = join(temporaryRoot, 'packaged-kun')
  const appImage = join(temporaryRoot, 'Kun.AppImage')
  writeFileSync(appImage, 'self-contained AppImage fixture\n')

  assert.deepEqual(resolveDesktopLaunchSelection({
    resourcesDir,
    runtimeExecutable,
    packagedRuntimeExecutable,
    desktopExecutable: appImage
  }), {
    cliExecutable: runtimeExecutable,
    desktopExecutable: appImage,
    applicationEntry: undefined,
    selfContained: true
  })
})

test('rejects missing and non-file desktop executable overrides', async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'kun-desktop-executable-validation-test-'))
  t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }))
  const input = {
    resourcesDir: join(temporaryRoot, 'resources'),
    runtimeExecutable: join(temporaryRoot, 'host-electron'),
    packagedRuntimeExecutable: join(temporaryRoot, 'packaged-kun')
  }

  assert.throws(
    () => resolveDesktopLaunchSelection({
      ...input,
      desktopExecutable: join(temporaryRoot, 'missing.AppImage')
    }),
    /Desktop executable does not exist/
  )

  const directory = join(temporaryRoot, 'directory.AppImage')
  mkdirSync(directory)
  assert.throws(
    () => resolveDesktopLaunchSelection({ ...input, desktopExecutable: directory }),
    /Desktop executable is not a file/
  )
})

test('launches an AppImage override through Xvfb without an external app.asar or inherited overrides', async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'kun-appimage-launch-plan-test-'))
  t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }))
  const appImage = join(temporaryRoot, 'Kun.AppImage')
  writeFileSync(appImage, 'self-contained AppImage fixture\n')
  const selection = resolveDesktopLaunchSelection({
    resourcesDir: join(temporaryRoot, 'resources'),
    runtimeExecutable: join(temporaryRoot, 'host-electron'),
    packagedRuntimeExecutable: join(temporaryRoot, 'packaged-kun'),
    desktopExecutable: appImage
  })
  const launch = createDesktopLaunchPlan({
    executable: selection.desktopExecutable,
    applicationArguments: [
      ...(selection.applicationEntry ? [selection.applicationEntry] : []),
      '--remote-debugging-port=12345'
    ],
    environment: {
      HOME: '/isolated-home',
      APPIMAGE_EXTRACT_AND_RUN: '1',
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: '--require=/tmp/inject.cjs'
    },
    platform: 'linux',
    hasDisplay: false,
    xvfbExecutable: '/usr/bin/xvfb-run'
  })

  assert.equal(selection.cliExecutable, join(temporaryRoot, 'host-electron'))
  assert.equal(launch.command, '/usr/bin/xvfb-run')
  assert.deepEqual(launch.args, [
    '-a',
    '-s',
    '-screen 0 1280x900x24',
    appImage,
    '--remote-debugging-port=12345'
  ])
  assert.equal(launch.args.some((argument) => argument.endsWith('app.asar')), false)
  assert.equal(launch.env.HOME, '/isolated-home')
  assert.equal(launch.env.APPIMAGE_EXTRACT_AND_RUN, '1')
  assert.equal(launch.env.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(launch.env.NODE_OPTIONS, undefined)
  assert.equal(launch.wrappedByXvfb, true)
})

test('preserves default explicit-host Electron launch with the packaged app.asar', () => {
  const resourcesDir = join(tmpdir(), 'packaged', 'resources')
  const runtimeExecutable = join(tmpdir(), 'host', 'Electron')
  const packagedRuntimeExecutable = join(tmpdir(), 'packaged', 'Kun')

  assert.deepEqual(resolveDesktopLaunchSelection({
    resourcesDir,
    runtimeExecutable,
    packagedRuntimeExecutable
  }), {
    cliExecutable: runtimeExecutable,
    desktopExecutable: runtimeExecutable,
    applicationEntry: join(resourcesDir, 'app.asar'),
    selfContained: false
  })
})

test('requires proof that the packaged runtime child completed the full smoke', () => {
  assert.doesNotThrow(() =>
    assertPackagedSmokeChildResult({
      error: undefined,
      status: 0,
      signal: null,
      stdout: `${PACKAGED_EXTENSION_SMOKE_SUCCESS_MARKER}darwin): complete\n`
    })
  )
  assert.throws(
    () =>
      assertPackagedSmokeChildResult({
        error: undefined,
        status: 0,
        signal: null,
        stdout: ''
      }),
    /required completion marker/
  )
  assert.throws(
    () =>
      assertPackagedSmokeChildResult({
        error: undefined,
        status: null,
        signal: 'SIGKILL',
        stdout: ''
      }),
    /SIGKILL/
  )
})

test('exports and installs the shared .kunx smoke fixture with a Chromium body marker', async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'kun-desktop-smoke-fixture-test-'))
  t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }))
  const profile = join(temporaryRoot, 'profile')
  const calls = []
  const installedRoot = join(profile, 'extensions', EXTENSION_ID, '1.0.0')

  const fixture = await installSmokeExtensionFixture({
    temporaryRoot,
    profile,
    webviewConnectUrls: ['http://127.0.0.1:43123/extension-network-canary'],
    runCli: (args) => {
      calls.push(args)
      if (args[1] !== 'install') return
      mkdirSync(join(installedRoot, 'dist', 'webview'), { recursive: true })
      writeFileSync(join(installedRoot, 'kun-extension.json'), '{}\n')
      writeFileSync(join(installedRoot, 'dist', 'webview', 'index.html'), '<main>installed</main>\n')
    }
  })

  assert.equal(fixture.installedRoot, installedRoot)
  assert.deepEqual(
    calls.map((args) => args[1]),
    ['validate', 'pack', 'install']
  )
  const sourceWebview = await readFile(join(fixture.source, 'dist', 'webview', 'index.html'), 'utf8')
  assert.match(sourceWebview, /data-kun-packaged-webview-smoke="ready"/)
  assert.match(sourceWebview, new RegExp(WEBVIEW_MARKER))
  assert.match(sourceWebview, /connect-src http:\/\/127\.0\.0\.1:43123/)
  assert.equal(
    smokeWebviewCsp(),
    "default-src 'none'; style-src 'self'; img-src 'self' data: kun-media:; media-src 'self' kun-media:; connect-src 'none'"
  )
  assert.throws(() => smokeWebviewCsp(['https://example.com']), /explicit loopback origin/)
})
