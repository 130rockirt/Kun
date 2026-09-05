import assert from 'node:assert/strict'
import test from 'node:test'
import {
  TUI_NODE_VERSION,
  createTuiReleaseMetadata,
  flatLauncherScript,
  resolveNpmCliInvocation,
  resolveTuiTarget,
  tuiArtifactName
} from './package-tui.mjs'

const BUILD_ID = 'a'.repeat(64)
const COMMIT = 'b'.repeat(40)

test('maps the supported standalone TUI targets to canonical release names', () => {
  const targets = [
    [resolveTuiTarget('darwin', 'arm64'), 'Kun-TUI-1.2.3-mac-arm64.tar.gz'],
    [resolveTuiTarget('darwin', 'x64'), 'Kun-TUI-1.2.3-mac-x64.tar.gz'],
    [resolveTuiTarget('linux', 'arm64'), 'Kun-TUI-1.2.3-linux-arm64.tar.gz'],
    [resolveTuiTarget('linux', 'x64'), 'Kun-TUI-1.2.3-linux-x64.tar.gz'],
    [resolveTuiTarget('win32', 'x64'), 'Kun-TUI-1.2.3-win-x64.zip']
  ]
  for (const [target, expected] of targets) {
    assert.equal(tuiArtifactName('1.2.3', target), expected)
  }
})

test('rejects unsupported target architectures', () => {
  assert.throws(() => resolveTuiTarget('win32', 'arm64'), /Unsupported standalone TUI target/)
})

test('runs npm through Node instead of a Windows cmd shim', () => {
  assert.deepEqual(resolveNpmCliInvocation({
    execPath: 'C:\\node\\node.exe',
    npmExecPath: 'C:\\node\\node_modules\\npm\\bin\\npm-cli.js'
  }), {
    command: 'C:\\node\\node.exe',
    args: ['C:\\node\\node_modules\\npm\\bin\\npm-cli.js']
  })
  assert.throws(
    () => resolveNpmCliInvocation({ execPath: '/node', npmExecPath: '' }),
    /npm_execpath is required/
  )
})

test('creates release metadata from the shared GUI release version', () => {
  const metadata = createTuiReleaseMetadata({
    version: '1.2.3',
    artifactVersion: '1.2.3',
    tag: 'v1.2.3',
    channel: 'stable',
    target: resolveTuiTarget('linux', 'x64'),
    buildId: BUILD_ID,
    commit: COMMIT,
    updateManifestUrl: 'https://downloads.example.test/latest-tui.json'
  })

  assert.deepEqual(metadata, {
    schemaVersion: 1,
    productName: 'Kun',
    component: 'tui',
    version: '1.2.3',
    artifactVersion: '1.2.3',
    tag: 'v1.2.3',
    channel: 'stable',
    target: 'linux-x64',
    platform: 'linux',
    os: 'linux',
    arch: 'x64',
    format: 'tar.gz',
    buildId: BUILD_ID,
    commit: COMMIT,
    nodeVersion: TUI_NODE_VERSION,
    updateEnabled: true,
    updateManifestUrl: 'https://downloads.example.test/latest-tui.json'
  })
})

test('daily metadata shares the release version but disables self-update', () => {
  const metadata = createTuiReleaseMetadata({
    version: '0.0.0-dev-20260729-1200',
    artifactVersion: '20260729.1200',
    tag: 'dev-20260729.1200',
    channel: 'frontier',
    target: resolveTuiTarget('darwin', 'arm64'),
    buildId: BUILD_ID,
    commit: COMMIT,
    updateManifestUrl: 'https://downloads.example.test/latest-tui.json'
  })
  assert.equal(metadata.version, '0.0.0-dev-20260729-1200')
  assert.equal(metadata.updateEnabled, false)
})

test('rejects an independently versioned TUI tag', () => {
  assert.throws(() => createTuiReleaseMetadata({
    version: '1.2.3',
    artifactVersion: '1.2.3',
    tag: 'v1.2.4',
    channel: 'stable',
    target: resolveTuiTarget('linux', 'x64'),
    buildId: BUILD_ID,
    commit: COMMIT,
    updateManifestUrl: 'https://downloads.example.test/latest-tui.json'
  }), /must identify one joint release/)
})

test('flat launcher execs the runtime and entry point directly under the base', () => {
  const posix = flatLauncherScript('darwin')
  assert.ok(posix.includes('export KUN_STANDALONE_ROOT="$root"'))
  assert.ok(posix.includes('exec "$root/runtime/node" "$root/app/kun/dist/cli/serve-entry.js" "$@"'))
  assert.ok(!posix.includes('releases/'))
  assert.ok(!posix.includes('current'))

  const windows = flatLauncherScript('win32')
  assert.ok(windows.includes('set "KUN_STANDALONE_ROOT=%~dp0.."'))
  assert.ok(windows.includes('"%~dp0..\\runtime\\node.exe" "%~dp0..\\app\\kun\\dist\\cli\\serve-entry.js" %*'))
  assert.ok(!windows.includes('current'))
  assert.ok(!windows.includes('releases\\'))
})
