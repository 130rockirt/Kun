import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  stat
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import * as yauzl from 'yauzl'
import { getProviderCatalogPreset } from '@kun/provider-catalog'
import {
  ModelConnectionCliAuthRequestSchema,
  type ModelConnectionCliAuthRequest,
  type ModelConnectionSnapshot
} from '../contracts/model-connections.js'
import { GeminiCliOAuthSource } from '../adapters/model/gemini-cli-oauth.js'
import type { ModelConnectionRegistry } from './model-connection-registry.js'

export type OfficialProviderCliId = ModelConnectionCliAuthRequest['provider']

export type OfficialProviderCliCommand = {
  provider: OfficialProviderCliId
  command: string
  args: string[]
  displayName: string
}

type AntigravityAsset = {
  name: string
  sha256: string
  archiveKind: 'tar.gz' | 'zip'
  binaryName: string
}

export const ANTIGRAVITY_CLI_VERSION = '1.1.8'
const ANTIGRAVITY_RELEASE_BASE =
  `https://github.com/google-antigravity/antigravity-cli/releases/download/${ANTIGRAVITY_CLI_VERSION}`

const ANTIGRAVITY_ASSETS: Record<string, AntigravityAsset> = {
  'linux-arm64': {
    name: 'agy_cli_linux_arm64.tar.gz',
    sha256: 'e75cebb03fce0fcad7d3bb682eb84c356a3c50ff8fb3dc4a89d2051f34fca0ab',
    archiveKind: 'tar.gz',
    binaryName: 'antigravity'
  },
  'linux-x64': {
    name: 'agy_cli_linux_x64.tar.gz',
    sha256: 'e92e6215532b3ce84455e341944067753ad90f6d24cebcec8002ce137e5162ce',
    archiveKind: 'tar.gz',
    binaryName: 'antigravity'
  },
  'darwin-arm64': {
    name: 'agy_cli_mac_arm64.tar.gz',
    sha256: '622d85db88bcfbf060aa4cbeaadcf2a287420f31236c1efb287409a949ccab25',
    archiveKind: 'tar.gz',
    binaryName: 'antigravity'
  },
  'darwin-x64': {
    name: 'agy_cli_mac_x64.tar.gz',
    sha256: '76afe4622132596f68557ef4531ec2e2dcd40e8025f6fb4435a273ce2eec0027',
    archiveKind: 'tar.gz',
    binaryName: 'antigravity'
  },
  'win32-arm64': {
    name: 'agy_cli_windows_arm64.zip',
    sha256: '2e5c5a5b67b4d2a197bc9eb5608f61e6a2f7d602b1012beb7e6b3c158e2a909c',
    archiveKind: 'zip',
    binaryName: 'antigravity.exe'
  },
  'win32-x64': {
    name: 'agy_cli_windows_x64.zip',
    sha256: 'e234c850e3d835d278bb9b4aa202c34d53e399eeebc3d9d1a575576896cdecee',
    archiveKind: 'zip',
    binaryName: 'antigravity.exe'
  }
}

export function antigravityCliAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): AntigravityAsset | undefined {
  return ANTIGRAVITY_ASSETS[`${platform}-${arch}`]
}

export function antigravityCliBinaryName(
  platform: NodeJS.Platform = process.platform
): string {
  return platform === 'win32' ? 'agy.exe' : 'agy'
}

export function antigravityCliBinaryPath(dataDir: string): string {
  return join(dataDir, 'provider-cli', 'antigravity', antigravityCliBinaryName())
}

export function resolveAntigravityCliCommand(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env
): OfficialProviderCliCommand | undefined {
  const executable = antigravityCliBinaryName()
  const pathCandidates = executableCandidates(executable, env)
  const command = [
    antigravityCliBinaryPath(dataDir),
    ...pathCandidates,
    // Older GUI-managed installs used the full upstream binary name.
    ...executableCandidates(process.platform === 'win32' ? 'antigravity.exe' : 'antigravity', env)
  ].find((candidate) => existsSync(candidate))
  return command
    ? { provider: 'antigravity', command, args: [], displayName: 'Antigravity CLI' }
    : undefined
}

