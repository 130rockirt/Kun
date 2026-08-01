import { readFile, rm } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { atomicWriteFile } from '../adapters/file/atomic-write.js'
import { extensionError } from './errors.js'

export type JsonValidator<T> = (value: unknown) => T

export class AtomicJsonFile<T> {
  private operation: Promise<unknown> = Promise.resolve()

  constructor(
    readonly path: string,
    private readonly validate: JsonValidator<T>
  ) {}

  async read(fallback: () => T): Promise<T> {
    const manager = managerAtomicJsonConfig(this.path)
    if (manager) {
      const snapshot = await readManagerSnapshot(manager, this.path)
      return snapshot.value === null ? fallback() : this.validate(snapshot.value)
    }
    try {
      const contents = await readFile(this.path, 'utf8')
      return this.validate(JSON.parse(contents) as unknown)
    } catch (error) {
      if (isMissingFile(error)) return fallback()
      if (error instanceof SyntaxError) {
        throw extensionError('EXTENSION_JSON_INVALID', 'Persisted extension JSON is malformed', {
          path: this.path
        }, error)
      }
      throw error
    }
  }

  async write(value: T): Promise<void> {
    const validated = this.validate(value)
    const manager = managerAtomicJsonConfig(this.path)
    if (manager) {
      await this.serialize(async () => {
        for (let attempt = 0; attempt < MAX_MANAGER_WRITE_ATTEMPTS; attempt += 1) {
          const snapshot = await readManagerSnapshot(manager, this.path)
          const written = await writeManagerSnapshot(
            manager,
            this.path,
            snapshot.revision,
            validated
          )
          if (written) return
        }
        throw managerConflictError(this.path)
      })
      return
    }
    await atomicWriteFile(this.path, `${JSON.stringify(validated, null, 2)}\n`)
  }

  async update(fallback: () => T, mutate: (current: T) => T | Promise<T>): Promise<T> {
    return this.serialize(async () => {
      const manager = managerAtomicJsonConfig(this.path)
      if (manager) {
        for (let attempt = 0; attempt < MAX_MANAGER_WRITE_ATTEMPTS; attempt += 1) {
          const snapshot = await readManagerSnapshot(manager, this.path)
          const current = snapshot.value === null ? fallback() : this.validate(snapshot.value)
          const next = this.validate(await mutate(current))
          if (await writeManagerSnapshot(manager, this.path, snapshot.revision, next)) return next
        }
        throw managerConflictError(this.path)
      }
      const current = await this.read(fallback)
      const next = this.validate(await mutate(current))
      await this.write(next)
      return next
    })
  }

  async delete(): Promise<void> {
    const manager = managerAtomicJsonConfig(this.path)
    if (manager) {
      await this.serialize(async () => {
        for (let attempt = 0; attempt < MAX_MANAGER_WRITE_ATTEMPTS; attempt += 1) {
          const snapshot = await readManagerSnapshot(manager, this.path)
          if (await deleteManagerSnapshot(manager, this.path, snapshot.revision)) return
        }
        throw managerConflictError(this.path)
      })
      return
    }
    await rm(this.path, { force: true })
  }

  private serialize<R>(operation: () => Promise<R>): Promise<R> {
    const result = this.operation.then(operation, operation)
    this.operation = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

const MAX_MANAGER_WRITE_ATTEMPTS = 8

type ManagerAtomicJsonConfig = {
  baseUrl: string
  token: string
  dataDir: string
}

type ManagerAtomicJsonSnapshot = {
  revision: number
  value: unknown | null
}

const ManagerAtomicJsonSnapshotSchema = z.object({
  snapshot: z.object({
    revision: z.number().int().nonnegative(),
    value: z.unknown().nullable()
  })
})

function managerAtomicJsonConfig(path: string): ManagerAtomicJsonConfig | null {
  const baseUrl = process.env.KUN_MANAGER_BASE_URL?.trim()
  const token = process.env.KUN_MANAGER_TOKEN?.trim()
  const configuredDataDir = process.env.KUN_MANAGER_DATA_DIR?.trim()
  if (!baseUrl || !token || !configuredDataDir) return null
  const dataDir = resolve(configuredDataDir)
  const target = resolve(path)
  const pathRelative = relative(dataDir, target)
  const sharedMcpPath = resolve(dataDir, '..', 'mcp.json')
  if (
    (target !== sharedMcpPath && (
        !pathRelative ||
        pathRelative === '.' ||
        pathRelative === '..' ||
        pathRelative.startsWith(`..${sep}`)
      )) ||
    !/\.json$/iu.test(target)
  ) return null
  return { baseUrl: baseUrl.replace(/\/+$/u, ''), token, dataDir }
}

export function isManagerAtomicJsonPath(path: string): boolean {
  return managerAtomicJsonConfig(path) !== null
}

async function readManagerSnapshot(
  manager: ManagerAtomicJsonConfig,
  path: string
): Promise<ManagerAtomicJsonSnapshot> {
  const response = await fetch(`${manager.baseUrl}/v1/data/atomic-json/read`, {
    method: 'POST',
    headers: managerHeaders(manager.token),
    body: JSON.stringify({ path }),
    signal: AbortSignal.timeout(5_000)
  })
  if (!response.ok) throw await managerRequestError(response, path)
  return ManagerAtomicJsonSnapshotSchema.parse(await response.json()).snapshot
}

async function writeManagerSnapshot<T>(
  manager: ManagerAtomicJsonConfig,
  path: string,
  expectedRevision: number,
  value: T
): Promise<boolean> {
  const response = await fetch(`${manager.baseUrl}/v1/data/atomic-json/write`, {
    method: 'PUT',
    headers: managerHeaders(manager.token),
    body: JSON.stringify({ path, expectedRevision, value }),
    signal: AbortSignal.timeout(5_000)
  })
  if (response.status === 409) return false
  if (!response.ok) throw await managerRequestError(response, path)
  ManagerAtomicJsonSnapshotSchema.parse(await response.json())
  return true
}

async function deleteManagerSnapshot(
  manager: ManagerAtomicJsonConfig,
  path: string,
  expectedRevision: number
): Promise<boolean> {
  const response = await fetch(`${manager.baseUrl}/v1/data/atomic-json/delete`, {
    method: 'DELETE',
    headers: managerHeaders(manager.token),
    body: JSON.stringify({ path, expectedRevision }),
    signal: AbortSignal.timeout(5_000)
  })
  if (response.status === 409) return false
  if (!response.ok) throw await managerRequestError(response, path)
  ManagerAtomicJsonSnapshotSchema.parse(await response.json())
  return true
}

function managerHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json'
  }
}

async function managerRequestError(response: Response, path: string): Promise<Error> {
  const detail = await response.text().catch(() => '')
  return extensionError('EXTENSION_JSON_MANAGER_UNAVAILABLE', 'Kun Service Manager rejected shared JSON access', {
    path,
    status: response.status,
    detail: detail.slice(0, 512)
  })
}

function managerConflictError(path: string): Error {
  return extensionError(
    'EXTENSION_JSON_REVISION_CONFLICT',
    'Shared extension JSON kept changing during update',
    { path, attempts: MAX_MANAGER_WRITE_ATTEMPTS }
  )
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}
