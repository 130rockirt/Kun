import {
  appendFile,
  mkdir,
  rename,
  stat,
  unlink
} from 'node:fs/promises'
import { dirname } from 'node:path'
import { applyPosixMode } from '../../../kun/src/security/posix-permissions.js'

export const BROWSER_USE_AUDIT_MAX_FILE_BYTES = 5 * 1024 * 1024
export const BROWSER_USE_AUDIT_MAX_ARCHIVES = 2

type BrowserUseAuditAppendOptions = {
  maxFileBytes?: number
  maxArchives?: number
}

export async function appendBrowserUseAuditLine(
  auditPath: string,
  line: string,
  options: BrowserUseAuditAppendOptions = {}
): Promise<void> {
  const maxFileBytes = options.maxFileBytes ?? BROWSER_USE_AUDIT_MAX_FILE_BYTES
  const maxArchives = options.maxArchives ?? BROWSER_USE_AUDIT_MAX_ARCHIVES
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) {
    throw new Error('Browser Use audit file limit must be a positive integer.')
  }
  if (!Number.isSafeInteger(maxArchives) || maxArchives < 0) {
    throw new Error('Browser Use audit archive limit must be a non-negative integer.')
  }

  const payload = line.endsWith('\n') ? line : `${line}\n`
  const payloadBytes = Buffer.byteLength(payload, 'utf8')
  if (payloadBytes > maxFileBytes) {
    throw new Error('Browser Use audit record exceeds the host file limit.')
  }

  const auditDirectory = dirname(auditPath)
  await mkdir(auditDirectory, { recursive: true, mode: 0o700 })
  await applyPosixMode(auditDirectory, 0o700)
  const currentBytes = await fileSize(auditPath)
  if (currentBytes > maxFileBytes) {
    await unlinkIfPresent(auditPath)
  } else if (currentBytes > 0 && currentBytes + payloadBytes > maxFileBytes) {
    await rotateAuditFiles(auditPath, maxArchives)
  }
  await appendFile(auditPath, payload, { encoding: 'utf8', mode: 0o600 })
  await applyPosixMode(auditPath, 0o600)
}

async function rotateAuditFiles(auditPath: string, maxArchives: number): Promise<void> {
  if (maxArchives === 0) {
    await unlinkIfPresent(auditPath)
    return
  }

  await unlinkIfPresent(`${auditPath}.${maxArchives}`)
  for (let index = maxArchives - 1; index >= 1; index -= 1) {
    await renameIfPresent(`${auditPath}.${index}`, `${auditPath}.${index + 1}`)
  }
  await renameIfPresent(auditPath, `${auditPath}.1`)
  for (let index = 1; index <= maxArchives; index += 1) {
    await chmodIfPresent(`${auditPath}.${index}`, 0o600)
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch (error) {
    if (isMissingFile(error)) return 0
    throw error
  }
}

async function renameIfPresent(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }
}

async function chmodIfPresent(path: string, mode: number): Promise<void> {
  try {
    await applyPosixMode(path, mode)
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