export function resolveGeminiCliCommand(
  env: NodeJS.ProcessEnv = process.env
): OfficialProviderCliCommand | undefined {
  const bundled = join(
    dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
    'node_modules',
    '@google',
    'gemini-cli',
    'bundle',
    'gemini.js'
  )
  if (existsSync(bundled)) {
    return {
      provider: 'gemini-cli',
      command: process.execPath,
      args: [bundled],
      displayName: 'Gemini CLI'
    }
  }
  const executable = process.platform === 'win32' ? 'gemini.cmd' : 'gemini'
  const command = executableCandidates(executable, env).find((candidate) => existsSync(candidate))
  if (command) {
    return {
      provider: 'gemini-cli',
      command,
      args: [],
      displayName: 'Gemini CLI'
    }
  }
  return undefined
}

export async function installAntigravityCli(options: {
  dataDir: string
  fetchImpl?: typeof fetch
  onProgress?: (receivedBytes: number, totalBytes: number) => void
}): Promise<OfficialProviderCliCommand> {
  const asset = antigravityCliAsset()
  if (!asset) throw new Error(`Antigravity CLI does not support ${process.platform}/${process.arch}`)
  const fetchImpl = options.fetchImpl ?? fetch
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'kun-antigravity-install-'))
  const archivePath = join(temporaryRoot, asset.name)
  const extractDir = join(temporaryRoot, 'extract')
  const destination = antigravityCliBinaryPath(options.dataDir)
  try {
    const response = await fetchImpl(`${ANTIGRAVITY_RELEASE_BASE}/${asset.name}`, {
      signal: AbortSignal.timeout(30 * 60 * 1000)
    })
    if (!response.ok || !response.body) {
      throw new Error(`Antigravity CLI download failed with HTTP ${response.status}`)
    }
    const totalBytes = Number(response.headers.get('content-length')) || 0
    let receivedBytes = 0
    const digest = createHash('sha256')
    const verifier = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        receivedBytes += chunk.length
        digest.update(chunk)
        options.onProgress?.(receivedBytes, totalBytes)
        callback(null, chunk)
      }
    })
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      verifier,
      createWriteStream(archivePath, { mode: 0o600 })
    )
    if (digest.digest('hex') !== asset.sha256) {
      throw new Error(`Antigravity CLI checksum mismatch for ${asset.name}`)
    }
    await mkdir(extractDir, { recursive: true, mode: 0o700 })
    if (asset.archiveKind === 'zip') {
      await extractZipBinary(archivePath, extractDir, asset.binaryName)
    } else {
      await runProcess('tar', ['-xzf', archivePath, '-C', extractDir], 60_000)
    }
    const extracted = await findExtractedBinary(extractDir, asset.binaryName)
    const details = await stat(extracted)
    if (!details.isFile() || details.size <= 0) {
      throw new Error(`${asset.binaryName} was not found in ${basename(asset.name)}`)
    }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await copyFile(extracted, destination)
    if (process.platform !== 'win32') await chmod(destination, 0o755)
    return {
      provider: 'antigravity',
      command: destination,
      args: [],
      displayName: 'Antigravity CLI'
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function verifyOfficialProviderLogin(options: {
  provider: OfficialProviderCliId
  dataDir: string
  geminiOAuthSource?: GeminiCliOAuthSource
  spawnFn?: typeof spawn
}): Promise<string[]> {
  if (options.provider === 'gemini-cli') {
    await (options.geminiOAuthSource ?? new GeminiCliOAuthSource()).accessToken()
    return [...requirePreset('gemini-cli-subscription').models]
  }
  const command = resolveAntigravityCliCommand(options.dataDir)
  if (!command) throw new Error('Antigravity CLI is not installed')
  const output = await captureProcess(
    command.command,
    [...command.args, 'models'],
    60_000,
    options.spawnFn
  )
  const models = parseModelLines(output.stdout)
  if (models.length === 0) {
    throw new Error(output.stderr.trim() || 'Antigravity CLI login could not be verified')
  }
  return models
}

export class OfficialProviderAuthService {
  constructor(private readonly options: {
    dataDir: string
    registry: ModelConnectionRegistry
    geminiOAuthSource?: GeminiCliOAuthSource
    spawnFn?: typeof spawn
  }) {}

  async complete(raw: unknown): Promise<ModelConnectionSnapshot> {
    const input = ModelConnectionCliAuthRequestSchema.parse(raw)
    await this.options.registry.assertRevision(input.expectedRevision)
    const models = await verifyOfficialProviderLogin({
      provider: input.provider,
      dataDir: this.options.dataDir,
      ...(this.options.geminiOAuthSource
        ? { geminiOAuthSource: this.options.geminiOAuthSource }
        : {}),
      ...(this.options.spawnFn ? { spawnFn: this.options.spawnFn } : {})
    })
    const preset = requirePreset(
      input.provider === 'gemini-cli'
        ? 'gemini-cli-subscription'
        : 'gemini-subscription'
    )
    const selectedModel = input.model && models.includes(input.model)
      ? input.model
      : models[0] ?? preset.models[0]
    if (!selectedModel) throw new Error(`${preset.name} returned no models`)
    return this.options.registry.connectAuthenticated({
      expectedRevision: input.expectedRevision,
      id: preset.id,
      name: preset.name,
      presetSource: preset.id,
      kind: preset.kind,
      authType: preset.authType,
      ...(preset.baseUrl ? { baseUrl: preset.baseUrl } : {}),
      endpointFormat: preset.endpointFormat,
      models,
      selectedModel,
      select: input.select,
      externalAuthVerified: true
    })
  }
}

function requirePreset(id: string) {
  const preset = getProviderCatalogPreset(id)
  if (!preset) throw new Error(`provider preset is unavailable: ${id}`)
  return preset
}

function executableCandidates(
  executable: string,
  env: NodeJS.ProcessEnv
): string[] {
  const fromPath = (env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, executable))
  return [
    ...fromPath,
    join(homedir(), '.local', 'bin', executable),
    ...(process.platform === 'darwin'
      ? [join('/opt/homebrew/bin', executable), join('/usr/local/bin', executable)]
      : process.platform === 'win32'
        ? []
        : [join('/usr/local/bin', executable), join('/usr/bin', executable)])
  ]
}

