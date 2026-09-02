import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import semver from 'semver'
import {
  isValidRuntimeProcessIdentity,
  runtimeProcessIdentity,
  runtimeProcessIsAlive,
  type RuntimeProcessIsAlive
} from '../server/runtime-process-identity.js'

export const TUI_UPDATE_LOCK_SUFFIX = '.kun-tui-update.lock'
export const TUI_UPDATE_TRANSACTION_DIR_SUFFIX = '.kun-tui-update'
export const TUI_UPDATE_TRANSACTION_FILE = 'transaction.json'
export const TUI_UPDATE_RESULT_FILE = 'update-result.json'
export const TUI_UPDATE_LOG_FILE = 'update.log'

export type TuiUpdateLock = {
  path: string
  release(): Promise<void>
}

export type TuiUpdateTransaction = {
  schemaVersion: 1
  previousVersion: string
  targetVersion: string
  buildId: string
  installRoot: string
  stagingRoot: string
  backupRoot: string
  pid: number
  token: string
  startedAt: string
}

export type TuiUpdateResult = {
  schemaVersion: 1
  status: 'succeeded' | 'failed'
  stage?: string
  error?: string
  previousVersion: string
  targetVersion: string
  finishedAt: string
}

export type TuiUpdateReconcileReport =
  | { kind: 'activated'; previousVersion: string; targetVersion: string }
  | { kind: 'failed'; message: string; stage?: string }
  | { kind: 'busy'; pid: number }

type ReconcileOptions = {
  now?: () => Date
  processIsAlive?: RuntimeProcessIsAlive
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
}

export function tuiUpdateLockPath(installRoot: string): string {
  const canonical = resolve(installRoot)
  return join(dirname(canonical), `.${basename(canonical)}${TUI_UPDATE_LOCK_SUFFIX}`)
}

export function tuiUpdateTransactionDir(installRoot: string): string {
  const canonical = resolve(installRoot)
  return join(dirname(canonical), `.${basename(canonical)}${TUI_UPDATE_TRANSACTION_DIR_SUFFIX}`)
}

export function tuiUpdateTransactionPath(installRoot: string): string {
  return join(tuiUpdateTransactionDir(installRoot), TUI_UPDATE_TRANSACTION_FILE)
}

export function tuiUpdateResultPath(installRoot: string): string {
  return join(tuiUpdateTransactionDir(installRoot), TUI_UPDATE_RESULT_FILE)
}

export function tuiUpdateLogPath(installRoot: string): string {
  return join(tuiUpdateTransactionDir(installRoot), TUI_UPDATE_LOG_FILE)
}

export function parseTuiUpdateTransaction(raw: string): TuiUpdateTransaction | null {
  try {
    const parsed = JSON.parse(raw) as Partial<TuiUpdateTransaction>
    return parsed.schemaVersion === 1 &&
      typeof parsed.previousVersion === 'string' &&
      typeof parsed.targetVersion === 'string' &&
      typeof parsed.buildId === 'string' &&
      /^[a-f0-9]{64}$/.test(parsed.buildId) &&
      typeof parsed.installRoot === 'string' &&
      typeof parsed.stagingRoot === 'string' &&
      typeof parsed.backupRoot === 'string' &&
      Number.isSafeInteger(parsed.pid) &&
      (parsed.pid ?? 0) > 0 &&
      typeof parsed.token === 'string' &&
      parsed.token.length > 0 &&
      typeof parsed.startedAt === 'string'
      ? parsed as TuiUpdateTransaction
      : null
  } catch {
    return null
  }
}

export function parseTuiUpdateResult(raw: string): TuiUpdateResult | null {
  try {
    const parsed = JSON.parse(raw) as Partial<TuiUpdateResult>
    return parsed.schemaVersion === 1 &&
      (parsed.status === 'succeeded' || parsed.status === 'failed') &&
      typeof parsed.previousVersion === 'string' &&
      typeof parsed.targetVersion === 'string' &&
      typeof parsed.finishedAt === 'string' &&
      (parsed.stage === undefined || typeof parsed.stage === 'string') &&
      (parsed.error === undefined || typeof parsed.error === 'string')
      ? parsed as TuiUpdateResult
      : null
  } catch {
    return null
  }
}

