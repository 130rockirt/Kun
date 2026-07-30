'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const {
  DISPLACED_THREAD_ID,
  LEGACY_THREAD_ID,
  RUNTIME_TOKEN,
  assertThreadIds,
  packagedUpgradeSettings,
  processState,
  runtimeConnectionFromDocument
} = require('./smoke-packaged-runtime-data-migration.cjs')

test('builds an upgraded profile that selects only the canonical legacy authority', () => {
  const settings = packagedUpgradeSettings(18899, '/workspace', '/home/.deepseekgui/kun')
  assert.equal(settings.agents.kun.dataDir, '/home/.deepseekgui/kun')
  assert.equal(settings.agents.kun.runtimeToken, RUNTIME_TOKEN)
  assert.equal(settings.agents.kun.autoStart, true)
})

test('requires both authoritative and salvaged histories in the packaged result', () => {
  assert.doesNotThrow(() => assertThreadIds(
    [{ id: LEGACY_THREAD_ID }, { id: DISPLACED_THREAD_ID }],
    [LEGACY_THREAD_ID, DISPLACED_THREAD_ID]
  ))
  assert.throws(
    () => assertThreadIds([{ id: LEGACY_THREAD_ID }], [LEGACY_THREAD_ID, DISPLACED_THREAD_ID]),
    /missing thr_packaged_upgrade_displaced/
  )
})

test('reports packaged process terminal states without signaling it', () => {
  assert.equal(processState(undefined), 'not-started')
  assert.equal(processState({ exitCode: null, signalCode: null }), 'running')
  assert.equal(processState({ exitCode: 1, signalCode: null }), 'exit-1')
  assert.equal(processState({ exitCode: null, signalCode: 'SIGTERM' }), 'signal-SIGTERM')
})

test('uses the elected shared Runtime connection instead of the legacy configured port', () => {
  assert.deepEqual(runtimeConnectionFromDocument({
    instanceId: 'runtime-smoke',
    launchMode: 'shared',
    pid: 1234,
    port: 62029,
    runtimeToken: 'elected-token'
  }), {
    instanceId: 'runtime-smoke',
    pid: 1234,
    port: 62029,
    token: 'elected-token'
  })
  assert.throws(
    () => runtimeConnectionFromDocument({
      instanceId: 'runtime-smoke',
      pid: 1234,
      port: 0,
      runtimeToken: 'token'
    }),
    /invalid port/
  )
  assert.throws(
    () => runtimeConnectionFromDocument({ pid: 1234, port: 62029, runtimeToken: 'token' }),
    /instance id/
  )
  assert.throws(
    () => runtimeConnectionFromDocument({
      instanceId: 'runtime-smoke',
      port: 62029,
      runtimeToken: 'token'
    }),
    /process id/
  )
})
