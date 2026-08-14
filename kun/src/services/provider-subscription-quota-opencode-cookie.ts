import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ProviderQuotaMetric } from '../contracts/provider-quota.js'
import { GeminiCliOAuthSource } from '../adapters/model/gemini-cli-oauth.js'
import {
  codexCliUserAgent,
  geminiCliRequestHeaders
} from '../adapters/model/provider-cli-identity.js'
import {
  isStoredCodexCredentialExpired,
  parseStoredCodexOAuthCredentials,
  refreshStoredCodexOAuthCredentials,
  type StoredCodexOAuthCredentials
} from './codex-oauth-credential-refresher.js'
import {
  isStoredGrokCredentialExpired,
  parseStoredGrokOAuthCredentials,
  refreshStoredGrokOAuthCredentials,
  type StoredGrokOAuthCredentials
} from './grok-oauth-credential-refresher.js'
import {
  readOpenCodeGoLocalQuota,
  type OpenCodeGoLocalQuotaResult
} from './opencode-go-local-quota.js'
import {
  fetchOpenCodeGoWebQuota as fetchOpenCodeGoWebQuotaImpl,
  filterOpenCodeGoCookieHeader,
  OpenCodeGoWebQuotaError,
  type OpenCodeGoWebQuotaResult
} from './opencode-go-web-quota.js'
import {
  listChromiumCookieDatabaseCandidates,
  readChromiumCookiesForDomainsWithDiagnosis,
  type ChromiumCookieDatabaseCandidate
} from './chromium-browser-cookies.js'
import { execFileAsync } from './provider-subscription-quota-service.js'
import { type JsonRecord, optionalRecord } from './provider-subscription-quota-support.js'

export type OpenCodeGoCookieResolverOptions = {
  platform?: NodeJS.Platform
  environment?: NodeJS.ProcessEnv
  homeDirectory?: string
  /** Prefer this Cookie header over env/cache/browser import. */
  manualCookieHeader?: string
  /** When true, skip the in-memory / Keychain cookie cache. */
  bypassCache?: boolean
  cookieDatabasePaths?: string[]
  readCookies?: (databasePath: string) => Promise<Array<{ name: string; value: string }>>
  readSafeStoragePassword?: (
    label: { service: string; account: string }
  ) => Promise<string | undefined>
}

export type OpenCodeGoCookieFailureReason = 'not_found' | 'decrypt_failed'

export type OpenCodeGoCookieResolveResult = {
  cookieHeader?: string
  source?: 'manual' | 'cache' | 'browser'
  failureReason?: OpenCodeGoCookieFailureReason
}

export const OPENCODE_GO_SIGN_IN_MESSAGE =
  'Sign in to opencode.ai in your browser, or use OpenCode Go locally first so its usage history exists.'

export const OPENCODE_GO_KEYCHAIN_MESSAGE =
  'Found an opencode.ai browser session, but could not unlock the browser Safe Storage keychain. Allow Keychain access for Kun (Chrome/Comet Safe Storage), or set KUN_OPENCODE_GO_COOKIE to a Cookie header.'

export const OPENCODE_GO_COOKIE_ENV = 'KUN_OPENCODE_GO_COOKIE'

export const OPENCODE_COOKIE_NAMES = new Set(['auth', '__host-auth'])

export const OPENCODE_GO_COOKIE_DOMAINS = ['opencode.ai', 'app.opencode.ai']

export const OPENCODE_GO_CACHE_SERVICE = 'kun-opencode-go'

export const OPENCODE_GO_CACHE_ACCOUNT = 'session-cookie'

export let openCodeGoCookieMemoryCache: string | undefined

export let openCodeGoCookieFailureReason: OpenCodeGoCookieFailureReason | undefined

/** Last browser-import failure for OpenCode Go quota probe messaging. */
export function getOpenCodeGoCookieFailureReason(): OpenCodeGoCookieFailureReason | undefined {
  return openCodeGoCookieFailureReason
}

/** Clears in-memory and Keychain-cached OpenCode Go session cookies. */
export function clearOpenCodeGoCookieCache(): void {
  openCodeGoCookieMemoryCache = undefined
  openCodeGoCookieFailureReason = undefined
  void clearPersistedOpenCodeGoCookieCache()
}

/**
 * Resolves an OpenCode session cookie header (auth / __Host-auth) from manual
 * config/env, a short-lived cache, or installed Chromium-family browsers
 * (including Comet/Dia), decrypting macOS Safe Storage values when needed.
 * Any read failure, missing cookie, or undecryptable cookie returns undefined
 * so callers fall back to the local usage database instead of surfacing an
 * error — use {@link getOpenCodeGoCookieFailureReason} for the specific cause.
 */
