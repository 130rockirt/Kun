import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import yazl from 'yazl'
import { assembleTuiRelease, readEmbeddedRelease } from './assemble-tui-release.mjs'

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
    await stageTargetArtifacts(directory, { legacy: false })

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
    const contract = JSON.parse(await readFile(join(directory, 'release-tui.json'), 'utf8'))
    assert.equal(contract.buildId, BUILD_ID)
    assert.equal(contract.artifacts.length, DEFINITIONS.length)

    const previousRelease = join(directory, 'previous-release-tui.json')
    await writeFile(previousRelease, JSON.stringify({ version: '1.2.2', buildId: BUILD_ID }))
    await assert.rejects(
      assembleTuiRelease({
        directory,
        version: '1.2.3',
        artifactVersion: '1.2.3',
        tag: 'v1.2.3',
        channel: 'stable',
        commit: COMMIT,
        expectedBuildId: BUILD_ID,
        previousRelease,
        publicBaseUrl: 'https://downloads.example.test',
        releasePrefix: 'deepseek-gui'
      }),
      /version changed from 1\.2\.2 to 1\.2\.3 but reused build id/
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

test('still assembles legacy flat-layout archives built before the pointer switch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'assemble-tui-release-legacy-'))
  try {
    await stageTargetArtifacts(directory, { legacy: true })
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
    assert.equal(release.artifacts.length, DEFINITIONS.length)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects archives that expose neither the pointer layout nor the legacy metadata member', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'assemble-tui-release-empty-'))
  try {
    const stage = join(directory, 'stage-empty')
    await mkdir(join(stage, 'kun'), { recursive: true })
    await writeFile(join(stage, 'kun', 'README.txt'), 'no release metadata here')
    for (const format of ['tar.gz', 'zip']) {
      const archive = join(directory, `empty.${format}`)
      if (format === 'zip') {
        const zip = new yazl.ZipFile()
        zip.addBuffer(Buffer.from('no release metadata here'), 'kun/README.txt')
        zip.end()
        await finished(zip, archive)
      } else {
        execFileSync('tar', ['-czf', archive, '-C', stage, 'kun'])
      }
      await assert.rejects(
        readEmbeddedRelease(archive),
        /Cannot read kun\/release\.json from empty\./
      )
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects a pointer that does not reference a release directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'assemble-tui-release-pointer-'))
  try {
    const stage = join(directory, 'stage-pointer')
    await mkdir(join(stage, 'kun'), { recursive: true })
    await writeFile(join(stage, 'kun', 'current'), 'shared/golden-build\n')
    const archive = join(directory, 'pointer.tar.gz')
    execFileSync('tar', ['-czf', archive, '-C', stage, 'kun'])
    await assert.rejects(
      readEmbeddedRelease(archive),
      /Invalid standalone TUI current pointer/
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('does not fall back to kun/release.json when a pointer is present but invalid', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'assemble-tui-release-no-fallback-'))
  try {
    const stage = join(directory, 'stage-no-fallback')
    await mkdir(join(stage, 'kun'), { recursive: true })
    await writeFile(join(stage, 'kun', 'current'), '../escape\n')
    await writeFile(join(stage, 'kun', 'release.json'), JSON.stringify(sampleRelease()))
    const archive = join(directory, 'no-fallback.tar.gz')
    execFileSync('tar', ['-czf', archive, '-C', stage, 'kun'])
    await assert.rejects(
      readEmbeddedRelease(archive),
      /Invalid standalone TUI current pointer/
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects a pointer whose release.json is missing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'assemble-tui-release-missing-meta-'))
  try {
    const stage = join(directory, 'stage-missing-meta')
    await mkdir(join(stage, 'kun'), { recursive: true })
    await writeFile(join(stage, 'kun', 'current'), `releases/${BUILD_ID}\n`)
    await writeFile(join(stage, 'kun', 'release.json'), JSON.stringify(sampleRelease()))
    const archive = join(directory, 'missing-meta.tar.gz')
    execFileSync('tar', ['-czf', archive, '-C', stage, 'kun'])
    await assert.rejects(
      readEmbeddedRelease(archive),
      new RegExp(`Cannot read kun/releases/${BUILD_ID}/release\\.json`)
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects a pointer that does not match the embedded build id', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'assemble-tui-release-mismatch-'))
  try {
    const otherBuildId = 'c'.repeat(64)
    const stage = join(directory, 'stage-mismatch')
    const releaseDir = join(stage, 'kun', 'releases', BUILD_ID)
    await mkdir(releaseDir, { recursive: true })
    await writeFile(join(stage, 'kun', 'current'), `releases/${BUILD_ID}\n`)
    await writeFile(
      join(releaseDir, 'release.json'),
      JSON.stringify(sampleRelease({ buildId: otherBuildId }))
    )
    const archive = join(directory, 'mismatch.tar.gz')
    execFileSync('tar', ['-czf', archive, '-C', stage, 'kun'])
    await assert.rejects(
      readEmbeddedRelease(archive),
      /Embedded TUI build id does not match current pointer/
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

function sampleRelease(overrides = {}) {
  return {
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
    nodeVersion: '22.23.1',
    updateEnabled: true,
    updateManifestUrl: 'https://downloads.example.test/latest-tui.json',
    ...overrides
  }
}

async function stageTargetArtifacts(directory, { legacy }) {
  for (const [target, platform, os, arch, format] of DEFINITIONS) {
    const fileName = `Kun-TUI-1.2.3-${os}-${arch}.${format}`
    const archive = join(directory, fileName)
    const release = sampleRelease({
      target,
      platform,
      os,
      arch,
      format
    })
    await createArchive(directory, archive, format, release, { legacy })
    const bytes = await readFile(archive)
    await writeFile(`${archive}.json`, JSON.stringify({
      fileName,
      size: (await stat(archive)).size,
      sha256: createHash('sha256').update(bytes).digest('hex')
    }))
  }
}

async function createArchive(directory, archive, format, release, { legacy }) {
  if (format === 'zip') {
    const zip = new yazl.ZipFile()
    if (legacy) {
      zip.addBuffer(Buffer.from(JSON.stringify(release)), 'kun/release.json')
    } else {
      zip.addBuffer(Buffer.from(`releases/${release.buildId}\n`), 'kun/current')
      zip.addBuffer(
        Buffer.from(`${JSON.stringify(release, null, 2)}\n`),
        `kun/releases/${release.buildId}/release.json`
      )
    }
    zip.end()
    await finished(zip, archive)
    return
  }
  const stage = join(directory, `stage-${release.target}`)
  if (legacy) {
    await mkdir(join(stage, 'kun'), { recursive: true })
    await writeFile(join(stage, 'kun', 'release.json'), JSON.stringify(release))
  } else {
    const releaseDir = join(stage, 'kun', 'releases', release.buildId)
    await mkdir(releaseDir, { recursive: true })
    await writeFile(join(stage, 'kun', 'current'), `releases/${release.buildId}\n`)
    await writeFile(join(releaseDir, 'release.json'), `${JSON.stringify(release, null, 2)}\n`)
  }
  execFileSync('tar', ['-czf', archive, '-C', stage, 'kun'])
}

function finished(zip, archive) {
  return new Promise((resolvePromise, reject) => {
    zip.outputStream
      .pipe(createWriteStream(archive))
      .on('error', reject)
      .on('close', resolvePromise)
  })
}
