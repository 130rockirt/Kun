import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync
} from 'node:fs'
import {
  createHmac
} from 'node:crypto'
import {
  isAbsolute,
  relative,
  resolve,
  sep
} from 'node:path'
import {
  type RuntimeDataRecoveryCandidateKind,
  type RuntimeDataRecoveryInventory
} from '../shared/runtime-data-recovery'
import {
  type CandidateDescriptor,
  type PathState,
  RuntimeDataRecoveryError
} from './runtime-data-dir-recovery-types'



export function candidateOpaqueId(secret: Buffer, generation: string, descriptor: CandidateDescriptor): string {
  const identity = [
    generation,
    descriptor.summary.kind,
    descriptor.realPath,
    String(descriptor.device),
    String(descriptor.inode),
    descriptor.fingerprint,
    JSON.stringify(descriptor.summary.inventory)
  ].join('\0')
  return createHmac('sha256', secret).update(identity).digest('base64url')
}

export function candidateLabel(kind: RuntimeDataRecoveryCandidateKind): string {
  if (kind === 'current') return 'Current Kun data / 当前 Kun 数据'
  if (kind === 'legacy') return 'Legacy Kun data / 旧版 Kun 数据'
  if (kind === 'staging') return 'Verified recovery staging copy / 已验证恢复暂存副本'
  return 'Preserved migration backup / 已保留的迁移备份'
}

export function compareCandidatePreference(left: CandidateDescriptor, right: CandidateDescriptor): number {
  const rank: Record<RuntimeDataRecoveryCandidateKind, number> = {
    current: 0,
    legacy: 1,
    staging: 2,
    backup: 3
  }
  return rank[left.summary.kind] - rank[right.summary.kind] ||
    right.summary.modifiedAt.localeCompare(left.summary.modifiedAt)
}

export function inventoriesEqual(left: RuntimeDataRecoveryInventory, right: RuntimeDataRecoveryInventory): boolean {
  return Object.keys(left).every((key) =>
    left[key as keyof RuntimeDataRecoveryInventory] === right[key as keyof RuntimeDataRecoveryInventory])
}

export function isEmptyInventory(inventory: RuntimeDataRecoveryInventory): boolean {
  return inventory.files === 0 && inventory.symlinks === 0 && inventory.directories <= 1
}

export function canonicalRelativePath(rootPath: string, entryPath: string): string {
  const value = relative(rootPath, entryPath)
  return value === '' ? '.' : value.split(sep).join('/')
}

export function isContained(rootPath: string, candidatePath: string, platform: NodeJS.Platform): boolean {
  const root = pathKey(resolve(rootPath), platform)
  const candidate = pathKey(resolve(candidatePath), platform)
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}

export function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  if (!left || !right || !isAbsolute(left) || !isAbsolute(right)) return false
  return pathKey(left, platform) === pathKey(right, platform)
}

export function pathKey(path: string, platform: NodeJS.Platform): string {
  const resolved = resolve(path).replace(/[\\/]+$/, '')
  return platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved
}

export function pathState(path: string): PathState {
  try {
    const metadata = lstatSync(path)
    if (metadata.isSymbolicLink()) return 'symlink'
    if (metadata.isDirectory()) return 'directory'
    if (metadata.isFile()) return 'file'
    return 'other'
  } catch (error) {
    return errnoCode(error) === 'ENOENT' ? 'missing' : 'inaccessible'
  }
}

export function errnoCode(error: unknown): string | undefined {
  return isObject(error) && typeof error.code === 'string' ? error.code : undefined
}

export function readBoundedFile(path: string, maximumBytes: number): string {
  const metadata = lstatSync(path)
  if (!metadata.isFile() || metadata.size > maximumBytes) throw new Error('file is not safely readable')
  return readFileSync(path, 'utf8')
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function fsyncFileBestEffort(path: string): void {
  const handle = openSync(path, 'r')
  try {
    try {
      fsyncSync(handle)
    } catch (error) {
      if (process.platform !== 'win32') throw error
    }
  } finally {
    closeSync(handle)
  }
}

export function fsyncDirectoryBestEffort(path: string): void {
  try {
    const handle = openSync(path, 'r')
    try {
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
  } catch {
    // Directory fsync is unavailable on some Windows filesystems.
  }
}

export function toRecoveryError(error: unknown): RuntimeDataRecoveryError {
  if (error instanceof RuntimeDataRecoveryError) return error
  return new RuntimeDataRecoveryError(
    'cutover_failed',
    'Runtime data recovery failed without changing preserved evidence.',
    { cause: error }
  )
}
