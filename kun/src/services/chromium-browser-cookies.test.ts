import { createCipheriv, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  decryptChromiumCookieValue,
  deriveChromiumSafeStorageKey,
  listChromiumCookieDatabaseCandidates,
  readChromiumCookiesForDomains
} from './chromium-browser-cookies.js'

describe('chromium-browser-cookies', () => {
  it('lists Comet cookie databases on macOS', () => {
    const paths = listChromiumCookieDatabaseCandidates({
      platform: 'darwin',
      homeDirectory: '/Users/kun',
      environment: {}
    }).map((candidate) => candidate.databasePath)

    expect(paths).toEqual(expect.arrayContaining([
      '/Users/kun/Library/Application Support/Google/Chrome/Default/Network/Cookies',
      '/Users/kun/Library/Application Support/Google/Chrome/Default/Cookies',
      '/Users/kun/Library/Application Support/Comet/Default/Network/Cookies',
      '/Users/kun/Library/Application Support/Comet/Default/Cookies',
      '/Users/kun/Library/Application Support/Dia/User Data/Default/Cookies'
    ]))
  })

  it('decrypts v10 cookies with DB version >= 24 domain hash prefix', () => {
    const password = 'test-password'
    const key = deriveChromiumSafeStorageKey(password)
    const hostKey = 'opencode.ai'
    const plaintext = 'session-token-value'
    const encrypted = encryptV10Cookie(plaintext, key, hostKey, 24)

    expect(decryptChromiumCookieValue(encrypted, key, hostKey, 24)).toBe(plaintext)
    expect(
      decryptChromiumCookieValue(encrypted, key, 'other.host', 24)
    ).toBeUndefined()
  })

  it('reads and decrypts OpenCode auth cookies from a Chromium DB', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kun-chromium-cookie-'))
    const databasePath = join(directory, 'Cookies')
    const password = 'comet-password'
    const key = deriveChromiumSafeStorageKey(password)
    const hostKey = 'opencode.ai'
    const token = 'auth-session-token'
    const encrypted = encryptV10Cookie(token, key, hostKey, 24)
    const localeEncrypted = encryptV10Cookie('en', key, hostKey, 24)
    createCookieDatabase(databasePath, [
      { hostKey, name: 'auth', value: '', encryptedHex: encrypted.toString('hex') },
      { hostKey, name: 'oc_locale', value: '', encryptedHex: localeEncrypted.toString('hex') }
    ])

    const cookies = await readChromiumCookiesForDomains({
      platform: 'darwin',
      candidates: [{
        browser: {
          id: 'comet',
          displayName: 'Comet',
          profileRootSegments: ['Comet'],
          safeStorageLabels: [{ service: 'Comet Safe Storage', account: 'Comet' }]
        },
        databasePath
      }],
      domainSuffixes: ['opencode.ai'],
      cookieNames: new Set(['auth', '__host-auth']),
      readSafeStoragePassword: async () => password
    })

    expect(cookies).toEqual([
      { name: 'auth', value: token, hostKey: 'opencode.ai' }
    ])
  })

  it('prefers plaintext cookie values without touching Safe Storage', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kun-chromium-cookie-plain-'))
    const databasePath = join(directory, 'Cookies')
    createCookieDatabase(databasePath, [
      { hostKey: 'opencode.ai', name: 'auth', value: 'plain-token', encryptedHex: '' }
    ])

    let passwordCalls = 0
    const cookies = await readChromiumCookiesForDomains({
      platform: 'darwin',
      candidates: [{
        browser: {
          id: 'chrome',
          displayName: 'Chrome',
          profileRootSegments: ['Google', 'Chrome'],
          safeStorageLabels: [{ service: 'Chrome Safe Storage', account: 'Chrome' }]
        },
        databasePath
      }],
      cookieNames: new Set(['auth']),
      readSafeStoragePassword: async () => {
        passwordCalls += 1
        return 'unused'
      }
    })

    expect(cookies).toEqual([
      { name: 'auth', value: 'plain-token', hostKey: 'opencode.ai' }
    ])
    expect(passwordCalls).toBe(0)
  })
})

function createCookieDatabase(
  databasePath: string,
  rows: Array<{ hostKey: string; name: string; value: string; encryptedHex: string }>
): void {
  const binary = process.platform === 'darwin' ? '/usr/bin/sqlite3' : 'sqlite3'
  const inserts = rows.map((row) => {
    const encryptedSql = row.encryptedHex ? `X'${row.encryptedHex}'` : `X''`
    return `INSERT INTO cookies (host_key, name, value, encrypted_value) VALUES ('${row.hostKey}', '${row.name}', '${row.value}', ${encryptedSql});`
  }).join('\n')
  execFileSync(binary, [databasePath], {
    input: `
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE cookies (
        host_key TEXT,
        name TEXT,
        value TEXT,
        encrypted_value BLOB
      );
      INSERT INTO meta (key, value) VALUES ('version', '24');
      ${inserts}
    `,
    encoding: 'utf8'
  })
}

function encryptV10Cookie(
  plaintext: string,
  key: Buffer,
  hostKey: string,
  databaseVersion: number
): Buffer {
  const body = databaseVersion >= 24
    ? Buffer.concat([
      createHash('sha256').update(hostKey, 'utf8').digest(),
      Buffer.from(plaintext, 'utf8')
    ])
    : Buffer.from(plaintext, 'utf8')
  const iv = Buffer.alloc(16, 0x20)
  const cipher = createCipheriv('aes-128-cbc', key, iv)
  const encrypted = Buffer.concat([cipher.update(body), cipher.final()])
  return Buffer.concat([Buffer.from('v10', 'utf8'), encrypted])
}
