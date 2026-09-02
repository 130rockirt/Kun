import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { runSelfUpdateCommand, standaloneTuiTarget } from './self-update.js'
import {
  tuiUpdateLogPath,
  tuiUpdateResultPath
} from './self-update-transaction.js'
import type { StandaloneTuiReleaseMetadata } from './self-update.js'

const BUILD_ID = 'a'.repeat(64)
const COMMIT = 'b'.repeat(40)

const children: ChildProcess[] = []
const roots: string[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    try {
      child.kill()
    } catch {
      // Already exited.
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function release(overrides: Partial<StandaloneTuiReleaseMetadata> = {}): StandaloneTuiReleaseMetadata {
  return {
    schemaVersion: 1,
    component: 'tui',
    version: '1.2.3',
    artifactVersion: '1.2.3',
    tag: 'v1.2.3',
    channel: 'stable',
    target: 'win32-x64',
    buildId: BUILD_ID,
    commit: COMMIT,
    updateEnabled: true,
    updateManifestUrl: 'https://downloads.example.test/latest-tui.json',
    ...overrides
  }
}

function latest() {
  const fileName = 'Kun-TUI-1.2.4-win-x64.zip'
  return {
    schemaVersion: 1,
    component: 'tui',
    version: '1.2.4',
    tag: 'v1.2.4',
    channel: 'stable',
    buildId: BUILD_ID,
    artifacts: [
      { target: 'darwin-arm64', fileName: 'Kun-TUI-1.2.4-mac-arm64.tar.gz', size: 123, sha256: 'c'.repeat(64), url: 'https://downloads.example.test/a' },
      { target: 'darwin-x64', fileName: 'Kun-TUI-1.2.4-mac-x64.tar.gz', size: 123, sha256: 'c'.repeat(64), url: 'https://downloads.example.test/b' },
      { target: 'linux-arm64', fileName: 'Kun-TUI-1.2.4-linux-arm64.tar.gz', size: 123, sha256: 'c'.repeat(64), url: 'https://downloads.example.test/c' },
      { target: 'linux-x64', fileName: 'Kun-TUI-1.2.4-linux-x64.tar.gz', size: 123, sha256: 'c'.repeat(64), url: 'https://downloads.example.test/d' },
      { target: 'win32-x64', fileName, size: 0, sha256: '0'.repeat(64), url: `https://downloads.example.test/${fileName}` }
    ]
  }
}

async function installFixture(): Promise<{ parent: string; root: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'kun-win-update-it-'))
  roots.push(parent)
  const root = join(parent, 'kun')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'release.json'), `${JSON.stringify(release())}\n`, 'utf8')
  const node = join(root, 'runtime', 'node.exe')
  await mkdir(join(root, 'runtime'), { recursive: true })
  await copyFile(process.execPath, node)
  return { parent, root }
}

async function updateArchive(parent: string): Promise<{ archive: string; bytes: Buffer }> {
  const stage = join(parent, 'next')
  const root = join(stage, 'kun')
  const entry = join(root, 'app', 'kun', 'dist', 'cli')
  await mkdir(entry, { recursive: true })
  await mkdir(join(root, 'runtime'), { recursive: true })
  await copyFile(process.execPath, join(root, 'runtime', 'node.exe'))
  await writeFile(
    join(entry, 'serve-entry.js'),
    "if (process.argv.includes('--version')) process.stdout.write('kun 1.2.4\\n')\n",
    'utf8'
  )
  await writeFile(
    join(root, 'release.json'),
    `${JSON.stringify(release({
      version: '1.2.4',
      artifactVersion: '1.2.4',
      tag: 'v1.2.4'
    }))}\n`,
    'utf8'
  )
  const archive = join(parent, 'Kun-TUI-1.2.4-win-x64.zip')
  execFileSync('tar', ['-czf', archive, '-C', stage, 'kun'])
  const bytes = await readFile(archive)
  return { archive, bytes }
}

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const exists = await stat(path).then(() => true).catch(() => false)
    if (exists) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
  }
}

