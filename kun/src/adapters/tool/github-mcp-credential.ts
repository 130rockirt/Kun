import { execFile } from 'node:child_process'
import { constants, accessSync, statSync } from 'node:fs'
import { dirname, posix, win32 } from 'node:path'
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

/**
 * `gh auth token` reads the credential through GitHub CLI's own credential handling.
 * Failures intentionally collapse to "unavailable" without exposing stderr,
 * command output, or credential-store details in runtime diagnostics.
 */
export function readGitHubCliToken(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const executable = resolveGitHubCliExecutable(env)
  if (!executable) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    execFile(
      executable,
      ['auth', 'token', '--hostname', 'github.com'],
      {
        encoding: 'utf8',
        env: githubCliEnvironment(env, executable),
        maxBuffer: GITHUB_CLI_TOKEN_MAX_BUFFER_BYTES,
        timeout: GITHUB_CLI_TOKEN_TIMEOUT_MS,
        windowsHide: true
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

/** Resolve only known GitHub CLI install locations, never an arbitrary PATH entry. */
export function resolveGitHubCliExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  isExecutable: (path: string) => boolean = (path) => isExecutableFile(path, platform)
): string | undefined {
  const candidates = githubCliExecutableCandidates(platform, env)
  return candidates.find((candidate) => isExecutable(candidate))
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
  childEnv.PATH = [...new Set([dirname(executable), ...safeSystemPaths])].join(pathDelimiter)
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

function windowsSystemPaths(env: NodeJS.ProcessEnv): string[] {
  const root = env.SystemRoot ?? env.WINDIR
  return root ? [win32.join(root, 'System32'), root] : []
}

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}
