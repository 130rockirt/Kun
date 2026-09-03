import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runSelfUpdateCommand, type StandaloneTuiReleaseMetadata } from './self-update.js'
import {
  tuiUpdateLockPath,
  tuiUpdateTransactionPath,
  tuiUpdateUpdaterPath
} from './self-update-transaction.js'

const BUILD_ID = 'a'.repeat(64)
const COMMIT = 'b'.repeat(40)

const mocks = vi.hoisted(() => ({
  scheduleWindowsReplacement: vi.fn(),
  recordTuiUpdateUpdater: vi.fn()
}))

vi.mock('./self-update-windows.js', () => {
  class WindowsReplacementHandoffError extends Error {
    readonly lockTakenOver: boolean
    constructor(message: string, lockTakenOver: boolean) {
      super(message)
      this.name = 'WindowsReplacementHandoffError'
      this.lockTakenOver = lockTakenOver
    }
  }
  return {
    scheduleWindowsReplacement: mocks.scheduleWindowsReplacement,
    WindowsReplacementHandoffError
  }
})

vi.mock('./self-update-transaction.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./self-update-transaction.js')>()
  return {
    ...actual,
    recordTuiUpdateUpdater: mocks.recordTuiUpdateUpdater
  }
})

const roots: string[] = []

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
const originalArchDescriptor = Object.getOwnPropertyDescriptor(process, 'arch')

beforeEach(() => {
  // Simulate a win32-x64 standalone TUI host so the Windows handoff branch runs.
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })

  mocks.scheduleWindowsReplacement.mockReset()
  mocks.scheduleWindowsReplacement.mockResolvedValue({
    pid: 4242,
    processIdentity: 'win32-v1:test',
    startedAt: '2026-01-01T00:00:00.000Z'
  })
  mocks.recordTuiUpdateUpdater.mockReset()
  mocks.recordTuiUpdateUpdater.mockImplementation(
    async (installRoot: string, updater: unknown) => {
      await mkdir(dirname(tuiUpdateUpdaterPath(installRoot)), { recursive: true })
      await writeFile(
        tuiUpdateUpdaterPath(installRoot),
        `${JSON.stringify(updater, null, 2)}\n`,
        'utf8'
      )
    }
  )
})

afterEach(async () => {
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor)
  }
  if (originalArchDescriptor) {
    Object.defineProperty(process, 'arch', originalArchDescriptor)
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
  const parent = await mkdtemp(join(tmpdir(), 'kun-win-handoff-it-'))
  roots.push(parent)
  const root = join(parent, 'kun')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'release.json'), `${JSON.stringify(release())}\n`, 'utf8')
  const node = join(root, 'runtime', 'node.exe')
  await mkdir(join(root, 'runtime'), { recursive: true })
  await copyFile(process.execPath, node)
  await chmod(node, 0o755)
  return { parent, root }
}

async function updateArchive(parent: string): Promise<{ archive: string; bytes: Buffer }> {
  const stage = join(parent, 'next')
  const root = join(stage, 'kun')
  const entry = join(root, 'app', 'kun', 'dist', 'cli')
  await mkdir(entry, { recursive: true })
  await mkdir(join(root, 'runtime'), { recursive: true })
  const node = join(root, 'runtime', 'node.exe')
  await copyFile(process.execPath, node)
  await chmod(node, 0o755)
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
  // The extractor only runs `tar -tf`/`tar -xf`, so compression is irrelevant
  // here. Skip gzip to keep this cross-platform test fast (the bundled node
  // binary is large).
  execFileSync('tar', ['-cf', archive, '-C', stage, 'kun'])
  const bytes = await readFile(archive)
  return { archive, bytes }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true).catch(() => false)
}

describe('Windows updater lock handoff', () => {
  it('keeps the handoff irreversible when recording the updater identity fails', async () => {
    mocks.recordTuiUpdateUpdater.mockRejectedValueOnce(
      Object.assign(new Error('operation not permitted, open updater.json'), { code: 'EPERM' })
    )
    const { parent, root } = await installFixture()
    const { bytes } = await updateArchive(parent)
    const manifest = latest()
    const artifact = manifest.artifacts.find((candidate) => candidate.target === 'win32-x64')!
    artifact.size = bytes.length
    artifact.sha256 = createHash('sha256').update(bytes).digest('hex')

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
    expect(stderr).toContain('warning: could not persist updater identity')

    // The outer finally must not delete the staging root the updater is about to
    // Move-Item into place.
    const stagingEntries = (await readdir(parent)).filter((name) => name.startsWith('.kun-update-'))
    expect(stagingEntries.length).toBeGreaterThan(0)

    // The parent must not release the lock the updater has already taken over.
    expect(await exists(tuiUpdateLockPath(root))).toBe(true)

    // The transaction must not be cleared after a verified handoff.
    expect(await exists(tuiUpdateTransactionPath(root))).toBe(true)
  }, 120_000)

  it('still writes the updater record when the handoff succeeds', async () => {
    const { parent, root } = await installFixture()
    const { bytes } = await updateArchive(parent)
    const manifest = latest()
    const artifact = manifest.artifacts.find((candidate) => candidate.target === 'win32-x64')!
    artifact.size = bytes.length
    artifact.sha256 = createHash('sha256').update(bytes).digest('hex')

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
    expect(stderr).toBe('')

    const updaterRecord = JSON.parse(await readFile(tuiUpdateUpdaterPath(root), 'utf8'))
    expect(updaterRecord).toMatchObject({
      schemaVersion: 1,
      pid: 4242,
      processIdentity: 'win32-v1:test'
    })
    expect(typeof updaterRecord.startedAt).toBe('string')
    expect(Number.isNaN(Date.parse(updaterRecord.startedAt))).toBe(false)
    expect(typeof updaterRecord.token).toBe('string')
    expect(updaterRecord.token.length).toBeGreaterThan(0)
  }, 120_000)
})
