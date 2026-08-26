'use strict'

const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const test = require('node:test')
const {
  NEGATIVE_SCENARIOS,
  POSITIVE_SCENARIOS,
  buildSmokeSettings,
  parseSmokeMarker,
  predecessorBuildId,
  runtimeBuildIdForFlavor
} = require('./smoke-packaged-update-handoff-support.cjs')
const {
  FAILED_PREFIX,
  READY_PREFIX,
  positiveIntegerArgument
} = require('./smoke-packaged-update-handoff.cjs')
const {
  platformDesktopArguments
} = require('./smoke-packaged-extension-desktop-runtime.cjs')

test('release matrix covers both update paths, active work, and auto-start off', () => {
  assert.deepEqual(POSITIVE_SCENARIOS.map((scenario) => scenario.name), [
    'external-auto-on-active',
    'in-app-auto-on',
    'external-auto-off'
  ])
  assert(POSITIVE_SCENARIOS.some((scenario) => scenario.path === 'external'))
  assert(POSITIVE_SCENARIOS.some((scenario) => scenario.path === 'in-app'))
  assert(POSITIVE_SCENARIOS.some((scenario) => scenario.activeWork))
  assert(POSITIVE_SCENARIOS.some((scenario) => scenario.autoStart === false))
})

test('negative release matrix names every fail-closed ownership case', () => {
  assert.deepEqual(NEGATIVE_SCENARIOS, [
    'pid-port-reuse',
    'non-kun-command',
    'changed-discovery-identity',
    'inspection-denied'
  ])
})

test('synthetic predecessor and development flavor use distinct stable build IDs', () => {
  const candidate = 'b'.repeat(64)
  const predecessor = predecessorBuildId(candidate)
  assert.match(predecessor, /^[a-f0-9]{64}$/u)
  assert.notEqual(predecessor, candidate)
  assert.equal(runtimeBuildIdForFlavor(predecessor, 'production'), predecessor)
  assert.match(runtimeBuildIdForFlavor(predecessor, 'development'), /^[a-f0-9]{64}$/u)
  assert.notEqual(runtimeBuildIdForFlavor(predecessor, 'development'), predecessor)
})

test('profile settings preserve explicit auto-start policy and canonical data scope', () => {
  const settings = buildSmokeSettings({
    dataDir: '/profile/data',
    port: 18899,
    runtimeToken: 'token',
    workspaceRoot: '/workspace',
    baseUrl: 'http://127.0.0.1:4000',
    autoStart: false
  })
  assert.equal(settings.agents.kun.autoStart, false)
  assert.equal(settings.agents.kun.dataDir, '/profile/data')
  assert.equal(settings.agents.kun.port, 18899)
})

test('acceptance and recovery markers are machine-readable', () => {
  assert.deepEqual(parseSmokeMarker(
    `noise\n${READY_PREFIX}{"postcondition":"drained"}\n`,
    READY_PREFIX
  ), { postcondition: 'drained' })
  assert.deepEqual(parseSmokeMarker(
    `${FAILED_PREFIX}{"retryable":false,"phase":"stop-runtimes"}\n`,
    FAILED_PREFIX
  ), { retryable: false, phase: 'stop-runtimes' })
})

test('timeout parser rejects invalid release gate values', () => {
  const original = process.argv
  try {
    process.argv = ['node', 'smoke', '--timeout-ms', '0']
    assert.throws(() => positiveIntegerArgument('--timeout-ms', 100), /positive integer/)
    process.argv = ['node', 'smoke']
    assert.equal(positiveIntegerArgument('--timeout-ms', 100), 100)
  } finally {
    process.argv = original
  }
})

test('Linux release handoff gates exercise the Chromium sandbox', () => {
  for (const workflow of [
    '.github/workflows/release.yml',
    '.github/workflows/pr-checks.yml',
    '.github/workflows/daily-dev-prerelease.yml'
  ]) {
    const source = readFileSync(join(process.cwd(), workflow), 'utf8')
    assert.doesNotMatch(source, /KUN_SMOKE_DISABLE_SANDBOX/u)
    assert.match(source, /kernel\.apparmor_restrict_unprivileged_userns=0/u)
  }
})

test('linux desktop smoke keeps the sandbox on unless CI explicitly opts out', () => {
  assert.deepEqual(platformDesktopArguments('linux'), ['--disable-gpu', '--disable-dev-shm-usage'])
  assert.deepEqual(platformDesktopArguments('darwin'), [])
  assert.deepEqual(platformDesktopArguments('win32'), [])

  const previous = process.env.KUN_SMOKE_DISABLE_SANDBOX
  try {
    process.env.KUN_SMOKE_DISABLE_SANDBOX = '1'
    assert.deepEqual(platformDesktopArguments('linux'), [
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-sandbox'
    ])
    assert.deepEqual(platformDesktopArguments('darwin'), [])
  } finally {
    if (previous === undefined) delete process.env.KUN_SMOKE_DISABLE_SANDBOX
    else process.env.KUN_SMOKE_DISABLE_SANDBOX = previous
  }
})
