import { execFile, execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import semver from 'semver'
import { withRuntimeDataDirAncillaryWriter } from '../server/runtime-data-dir-lease.js'

const RELEASE_METADATA_FILENAME = 'release.json'
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000
const FETCH_TIMEOUT_MS = 15_000
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1_000
const STANDALONE_TUI_TARGETS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-x64'
])

export type StandaloneTuiReleaseMetadata = {
  schemaVersion: 1
  component: 'tui'
  version: string
  artifactVersion: string
  tag: string
  channel: 'stable' | 'frontier'
  target: string
  buildId: string
  commit: string
  updateEnabled: boolean
  updateManifestUrl: string
}

export type TuiUpdateArtifact = {
  target: string
  fileName: string
  size: number
  sha256: string
  url: string
}

export type TuiUpdateManifest = {
  schemaVersion: 1
  component: 'tui'
  version: string
  tag: string
  channel: 'stable' | 'frontier'
  buildId: string
  artifacts: TuiUpdateArtifact[]
}

export type TuiUpdateCheck = {
  current: StandaloneTuiReleaseMetadata
  latest: TuiUpdateManifest
  artifact: TuiUpdateArtifact
  available: boolean
}

type UpdateIo = {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  env?: Record<string, string | undefined>
  fetch?: typeof fetch
}

export const KUN_UPDATE_USAGE = `kun update [--check] [--yes]

Checks the stable R2 release shared by Kun GUI and standalone TUI.
The GUI-bundled TUI is updated with the GUI application and cannot update itself.
`

export function standaloneTuiTarget(
  platform = process.platform,
  arch = process.arch
): string | undefined {
  const target = `${platform}-${arch}`
  return STANDALONE_TUI_TARGETS.has(target) ? target : undefined
}

export function parseTuiUpdateManifest(
  value: unknown,
  current: StandaloneTuiReleaseMetadata
): TuiUpdateManifest {
  if (!isRecord(value)) throw new Error('latest-tui.json must contain an object')
  if (
    value.schemaVersion !== 1 ||
    value.component !== 'tui' ||
    value.channel !== 'stable' ||
    typeof value.version !== 'string' ||
    !semver.valid(value.version) ||
    typeof value.tag !== 'string' ||
    typeof value.buildId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.buildId) ||
    !Array.isArray(value.artifacts)
  ) {
    throw new Error('latest-tui.json has an unsupported release contract')
  }
  if (current.channel !== 'stable' || !current.updateEnabled) {
    throw new Error('self-update is available only for stable standalone TUI releases')
  }
  const artifacts = value.artifacts.map((artifact) => parseArtifact(artifact))
  const targets = new Set(artifacts.map((artifact) => artifact.target))
  const expectedTargets = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']
  const expectedFiles = new Map([
    ['darwin-arm64', `Kun-TUI-${value.version}-mac-arm64.tar.gz`],
    ['darwin-x64', `Kun-TUI-${value.version}-mac-x64.tar.gz`],
    ['linux-arm64', `Kun-TUI-${value.version}-linux-arm64.tar.gz`],
    ['linux-x64', `Kun-TUI-${value.version}-linux-x64.tar.gz`],
    ['win32-x64', `Kun-TUI-${value.version}-win-x64.zip`]
  ])
  if (
    value.tag !== `v${value.version}` ||
    targets.size !== artifacts.length ||
    artifacts.length !== expectedTargets.length ||
    expectedTargets.some((target) => !targets.has(target)) ||
    artifacts.some((artifact) => artifact.fileName !== expectedFiles.get(artifact.target))
  ) {
    throw new Error('latest-tui.json does not describe one complete stable release')
  }
  return {
    schemaVersion: 1,
    component: 'tui',
    version: value.version,
    tag: value.tag,
    channel: 'stable',
    buildId: value.buildId,
    artifacts
  }
}

export async function readStandaloneTuiRelease(
  env: Record<string, string | undefined> = process.env
): Promise<{ root: string; metadata: StandaloneTuiReleaseMetadata } | null> {
  const configuredRoot = env.KUN_STANDALONE_ROOT?.trim()
  if (!configuredRoot) return null
  const root = resolve(configuredRoot)
  try {
    const metadata = parseStandaloneRelease(
      JSON.parse(await readFile(join(root, RELEASE_METADATA_FILENAME), 'utf8')) as unknown
    )
    return { root, metadata }
  } catch {
    return null
  }
}

