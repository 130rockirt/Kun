'use strict'

const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const test = require('node:test')
const {
  _internals: {
    parseArgs,
    readLock,
    assertManifestMatchesLock,
    normalizedArchivePath,
    assertRemoteRuntimeUrl,
    downloadRuntimeInput
  }
} = require('./prepare-open-connector-runtime.cjs')

test('pins the OpenConnector runtime archive and protocol contract', () => {
  const lock = readLock()
  assert.deepEqual(lock, {
    schemaVersion: 1,
    name: 'open-connector',
    version: '1.4.0',
    protocolVersion: '1',
    nodeRange: '>=22',
    entrypoint: 'dist/server/index.js',
    archive: {
      file: 'open-connector-runtime-1.4.0.tar.gz',
      sha256: '1275d22c83cabb16161f01cb7acfbe1a2ebb0c7696f3a3b5129d8bc7dbd6454f',
      sizeBytes: 12441728
    }
  })
})

test('requires an artifact manifest to exactly match the pinned runtime', () => {
  const lock = readLock()
  assert.doesNotThrow(() => assertManifestMatchesLock(lock, lock))
  assert.throws(
    () => assertManifestMatchesLock({ ...lock, protocolVersion: '2' }, lock),
    /does not match/
  )
})

test('rejects traversal and non-portable archive paths before extraction', () => {
  assert.equal(normalizedArchivePath('./dist/server/index.js'), 'dist/server/index.js')
  assert.equal(normalizedArchivePath('./'), '')
  for (const unsafePath of ['../runtime.json', '/tmp/runtime.json', 'dist\\server\\index.js', 'a/../runtime.json']) {
    assert.throws(() => normalizedArchivePath(unsafePath), /unsafe path/)
  }
})

test('accepts only explicit archive and manifest inputs', () => {
  assert.deepEqual(
    parseArgs(['--archive', '/tmp/runtime.tar.gz', '--manifest', '/tmp/manifest.json', '--force']),
    { archive: '/tmp/runtime.tar.gz', manifest: '/tmp/manifest.json', force: true }
  )
  assert.throws(() => parseArgs(['--source', '/tmp/open-connector']), /Unknown argument/)
})

test('accepts only credential-free HTTPS artifact URLs and bounds downloads', async () => {
  assert.equal(assertRemoteRuntimeUrl('https://downloads.example.test/runtime.tar.gz', 'archive'), 'https://downloads.example.test/runtime.tar.gz')
  for (const unsafe of ['http://downloads.example.test/runtime.tar.gz', 'https://user:pass@downloads.example.test/runtime.tar.gz', 'not-a-url']) {
    assert.throws(() => assertRemoteRuntimeUrl(unsafe, 'archive'), /HTTPS URL/)
  }
  const headers = new Headers({ 'content-length': '4' })
  const bytes = await downloadRuntimeInput({
    url: 'https://downloads.example.test/runtime.tar.gz',
    label: 'archive',
    maxBytes: 4,
    expectedBytes: 4,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      url: 'https://cdn.example.test/runtime.tar.gz',
      headers,
      arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer
    })
  })
  assert.deepEqual([...bytes], [1, 2, 3, 4])
})

test('wires public artifact URLs into every desktop packaging workflow', () => {
  for (const workflow of ['pr-checks.yml', 'release.yml', 'daily-dev-prerelease.yml']) {
    const source = readFileSync(join(__dirname, '..', '.github', 'workflows', workflow), 'utf8')
    assert.match(source, /KUN_OPENCONNECTOR_RUNTIME_ARCHIVE_URL: \$\{\{ vars\.KUN_OPENCONNECTOR_RUNTIME_ARCHIVE_URL \}\}/)
    assert.match(source, /KUN_OPENCONNECTOR_RUNTIME_MANIFEST_URL: \$\{\{ vars\.KUN_OPENCONNECTOR_RUNTIME_MANIFEST_URL \}\}/)
  }
})

test('keeps the Electron sidecar resolver aligned with runtime artifact metadata', () => {
  const source = readFileSync(join(__dirname, '..', 'src', 'main', 'connectors', 'open-connector-sidecar.ts'), 'utf8')
  assert.match(source, /join\(root, 'runtime\.json'\)/)
  assert.doesNotMatch(source, /join\(root, 'manifest\.json'\)/)
})
