import { execFile } from 'node:child_process'
import { constants, accessSync, realpathSync, statSync } from 'node:fs'
import { delimiter, posix, win32 } from 'node:path'
import type { McpServerConfig } from '../../contracts/capabilities.js'
import {
  KUN_GITHUB_PAT_ENV_VAR,
  isKunManagedGitHubMcpServer
} from '../../contracts/builtin-mcp.js'
import { McpAuthorizationRequiredError } from './mcp-types.js'

const GITHUB_CLI_TOKEN_TIMEOUT_MS = 5_000
const GITHUB_CLI_TOKEN_MAX_BUFFER_BYTES = 64 * 1024
const GITHUB_TOKEN_ENV_VARS = [KUN_GITHUB_PAT_ENV_VAR, 'GH_TOKEN', 'GITHUB_TOKEN'] as const
const GITHUB_CLI_ENV_ALLOWLIST = [
  'HOME',
  'USER',
  'LOGNAME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'GH_CONFIG_DIR',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL'
] as const

export const GITHUB_MCP_AUTHORIZATION_REQUIRED_MESSAGE =
  `GitHub authorization required. Run "gh auth login" or set ${KUN_GITHUB_PAT_ENV_VAR} before starting Kun, then restart Kun.`

export const GITHUB_MCP_AUTHORIZATION_REJECTED_MESSAGE =
  `GitHub credentials were rejected. Refresh the "gh auth login" session or ${KUN_GITHUB_PAT_ENV_VAR}, then restart Kun.`

export type GitHubMcpCredentialOptions = {
  env?: NodeJS.ProcessEnv
  readGitHubCliToken?: (env: NodeJS.ProcessEnv) => Promise<string | undefined>
}

/**
 * Materialize the managed GitHub bearer header only in memory. The generated
 * config retains an environment reference, while desktop launches can reuse
 * the GitHub CLI credential stored in the OS credential manager.
 */
export async function resolveBuiltinGitHubMcpCredentials(
  serverId: string,
  server: McpServerConfig,
  options: GitHubMcpCredentialOptions = {}
): Promise<McpServerConfig> {
  if (!isKunManagedGitHubMcpServer(server)) return server
  const env = options.env ?? process.env
  const environmentToken = firstGitHubEnvironmentToken(env)
  const cliToken = environmentToken
    ? undefined
    : await (options.readGitHubCliToken ?? readGitHubCliToken)(env)
  const token = environmentToken || cliToken?.trim()
  if (!token) {
    throw new McpAuthorizationRequiredError(
      serverId,
      GITHUB_MCP_AUTHORIZATION_REQUIRED_MESSAGE
    )
  }
  return {
    ...server,
    headers: {
      ...server.headers,
      Authorization: `Bearer ${token}`
    }
  }
}

export type GitHubCliExecutableSource = 'fixed' | 'path' | 'windows-fallback'

export type ResolvedGitHubCliExecutable = {
  path: string
  source: GitHubCliExecutableSource
}

/**
 * `gh auth token` reads the credential through GitHub CLI's own credential handling.
 * Failures intentionally collapse to "unavailable" without exposing stderr,
 * command output, or credential-store details in runtime diagnostics.
 */
export function readGitHubCliToken(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const resolvedExecutable = resolveGitHubCliExecutableDetails(env)
  if (!resolvedExecutable) return Promise.resolve(undefined)
  process.stderr.write(
    `kun github-mcp: using gh executable from ${resolvedExecutable.source}: ${resolvedExecutable.path}\n`
  )
  return new Promise((resolve) => {
    execFile(
      resolvedExecutable.path,
      ['auth', 'token', '--hostname', 'github.com'],
      {
        encoding: 'utf8',
        env: githubCliEnvironment(env, resolvedExecutable.path),
        maxBuffer: GITHUB_CLI_TOKEN_MAX_BUFFER_BYTES,
        timeout: GITHUB_CLI_TOKEN_TIMEOUT_MS,
        windowsHide: true,
        shell: false
      },
      (error, stdout) => {
        if (error) {
          resolve(undefined)
          return
        }
        const token = stdout.trim()
        resolve(token || undefined)
      }
    )
  })
}

/** Resolve a verified GitHub CLI from known locations, then the user's PATH. */
export function resolveGitHubCliExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  isExecutable: (path: string) => boolean = (path) => isExecutableFile(path, platform),
  resolveRealpath: (path: string) => string = realpathSync
): string | undefined {
  return resolveGitHubCliExecutableDetails(env, platform, isExecutable, resolveRealpath)?.path
}

