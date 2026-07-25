import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { GEMINI_CLI_SUBSCRIPTION_MODEL_IDS } from '../shared/model-provider-presets'

const execFileAsync = promisify(execFile)

export type GeminiCliSubscriptionStatus = {
  installed: boolean
  authenticated: boolean
  path?: string
  credentialSource?: 'keychain' | 'file'
}

export function resolveGeminiCliBinary(): string | undefined {
  const executable = process.platform === 'win32' ? 'gemini.cmd' : 'gemini'
  const pathCandidates = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, executable))
  const candidates = [
    ...pathCandidates,
    join(homedir(), '.local', 'bin', executable),
    ...(process.platform === 'darwin'
      ? [
          join('/opt/homebrew/bin', executable),
          join('/usr/local/bin', executable)
        ]
      : process.platform === 'win32'
        ? []
        : [join('/usr/local/bin', executable), join('/usr/bin', executable)])
  ]
  return candidates.find((candidate) => existsSync(candidate))
}

export async function geminiCliSubscriptionStatus(): Promise<GeminiCliSubscriptionStatus> {
  const binaryPath = resolveGeminiCliBinary()
  const legacyCredentialPath = join(homedir(), '.gemini', 'oauth_creds.json')
  const keychain = process.platform === 'darwin'
    ? await hasMacGeminiCliCredential()
    : false
  const file = existsSync(legacyCredentialPath)
  return {
    installed: Boolean(binaryPath),
    authenticated: keychain || file,
    ...(binaryPath ? { path: binaryPath } : {}),
    ...(keychain
      ? { credentialSource: 'keychain' as const }
      : file
        ? { credentialSource: 'file' as const }
        : {})
  }
}

export function geminiCliSubscriptionModels(): string[] {
  return [...GEMINI_CLI_SUBSCRIPTION_MODEL_IDS]
}

async function hasMacGeminiCliCredential(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/security', [
      'find-generic-password',
      '-s',
      'gemini-cli-oauth',
      '-a',
      'main-account',
      '-w'
    ], {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 512 * 1024
    })
    const parsed = JSON.parse(stdout.trim()) as {
      token?: { accessToken?: unknown; refreshToken?: unknown }
    }
    return Boolean(
      typeof parsed.token?.accessToken === 'string' ||
      typeof parsed.token?.refreshToken === 'string'
    )
  } catch {
    return false
  }
}