describe.runIf(process.platform === 'win32')('Windows standalone TUI replacement', () => {
  it('waits for a running instance, replaces the install, and records the result', async () => {
    const { parent, root } = await installFixture()
    const { bytes } = await updateArchive(parent)
    const manifest = latest()
    const artifact = manifest.artifacts.find((candidate) => candidate.target === 'win32-x64')!
    artifact.size = bytes.length
    artifact.sha256 = createHash('sha256').update(bytes).digest('hex')

    // Occupy the install root with a long-lived process running from it.
    const occupant = spawn(join(root, 'runtime', 'node.exe'), ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore'
    })
    children.push(occupant)

    let stdout = ''
    let stderr = ''
    const code = await runSelfUpdateCommand(['--yes'], {
      stdout: { write: (chunk) => { stdout += chunk } },
      stderr: { write: (chunk) => { stderr += chunk } },
      env: { KUN_STANDALONE_ROOT: root },
      fetch: async (url) => String(url).endsWith('latest-tui.json')
        ? Response.json(manifest)
        : new Response(new Uint8Array(bytes))
    })
    expect(code).toBe(0)
    expect(stdout).toContain('is staged')
    expect(stdout).toContain('result is reported on next launch')
    expect(stderr).toBe('')
    // Not yet replaced: the occupant still runs from the install root.
    expect(JSON.parse(await readFile(join(root, 'release.json'), 'utf8')))
      .toMatchObject({ version: '1.2.3' })

    occupant.kill()
    children.splice(children.indexOf(occupant), 1)
    expect(await waitForFile(tuiUpdateResultPath(root), 120_000)).toBe(true)
    const result = JSON.parse(await readFile(tuiUpdateResultPath(root), 'utf8'))
    expect(result).toMatchObject({ status: 'succeeded', previousVersion: '1.2.3', targetVersion: '1.2.4' })
    expect(JSON.parse(await readFile(join(root, 'release.json'), 'utf8')))
      .toMatchObject({ version: '1.2.4' })
    expect(JSON.parse(await readFile(`${root}.previous/release.json`, 'utf8')))
      .toMatchObject({ version: '1.2.3' })
    const log = await readFile(tuiUpdateLogPath(root), 'utf8')
    expect(log).toContain('waiting for')
    expect(log).toContain('replacement succeeded')
  }, 180_000)

  it('retries the swap through a transient file lock', async () => {
    const { parent, root } = await installFixture()
    const { bytes } = await updateArchive(parent)
    const manifest = latest()
    const artifact = manifest.artifacts.find((candidate) => candidate.target === 'win32-x64')!
    artifact.size = bytes.length
    artifact.sha256 = createHash('sha256').update(bytes).digest('hex')

    let stdout = ''
    const code = await runSelfUpdateCommand(['--yes'], {
      stdout: { write: (chunk) => { stdout += chunk } },
      stderr: { write: () => undefined },
      env: { KUN_STANDALONE_ROOT: root },
      fetch: async (url) => String(url).endsWith('latest-tui.json')
        ? Response.json(manifest)
        : new Response(new Uint8Array(bytes))
    })
    expect(code).toBe(0)

    // Hold a handle inside the install root so the first Move-Item fails, then
    // release it so a retry succeeds.
    const handle = await open(join(root, 'release.json'), 'r')
    setTimeout(() => {
      void handle.close()
    }, 6_000)

    expect(await waitForFile(tuiUpdateResultPath(root), 120_000)).toBe(true)
    const result = JSON.parse(await readFile(tuiUpdateResultPath(root), 'utf8'))
    expect(result.status).toBe('succeeded')
    const log = await readFile(tuiUpdateLogPath(root), 'utf8')
    const attempts = log.match(/replacement attempt /g) ?? []
    expect(attempts.length).toBeGreaterThanOrEqual(1)
  }, 180_000)
})

// Keep the import exercised on all platforms so unused-import checks do not
// flag the Windows-only fixture above when skipped elsewhere.
void standaloneTuiTarget
