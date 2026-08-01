import { randomBytes } from 'node:crypto'
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import {
  createSecretEncryptor,
  defaultSecretCommandRunner,
  hasPersistedSecretKeyMaterial,
  type SecretEncryptor
} from '../../../kun/src/security/secret-store.js'

const BOOTSTRAP_AAD = 'kun:open-connector:bootstrap:v1'

const StoredBootstrapSecretsSchema = z.object({
  schemaVersion: z.literal(1),
  adminToken: z.string().min(32),
  runtimeToken: z.string().min(32),
  encryptionKey: z.string().min(32),
  instanceProofKey: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  createdAt: z.string().datetime()
}).strict()

const BootstrapSecretsSchema = StoredBootstrapSecretsSchema.extend({
  instanceProofKey: z.string().regex(/^[a-f0-9]{64}$/i)
}).strict()

const EncryptedBootstrapSchema = z.object({
  schemaVersion: z.literal(1),
  ciphertext: z.string().startsWith('enc:v1:')
}).strict()

export type OpenConnectorBootstrapSecrets = z.infer<typeof BootstrapSecretsSchema>

export type OpenConnectorBootstrapPaths = {
  connectorRoot: string
  runtimeDataDir: string
  bootstrapPath: string
  keyFilePath: string
}

export function openConnectorBootstrapPaths(userDataDir: string): OpenConnectorBootstrapPaths {
  const connectorRoot = join(userDataDir, 'connectors', 'open-connector')
  return {
    connectorRoot,
    runtimeDataDir: join(connectorRoot, 'data'),
    bootstrapPath: join(connectorRoot, 'bootstrap.enc.json'),
    keyFilePath: join(userDataDir, 'connectors', 'secret.key')
  }
}

export async function loadOrCreateOpenConnectorBootstrap(
  userDataDir: string,
  options: {
    encryptor?: SecretEncryptor
    now?: () => Date
  } = {}
): Promise<{ secrets: OpenConnectorBootstrapSecrets; paths: OpenConnectorBootstrapPaths }> {
  const paths = openConnectorBootstrapPaths(userDataDir)
  await mkdir(paths.connectorRoot, { recursive: true, mode: 0o700 })
  await chmod(paths.connectorRoot, 0o700).catch(() => undefined)

  const encryptor = options.encryptor ?? (await createSecretEncryptor({
    keyFilePath: paths.keyFilePath,
    run: defaultSecretCommandRunner,
    canBootstrapKeyFileFallback: async () =>
      !(await pathExists(paths.bootstrapPath)) &&
      !(await hasPersistedSecretKeyMaterial(userDataDir))
  })).encryptor

  const existing = await readEncryptedBootstrap(paths.bootstrapPath, encryptor)
  if (existing) {
    const secrets = BootstrapSecretsSchema.parse({
      ...existing,
      instanceProofKey: existing.instanceProofKey ?? randomBytes(32).toString('hex')
    })
    if (!existing.instanceProofKey) await writeEncryptedBootstrap(paths.bootstrapPath, secrets, encryptor)
    return { secrets, paths }
  }

  const secrets: OpenConnectorBootstrapSecrets = {
    schemaVersion: 1,
    adminToken: randomSecret('kun_oc_admin'),
    runtimeToken: randomSecret('kun_oc_runtime'),
    encryptionKey: randomBytes(32).toString('base64'),
    instanceProofKey: randomBytes(32).toString('hex'),
    createdAt: (options.now?.() ?? new Date()).toISOString()
  }
  await writeEncryptedBootstrap(paths.bootstrapPath, secrets, encryptor)
  return { secrets, paths }
}

async function readEncryptedBootstrap(
  path: string,
  encryptor: SecretEncryptor
): Promise<z.infer<typeof StoredBootstrapSecretsSchema> | null> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (isMissingFile(error)) return null
    throw error
  }
  const envelope = EncryptedBootstrapSchema.parse(JSON.parse(raw) as unknown)
  return StoredBootstrapSecretsSchema.parse(
    JSON.parse(encryptor.decrypt(envelope.ciphertext, BOOTSTRAP_AAD)) as unknown
  )
}

async function writeEncryptedBootstrap(
  path: string,
  secrets: OpenConnectorBootstrapSecrets,
  encryptor: SecretEncryptor
): Promise<void> {
  const ciphertext = encryptor.encrypt(JSON.stringify(secrets), BOOTSTRAP_AAD)
  const body = `${JSON.stringify({ schemaVersion: 1, ciphertext }, null, 2)}\n`
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporaryPath, body, { mode: 0o600 })
    await chmod(temporaryPath, 0o600).catch(() => undefined)
    await rename(temporaryPath, path)
    await chmod(path, 0o600).catch(() => undefined)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

function randomSecret(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}
