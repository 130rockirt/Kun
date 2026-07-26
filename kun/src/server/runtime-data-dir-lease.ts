import { randomUUID } from 'node:crypto'
import { open, readFile, rename, rm, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { mkdir } from 'node:fs/promises'

export const RUNTIME_DATA_DIR_OWNER_FILE = '.kun-runtime-owner.json'

type RuntimeDataDirOwner = {
  schemaVersion: 1
  pid: number
  token: string
  startedAt: string
}

export type RuntimeDataDirLease = {
  path: string
  release(): Promise<void>
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
}

function defaultProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !isErrno(error, 'ESRCH')
  }
}

function parseOwner(raw: string): RuntimeDataDirOwner | null {
  try {
    const parsed = JSON.parse(raw) as Partial<RuntimeDataDirOwner>
    return parsed.schemaVersion === 1 &&
      Number.isSafeInteger(parsed.pid) &&
      (parsed.pid ?? 0) > 0 &&
      typeof parsed.token === 'string' &&
      parsed.token.length > 0 &&
      typeof parsed.startedAt === 'string'
      ? parsed as RuntimeDataDirOwner
      : null
  } catch {
    return null
  }
}

async function writeOwnerExclusively(path: string, owner: RuntimeDataDirOwner): Promise<void> {
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function acquireRuntimeDataDirLease(
  dataDir: string,
  options: {
    pid?: number
    now?: () => Date
    processIsAlive?: (pid: number) => boolean
  } = {}
): Promise<RuntimeDataDirLease> {
  const pid = options.pid ?? process.pid
  const now = options.now ?? (() => new Date())
  const processIsAlive = options.processIsAlive ?? defaultProcessIsAlive
  const path = join(dataDir, RUNTIME_DATA_DIR_OWNER_FILE)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })

  const owner: RuntimeDataDirOwner = {
    schemaVersion: 1,
    pid,
    token: randomUUID(),
    startedAt: now().toISOString()
  }

  for (;;) {
    try {
      await writeOwnerExclusively(path, owner)
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
    if (processIsAlive(existing.pid)) {
      throw new Error(
        `Kun Runtime data directory is already owned by active process ${existing.pid}: ${dataDir}`
      )
    }

    const stalePath = `${path}.stale-${pid}-${randomUUID()}`
    try {
      await rename(path, stalePath)
    } catch (error) {
      if (isErrno(error, 'ENOENT')) continue
      throw error
    }
    await rm(stalePath, { force: true })
  }

  let released = false
  return {
    path,
    release: async () => {
      if (released) return
      released = true
      let current: RuntimeDataDirOwner | null = null
      try {
        current = parseOwner(await readFile(path, 'utf8'))
      } catch (error) {
        if (isErrno(error, 'ENOENT')) return
        throw error
      }
      if (current?.token !== owner.token) return
      await unlink(path).catch((error) => {
        if (!isErrno(error, 'ENOENT')) throw error
      })
    }
  }
}
