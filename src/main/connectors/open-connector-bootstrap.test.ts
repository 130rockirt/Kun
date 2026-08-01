import { createAesEncryptor } from '../../../kun/src/security/secret-store.js'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loadOrCreateOpenConnectorBootstrap,
  openConnectorBootstrapPaths
} from './open-connector-bootstrap'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ))
})

describe('OpenConnector bootstrap secrets', () => {
  it('creates three independent secrets and persists ciphertext only', async () => {
    const root = await temporaryRoot()
    const encryptor = createAesEncryptor(Buffer.alloc(32, 7))
    const first = await loadOrCreateOpenConnectorBootstrap(root, {
      encryptor,
      now: () => new Date('2026-07-31T00:00:00.000Z')
    })
    const second = await loadOrCreateOpenConnectorBootstrap(root, { encryptor })

    expect(first.secrets).toEqual(second.secrets)
    expect(new Set([
      first.secrets.adminToken,
      first.secrets.runtimeToken,
      first.secrets.encryptionKey,
      first.secrets.instanceProofKey
    ]).size).toBe(4)
    expect(first.secrets.instanceProofKey).toMatch(/^[a-f0-9]{64}$/)

    const stored = await readFile(first.paths.bootstrapPath, 'utf8')
    expect(stored).toContain('enc:v1:')
    expect(stored).not.toContain(first.secrets.adminToken)
    expect(stored).not.toContain(first.secrets.runtimeToken)
    expect(stored).not.toContain(first.secrets.encryptionKey)
    expect(stored).not.toContain(first.secrets.instanceProofKey)
    if (process.platform !== 'win32') {
      expect((await stat(first.paths.bootstrapPath)).mode & 0o777).toBe(0o600)
      expect((await stat(first.paths.connectorRoot)).mode & 0o777).toBe(0o700)
    }
  })

  it('migrates a legacy encrypted bootstrap with a persistent instance proof key', async () => {
    const root = await temporaryRoot()
    const paths = openConnectorBootstrapPaths(root)
    const encryptor = createAesEncryptor(Buffer.alloc(32, 5))
    const legacy = {
      schemaVersion: 1,
      adminToken: `kun_oc_admin_${'a'.repeat(43)}`,
      runtimeToken: `kun_oc_runtime_${'b'.repeat(43)}`,
      encryptionKey: Buffer.alloc(32, 9).toString('base64'),
      createdAt: '2026-07-31T00:00:00.000Z'
    }
    await mkdir(paths.connectorRoot, { recursive: true })
    await writeFile(paths.bootstrapPath, JSON.stringify({
      schemaVersion: 1,
      ciphertext: encryptor.encrypt(JSON.stringify(legacy), 'kun:open-connector:bootstrap:v1')
    }))

    const migrated = await loadOrCreateOpenConnectorBootstrap(root, { encryptor })
    const reloaded = await loadOrCreateOpenConnectorBootstrap(root, { encryptor })
    expect(migrated.secrets).toMatchObject(legacy)
    expect(migrated.secrets.instanceProofKey).toMatch(/^[a-f0-9]{64}$/)
    expect(reloaded.secrets.instanceProofKey).toBe(migrated.secrets.instanceProofKey)
  })

  it('fails closed when an encrypted bootstrap is malformed', async () => {
    const root = await temporaryRoot()
    const paths = openConnectorBootstrapPaths(root)
    await loadOrCreateOpenConnectorBootstrap(root, {
      encryptor: createAesEncryptor(Buffer.alloc(32, 3))
    })
    await writeFile(paths.bootstrapPath, '{"schemaVersion":1,"ciphertext":"plaintext"}\n')

    await expect(loadOrCreateOpenConnectorBootstrap(root, {
      encryptor: createAesEncryptor(Buffer.alloc(32, 3))
    })).rejects.toThrow()
  })
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kun-openconnector-bootstrap-'))
  temporaryRoots.push(root)
  return root
}
