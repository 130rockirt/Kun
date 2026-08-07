import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const CHROMIUM_COOKIE_SALT = Buffer.from('saltysalt')
const CHROMIUM_COOKIE_IV = Buffer.alloc(16, 0x20)
const KEYCHAIN_TIMEOUT_MS = 4_000

export type ChromiumCookieRow = {
  name: string
  value: string
  hostKey: string
}

export type ChromiumSafeStorageLabel = {
  service: string
  account: string
}

export type ChromiumBrowserCookieSource = {
  id: string
  displayName: string
  /** Application Support-relative profile root on macOS / Linux config root. */
  profileRootSegments: string[]
  /** Windows Local AppData-relative profile root. */
  windowsProfileRootSegments?: string[]
  safeStorageLabels: ChromiumSafeStorageLabel[]
}

/**
 * Chromium browsers CodexBar / SweetCookieKit can import from for OpenCode Go.
 * Keep Comet and Dia here — they are real session hosts for opencode.ai.
 */
export const OPENCODE_GO_CHROMIUM_BROWSERS: ChromiumBrowserCookieSource[] = [
  {
    id: 'chrome',
    displayName: 'Chrome',
    profileRootSegments: ['Google', 'Chrome'],
    windowsProfileRootSegments: ['Google', 'Chrome', 'User Data'],
    safeStorageLabels: [{ service: 'Chrome Safe Storage', account: 'Chrome' }]
  },
  {
    id: 'edge',
    displayName: 'Microsoft Edge',
    profileRootSegments: ['Microsoft Edge'],
    windowsProfileRootSegments: ['Microsoft', 'Edge', 'User Data'],
    safeStorageLabels: [
      { service: 'Microsoft Edge Safe Storage', account: 'Microsoft Edge' }
    ]
  },
  {
    id: 'brave',
    displayName: 'Brave',
    profileRootSegments: ['BraveSoftware', 'Brave-Browser'],
    windowsProfileRootSegments: ['BraveSoftware', 'Brave-Browser', 'User Data'],
    safeStorageLabels: [{ service: 'Brave Safe Storage', account: 'Brave' }]
  },
  {
    id: 'arc',
    displayName: 'Arc',
    profileRootSegments: ['Arc', 'User Data'],
    safeStorageLabels: [{ service: 'Arc Safe Storage', account: 'Arc' }]
  },
  {
    id: 'dia',
    displayName: 'Dia',
    profileRootSegments: ['Dia', 'User Data'],
    safeStorageLabels: [{ service: 'Dia Safe Storage', account: 'Dia' }]
  },
  {
    id: 'comet',
    displayName: 'Comet',
    profileRootSegments: ['Comet'],
    safeStorageLabels: [{ service: 'Comet Safe Storage', account: 'Comet' }]
  },
  {
    id: 'vivaldi',
    displayName: 'Vivaldi',
    profileRootSegments: ['Vivaldi'],
    windowsProfileRootSegments: ['Vivaldi', 'User Data'],
    safeStorageLabels: [{ service: 'Vivaldi Safe Storage', account: 'Vivaldi' }]
  },
  {
    id: 'chromium',
    displayName: 'Chromium',
    profileRootSegments: ['Chromium'],
    windowsProfileRootSegments: ['Chromium', 'User Data'],
    safeStorageLabels: [{ service: 'Chromium Safe Storage', account: 'Chromium' }]
  }
]

export type ChromiumCookieDatabaseCandidate = {
  browser: ChromiumBrowserCookieSource
  databasePath: string
}

export type ReadChromiumCookiesForDomainsOptions = {
  platform?: NodeJS.Platform
  environment?: NodeJS.ProcessEnv
  homeDirectory?: string
  browsers?: ChromiumBrowserCookieSource[]
  candidates?: ChromiumCookieDatabaseCandidate[]
  domainSuffixes?: string[]
  cookieNames?: Set<string>
  readSafeStoragePassword?: (
    label: ChromiumSafeStorageLabel
  ) => Promise<string | undefined>
}

