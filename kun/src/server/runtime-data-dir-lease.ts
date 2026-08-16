import { randomUUID } from 'node:crypto'
import { open, readFile, rmdir, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import {
  acquireRuntimeDataDirWriterClaim,
  assertRuntimeDataDirMigrationInactive,
  reclaimLockFileIfUnchanged,
  runtimeDataDirOwnerPath
} from './runtime-data-dir-migration-lock.js'
import {
  isValidRuntimeProcessIdentity,
  runtimeProcessIdentity,
  runtimeProcessIsAlive,
  type RuntimeProcessIsAlive
} from './runtime-process-identity.js'

export { RUNTIME_DATA_DIR_OWNER_FILE } from './runtime-data-dir-migration-lock.js'

type RuntimeDataDirOwner = {
  schemaVersion: 1
  pid: number
  token: string
  startedAt: string
  processIdentity?: string
}

export type RuntimeDataDirLease = {
  path: string
  claimPath: string
  authority: RuntimeDataDirWriterAuthority
  release(): Promise<void>
}

/**
 * Scoped proof that the current process already owns the data-dir writer
 * lease. Reentrant config operations run under this authority instead of
 * publishing a second claim that would conflict with their own Runtime.
 */
export type RuntimeDataDirWriterAuthority = {
  readonly dataDir: string
  runExclusive<T>(dataDir: string, action: () => Promise<T>): Promise<T>
}

export async function withRuntimeDataDirConfigWriter<T>(
  dataDir: string,
  action: () => Promise<T>,
  options: {
    authority?: RuntimeDataDirWriterAuthority
    afterClaimAcquired?: () => void | Promise<void>
  } = {}
): Promise<T> {
  if (options.authority) return options.authority.runExclusive(dataDir, action)
  // A short config mutation must also publish the compatibility owner file.
  // Runtimes predating writer claims only coordinate through that file, while
  // current Runtime and migration processes observe the config claim first.
  const lease = await acquireRuntimeDataDirWriterLease(dataDir, 'config')
  let result: T
  try {
    await options.afterClaimAcquired?.()
    result = await action()
  } catch (error) {
    await lease.release().catch(() => undefined)
    throw error
  }
  await lease.release()
  return result
}

/**
 * Fence small non-store writes that live under dataDir (TUI state, update
 * timestamps, local share snapshots). They may coexist with the active
 * Runtime owner, but migration must observe the published claim and the
 * ancillary writer must reject an existing migration claim or compatibility
 * lock.
 */
export async function withRuntimeDataDirAncillaryWriter<T>(
  dataDir: string,
  action: () => Promise<T>,
  options: {
    afterClaimAcquired?: () => void | Promise<void>
  } = {}
): Promise<T> {
  const claim = await acquireRuntimeDataDirWriterClaim(dataDir, 'ancillary')
  let result: T
  try {
    await assertRuntimeDataDirMigrationInactive(dataDir)
    await options.afterClaimAcquired?.()
    await assertRuntimeDataDirMigrationInactive(dataDir)
    result = await action()
  } catch (error) {
    await claim.release().catch(() => undefined)
    throw error
  }
  await claim.release()
  return result
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
}

function parseOwner(raw: string): RuntimeDataDirOwner | null {
  try {
    const parsed = JSON.parse(raw) as Partial<RuntimeDataDirOwner>
    return parsed.schemaVersion === 1 &&
      Number.isSafeInteger(parsed.pid) &&
      (parsed.pid ?? 0) > 0 &&
      typeof parsed.token === 'string' &&
      parsed.token.length > 0 &&
      typeof parsed.startedAt === 'string' &&
      isValidRuntimeProcessIdentity(parsed.processIdentity)
      ? parsed as RuntimeDataDirOwner
      : null
  } catch {
    return null
  }
}

async function writeOwnerExclusively(path: string, owner: RuntimeDataDirOwner): Promise<void> {
  const handle = await open(path, 'wx', 0o600)
  let failure: unknown
  try {
    await handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`, 'utf8')
    await handle.sync()
  } catch (error) {
    failure = error
  }
  try {
    await handle.close()
  } catch (error) {
    if (failure === undefined) failure = error
  }
  if (failure !== undefined) {
    await unlink(path).catch(() => undefined)
    throw failure
  }
}

type RuntimeDataDirLeaseOptions = {
  pid?: number
  now?: () => Date
  processIsAlive?: RuntimeProcessIsAlive
  beforeStaleReclaim?: (path: string, expectedRaw: string) => void | Promise<void>
}

async function acquireRuntimeDataDirWriterLease(
  dataDir: string,
  claimKind: 'runtime' | 'config',
  options: RuntimeDataDirLeaseOptions = {}
): Promise<RuntimeDataDirLease> {
  const pid = options.pid ?? process.pid
  const now = options.now ?? (() => new Date())
  const processIsAlive = options.processIsAlive ?? runtimeProcessIsAlive
  const path = runtimeDataDirOwnerPath(dataDir)
  const writerClaim = await acquireRuntimeDataDirWriterClaim(dataDir, claimKind, {
    pid,
    now,
    processIsAlive
  })

  // Check both sides of owner-file creation. If a migration wins between the
  // checks, this contender removes only its token-matched owner record and
  // exits before constructing any persistent Runtime stores.
  const processIdentity = runtimeProcessIdentity(pid)
  const owner: RuntimeDataDirOwner = {
    schemaVersion: 1,
    pid,
    token: randomUUID(),
    startedAt: now().toISOString(),
    ...(processIdentity ? { processIdentity } : {})
  }
  let ownerCreated = false
  let dataDirCreated = false
  try {
    await assertRuntimeDataDirMigrationInactive(dataDir, {
      pid,
      processIsAlive,
      beforeStaleReclaim: options.beforeStaleReclaim
    })
    dataDirCreated = (await mkdir(dirname(path), { recursive: true, mode: 0o700 })) !== undefined
    for (;;) {
      try {
        await writeOwnerExclusively(path, owner)
        ownerCreated = true
        break
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) throw error
      }

      let existingRaw: string
      try {
        existingRaw = await readFile(path, 'utf8')
      } catch (error) {
        if (isErrno(error, 'ENOENT')) continue
        throw new Error(`could not inspect Kun Runtime data directory owner at ${path}`, {
          cause: error
        })
      }
      const existing = parseOwner(existingRaw)
      if (!existing) {
        throw new Error(`Kun Runtime data directory owner record is invalid: ${path}`)
      }
      if (processIsAlive(existing.pid, existing)) {
        throw new Error(
          `Kun Runtime data directory is already owned by active process ${existing.pid}: ${dataDir}`
        )
      }

      await reclaimLockFileIfUnchanged(path, existingRaw, {
        pid,
        beforeReclaim: options.beforeStaleReclaim
      })
    }
    await assertRuntimeDataDirMigrationInactive(dataDir, {
      pid,
      processIsAlive,
      beforeStaleReclaim: options.beforeStaleReclaim
    })
  } catch (error) {
    if (ownerCreated) {
      const current = parseOwner(await readFile(path, 'utf8').catch(() => ''))
      if (current?.token === owner.token) await unlink(path).catch(() => undefined)
    }
    if (dataDirCreated) await rmdir(dirname(path)).catch(() => undefined)
    await writerClaim.release().catch(() => undefined)
    throw error
  }

  let released = false
  let authorityQueue: Promise<void> = Promise.resolve()
  const canonicalDataDir = resolve(dataDir)
  const authority: RuntimeDataDirWriterAuthority = {
    dataDir: canonicalDataDir,
    runExclusive: async <T>(candidateDataDir: string, action: () => Promise<T>): Promise<T> => {
      if (released) throw new Error('Kun Runtime data directory writer authority has been released')
      if (resolve(candidateDataDir) !== canonicalDataDir) {
        throw new Error('Kun Runtime data directory writer authority does not cover this path')
      }
      const operation = authorityQueue.then(action)
      authorityQueue = operation.then(() => undefined, () => undefined)
      return operation
    }
  }
  return {
    path,
    claimPath: writerClaim.path,
    authority,
    release: async () => {
      if (released) return
      released = true
      await authorityQueue
      let firstError: unknown
      let current: RuntimeDataDirOwner | null = null
      try {
        current = parseOwner(await readFile(path, 'utf8'))
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) firstError = error
      }
      if (current?.token === owner.token) {
        try {
          await unlink(path)
        } catch (error) {
          if (!isErrno(error, 'ENOENT') && firstError === undefined) firstError = error
        }
      }
      try {
        await writerClaim.release()
      } catch (error) {
        if (firstError === undefined) firstError = error
      }
      if (firstError !== undefined) throw firstError
    }
  }
}

export async function acquireRuntimeDataDirLease(
  dataDir: string,
  options: RuntimeDataDirLeaseOptions = {}
): Promise<RuntimeDataDirLease> {
  return acquireRuntimeDataDirWriterLease(dataDir, 'runtime', options)
}