export async function resolveOpenCodeGoCookie(
  options: OpenCodeGoCookieResolverOptions = {}
): Promise<string | undefined> {
  const result = await resolveOpenCodeGoCookieResult(options)
  return result.cookieHeader
}

export async function resolveOpenCodeGoCookieResult(
  options: OpenCodeGoCookieResolverOptions = {}
): Promise<OpenCodeGoCookieResolveResult> {
  const environment = options.environment ?? process.env
  const injectedReader = Boolean(options.readCookies || options.cookieDatabasePaths)
  const allowCache = !options.bypassCache && !injectedReader

  if (!injectedReader) {
    const manual = filterOpenCodeGoCookieHeader(
      options.manualCookieHeader ??
        environment[OPENCODE_GO_COOKIE_ENV] ??
        undefined
    )
    if (manual) {
      openCodeGoCookieFailureReason = undefined
      openCodeGoCookieMemoryCache = manual
      void persistOpenCodeGoCookieCache(manual, options.platform)
      return { cookieHeader: manual, source: 'manual' }
    }

    if (allowCache) {
      const cached = openCodeGoCookieMemoryCache ??
        await loadPersistedOpenCodeGoCookieCache(options.platform)
      const filteredCached = filterOpenCodeGoCookieHeader(cached)
      if (filteredCached) {
        openCodeGoCookieMemoryCache = filteredCached
        openCodeGoCookieFailureReason = undefined
        return { cookieHeader: filteredCached, source: 'cache' }
      }
    }
  } else if (options.manualCookieHeader) {
    const manual = filterOpenCodeGoCookieHeader(options.manualCookieHeader)
    if (manual) {
      openCodeGoCookieFailureReason = undefined
      return { cookieHeader: manual, source: 'manual' }
    }
  }

  // Tests and callers can still inject plaintext cookie readers per DB path.
  if (injectedReader) {
    const databasePaths = options.cookieDatabasePaths ??
      openCodeGoCookieDatabasePaths(options)
    const readCookies = options.readCookies
    if (!readCookies) {
      return resolveOpenCodeGoCookieFromChromiumSources({
        ...options,
        candidates: databasePaths.map((databasePath) => ({
          browser: {
            id: 'custom',
            displayName: 'Custom',
            profileRootSegments: [],
            // Allow Safe Storage overrides when callers inject DB paths only.
            safeStorageLabels: [
              { service: 'Chrome Safe Storage', account: 'Chrome' },
              { service: 'Comet Safe Storage', account: 'Comet' }
            ]
          },
          databasePath
        }))
      })
    }
    for (const databasePath of databasePaths) {
      try {
        const cookies = await readCookies(databasePath)
        const pairs = cookies
          .filter((cookie) => OPENCODE_COOKIE_NAMES.has(cookie.name.toLowerCase()))
          .filter((cookie) => cookie.value.trim().length > 0)
          .filter((cookie) => !cookie.value.startsWith('v10'))
          .map((cookie) => `${cookie.name}=${cookie.value}`)
        if (pairs.length > 0) {
          const cookieHeader = pairs.join('; ')
          openCodeGoCookieFailureReason = undefined
          return { cookieHeader, source: 'browser' }
        }
      } catch {
        // Browser cookie databases may be locked; try the next candidate.
      }
    }
    openCodeGoCookieFailureReason = 'not_found'
    return { failureReason: 'not_found' }
  }

  return resolveOpenCodeGoCookieFromChromiumSources(options)
}

export async function resolveOpenCodeGoCookieFromChromiumSources(
  options: OpenCodeGoCookieResolverOptions & {
    candidates?: ChromiumCookieDatabaseCandidate[]
  }
): Promise<OpenCodeGoCookieResolveResult> {
  const { cookies, diagnosis } = await readChromiumCookiesForDomainsWithDiagnosis({
    platform: options.platform,
    environment: options.environment,
    homeDirectory: options.homeDirectory,
    candidates: options.candidates,
    domainSuffixes: OPENCODE_GO_COOKIE_DOMAINS,
    cookieNames: OPENCODE_COOKIE_NAMES,
    ...(options.readSafeStoragePassword
      ? { readSafeStoragePassword: options.readSafeStoragePassword }
      : {})
  })
  const pairs = cookies
    .filter((cookie) => OPENCODE_COOKIE_NAMES.has(cookie.name.toLowerCase()))
    .filter((cookie) => cookie.value.trim().length > 0)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
  if (pairs.length > 0) {
    const cookieHeader = pairs.join('; ')
    openCodeGoCookieFailureReason = undefined
    openCodeGoCookieMemoryCache = cookieHeader
    void persistOpenCodeGoCookieCache(cookieHeader, options.platform)
    return { cookieHeader, source: 'browser' }
  }
  const failureReason: OpenCodeGoCookieFailureReason =
    diagnosis.kind === 'decrypt_failed' ? 'decrypt_failed' : 'not_found'
  openCodeGoCookieFailureReason = failureReason
  return { failureReason }
}