/**
 * Reads Chromium cookies for the given domains, decrypting macOS Safe Storage
 * values when needed. Mirrors SweetCookieKit's best-effort Chromium path:
 * copy the locked Cookies DB, decrypt v10 blobs with PBKDF2+AES-CBC, and for
 * cookie DB version >= 24 strip the SHA-256(host_key) prefix.
 */
export async function readChromiumCookiesForDomains(
  options: ReadChromiumCookiesForDomainsOptions = {}
): Promise<ChromiumCookieRow[]> {
  const domainSuffixes = options.domainSuffixes ?? ['opencode.ai']
  const cookieNames = options.cookieNames
  const candidates = options.candidates ??
    listChromiumCookieDatabaseCandidates(options)
  for (const candidate of candidates) {
    try {
      const rows = await readCookiesFromDatabase(candidate.databasePath, domainSuffixes)
      const matched = rows.filter((row) =>
        cookieNames ? cookieNames.has(row.name.toLowerCase()) : true
      )
      if (matched.length === 0) continue

      const plaintext = matched.filter((row) => row.value.trim().length > 0)
      if (plaintext.length > 0) {
        return plaintext.map((row) => ({
          name: row.name,
          value: row.value,
          hostKey: row.hostKey
        }))
      }

      const encrypted = matched.filter((row) => row.encryptedValue.length > 0)
      if (encrypted.length === 0) continue
      const platform = options.platform ?? process.platform
      if (platform !== 'darwin') continue

      const password = await resolveSafeStoragePassword(
        candidate.browser,
        options.readSafeStoragePassword
      )
      if (!password) continue
      const key = deriveChromiumSafeStorageKey(password)
      const decrypted: ChromiumCookieRow[] = []
      for (const row of encrypted) {
        const value = decryptChromiumCookieValue(
          row.encryptedValue,
          key,
          row.hostKey,
          row.databaseVersion
        )
        if (!value?.trim()) continue
        decrypted.push({ name: row.name, value, hostKey: row.hostKey })
      }
      if (decrypted.length > 0) return decrypted
    } catch {
      // Locked/missing DBs and keychain denials are expected; try the next source.
    }
  }
  return []
}

export function listChromiumCookieDatabaseCandidates(
  options: Omit<
    ReadChromiumCookiesForDomainsOptions,
    'candidates' | 'domainSuffixes' | 'cookieNames' | 'readSafeStoragePassword'
  > = {}
): ChromiumCookieDatabaseCandidate[] {
  const platform = options.platform ?? process.platform
  const environment = options.environment ?? process.env
  const userHome = options.homeDirectory ?? homedir()
  const browsers = options.browsers ?? OPENCODE_GO_CHROMIUM_BROWSERS
  const joinPath = platform === 'win32' ? win32.join : join
  const roots: Array<{ browser: ChromiumBrowserCookieSource; root: string }> = []

  for (const browser of browsers) {
    if (platform === 'darwin') {
      roots.push({
        browser,
        root: joinPath(userHome, 'Library', 'Application Support', ...browser.profileRootSegments)
      })
      continue
    }
    if (platform === 'linux') {
      const linuxRootById: Record<string, string[]> = {
        chrome: ['google-chrome'],
        edge: ['microsoft-edge'],
        brave: ['brave'],
        arc: ['arc'],
        chromium: ['chromium'],
        vivaldi: ['vivaldi'],
        comet: ['comet']
      }
      const segments = linuxRootById[browser.id]
      if (!segments) continue
      roots.push({
        browser,
        root: joinPath(userHome, '.config', ...segments)
      })
      continue
    }
    if (platform === 'win32') {
      const segments = browser.windowsProfileRootSegments
      if (!segments) continue
      const localAppData = environment.LOCALAPPDATA?.trim()
      const localRoot = localAppData || joinPath(userHome, 'AppData', 'Local')
      roots.push({
        browser,
        root: joinPath(localRoot, ...segments)
      })
    }
  }

  const out: ChromiumCookieDatabaseCandidate[] = []
  for (const { browser, root } of roots) {
    for (const profileName of discoverChromiumProfileNamesSync(root)) {
      out.push(
        {
          browser,
          databasePath: joinPath(root, profileName, 'Network', 'Cookies')
        },
        {
          browser,
          databasePath: joinPath(root, profileName, 'Cookies')
        }
      )
    }
  }
  return out
}