function parseLockOwner(raw: string): {
  schemaVersion: 1
  pid: number
  token: string
  startedAt: string
  processIdentity?: string
  root: string
} | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return parsed.schemaVersion === 1 &&
      Number.isSafeInteger(parsed.pid) &&
      (parsed.pid as number) > 0 &&
      typeof parsed.token === 'string' &&
      parsed.token.length > 0 &&
      typeof parsed.startedAt === 'string' &&
      isValidRuntimeProcessIdentity(parsed.processIdentity) &&
      typeof parsed.root === 'string' &&
      parsed.root.length > 0
      ? parsed as never
      : null
  } catch {
    return null
  }
}

/**
 * Serialize self-updates for one install root across every Kun TUI process.
 * Follows the same exclusive-create + liveness reclaim pattern as the runtime
 * data-dir migration lock: a dead owner's file is renamed away, verified to be
 * byte-identical to what was read, then removed, so a live replacement lock is
 * never deleted by path alone.
 */
export async function acquireTuiUpdateLock(
  installRoot: string,
  options: {
    pid?: number
    processIsAlive?: RuntimeProcessIsAlive
  } = {}
): Promise<TuiUpdateLock> {
  const pid = options.pid ?? process.pid
  const processIsAlive = options.processIsAlive ?? runtimeProcessIsAlive
  const canonical = resolve(installRoot)
  const path = tuiUpdateLockPath(canonical)
  const token = randomUUID()
  const record = {
    schemaVersion: 1 as const,
    pid,
    token,
    startedAt: new Date().toISOString(),
    ...(runtimeProcessIdentity(pid) ? { processIdentity: runtimeProcessIdentity(pid) } : {}),
    root: canonical
  }
  await mkdir(dirname(path), { recursive: true })
  for (;;) {
    let created = false
    try {
      const handle = await open(path, 'wx', 0o600)
      created = true
      try {
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      break
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) {
        if (created) await unlink(path).catch(() => undefined)
        throw error
      }
    }
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (error) {
      if (isErrno(error, 'ENOENT')) continue
      throw new Error(`could not inspect Kun TUI update lock at ${path}`, { cause: error })
    }
    const owner = parseLockOwner(raw)
    if (!owner) throw new Error(`Kun TUI update lock is invalid: ${path}`)
    if (processIsAlive(owner.pid, owner)) {
      throw new Error(
        `another Kun TUI update is already running in process ${owner.pid}; ` +
        'retry after it finishes'
      )
    }
    // Reclaim the exact dead-owner bytes without deleting a live replacement.
    const displacedPath = `${path}.stale-${pid}-${randomUUID()}`
    try {
      await rename(path, displacedPath)
    } catch (error) {
      if (isErrno(error, 'ENOENT')) continue
      throw error
    }
    const displacedRaw = await readFile(displacedPath, 'utf8').catch((error) => {
      throw new Error(`could not verify displaced Kun TUI update lock at ${displacedPath}`, {
        cause: error
      })
    })
    if (displacedRaw !== raw) {
      // A live contender replaced the lock while we reclaimed; restore it and fail.
      try {
        const { link } = await import('node:fs/promises')
        await link(displacedPath, path)
        await unlink(displacedPath)
      } catch (restoreError) {
        throw new Error(
          `Kun TUI update lock changed during stale-owner recovery; ` +
          `the displaced live record was preserved at ${displacedPath}`,
          { cause: restoreError }
        )
      }
      throw new Error('Kun TUI update lock owner changed during stale-owner recovery')
    }
    await rm(displacedPath, { force: true })
  }
  let released = false
  return {
    path,
    release: async () => {
      if (released) return
      released = true
      const current = parseLockOwner(await readFile(path, 'utf8').catch(() => ''))
      if (current?.token === token) {
        await unlink(path).catch((error) => {
          if (!isErrno(error, 'ENOENT')) throw error
        })
      }
    }
  }
}

