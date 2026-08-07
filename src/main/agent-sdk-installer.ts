/**
 * On-demand provisioning of the Agent SDK's Claude Code binary.
 *
 * The SDK ships a ~222MB per-platform binary as an optional dependency. We do
 * NOT bundle it into the installer (see electron-builder config — only the small
 * SDK JS is packaged). Instead it's downloaded on first use, straight from the
 * npm registry tarball (no `npm` needed on the user's machine), extracted into a
 * writable user-data dir, and the runtime is pointed at it via
 * `pathToClaudeCodeExecutable`.
 */
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, rmSync, chmodSync, statSync } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SdkDownloadState } from '../shared/kun-gui-api'
import { fetchWithOptionalProxy } from './proxy-fetch'

export type { SdkDownloadState } from '../shared/kun-gui-api'

// Keep in sync with kun/package.json's @anthropic-ai/claude-agent-sdk version.
export const AGENT_SDK_VERSION = '0.3.220'
const REGISTRY = 'https://registry.npmjs.org'

export function claudeBinaryName(): string {
  return process.platform === 'win32' ? 'claude.exe' : 'claude'
}

/** The per-platform binary package, e.g. @anthropic-ai/claude-agent-sdk-darwin-arm64. */
export function platformBinaryPackage(): string | undefined {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : undefined
  const platform =
    process.platform === 'darwin'
      ? 'darwin'
      : process.platform === 'win32'
        ? 'win32'
        : process.platform === 'linux'
          ? 'linux'
          : undefined
  if (!arch || !platform) return undefined
  return `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`
}

/** Where the on-demand binary is downloaded to. */
export function agentSdkBinaryPath(userDataDir: string): string {
  return join(userDataDir, 'agent-sdk', claudeBinaryName())
}

/**
 * Resolve the Claude Code binary: the on-demand download first, then a bundled
 * copy in kun's node_modules (present in dev / if ever bundled). Returns the
 * first that exists, or undefined → needs downloading.
 */
export function resolveClaudeBinary(userDataDir: string, kunDirs: readonly string[]): string | undefined {
  const downloaded = agentSdkBinaryPath(userDataDir)
  if (existsSync(downloaded)) return downloaded
  const pkg = platformBinaryPackage()
  if (pkg) {
    const bin = claudeBinaryName()
    for (const dir of kunDirs) {
      const candidate = join(dir, 'node_modules', pkg, bin)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

export function agentSdkStatus(
  userDataDir: string,
  kunDirs: readonly string[]
): { installed: boolean; path?: string } {
  const path = resolveClaudeBinary(userDataDir, kunDirs)
  return path ? { installed: true, path } : { installed: false }
}

function runTar(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, { stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))))
  })
}

export type AgentSdkInstallResult =
  | { ok: true; path: string }
  | { ok: false; message: string }

/**
 * Download the platform binary tarball from the npm registry and extract the
 * `claude` executable into the user-data dir. `proxyUrl` routes through the
 * model proxy (npm/registry is region-restricted for some users).
 */
export async function installClaudeBinary(options: {
  userDataDir: string
  proxyUrl?: string
  version?: string
  onProgress?: (receivedBytes: number, totalBytes: number) => void
}): Promise<AgentSdkInstallResult> {
  const pkg = platformBinaryPackage()
  if (!pkg) return { ok: false, message: `unsupported platform: ${process.platform}/${process.arch}` }
  const version = options.version ?? AGENT_SDK_VERSION
  const proxyUrl = options.proxyUrl ?? ''
  const destDir = join(options.userDataDir, 'agent-sdk')
  const binPath = join(destDir, claudeBinaryName())
  const tgz = join(tmpdir(), `kun-agent-sdk-${process.pid}.tgz`)
  try {
    // 1. registry metadata → exact tarball url
    const metaRes = await fetchWithOptionalProxy(`${REGISTRY}/${pkg}/${version}`, {}, proxyUrl)
    if (!metaRes.ok) throw new Error(`registry ${pkg}@${version}: ${metaRes.status}`)
    const meta = (await metaRes.json()) as { dist?: { tarball?: string } }
    const tarball = meta.dist?.tarball
    if (!tarball) throw new Error(`no tarball for ${pkg}@${version}`)

    // 2. stream the (~222MB) tarball to a temp file, reporting progress
    const res = await fetchWithOptionalProxy(tarball, {}, proxyUrl)
    if (!res.ok || !res.body) throw new Error(`download ${tarball}: ${res.status}`)
    const totalBytes = Number(res.headers.get('content-length')) || 0
    let receivedBytes = 0
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        receivedBytes += chunk.length
        options.onProgress?.(receivedBytes, totalBytes)
        cb(null, chunk)
      }
    })
    mkdirSync(destDir, { recursive: true })
    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      counter,
      createWriteStream(tgz)
    )

    // 3. extract just the binary (tarball root is `package/`)
    await runTar(['-xzf', tgz, '-C', destDir, '--strip-components=1', `package/${claudeBinaryName()}`])
    if (!existsSync(binPath) || statSync(binPath).size === 0) {
      throw new Error('binary not found in tarball')
    }
    if (process.platform !== 'win32') chmodSync(binPath, 0o755)
    return { ok: true, path: binPath }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  } finally {
    rmSync(tgz, { force: true })
  }
}

