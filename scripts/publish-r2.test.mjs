import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  artifactVersionForTag,
  collectRequiredSidecarAssets,
  collectTuiRelease,
  releaseVersionForTag,
  validatePromotionContract
} from './publish-r2.mjs'

test('requires exactly one Linux deb sidecar matching the release tag', () => {
  assert.deepEqual(
    collectRequiredSidecarAssets({
      entries: [
        'Kun-1.2.3-linux-x86_64.AppImage',
        'Kun-1.2.3-linux-amd64.deb',
        'latest-linux.yml'
      ],
      platform: 'linux',
      tagVersion: '1.2.3'
    }),
    ['Kun-1.2.3-linux-amd64.deb']
  )

  for (const entries of [
    [],
    ['Kun-1.2.2-linux-amd64.deb'],
    ['Kun-1.2.2-linux-amd64.deb', 'Kun-1.2.3-linux-amd64.deb']
  ]) {
    assert.throws(
      () => collectRequiredSidecarAssets({ entries, platform: 'linux', tagVersion: '1.2.3' }),
      /Expected exactly one Linux deb sidecar named Kun-1\.2\.3-linux-amd64\.deb/
    )
  }
})

test('does not require Linux sidecars for other platforms', () => {
  assert.deepEqual(
    collectRequiredSidecarAssets({ entries: [], platform: 'mac', tagVersion: '1.2.3' }),
    []
  )
})

test('derives one GUI/TUI version pair from stable and Daily tags', () => {
  assert.equal(releaseVersionForTag('v1.2.3'), '1.2.3')
  assert.equal(artifactVersionForTag('v1.2.3'), '1.2.3')
  assert.equal(releaseVersionForTag('dev-20260729.1200'), '0.0.0-dev-20260729-1200')
  assert.equal(artifactVersionForTag('dev-20260729.1200'), '20260729.1200')
})

test('collects exactly four same-version standalone TUI targets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'publish-r2-tui-'))
  try {
    const definitions = [
      ['darwin-arm64', 'mac', 'arm64', 'tar.gz'],
      ['darwin-x64', 'mac', 'x64', 'tar.gz'],
      ['linux-x64', 'linux', 'x64', 'tar.gz'],
      ['win32-x64', 'win', 'x64', 'zip']
    ]
    const artifacts = []
    for (const [target, os, arch, format] of definitions) {
      const fileName = `Kun-TUI-1.2.3-${os}-${arch}.${format}`
      const bytes = Buffer.from(target)
      await writeFile(join(directory, fileName), bytes)
      artifacts.push({
        target,
        os,
        arch,
        format,
        fileName,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        nodeVersion: '22.23.1'
      })
    }
    await writeFile(join(directory, 'SHA256SUMS-tui.txt'), 'fixture\n')
    await writeFile(join(directory, 'release-tui.json'), JSON.stringify({
      schemaVersion: 1,
      component: 'tui',
      version: '1.2.3',
      artifactVersion: '1.2.3',
      tag: 'v1.2.3',
      channel: 'stable',
      artifacts,
      buildId: 'a'.repeat(64),
      commit: 'b'.repeat(40)
    }))
    const release = await collectTuiRelease({
      distDir: directory,
      tag: 'v1.2.3',
      channel: 'stable',
      config: {
        prefix: 'deepseek-gui',
        publicBaseUrl: 'https://downloads.example.test'
      }
    })
    assert.equal(release.files.length, 6)
    assert.deepEqual(
      release.manifest.artifacts.map((artifact) => artifact.target).sort(),
      definitions.map(([target]) => target).sort()
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('gates joint promotion on all GUI platforms and all four TUI targets', () => {
  const platforms = ['mac', 'win', 'linux']
  const platformManifests = platforms.map((platform) => ({
    version: '1.2.3',
    tag: 'v1.2.3',
    channel: 'stable',
    platform,
    files: [],
    downloads: []
  }))
  const tuiManifest = {
    version: '1.2.3',
    tag: 'v1.2.3',
    channel: 'stable',
    buildId: 'a'.repeat(64),
    artifacts: [
      { target: 'darwin-arm64' },
      { target: 'darwin-x64' },
      { target: 'linux-x64' },
      { target: 'win32-x64' }
    ]
  }
  assert.equal(validatePromotionContract({
    tag: 'v1.2.3',
    channel: 'stable',
    platforms,
    platformManifests,
    tuiManifest,
    requireTui: true
  }), '1.2.3')
  assert.throws(() => validatePromotionContract({
    tag: 'v1.2.3',
    channel: 'stable',
    platforms: ['mac', 'win'],
    platformManifests: platformManifests.slice(0, 2),
    tuiManifest,
    requireTui: true
  }), /requires mac, win, and linux/)
  assert.throws(() => validatePromotionContract({
    tag: 'v1.2.3',
    channel: 'stable',
    platforms,
    platformManifests,
    tuiManifest: {
      ...tuiManifest,
      artifacts: tuiManifest.artifacts.slice(0, 3)
    },
    requireTui: true
  }), /TUI manifest is incompatible/)
})
