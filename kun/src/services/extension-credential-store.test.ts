import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createAesEncryptor } from '../security/secret-store.js'
import {
  ExtensionCredentialStore,
  redactExtensionSecrets,
  type PrimaryCredentialBackend
} from './extension-credential-store.js'

describe('ExtensionCredentialStore', () => {
  it('uses authenticated encrypted fallback without plaintext-at-rest', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-extension-credentials-'))
    const store = new ExtensionCredentialStore({ dataDir, profileId: 'profile-a' })
    const reference = await store.create({
      apiKey: 'sk-super-secret-value',
      refreshToken: 'refresh-super-secret-value'
    })

    await expect(store.protection()).resolves.toMatchObject({
      mode: 'encrypted-fallback', degraded: true, available: true
    })
    await expect(store.get(reference)).resolves.toEqual({
      apiKey: 'sk-super-secret-value',
      refreshToken: 'refresh-super-secret-value'
    })
    const encrypted = await readFile(join(dataDir, 'credentials', 'credentials.enc.json'), 'utf8')
    expect(encrypted).not.toContain('sk-super-secret-value')
    expect(encrypted).not.toContain('refresh-super-secret-value')

    const otherProfile = new ExtensionCredentialStore({ dataDir, profileId: 'profile-b' })
    await expect(otherProfile.get(reference)).rejects.toThrow(/another profile/)
  })

  it('prefers an available primary credential backend', async () => {
    const values = new Map<string, string>()
    const primary: PrimaryCredentialBackend = {
      id: 'test-keychain',
      isAvailable: async () => true,
      set: async (key, value) => { values.set(key, value) },
      get: async (key) => values.get(key) ?? null,
      delete: async (key) => { values.delete(key) }
    }
    const store = new ExtensionCredentialStore({
      dataDir: await mkdtemp(join(tmpdir(), 'kun-extension-primary-')),
      profileId: 'profile-a',
      primary
    })
    const reference = await store.create({ accessToken: 'token-value' })

    await expect(store.protection()).resolves.toMatchObject({
      mode: 'primary', degraded: false, available: true, backend: 'test-keychain'
    })
    await expect(store.get(reference)).resolves.toEqual({ accessToken: 'token-value' })
  })

  it('fails closed when a configured primary backend becomes unavailable', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-extension-primary-unavailable-'))
    const primary: PrimaryCredentialBackend = {
      id: 'test-keychain',
      isAvailable: async () => false,
      set: async () => undefined,
      get: async () => null,
      delete: async () => undefined
    }
    const store = new ExtensionCredentialStore({ dataDir, profileId: 'profile-a', primary })

    await expect(store.protection()).resolves.toMatchObject({
      mode: 'unavailable', available: false
    })
    await expect(store.create({ apiKey: 'must-not-fallback' }))
      .rejects.toThrow('protected credential storage is unavailable')
    await expect(readFile(join(dataDir, 'credentials', 'credentials.enc.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects ambiguous primary and key-provider value backends', () => {
    const primary: PrimaryCredentialBackend = {
      id: 'test-keychain',
      isAvailable: async () => true,
      set: async () => undefined,
      get: async () => null,
      delete: async () => undefined
    }
    expect(() => new ExtensionCredentialStore({
      dataDir: '/tmp/kun-extension-ambiguous-backends',
      profileId: 'profile-a',
      primary,
      keyProvider: {
        encryptor: createAesEncryptor(randomBytes(32)),
        osKeychain: true,
        reason: 'test key provider'
      }
    })).toThrow('cannot be configured together')
  })

  it('uses Kun OS-backed key protection and binds ciphertext to profile and reference', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-extension-os-credentials-'))
    const keyProvider = {
      encryptor: createAesEncryptor(randomBytes(32)),
      osKeychain: true,
      reason: 'test key stored in OS keychain'
    }
    const store = new ExtensionCredentialStore({
      dataDir,
      profileId: 'profile-a',
      keyProvider
    })
    const reference = await store.create({ apiKey: 'os-protected-secret' })

    await expect(store.protection()).resolves.toMatchObject({
      mode: 'primary', degraded: false, available: true,
      backend: 'kun-os-credential-key'
    })
    await expect(store.get(reference)).resolves.toEqual({ apiKey: 'os-protected-secret' })

    const otherProfile = new ExtensionCredentialStore({
      dataDir,
      profileId: 'profile-b',
      keyProvider
    })
    await expect(otherProfile.get(reference)).rejects.toThrow(/another profile/)
  })

  it('reports Kun key-file protection as the degraded encrypted fallback', async () => {
    const store = new ExtensionCredentialStore({
      dataDir: await mkdtemp(join(tmpdir(), 'kun-extension-degraded-')),
      profileId: 'profile-a',
      keyProvider: {
        encryptor: createAesEncryptor(randomBytes(32)),
        osKeychain: false,
        reason: 'OS keychain unavailable; test key file'
      }
    })
    const reference = await store.create({ refreshToken: 'refresh-value' })

    await expect(store.protection()).resolves.toMatchObject({
      mode: 'encrypted-fallback', degraded: true, available: true,
      backend: 'kun-encrypted-secret-store'
    })
    await expect(store.get(reference)).resolves.toEqual({ refreshToken: 'refresh-value' })
  })

  it('redacts credential fields and known values recursively', () => {
    expect(redactExtensionSecrets({
      authorization: 'Bearer token-value',
      nested: { message: 'failed with token-value', api_key: 'secret' }
    }, ['token-value'])).toEqual({
      authorization: '[REDACTED]',
      nested: { message: 'failed with [REDACTED]', api_key: '[REDACTED]' }
    })
  })
})
