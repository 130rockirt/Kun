import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import yazl from 'yazl'
import { assembleTuiRelease } from './assemble-tui-release.mjs'

const BUILD_ID = 'a'.repeat(64)
const COMMIT = 'b'.repeat(40)
const DEFINITIONS = [
  ['darwin-arm64', 'darwin', 'mac', 'arm64', 'tar.gz'],
  ['darwin-x64', 'darwin', 'mac', 'x64', 'tar.gz'],
  ['linux-arm64', 'linux', 'linux', 'arm64', 'tar.gz'],
  ['linux-x64', 'linux', 'linux', 'x64', 'tar.gz'],
  ['win32-x64', 'win32', 'win', 'x64', 'zip']
]

test('assembles tar and zip targets into one shared GUI/TUI release contract', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'assemble-tui-release-'))
  try {
    for (const [target, platform, os, arch, format] of DEFINITIONS) {
      const fileName = `Kun-TUI-1.2.3-${os}-${arch}.${format}`
      const archive = join(directory, fileName)
      const release = {
        schemaVersion: 1,
        productName: 'Kun',
        component: 'tui',
        version: '1.2.3',
        artifactVersion: '1.2.3',
        tag: 'v1.2.3',
        channel: 'stable',
        target,
        platform,
        os,
        arch,
        format,
        buildId: BUILD_ID,
        commit: COMMIT,
        nodeVersion: '22.23.1',
        updateEnabled: true,
        updateManifestUrl: 'https://downloads.example.test/latest-tui.json'
      }
      await createArchive(directory, archive, format, release)
      const bytes = await readFile(archive)
      await writeFile(`${archive}.json`, JSON.stringify({
        fileName,
        size: (await stat(archive)).size,
        sha256: createHash('sha256').update(bytes).digest('hex')
      }))
    }

    const release = await assembleTuiRelease({
      directory,
      version: '1.2.3',
      artifactVersion: '1.2.3',
      tag: 'v1.2.3',
      channel: 'stable',
      commit: COMMIT,
      expectedBuildId: BUILD_ID,
      publicBaseUrl: 'https://downloads.example.test',
      releasePrefix: 'deepseek-gui'
    })
    assert.equal(release.buildId, BUILD_ID)
    assert.deepEqual(
      release.artifacts.map((artifact) => artifact.target),
      DEFINITIONS.map(([target]) => target)
    )
    assert.match(
      await readFile(join(directory, 'SHA256SUMS-tui.txt'), 'utf8'),
      /Kun-TUI-1\.2\.3-win-x64\.zip/
    )

    await assert.rejects(
      assembleTuiRelease({
        directory,
        version: '1.2.3',
        artifactVersion: '1.2.3',
        tag: 'v1.2.3',
        channel: 'stable',
        commit: COMMIT,
        expectedBuildId: 'c'.repeat(64),
        publicBaseUrl: 'https://downloads.example.test',
        releasePrefix: 'deepseek-gui'
      }),
      /does not match the shared GUI runtime/
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

async function createArchive(directory, archive, format, release) {
  if (format === 'zip') {
    const zip = new yazl.ZipFile()
    zip.addBuffer(Buffer.from(JSON.stringify(release)), 'kun/release.json')
    zip.end()
    await new Promise((resolvePromise, reject) => {
      zip.outputStream
        .pipe(createWriteStream(archive))
        .on('error', reject)
        .on('close', resolvePromise)
    })
    return
  }
  const stage = join(directory, `stage-${release.target}`)
  await mkdir(join(stage, 'kun'), { recursive: true })
  await writeFile(join(stage, 'kun', 'release.json'), JSON.stringify(release))
  execFileSync('tar', ['-czf', archive, '-C', stage, 'kun'])
}