/** Exported for tests: PBKDF2 key derivation used by Chromium Safe Storage. */
export function deriveChromiumSafeStorageKey(password: string): Buffer {
  return pbkdf2Sync(password, CHROMIUM_COOKIE_SALT, 1_003, 16, 'sha1')
}

/** Exported for tests: decrypt a Chromium v10 cookie blob. */
export function decryptChromiumCookieValue(
  encryptedValue: Buffer,
  key: Buffer,
  hostKey: string,
  databaseVersion: number
): string | undefined {
  if (encryptedValue.length <= 3) return undefined
  const prefix = encryptedValue.subarray(0, 3).toString('utf8')
  if (prefix !== 'v10') return undefined
  const payload = encryptedValue.subarray(3)
  if (payload.length === 0 || payload.length % 16 !== 0) return undefined
  let decrypted: Buffer
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, CHROMIUM_COOKIE_IV)
    decrypted = Buffer.concat([decipher.update(payload), decipher.final()])
  } catch {
    return undefined
  }
  let value = decrypted
  if (databaseVersion >= 24) {
    const expectedDomainHash = createHash('sha256').update(hostKey, 'utf8').digest()
    if (
      value.length < expectedDomainHash.length ||
      !value.subarray(0, expectedDomainHash.length).equals(expectedDomainHash)
    ) {
      return undefined
    }
    value = value.subarray(expectedDomainHash.length)
  }
  const text = value.toString('utf8')
  return text.length > 0 ? text : undefined
}

type RawCookieRow = {
  name: string
  value: string
  hostKey: string
  encryptedValue: Buffer
  databaseVersion: number
}