export function resolveGitHubCliExecutableDetails(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  isExecutable: (path: string) => boolean = (path) => isExecutableFile(path, platform),
  resolveRealpath: (path: string) => string = realpathSync
): ResolvedGitHubCliExecutable | undefined {
  for (const candidate of githubCliExecutableCandidates(platform, env)) {
    const path = resolveExecutableCandidate(candidate, platform, isExecutable, resolveRealpath)
    if (path) return { path, source: 'fixed' }
  }
  for (const candidate of githubCliPathCandidates(platform, env)) {
    const path = resolveExecutableCandidate(candidate, platform, isExecutable, resolveRealpath)
    if (path) return { path, source: 'path' }
  }
  for (const candidate of windowsGitHubCliFallbackCandidates(platform, env)) {
    const path = resolveExecutableCandidate(candidate, platform, isExecutable, resolveRealpath)
    if (path) return { path, source: 'windows-fallback' }
  }
  return undefined
}

/** Minimal child environment needed for gh config and OS credential stores. */
export function githubCliEnvironment(
  env: NodeJS.ProcessEnv,
  executable: string,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {}
  for (const key of GITHUB_CLI_ENV_ALLOWLIST) {
    const value = env[key]
    if (value !== undefined) childEnv[key] = value
  }
  const safeSystemPaths = platform === 'win32'
    ? windowsSystemPaths(env)
    : ['/usr/bin', '/bin', '/usr/sbin', '/sbin']
  const pathDelimiter = platform === 'win32' ? ';' : ':'
  const pathApi = platform === 'win32' ? win32 : posix
  childEnv.PATH = [...new Set([pathApi.dirname(executable), ...safeSystemPaths])].join(pathDelimiter)
  return childEnv
}

function firstGitHubEnvironmentToken(env: NodeJS.ProcessEnv): string | undefined {
  for (const name of GITHUB_TOKEN_ENV_VARS) {
    const value = env[name]?.trim()
    if (value) return value
  }
  return undefined
}

function githubCliExecutableCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): string[] {
  const executable = platform === 'win32' ? 'gh.exe' : 'gh'
  if (platform === 'darwin') {
    return [
      posix.join('/opt/homebrew/bin', executable),
      posix.join('/usr/local/bin', executable),
      posix.join('/opt/local/bin', executable)
    ]
  }
  if (platform === 'linux') {
    return [
      posix.join('/home/linuxbrew/.linuxbrew/bin', executable),
      posix.join('/usr/local/bin', executable),
      posix.join('/usr/bin', executable),
      posix.join('/snap/bin', executable)
    ]
  }
  if (platform === 'win32') {
    return [
      env.ProgramFiles ? win32.join(env.ProgramFiles, 'GitHub CLI', executable) : '',
      env['ProgramFiles(x86)']
        ? win32.join(env['ProgramFiles(x86)'], 'GitHub CLI', executable)
        : '',
      env.LOCALAPPDATA
        ? win32.join(env.LOCALAPPDATA, 'Programs', 'GitHub CLI', executable)
        : ''
    ].filter(Boolean)
  }
  return []
}

function githubCliPathCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const pathValue = env.PATH
  if (!pathValue) return []
  const pathApi = platform === 'win32' ? win32 : posix
  const executable = platform === 'win32' ? 'gh.exe' : 'gh'
  const pathDelimiter = platform === 'win32' ? win32.delimiter : delimiter
  const directories = pathValue
    .split(pathDelimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
  return [...new Set(directories)].map((directory) => pathApi.join(directory, executable))
}

function windowsGitHubCliFallbackCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): string[] {
  if (platform !== 'win32') return []
  const executable = 'gh.exe'
  return [
    env.USERPROFILE ? win32.join(env.USERPROFILE, 'scoop', 'shims', executable) : '',
    env.LOCALAPPDATA
      ? win32.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', executable)
      : ''
  ].filter(Boolean)
}

function resolveExecutableCandidate(
  candidate: string,
  platform: NodeJS.Platform,
  isExecutable: (path: string) => boolean,
  resolveRealpath: (path: string) => string
): string | undefined {
  const pathApi = platform === 'win32' ? win32 : posix
  try {
    const absoluteCandidate = pathApi.resolve(candidate)
    const resolvedPath = resolveRealpath(absoluteCandidate)
    return isExecutable(resolvedPath) ? resolvedPath : undefined
  } catch {
    return undefined
  }
}

function windowsSystemPaths(env: NodeJS.ProcessEnv): string[] {
  const root = env.SystemRoot ?? env.WINDIR
  return root ? [win32.join(root, 'System32'), root] : []
}

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    const resolvedPath = realpathSync(path)
    if (!statSync(resolvedPath).isFile()) return false
    accessSync(resolvedPath, platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}