// ---------------------------------------------------------------------------
// Background download — a process-wide singleton so it keeps running even if the
// user navigates away from the settings page; the UI re-reads its state on mount.
// ---------------------------------------------------------------------------

let activeState: SdkDownloadState | null = null

export type StartAgentSdkInstallOptions = {
  userDataDir: string
  proxyUrl?: string
  version?: string
  /** Recreate Kun after the binary appears so its launch environment sees it. */
  restartRuntime: () => Promise<void>
}

type StartAgentSdkInstallDependencies = {
  installBinary: typeof installClaudeBinary
  hasDownloadedBinary: (userDataDir: string) => boolean
}

function hasDownloadedClaudeBinary(userDataDir: string): boolean {
  const path = agentSdkBinaryPath(userDataDir)
  try {
    return existsSync(path) && statSync(path).size > 0
  } catch {
    return false
  }
}

function restartFailureMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return detail
    ? `Claude runtime downloaded, but Kun could not restart: ${detail}`
    : 'Claude runtime downloaded, but Kun could not restart. Try again.'
}

/** Current background-download state, or null if none has run. */
export function agentSdkDownloadState(): SdkDownloadState | null {
  return activeState
}

/**
 * Start (or resume) the background provisioning. A successful binary download is
 * not usable until Kun restarts with its newly resolved binary path. The state is
 * therefore `downloading -> restarting -> done`; repeated calls share either
 * active state, and a retry after a restart failure reuses the downloaded binary.
 */
export function startAgentSdkInstall(
  options: StartAgentSdkInstallOptions,
  onState?: (state: SdkDownloadState) => void,
  dependencies: Partial<StartAgentSdkInstallDependencies> = {}
): SdkDownloadState {
  if (activeState?.status === 'downloading' || activeState?.status === 'restarting') {
    return activeState
  }
  const installBinary = dependencies.installBinary ?? installClaudeBinary
  const hasDownloadedBinary = dependencies.hasDownloadedBinary ?? hasDownloadedClaudeBinary
  const emit = (state: SdkDownloadState): void => {
    activeState = state
    onState?.(state)
  }

  const restart = async (receivedBytes: number, totalBytes: number): Promise<void> => {
    emit({ status: 'restarting', receivedBytes, totalBytes })
    try {
      await options.restartRuntime()
      emit({ status: 'done', receivedBytes, totalBytes })
    } catch (error) {
      emit({
        status: 'error',
        receivedBytes,
        totalBytes,
        message: restartFailureMessage(error)
      })
    }
  }

  if (hasDownloadedBinary(options.userDataDir)) {
    void restart(0, 0)
    return activeState as SdkDownloadState
  }

  emit({ status: 'downloading', receivedBytes: 0, totalBytes: 0 })
  void installBinary({
    userDataDir: options.userDataDir,
    proxyUrl: options.proxyUrl,
    version: options.version,
    onProgress: (receivedBytes, totalBytes) => emit({ status: 'downloading', receivedBytes, totalBytes })
  })
    .then(async (result) => {
      const received = activeState?.receivedBytes ?? 0
      const total = activeState?.totalBytes ?? 0
      if (!result.ok) {
        emit({ status: 'error', receivedBytes: received, totalBytes: total, message: result.message })
        return
      }
      await restart(received, total)
    })
    .catch((error) => {
      const received = activeState?.receivedBytes ?? 0
      const total = activeState?.totalBytes ?? 0
      emit({
        status: 'error',
        receivedBytes: received,
        totalBytes: total,
        message: error instanceof Error ? error.message : String(error)
      })
    })
  return activeState as SdkDownloadState
}
