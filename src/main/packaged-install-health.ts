import { statSync as nodeStatSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

export type PackagedInstallHealth =
  | { ok: true }
  | { ok: false; missing: string[] }

type PackagedInstallHealthInput = {
  isPackaged: boolean
  executablePath: string
  resourcesPath: string
}

type FileStat = {
  isFile(): boolean
  size: number | bigint
}

type FileStatSync = (path: string) => FileStat
type ModuleLoader = (id: string) => unknown

const requireFromHere = createRequire(import.meta.url)

/**
 * Electron virtualizes `node:fs` access to an ASAR archive. In a packaged app,
 * statSync(resources/app.asar) therefore describes the mounted archive root as
 * a directory instead of the physical archive file. `original-fs` bypasses the
 * ASAR layer; plain Node (including unit tests) falls back to its already-raw fs.
 */
export function resolveInstallHealthFileStat(loadModule: ModuleLoader = requireFromHere): FileStatSync {
  try {
    const rawFs = loadModule('original-fs') as { statSync?: FileStatSync }
    if (typeof rawFs?.statSync === 'function') {
      return (path) => rawFs.statSync!(path)
    }
  } catch {
    // `original-fs` is an Electron built-in and is unavailable in plain Node.
  }
  return (path) => nodeStatSync(path)
}

const rawStatSync = resolveInstallHealthFileStat()

function isNonEmptyFile(path: string): boolean {
  try {
    const stat = rawStatSync(path)
    return stat.isFile() && stat.size > 0n
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