async function findExtractedBinary(root: string, binaryName: string): Promise<string> {
  const direct = join(root, binaryName)
  if (existsSync(direct)) return direct
  const nested = join(root, 'bin', binaryName)
  if (existsSync(nested)) return nested
  throw new Error(`${binaryName} was not found in the Antigravity archive`)
}

async function extractZipBinary(
  archivePath: string,
  destination: string,
  binaryName: string
): Promise<void> {
  const archive = await yauzl.openPromise(archivePath, {
    lazyEntries: true,
    decodeStrings: true,
    validateEntrySizes: true,
    strictFileNames: true,
    autoClose: false
  })
  try {
    let found = false
    for await (const entry of archive.eachEntry()) {
      const normalized = entry.fileName.replaceAll('\\', '/')
      if (normalized.endsWith('/') || basename(normalized) !== binaryName) continue
      if (entry.uncompressedSize > 256 * 1024 * 1024) {
        throw new Error('Antigravity CLI archive entry exceeds the size limit')
      }
      const target = join(destination, binaryName)
      const input = await archive.openReadStreamPromise(entry)
      await pipeline(input, createWriteStream(target, { flags: 'wx', mode: 0o700 }))
      found = true
      break
    }
    if (!found) throw new Error(`${binaryName} was not found in the Antigravity archive`)
  } finally {
    archive.close()
  }
}

function runProcess(command: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true, shell: false })
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error(`${command} timed out`))
    }, timeoutMs)
    child.once('error', finish)
    child.once('exit', (code) => finish(
      code === 0 ? undefined : new Error(`${command} exited with code ${code ?? 'unknown'}`)
    ))
  })
}

function captureProcess(
  command: string,
  args: string[],
  timeoutMs: number,
  spawnFn: typeof spawn = spawn
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawnFn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
        env: process.env
      })
    } catch (error) {
      reject(error)
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve({ stdout, stderr })
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error(`${command} login verification timed out`))
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout = `${stdout}${String(chunk)}`.slice(-256 * 1024)
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = `${stderr}${String(chunk)}`.slice(-64 * 1024)
    })
    child.once('error', finish)
    child.once('exit', (code) => finish(
      code === 0 ? undefined : new Error(stderr.trim() || `${command} exited with code ${code ?? 'unknown'}`)
    ))
  })
}

function parseModelLines(stdout: string): string[] {
  const pattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/iu
  return [...new Set(stdout.split(/\r?\n/u)
    .map((line) => line.trim().replace(/-(?:low|medium|high)$/iu, ''))
    .filter((line) => line.length <= 128 && pattern.test(line)))]
}