/** Persist the pending replacement so a later launch can finish or report it. */
export async function writeTuiUpdateTransaction(
  installRoot: string,
  input: {
    previousVersion: string
    targetVersion: string
    buildId: string
    stagingRoot: string
    backupRoot: string
  }
): Promise<TuiUpdateTransaction> {
  const canonical = resolve(installRoot)
  const dir = tuiUpdateTransactionDir(canonical)
  const transaction: TuiUpdateTransaction = {
    schemaVersion: 1,
    previousVersion: input.previousVersion,
    targetVersion: input.targetVersion,
    buildId: input.buildId,
    installRoot: canonical,
    stagingRoot: resolve(input.stagingRoot),
    backupRoot: resolve(input.backupRoot),
    pid: process.pid,
    token: randomUUID(),
    startedAt: new Date().toISOString()
  }
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, TUI_UPDATE_TRANSACTION_FILE)
  await writeFileAtomically(path, `${JSON.stringify(transaction, null, 2)}\n`)
  return transaction
}

export async function writeTuiUpdateResult(
  installRoot: string,
  result: Omit<TuiUpdateResult, 'schemaVersion' | 'finishedAt'>
): Promise<void> {
  const path = tuiUpdateResultPath(installRoot)
  await mkdir(dirname(path), { recursive: true })
  const record: TuiUpdateResult = {
    schemaVersion: 1,
    ...result,
    finishedAt: new Date().toISOString()
  }
  await writeFileAtomically(path, `${JSON.stringify(record, null, 2)}\n`)
}

async function writeFileAtomically(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, path)
}

/** Remove transaction metadata but keep the diagnostic log for inspection. */
async function clearTuiUpdateTransaction(installRoot: string): Promise<void> {
  const dir = tuiUpdateTransactionDir(installRoot)
  for (const name of [TUI_UPDATE_TRANSACTION_FILE, TUI_UPDATE_RESULT_FILE]) {
    await rm(join(dir, name), { force: true }).catch(() => undefined)
  }
  try {
    const entries = await readdir(dir)
    if (!entries.length) await rm(dir, { recursive: true, force: true })
  } catch {
    // Directory already gone.
  }
}

type StagedRelease = { version: string; buildId: string }

async function readStagedRelease(stagingRoot: string): Promise<StagedRelease | null> {
  try {
    const parsed = JSON.parse(
      await readFile(join(stagingRoot, 'kun', 'release.json'), 'utf8')
    ) as { version?: unknown; buildId?: unknown }
    if (typeof parsed.version !== 'string' || typeof parsed.buildId !== 'string') return null
    return { version: parsed.version, buildId: parsed.buildId }
  } catch {
    return null
  }
}

/**
 * Complete a replacement whose detached script never finished. The staged tree
 * already passed size/hash/entry validation plus a version smoke test, so
 * finishing the same rename swap in-process is safe.
 */
async function rollForwardTuiUpdate(transaction: TuiUpdateTransaction): Promise<void> {
  const { installRoot, stagingRoot, backupRoot } = transaction
  const nextRoot = join(stagingRoot, 'kun')
  await rm(backupRoot, { recursive: true, force: true })
  const currentExists = await stat(installRoot).then(() => true).catch(() => false)
  if (currentExists) await rename(installRoot, backupRoot)
  try {
    await rename(nextRoot, installRoot)
  } catch (error) {
    if (currentExists) await rename(backupRoot, installRoot).catch(() => undefined)
    throw error
  }
  await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
}

/**
 * Inspect a pending self-update transaction at launch and reconcile it:
 * report a recorded outcome, finish a staged replacement whose detached
 * script died, or restore the previous install. Returns null when there is
 * nothing pending, and `busy` while a live process still owns the update.
 */
