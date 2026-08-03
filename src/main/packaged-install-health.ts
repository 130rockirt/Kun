import { statSync } from 'node:fs'
import { join } from 'node:path'

export type PackagedInstallHealth =
  | { ok: true }
  | { ok: false; missing: string[] }

type PackagedInstallHealthInput = {
  isPackaged: boolean
  executablePath: string
  resourcesPath: string
}

function isNonEmptyFile(path: string): boolean {
  try {
    const stat = statSync(path)
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}

/**
 * Detect the subset of interrupted-install failures where Electron can still
 * start but the unpacked Kun runtime is incomplete. A missing app.asar cannot
 * reach this code, so the installer performs the same post-install check.
 */
export function inspectPackagedInstallHealth(input: PackagedInstallHealthInput): PackagedInstallHealth {
  if (!input.isPackaged) return { ok: true }

  const required = [
    { label: 'application executable', path: input.executablePath },
    { label: 'resources/app.asar', path: join(input.resourcesPath, 'app.asar') },
    {
      label: 'Kun runtime entry',
      path: join(input.resourcesPath, 'app.asar.unpacked', 'kun', 'dist', 'cli', 'serve-entry.js')
    },
    {
      label: 'Kun service manager entry',
      path: join(input.resourcesPath, 'app.asar.unpacked', 'kun', 'dist', 'manager', 'manager-entry.js')
    }
  ]
  const missing = required.filter((entry) => !isNonEmptyFile(entry.path)).map((entry) => entry.label)
  return missing.length === 0 ? { ok: true } : { ok: false, missing }
}
