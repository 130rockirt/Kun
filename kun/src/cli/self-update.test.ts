import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkStandaloneTuiUpdate,
  checkStandaloneTuiUpdateOnce,
  parseTuiUpdateManifest,
  runSelfUpdateCommand,
  standaloneTuiTarget,
  type StandaloneTuiReleaseMetadata
} from './self-update.js'

const roots: string[] = []
const BUILD_ID = 'a'.repeat(64)
const COMMIT = 'b'.repeat(40)
const HOST_TARGET = standaloneTuiTarget() ?? 'linux-x64'

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('standalone TUI self-update', () => {
  it('maps only the release target matrix', () => {
    expect(standaloneTuiTarget('darwin', 'arm64')).toBe('darwin-arm64')
    expect(standaloneTuiTarget('darwin', 'x64')).toBe('darwin-x64')
    expect(standaloneTuiTarget('linux', 'x64')).toBe('linux-x64')
    expect(standaloneTuiTarget('win32', 'x64')).toBe('win32-x64')
    expect(standaloneTuiTarget('linux', 'arm64')).toBeUndefined()
  })

  it('accepts a stable manifest only when it matches the shared release contract', () => {
    const current = release()
    const manifest = parseTuiUpdateManifest(latest(), current)
    expect(manifest.version).toBe('1.2.4')
    expect(manifest.artifacts).toHaveLength(4)
    expect(() => parseTuiUpdateManifest(
      { ...latest(), channel: 'frontier' },
      current
    )).toThrow(/unsupported release contract/)
  })

  it('reports a newer GUI-shared stable version for the installed target', async () => {
    const root = await standaloneRoot(release())
    const result = await checkStandaloneTuiUpdate({
      env: { KUN_STANDALONE_ROOT: root },
      fetch: async () => Response.json(latest())
    })
    expect(result).toMatchObject({
      available: true,
      current: { version: '1.2.3' },
      latest: { version: '1.2.4' },
      artifact: { target: HOST_TARGET }
    })
  })

  it('does not expose self-update from the GUI-bundled TUI', async () => {
    let stderr = ''
    const code = await runSelfUpdateCommand(['--check'], {
      stdout: { write: () => undefined },
      stderr: { write: (chunk) => { stderr += chunk } },
      env: {}
    })
    expect(code).toBe(69)
    expect(stderr).toContain('bundled with Kun GUI')
  })

  it('does not write standalone update state for the GUI-bundled TUI', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-gui-update-state-test-'))
    roots.push(dataDir)
    await expect(checkStandaloneTuiUpdateOnce({
      env: {},
      dataDir,
      fetch: async () => {
        throw new Error('GUI-bundled TUI must not fetch standalone updates')
      }
    })).resolves.toBeNull()
    await expect(readFile(join(dataDir, 'tui-update-check.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('requires explicit confirmation before downloading an available update', async () => {
    const root = await standaloneRoot(release())
    let stdout = ''
    let requests = 0
    const code = await runSelfUpdateCommand([], {
      stdout: { write: (chunk) => { stdout += chunk } },
      stderr: { write: () => undefined },
      env: { KUN_STANDALONE_ROOT: root },
      fetch: async () => {
        requests += 1
        return Response.json(latest())
      }
    })
    expect(code).toBe(10)
    expect(stdout).toContain('kun update --yes')
    expect(requests).toBe(1)
  })

  it.skipIf(process.platform === 'win32')(
    'installs an authenticated archive and keeps a rollback copy after confirmation',
    async () => {
      const target = standaloneTuiTarget()
      expect(target).toBeTruthy()
      const parent = await mkdtemp(join(tmpdir(), 'kun-self-update-install-'))
      roots.push(parent)
      const currentRoot = join(parent, 'kun')
      await mkdir(currentRoot)
      await writeFile(
        join(currentRoot, 'release.json'),
        `${JSON.stringify(release({ target }))}\n`,
        'utf8'
      )
      const archive = await updateArchive(parent, target!)
      const bytes = await readFile(archive)
      const next = latest()
      const selected = next.artifacts.find((artifact) => artifact.target === target)!
      selected.size = bytes.length
      selected.sha256 = createHash('sha256').update(bytes).digest('hex')
      let output = ''
      const code = await runSelfUpdateCommand(['--yes'], {
        stdout: { write: (chunk) => { output += chunk } },
        stderr: { write: () => undefined },
        env: { KUN_STANDALONE_ROOT: currentRoot },
        fetch: async (url) => String(url).endsWith('latest-tui.json')
          ? Response.json(next)
          : new Response(bytes)
      })
      expect(code).toBe(0)
      expect(output).toContain('1.2.4 installed')
      expect(JSON.parse(await readFile(join(currentRoot, 'release.json'), 'utf8')))
        .toMatchObject({ version: '1.2.4', target })
      expect(JSON.parse(await readFile(`${currentRoot}.previous/release.json`, 'utf8')))
        .toMatchObject({ version: '1.2.3', target })
    },
    30_000
  )

  it('throttles startup checks for 24 hours', async () => {
    const root = await standaloneRoot(release())
    const dataDir = join(root, 'data')
    let requests = 0
    const fetch = async () => {
      requests += 1
      return Response.json(latest())
    }
    const first = await checkStandaloneTuiUpdateOnce({
      env: { KUN_STANDALONE_ROOT: root },
      dataDir,
      fetch,
      now: Date.parse('2026-07-29T00:00:00.000Z')
    })
    const second = await checkStandaloneTuiUpdateOnce({
      env: { KUN_STANDALONE_ROOT: root },
      dataDir,
      fetch,
      now: Date.parse('2026-07-29T01:00:00.000Z')
    })
    expect(first?.available).toBe(true)
    expect(second).toBeNull()
    expect(requests).toBe(1)
    expect(JSON.parse(await readFile(join(dataDir, 'tui-update-check.json'), 'utf8')))
      .toMatchObject({ currentVersion: '1.2.3', latestVersion: '1.2.4', available: true })
  })
})

function release(
  overrides: Partial<StandaloneTuiReleaseMetadata> = {}
): StandaloneTuiReleaseMetadata {
  return {
    schemaVersion: 1,
    component: 'tui',
    version: '1.2.3',
    artifactVersion: '1.2.3',
    tag: 'v1.2.3',
    channel: 'stable',
    target: HOST_TARGET,
    buildId: BUILD_ID,
    commit: COMMIT,
    updateEnabled: true,
    updateManifestUrl: 'https://downloads.example.test/latest-tui.json',
    ...overrides
  }
}

function latest() {
  return {
    schemaVersion: 1,
    productName: 'Kun',
    component: 'tui',
    version: '1.2.4',
    artifactVersion: '1.2.4',
    tag: 'v1.2.4',
    channel: 'stable',
    commit: COMMIT,
    buildId: BUILD_ID,
    releaseDate: '2026-07-29T00:00:00.000Z',
    generatedAt: '2026-07-29T00:00:00.000Z',
    githubReleaseUrl: 'https://github.com/KunAgent/Kun/releases/tag/v1.2.4',
    artifacts: [
      artifact('darwin-arm64', 'mac', 'arm64', 'tar.gz'),
      artifact('darwin-x64', 'mac', 'x64', 'tar.gz'),
      artifact('linux-x64', 'linux', 'x64', 'tar.gz'),
      artifact('win32-x64', 'win', 'x64', 'zip')
    ]
  }
}

function artifact(target: string, os: string, arch: string, format: string) {
  const fileName = `Kun-TUI-1.2.4-${os}-${arch}.${format}`
  return {
    target,
    platform: target.split('-')[0],
    os,
    arch,
    format,
    fileName,
    size: 123,
    sha256: 'c'.repeat(64),
    nodeVersion: '22.23.1',
    url: `https://downloads.example.test/${fileName}`
  }
}

async function standaloneRoot(metadata: StandaloneTuiReleaseMetadata): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kun-self-update-test-'))
  roots.push(root)
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'release.json'), `${JSON.stringify(metadata)}\n`, 'utf8')
  return root
}