export async function reconcilePendingTuiUpdate(
  installRoot: string,
  options: ReconcileOptions = {}
): Promise<TuiUpdateReconcileReport | null> {
  const canonical = resolve(installRoot)
  const processIsAlive = options.processIsAlive ?? runtimeProcessIsAlive
  let transaction: TuiUpdateTransaction | null = null
  try {
    transaction = parseTuiUpdateTransaction(
      await readFile(tuiUpdateTransactionPath(canonical), 'utf8')
    )
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null
    throw error
  }
  if (!transaction) {
    // Corrupt transaction metadata: never touch the install automatically.
    await clearTuiUpdateTransaction(canonical)
    return {
      kind: 'failed',
      stage: 'transaction',
      message: 'the pending update record was unreadable; the installation was left unchanged'
    }
  }
  const resultRaw = await readFile(tuiUpdateResultPath(canonical), 'utf8')
    .catch((error: unknown) => {
      if (isErrno(error, 'ENOENT')) return null
      throw error
    })
  if (resultRaw !== null) {
    const result = parseTuiUpdateResult(resultRaw)
    if (!result) {
      await clearTuiUpdateTransaction(canonical)
      return {
        kind: 'failed',
        stage: 'result',
        message: 'the update result record was unreadable; check update.log next to the install'
      }
    }
    if (result.status === 'succeeded') {
      await clearTuiUpdateTransaction(canonical)
      await rm(transaction.stagingRoot, { recursive: true, force: true }).catch(() => undefined)
      return {
        kind: 'activated',
        previousVersion: result.previousVersion,
        targetVersion: result.targetVersion
      }
    }
    await clearTuiUpdateTransaction(canonical)
    return {
      kind: 'failed',
      stage: result.stage,
      message:
        `the staged update to Kun ${result.targetVersion} failed` +
        `${result.stage ? ` during ${result.stage}` : ''}` +
        `${result.error ? `: ${result.error}` : ''}. ` +
        'The previous installation was kept; run `kun update --yes` to retry. ' +
        `Details: ${tuiUpdateLogPath(canonical)}`
    }
  }
  // No result yet: either the replacement is still running or it died.
  const lockOwner = parseLockOwner(
    await readFile(tuiUpdateLockPath(canonical), 'utf8').catch(() => '')
  )
  if (lockOwner && processIsAlive(lockOwner.pid, lockOwner)) {
    return { kind: 'busy', pid: lockOwner.pid }
  }
  const staged = await readStagedRelease(transaction.stagingRoot)
  if (
    staged &&
    staged.version === transaction.targetVersion &&
    staged.buildId === transaction.buildId
  ) {
    try {
      await rollForwardTuiUpdate(transaction)
      await writeTuiUpdateResult(canonical, {
        status: 'succeeded',
        previousVersion: transaction.previousVersion,
        targetVersion: transaction.targetVersion
      })
      await clearTuiUpdateTransaction(canonical)
      return {
        kind: 'activated',
        previousVersion: transaction.previousVersion,
        targetVersion: transaction.targetVersion
      }
    } catch (error) {
      await writeTuiUpdateResult(canonical, {
        status: 'failed',
        stage: 'replace',
        error: 'could not move the staged release into place',
        previousVersion: transaction.previousVersion,
        targetVersion: transaction.targetVersion
      }).catch(() => undefined)
      await clearTuiUpdateTransaction(canonical)
      return {
        kind: 'failed',
        stage: 'replace',
        message:
          `the staged update to Kun ${transaction.targetVersion} could not be activated ` +
          `(${error instanceof Error ? error.message : String(error)}). ` +
          'The previous installation was kept; run `kun update --yes` to retry.'
      }
    }
  }
  // Staging is gone or does not match: restore the backup when the install root
  // itself is missing, then report the failure.
  const installExists = await stat(canonical).then(() => true).catch(() => false)
  let restored = false
  if (!installExists) {
    const backupExists = await stat(transaction.backupRoot).then(() => true).catch(() => false)
    if (backupExists) {
      await rename(transaction.backupRoot, canonical)
      restored = true
    }
  }
  await clearTuiUpdateTransaction(canonical)
  return {
    kind: 'failed',
    stage: 'staging',
    message:
      `the staged update to Kun ${transaction.targetVersion} was interrupted before it could run. ` +
      (restored
        ? 'The previous installation was restored from its backup. '
        : installExists
          ? 'The current installation was left unchanged. '
          : 'No usable installation remains; reinstall Kun. ') +
      'Run `kun update --yes` to retry.'
  }
}

/** True when the installed release already satisfies the update target. */
export function installedReleaseSatisfies(
  installed: { version: string } | null,
  targetVersion: string
): boolean {
  if (!installed || !semver.valid(installed.version)) return false
  return semver.gte(installed.version, targetVersion)
}