export async function checkStandaloneTuiUpdate(
  input: {
    env?: Record<string, string | undefined>
    fetch?: typeof fetch
  } = {}
): Promise<TuiUpdateCheck | null> {
  const standalone = await readStandaloneTuiRelease(input.env ?? process.env)
  if (!standalone) return null
  const { metadata } = standalone
  if (!metadata.updateEnabled || metadata.channel !== 'stable') return null
  const runtimeTarget = standaloneTuiTarget()
  if (!runtimeTarget || metadata.target !== runtimeTarget) {
    throw new Error(`standalone release target ${metadata.target} does not match this host`)
  }
  const response = await (input.fetch ?? fetch)(metadata.updateManifestUrl, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`update manifest request failed with HTTP ${response.status}`)
  const latest = parseTuiUpdateManifest(await response.json(), metadata)
  const artifact = latest.artifacts.find((candidate) => candidate.target === metadata.target)
  if (!artifact) throw new Error(`latest release does not support ${metadata.target}`)
  return {
    current: metadata,
    latest,
    artifact,
    available: semver.gt(latest.version, metadata.version)
  }
}

export async function checkStandaloneTuiUpdateOnce(
  input: {
    env?: Record<string, string | undefined>
    fetch?: typeof fetch
    dataDir: string
    now?: number
  }
): Promise<TuiUpdateCheck | null> {
  const standalone = await readStandaloneTuiRelease(input.env ?? process.env)
  if (
    !standalone ||
    standalone.metadata.channel !== 'stable' ||
    !standalone.metadata.updateEnabled
  ) return null
  const statePath = join(input.dataDir, 'tui-update-check.json')
  const now = input.now ?? Date.now()
  try {
    const state = JSON.parse(await readFile(statePath, 'utf8')) as { checkedAt?: unknown }
    if (
      typeof state.checkedAt === 'string' &&
      now - Date.parse(state.checkedAt) < UPDATE_CHECK_INTERVAL_MS
    ) return null
  } catch {
    // Missing or invalid state means a check is due.
  }
  const result = await checkStandaloneTuiUpdate(input)
  await withRuntimeDataDirAncillaryWriter(input.dataDir, async () => {
    await mkdir(input.dataDir, { recursive: true, mode: 0o700 })
    await writeFile(
      statePath,
      `${JSON.stringify({
        checkedAt: new Date(now).toISOString(),
        currentVersion: result?.current.version,
        latestVersion: result?.latest.version,
        available: result?.available ?? false
      }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 }
    )
  })
  return result
}

export async function runSelfUpdateCommand(
  argv: readonly string[],
  io: UpdateIo
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout.write(KUN_UPDATE_USAGE)
    return 0
  }
  const unknown = argv.filter((argument) => argument !== '--check' && argument !== '--yes')
  if (unknown.length) {
    io.stderr.write(`kun update: unknown option ${unknown[0]}\n`)
    return 64
  }
  if (argv.includes('--check') && argv.includes('--yes')) {
    io.stderr.write('kun update: --check and --yes are mutually exclusive\n')
    return 64
  }
  const standalone = await readStandaloneTuiRelease(io.env ?? process.env)
  if (!standalone) {
    io.stderr.write(
      'kun update: this TUI is bundled with Kun GUI or is not a managed standalone archive; update the GUI application instead.\n'
    )
    return 69
  }
  if (!standalone.metadata.updateEnabled || standalone.metadata.channel !== 'stable') {
    io.stderr.write('kun update: Daily/frontier TUI builds do not support self-update.\n')
    return 69
  }
  try {
    const check = await checkStandaloneTuiUpdate({
      env: io.env,
      fetch: io.fetch
    })
    if (!check) {
      io.stderr.write('kun update: standalone release metadata is unavailable.\n')
      return 69
    }
    if (!check.available) {
      io.stdout.write(`Kun ${check.current.version} is up to date.\n`)
      return 0
    }
    io.stdout.write(`Kun ${check.latest.version} is available (current ${check.current.version}).\n`)
    if (argv.includes('--check')) return 10
    if (!argv.includes('--yes')) {
      io.stdout.write('Run `kun update --yes` to download and install this joint GUI/TUI release.\n')
      return 10
    }
    await installStandaloneTuiUpdate(standalone.root, check, io)
    return 0
  } catch (error) {
    io.stderr.write(`kun update: ${error instanceof Error ? error.message : String(error)}\n`)
    return 70
  }
}

async function installStandaloneTuiUpdate(
  currentRoot: string,
  check: TuiUpdateCheck,
  io: UpdateIo
): Promise<void> {
  await access(currentRoot)
  await access(dirname(currentRoot))
  const stagingRoot = await mkdtemp(join(dirname(currentRoot), '.kun-update-'))
  const archivePath = join(stagingRoot, check.artifact.fileName)
  let retainStagingForWindows = false
  try {
    await downloadFile(check.artifact.url, archivePath, io.fetch ?? fetch)
    const details = await stat(archivePath)
    if (details.size !== check.artifact.size) throw new Error('downloaded update size does not match manifest')
    const digest = await sha256File(archivePath)
    if (digest !== check.artifact.sha256) throw new Error('downloaded update SHA-256 does not match manifest')
    validateArchiveEntries(archivePath)
    execFileSync('tar', ['-xf', archivePath, '-C', stagingRoot], { stdio: 'ignore' })
    const nextRoot = join(stagingRoot, 'kun')
    const nextRelease = parseStandaloneRelease(
      JSON.parse(await readFile(join(nextRoot, RELEASE_METADATA_FILENAME), 'utf8')) as unknown
    )
    if (
      nextRelease.version !== check.latest.version ||
      nextRelease.target !== check.current.target ||
      nextRelease.buildId !== check.latest.buildId
    ) {
      throw new Error('downloaded update metadata does not match latest-tui.json')
    }
    await smokeNewRelease(nextRoot, check.latest.version)
    if (process.platform === 'win32') {
      await scheduleWindowsReplacement(currentRoot, nextRoot, check.current.version)
      retainStagingForWindows = true
      io.stdout.write(`Kun ${check.latest.version} is staged and will activate after this process exits.\n`)
      return
    }
    const backupRoot = `${currentRoot}.previous`
    await rm(backupRoot, { recursive: true, force: true })
    await rename(currentRoot, backupRoot)
    try {
      await rename(nextRoot, currentRoot)
    } catch (error) {
      await rename(backupRoot, currentRoot).catch(() => undefined)
      throw error
    }
    io.stdout.write(`Kun ${check.latest.version} installed. Restart Kun to use the new release.\n`)
  } finally {
    if (!retainStagingForWindows) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

function parseStandaloneRelease(value: unknown): StandaloneTuiReleaseMetadata {
  if (!isRecord(value)) throw new Error('release.json must contain an object')
  const version = typeof value.version === 'string' ? value.version : ''
  const artifactVersion = typeof value.artifactVersion === 'string'
    ? value.artifactVersion
    : ''
  const channelContractMatches = value.channel === 'stable'
    ? value.updateEnabled === true &&
      value.tag === `v${version}` &&
      artifactVersion === version
    : value.channel === 'frontier' &&
      value.updateEnabled === false &&
      value.tag === `dev-${artifactVersion}` &&
      version === `0.0.0-dev-${artifactVersion.replace('.', '-')}`
  if (
    value.schemaVersion !== 1 ||
    value.component !== 'tui' ||
    typeof value.version !== 'string' ||
    !semver.valid(value.version) ||
    typeof value.artifactVersion !== 'string' ||
    typeof value.tag !== 'string' ||
    (value.channel !== 'stable' && value.channel !== 'frontier') ||
    typeof value.target !== 'string' ||
    !STANDALONE_TUI_TARGETS.has(value.target) ||
    typeof value.buildId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.buildId) ||
    typeof value.commit !== 'string' ||
    !/^[a-f0-9]{40}$/.test(value.commit) ||
    typeof value.updateEnabled !== 'boolean' ||
    typeof value.updateManifestUrl !== 'string' ||
    !isHttpsUrl(value.updateManifestUrl) ||
    !channelContractMatches
  ) {
    throw new Error('release.json has an unsupported standalone TUI contract')
  }
  return {
    schemaVersion: 1,
    component: 'tui',
    version: value.version,
    artifactVersion: value.artifactVersion,
    tag: value.tag,
    channel: value.channel,
    target: value.target,
    buildId: value.buildId,
    commit: value.commit,
    updateEnabled: value.updateEnabled,
    updateManifestUrl: value.updateManifestUrl
  }
}

function parseArtifact(value: unknown): TuiUpdateArtifact {
  if (
    !isRecord(value) ||
    typeof value.target !== 'string' ||
    typeof value.fileName !== 'string' ||
    value.fileName.includes('/') ||
    value.fileName.includes('\\') ||
    !Number.isSafeInteger(value.size) ||
    Number(value.size) <= 0 ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    typeof value.url !== 'string' ||
    !isHttpsUrl(value.url)
  ) {
    throw new Error('latest-tui.json contains an invalid artifact')
  }
  return {
    target: value.target,
    fileName: value.fileName,
    size: Number(value.size),
    sha256: value.sha256,
    url: value.url
  }
}

async function downloadFile(url: string, destination: string, fetchImpl: typeof fetch): Promise<void> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!response.ok || !response.body) {
    throw new Error(`update download failed with HTTP ${response.status}`)
  }
  await pipeline(
    Readable.fromWeb(response.body as never),
    createWriteStream(destination, { mode: 0o600 })
  )
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function validateArchiveEntries(path: string): void {
  const entries = execFileSync('tar', ['-tf', path], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  }).split(/\r?\n/).filter(Boolean)
  if (!entries.length) throw new Error('downloaded update archive is empty')
  for (const entry of entries) {
    const normalized = entry.replaceAll('\\', '/')
    if (
      normalized.startsWith('/') ||
      !normalized.startsWith('kun/') ||
      normalized.split('/').includes('..')
    ) {
      throw new Error(`downloaded update contains an unsafe path: ${entry}`)
    }
  }
}

async function smokeNewRelease(root: string, expectedVersion: string): Promise<void> {
  const node = join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node')
  const entry = join(root, 'app', 'kun', 'dist', 'cli', 'serve-entry.js')
  const output = execFileSync(node, [entry, '--version'], {
    encoding: 'utf8',
    env: { ...process.env, KUN_STANDALONE_ROOT: root },
    timeout: 15_000
  }).trim()
  if (output !== `kun ${expectedVersion}`) {
    throw new Error(`downloaded update smoke returned ${JSON.stringify(output)}`)
  }
}

async function scheduleWindowsReplacement(
  currentRoot: string,
  nextRoot: string,
  previousVersion: string
): Promise<void> {
  const scriptPath = join(tmpdir(), `kun-update-${process.pid}.ps1`)
  const backupRoot = `${currentRoot}.previous`
  const quote = (value: string) => value.replaceAll("'", "''")
  await writeFile(scriptPath, [
    '$ErrorActionPreference = "Stop"',
    `Wait-Process -Id ${process.pid}`,
    `$current = '${quote(currentRoot)}'`,
    `$next = '${quote(nextRoot)}'`,
    '$staging = Split-Path $next -Parent',
    `$backup = '${quote(backupRoot)}'`,
    'if (Test-Path $backup) { Remove-Item -Recurse -Force $backup }',
    'Move-Item $current $backup',
    'try {',
    '  Move-Item $next $current',
    '} catch {',
    '  if (Test-Path $current) { Remove-Item -Recurse -Force $current }',
    '  Move-Item $backup $current',
    '  throw',
    '}',
    `Set-Content -Path ($current + '\\\\.updated-from') -Value '${quote(previousVersion)}'`,
    'if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }',
    'Remove-Item -Force $PSCommandPath',
    ''
  ].join('\r\n'), 'utf8')
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    { detached: true, stdio: 'ignore', windowsHide: true }
  )
  child.unref()
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

// Retained as an injectable seam for Windows updater tests.
export function waitForProcessExit(pid: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile(process.execPath, ['-e', `process.kill(${pid}, 0)`], (error) => {
      if (error) resolvePromise()
      else reject(new Error(`process ${pid} is still running`))
    })
  })
}