export async function loadPersistedOpenCodeGoCookieCache(
  platform: NodeJS.Platform | undefined
): Promise<string | undefined> {
  if ((platform ?? process.platform) !== 'darwin') return undefined
  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-w',
      '-s',
      OPENCODE_GO_CACHE_SERVICE,
      '-a',
      OPENCODE_GO_CACHE_ACCOUNT
    ], {
      encoding: 'utf8',
      timeout: 2_000,
      maxBuffer: 64 * 1024
    })
    return filterOpenCodeGoCookieHeader(stdout.trim()) || undefined
  } catch {
    return undefined
  }
}

export async function persistOpenCodeGoCookieCache(
  cookieHeader: string,
  platform: NodeJS.Platform | undefined
): Promise<void> {
  if ((platform ?? process.platform) !== 'darwin') return
  try {
    await execFileAsync('security', [
      'add-generic-password',
      '-U',
      '-s',
      OPENCODE_GO_CACHE_SERVICE,
      '-a',
      OPENCODE_GO_CACHE_ACCOUNT,
      '-w',
      cookieHeader
    ], {
      encoding: 'utf8',
      timeout: 2_000,
      maxBuffer: 64 * 1024
    })
  } catch {
    // Cache persistence is best-effort.
  }
}

export async function clearPersistedOpenCodeGoCookieCache(): Promise<void> {
  if (process.platform !== 'darwin') return
  try {
    await execFileAsync('security', [
      'delete-generic-password',
      '-s',
      OPENCODE_GO_CACHE_SERVICE,
      '-a',
      OPENCODE_GO_CACHE_ACCOUNT
    ], {
      encoding: 'utf8',
      timeout: 2_000,
      maxBuffer: 64 * 1024
    })
  } catch {
    // Missing cache entries are fine.
  }
}

export function openCodeGoCookieDatabasePaths(
  options: Omit<OpenCodeGoCookieResolverOptions, 'readCookies' | 'readSafeStoragePassword'> = {}
): string[] {
  return listChromiumCookieDatabaseCandidates({
    platform: options.platform,
    environment: options.environment,
    homeDirectory: options.homeDirectory
  }).map((candidate) => candidate.databasePath)
}

export async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

export function resolveHomePath(value: string): string {
  if (value === '~') return homedir()
  return value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
}

export async function readSqliteValue(dbPath: string, key: string): Promise<string | undefined> {
  const binary = process.platform === 'darwin' ? '/usr/bin/sqlite3' : 'sqlite3'
  try {
    const escapedKey = key.replaceAll("'", "''")
    const { stdout } = await execFileAsync(binary, [
      dbPath,
      `SELECT value FROM ItemTable WHERE key='${escapedKey}' LIMIT 1;`
    ], {
      encoding: 'utf8',
      timeout: 2_000,
      maxBuffer: 512 * 1024
    })
    return stdout.trim() || undefined
  } catch {
    return undefined
  }
}

export function headerValue(headers: Record<string, string> | undefined, name: string): string {
  const match = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())
  return match?.[1]?.trim() ?? ''
}

export function jwtClaims(token: string): JsonRecord | undefined {
  const payload = token.split('.')[1]
  if (!payload) return undefined
  try {
    return optionalRecord(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
  } catch {
    return undefined
  }
}

export function protobufLengthFields(buffer: Buffer): Array<{ number: number; value: Buffer }> {
  const fields: Array<{ number: number; value: Buffer }> = []
  let offset = 0
  while (offset < buffer.length) {
    const tag = protobufVarint(buffer, offset)
    if (!tag) return []
    offset = tag.offset
    const number = Math.floor(tag.value / 8)
    const wireType = tag.value % 8
    if (number <= 0 || wireType !== 2) return []
    const length = protobufVarint(buffer, offset)
    if (!length) return []
    offset = length.offset
    const end = offset + length.value
    if (length.value < 0 || end > buffer.length) return []
    fields.push({ number, value: buffer.subarray(offset, end) })
    offset = end
  }
  return fields
}

export function protobufVarint(
  buffer: Buffer,
  initialOffset: number
): { value: number; offset: number } | undefined {
  let value = 0
  let shift = 0
  let offset = initialOffset
  while (offset < buffer.length && shift <= 49) {
    const byte = buffer[offset]!
    offset += 1
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return { value, offset }
    shift += 7
  }
  return undefined
}
