import { app } from 'electron'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import type { GuiUpdateChannel } from '../shared/gui-update'

export const PENDING_UPDATE_FILE = 'pending-update.json'
export const PENDING_UPDATE_RESULT_FILE = 'pending-update-result.json'
export const KUN_PENDING_UPDATE_PATH = 'KUN_PENDING_UPDATE_PATH'
export const KUN_PENDING_UPDATE_RESULT = 'KUN_PENDING_UPDATE_RESULT'
export const PENDING_UPDATE_SCHEMA_VERSION = 1

export type PendingUpdate = {
  schemaVersion: typeof PENDING_UPDATE_SCHEMA_VERSION
  state: 'installing'
  oldVersion: string
  newVersion: string
  installDir: string
  installerPath: string
  installerSha512?: string
  channel: GuiUpdateChannel
  writtenAt: string
  backupDir?: string
}

export type PendingUpdateResult = {
  schemaVersion: typeof PENDING_UPDATE_SCHEMA_VERSION
  outcome: 'success' | 'aborted'
  code: string
  message: string
  at: string
  phase?: string
  backupDir?: string
}

export function pendingUpdatePath(userDataPath = app.getPath('userData')): string {
  return join(userDataPath, PENDING_UPDATE_FILE)
}

export function pendingUpdateResultPath(userDataPath = app.getPath('userData')): string {
  return join(userDataPath, PENDING_UPDATE_RESULT_FILE)
}

async function writeAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporaryPath, path)
}

function isPendingUpdate(value: unknown): value is PendingUpdate {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return record.schemaVersion === PENDING_UPDATE_SCHEMA_VERSION &&
    record.state === 'installing' &&
    typeof record.oldVersion === 'string' &&
    typeof record.newVersion === 'string' &&
    typeof record.installDir === 'string' &&
    typeof record.installerPath === 'string' &&
    typeof record.channel === 'string' &&
    typeof record.writtenAt === 'string'
}

function isPendingUpdateResult(value: unknown): value is PendingUpdateResult {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return record.schemaVersion === PENDING_UPDATE_SCHEMA_VERSION &&
    (record.outcome === 'success' || record.outcome === 'aborted') &&
    typeof record.code === 'string' &&
    typeof record.message === 'string' &&
    typeof record.at === 'string'
}

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[kun-gui updater] ignored malformed pending update state:', error)
    }
    return null
  }
}

export async function writePendingUpdate(
  update: Omit<PendingUpdate, 'schemaVersion' | 'state' | 'writtenAt'>,
  userDataPath?: string
): Promise<PendingUpdate> {
  const pending: PendingUpdate = {
    schemaVersion: PENDING_UPDATE_SCHEMA_VERSION,
    state: 'installing',
    writtenAt: new Date().toISOString(),
    ...update
  }
  await writeAtomically(pendingUpdatePath(userDataPath), pending)
  return pending
}

export async function readPendingUpdate(userDataPath?: string): Promise<PendingUpdate | null> {
  const pending = await readJson(pendingUpdatePath(userDataPath))
  return isPendingUpdate(pending) ? pending : null
}

export async function clearPendingUpdate(userDataPath?: string): Promise<void> {
  await rm(pendingUpdatePath(userDataPath), { force: true })
}

export async function cleanupPendingUpdateBackup(backupDir?: string): Promise<void> {
  if (!backupDir || process.platform !== 'win32') return
  const recoveryRoot = resolve(app.getPath('appData'), 'KunInstallerRecovery')
  const backup = resolve(backupDir)
  if (!/^update-backup-\d+$/.test(basename(backup)) || relative(recoveryRoot, backup).startsWith('..')) return
  await rm(backup, { recursive: true, force: true })
}

export async function writePendingUpdateResult(
  result: Omit<PendingUpdateResult, 'schemaVersion' | 'at'>,
  userDataPath?: string
): Promise<PendingUpdateResult> {
  const pendingResult: PendingUpdateResult = {
    schemaVersion: PENDING_UPDATE_SCHEMA_VERSION,
    at: new Date().toISOString(),
    ...result
  }
  await writeAtomically(pendingUpdateResultPath(userDataPath), pendingResult)
  return pendingResult
}

export async function readPendingUpdateResult(userDataPath?: string): Promise<PendingUpdateResult | null> {
  const result = await readJson(pendingUpdateResultPath(userDataPath))
  return isPendingUpdateResult(result) ? result : null
}

export async function clearPendingUpdateResult(userDataPath?: string): Promise<void> {
  await rm(pendingUpdateResultPath(userDataPath), { force: true })
}

export async function consumePendingUpdateResult(userDataPath?: string): Promise<PendingUpdateResult | null> {
  const result = await readPendingUpdateResult(userDataPath)
  if (result) await clearPendingUpdateResult(userDataPath)
  return result
}

export function setPendingUpdateEnvironment(
  pendingPath = pendingUpdatePath(),
  resultPath = pendingUpdateResultPath(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): () => void {
  if (platform !== 'win32') return () => undefined
  const previous = [KUN_PENDING_UPDATE_PATH, KUN_PENDING_UPDATE_RESULT].map((key) => ({
    key,
    hadValue: Object.prototype.hasOwnProperty.call(env, key),
    value: env[key]
  }))
  env[KUN_PENDING_UPDATE_PATH] = pendingPath
  env[KUN_PENDING_UPDATE_RESULT] = resultPath
  return () => {
    for (const item of previous) {
      if (item.hadValue && item.value !== undefined) env[item.key] = item.value
      else delete env[item.key]
    }
  }
}
