import { chmodSync } from 'node:fs'
import { chmod } from 'node:fs/promises'

export function shouldApplyPosixMode(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32'
}

/** Windows ACLs do not implement POSIX modes; permission hardening is non-applicable there. */
export async function applyPosixMode(path: string, mode: number): Promise<void> {
  if (!shouldApplyPosixMode()) return
  await chmod(path, mode)
}

export function applyPosixModeSync(path: string, mode: number): void {
  if (!shouldApplyPosixMode()) return
  chmodSync(path, mode)
}