async function updateArchive(parent: string, target: string): Promise<string> {
  const stage = join(parent, 'next')
  const root = join(stage, 'kun')
  const node = join(root, 'runtime', 'node')
  const entry = join(root, 'app', 'kun', 'dist', 'cli', 'serve-entry.js')
  await mkdir(join(entry, '..'), { recursive: true })
  await mkdir(join(root, 'runtime'), { recursive: true })
  await copyFile(process.execPath, node)
  await chmod(node, 0o755)
  await writeFile(
    entry,
    "if (process.argv.includes('--version')) process.stdout.write('kun 1.2.4\\n')\n",
    'utf8'
  )
  await writeFile(
    join(root, 'release.json'),
    `${JSON.stringify(release({
      version: '1.2.4',
      artifactVersion: '1.2.4',
      tag: 'v1.2.4',
      target,
      buildId: BUILD_ID,
      commit: COMMIT
    }))}\n`,
    'utf8'
  )
  const archive = join(parent, `Kun-TUI-1.2.4-${targetName(target)}`)
  execFileSync('tar', ['-czf', archive, '-C', stage, 'kun'])
  return archive
}

function targetName(target: string): string {
  if (target === 'darwin-arm64') return 'mac-arm64.tar.gz'
  if (target === 'darwin-x64') return 'mac-x64.tar.gz'
  if (target === 'linux-x64') return 'linux-x64.tar.gz'
  throw new Error(`Unsupported Unix test target: ${target}`)
}
