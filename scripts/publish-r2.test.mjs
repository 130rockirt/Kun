import assert from 'node:assert/strict'
import test from 'node:test'
import { collectRequiredSidecarAssets } from './publish-r2.mjs'

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
