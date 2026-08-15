'use strict'

const assert = require('node:assert/strict')
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const test = require('node:test')
const {
  MIB,
  MAC_ARM64_BUDGETS,
  buildReport,
  parseArgs,
  packagedAppPath,
  budgetFailures,
  formatBytes
} = require('./check-package-size.cjs')

test('resolves platform-specific unpacked application paths', () => {
  assert.match(packagedAppPath('/dist', 'darwin', 'arm64'), /mac-arm64[\\/]Kun\.app$/u)
  assert.match(packagedAppPath('/dist', 'darwin', 'x64'), /mac[\\/]Kun\.app$/u)
  assert.match(packagedAppPath('/dist', 'win32', 'x64'), /win-unpacked$/u)
  assert.match(packagedAppPath('/dist', 'linux', 'x64'), /linux-unpacked$/u)
  assert.match(packagedAppPath('/dist', 'linux', 'arm64'), /linux-arm64-unpacked$/u)
})

test('parses explicit report and enforcement arguments', () => {
  const distDir = join(tmpdir(), 'kun-package-size-dist')
  assert.deepEqual(
    parseArgs(['--platform', 'darwin', '--arch', 'arm64', '--dist-dir', distDir, '--enforce']),
    {
      platform: 'darwin',
      arch: 'arm64',
      distDir: resolve(distDir),
      enforce: true
    }
  )
})

test('enforces all macOS arm64 application and artifact budgets', () => {
  const report = {
    platform: 'darwin',
    arch: 'arm64',
    appBytes: MAC_ARM64_BUDGETS.app + 1,
    artifacts: [
      { name: 'Kun-test-mac-arm64.dmg', extension: '.dmg', bytes: MAC_ARM64_BUDGETS.dmg + 1 },
      { name: 'Kun-test-mac-arm64.zip', extension: '.zip', bytes: MAC_ARM64_BUDGETS.zip + 1 }
    ]
  }
  assert.equal(budgetFailures(report).length, 3)
  assert.deepEqual(
    budgetFailures({ ...report, platform: 'linux', artifacts: [] }),
    []
  )
})

test('formats binary package sizes explicitly', () => {
  assert.equal(formatBytes(1.5 * MIB), '1.5 MiB')
})

test('reports root and Kun dependencies plus aggregate extra resources', (t) => {
  const distDir = mkdtempSync(join(tmpdir(), 'kun-package-size-'))
  t.after(() => rmSync(distDir, { recursive: true, force: true }))
  const resources = join(distDir, 'mac-arm64', 'Kun.app', 'Contents', 'Resources')
  const files = [
    ['app.asar', 11],
    ['app.asar.unpacked/node_modules/runtime.js', 13],
    ['app.asar.unpacked/kun/node_modules/runtime.js', 17],
    ['officecli/officecli', 19],
    ['whisper/darwin-arm64/whisper-cli', 23],
    ['bundled-extensions/catalog.json', 29],
    ['THIRD_PARTY_NOTICES.md', 31]
  ]
  for (const [relativePath, bytes] of files) {
    const path = join(resources, relativePath)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, Buffer.alloc(bytes))
  }

  const report = buildReport({
    platform: 'darwin',
    arch: 'arm64',
    distDir
  })
  const componentBytes = Object.fromEntries(
    report.components.map(({ name, bytes }) => [name, bytes])
  )
  assert.equal(componentBytes['root-unpacked-node_modules'], 13)
  assert.equal(componentBytes['kun-unpacked-node_modules'], 17)
  assert.equal(componentBytes['extra-resources'], 19 + 23 + 29 + 31)
})