async function readCookiesFromDatabase(
  databasePath: string,
  domainSuffixes: string[]
): Promise<RawCookieRow[]> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'kun-chromium-cookies-'))
  const copiedDb = join(tempRoot, 'Cookies')
  try {
    await copyFile(databasePath, copiedDb)
    await Promise.allSettled([
      copyFile(`${databasePath}-wal`, `${copiedDb}-wal`),
      copyFile(`${databasePath}-shm`, `${copiedDb}-shm`)
    ])

    let sqliteModule: { default: typeof import('better-sqlite3') }
    try {
      sqliteModule = await import('better-sqlite3')
    } catch {
      return await readCookiesFromDatabaseWithSqliteCli(copiedDb, domainSuffixes)
    }

    let database: import('better-sqlite3').Database
    try {
      database = new sqliteModule.default(copiedDb, {
        readonly: true,
        fileMustExist: true
      })
    } catch {
      // Native module ABI mismatches (system Node vs Electron) fall back to sqlite3 CLI.
      return await readCookiesFromDatabaseWithSqliteCli(copiedDb, domainSuffixes)
    }
    try {
      database.pragma('query_only = ON')
      database.pragma('busy_timeout = 250')
      const versionRow = database.prepare(
        "SELECT value FROM meta WHERE key = 'version' LIMIT 1"
      ).get() as { value?: string | number } | undefined
      const databaseVersion = Number(versionRow?.value ?? 0)
      const where = domainSuffixes
        .map(() => 'host_key LIKE ?')
        .join(' OR ')
      const params = domainSuffixes.map((suffix) => `%${suffix}`)
      const rows = database.prepare(`
        SELECT host_key AS hostKey, name, value, encrypted_value AS encryptedValue
        FROM cookies
        WHERE ${where}
      `).all(...params) as Array<{
        hostKey?: unknown
        name?: unknown
        value?: unknown
        encryptedValue?: unknown
      }>
      return rows.flatMap((row) => {
        const hostKey = typeof row.hostKey === 'string' ? row.hostKey : ''
        const name = typeof row.name === 'string' ? row.name : ''
        if (!hostKey || !name) return []
        const value = typeof row.value === 'string' ? row.value : ''
        const encryptedValue = Buffer.isBuffer(row.encryptedValue)
          ? row.encryptedValue
          : row.encryptedValue instanceof Uint8Array
            ? Buffer.from(row.encryptedValue)
            : Buffer.alloc(0)
        return [{ name, value, hostKey, encryptedValue, databaseVersion }]
      })
    } finally {
      database.close()
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

async function readCookiesFromDatabaseWithSqliteCli(
  databasePath: string,
  domainSuffixes: string[]
): Promise<RawCookieRow[]> {
  const binary = process.platform === 'darwin' ? '/usr/bin/sqlite3' : 'sqlite3'
  const where = domainSuffixes
    .map((suffix) => `host_key LIKE '%${suffix.replaceAll("'", "''")}%'`)
    .join(' OR ')
  const versionResult = await execFileAsync(binary, [
    databasePath,
    "SELECT value FROM meta WHERE key='version' LIMIT 1;"
  ], {
    encoding: 'utf8',
    timeout: 2_000,
    maxBuffer: 64 * 1024
  }).catch(() => ({ stdout: '0' }))
  const databaseVersion = Number(versionResult.stdout.trim() || 0)
  const { stdout } = await execFileAsync(binary, [
    '-separator',
    '\t',
    databasePath,
    `SELECT host_key, name, value, hex(encrypted_value) FROM cookies WHERE ${where};`
  ], {
    encoding: 'utf8',
    timeout: 2_000,
    maxBuffer: 512 * 1024
  })
  return stdout
    .split('\n')
    .flatMap((line) => {
      if (!line.trim()) return []
      const [hostKey, name, value, encryptedHex = ''] = line.split('\t')
      if (!hostKey || !name) return []
      return [{
        hostKey,
        name,
        value: value ?? '',
        encryptedValue: encryptedHex
          ? Buffer.from(encryptedHex, 'hex')
          : Buffer.alloc(0),
        databaseVersion
      }]
    })
}

async function resolveSafeStoragePassword(
  browser: ChromiumBrowserCookieSource,
  override?: (label: ChromiumSafeStorageLabel) => Promise<string | undefined>
): Promise<string | undefined> {
  for (const label of browser.safeStorageLabels) {
    if (override) {
      const password = await override(label)
      if (password?.trim()) return password.trim()
      continue
    }
    const password = await readMacosSafeStoragePassword(label)
    if (password?.trim()) return password.trim()
  }
  return undefined
}

async function readMacosSafeStoragePassword(
  label: ChromiumSafeStorageLabel
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-w',
      '-s',
      label.service,
      '-a',
      label.account
    ], {
      encoding: 'utf8',
      timeout: KEYCHAIN_TIMEOUT_MS,
      maxBuffer: 64 * 1024
    })
    const password = stdout.trim()
    return password || undefined
  } catch {
    return undefined
  }
}

function discoverChromiumProfileNamesSync(root: string): string[] {
  // Synchronous discovery keeps path listing pure for tests; IO failures just
  // fall back to the Default profile, which matches the previous OpenCode Go behavior.
  try {
    const entries = readdirSync(root, { withFileTypes: true })
    const names = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) =>
        name === 'Default' ||
        name.startsWith('Profile ') ||
        name.startsWith('user-')
      )
      .sort((left, right) => left.localeCompare(right))
    return names.length > 0 ? names : ['Default']
  } catch {
    return ['Default']
  }
}
