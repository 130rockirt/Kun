import { homedir } from 'node:os'
import { basename, dirname, join, posix, win32 } from 'node:path'
import type { AppSettingsV1 } from '../../shared/app-settings'
import type {
  UninstallPathItem,
  UninstallRemoveAppMode
} from '../../shared/uninstall'
import {
  canonicalCurrentKunDataDir,
  canonicalLegacyKunDataDir,
  classifyCanonicalKunDataDir
} from '../kun-data-dir-paths'
import { COMPATIBLE_USER_DATA_DIR_NAMES } from '../settings-file-paths'

export type UninstallPlatform = NodeJS.Platform

export type UninstallPathCollectionInput = {
  userDataPath: string
  settings?: AppSettingsV1 | null
  homeDir?: string
  platform?: UninstallPlatform
}

export type UninstallAppRemovalTarget = {
  mode: UninstallRemoveAppMode
  target?: string
  /** The user-selected application installation location, for display only. */
  installPath?: string
  hint?: string
}

function pathApi(platform: UninstallPlatform): typeof posix | typeof win32 {
  return platform === 'win32' ? win32 : posix
}

function comparablePath(raw: string, homeDir: string, platform: UninstallPlatform): string {
  const api = pathApi(platform)
  const value = raw.trim()
  const expanded = value.startsWith('~/') || value.startsWith('~\\')
    ? api.resolve(join(homeDir, value.slice(2)))
    : api.resolve(value)
  const withoutTrailing = expanded.length > api.parse(expanded).root.length
    ? expanded.replace(/[\\/]+$/u, '')
    : expanded
  return platform === 'win32'
    ? withoutTrailing.toLocaleLowerCase('en-US')
    : withoutTrailing
}

/**
 * Defensive guard applied to every path that will be handed to the cleanup
 * script. Paths come from the app inventory below, but a settings-provided
 * custom dataDir must never let us delete the filesystem root, the user home,
 * or an ancestor of the home directory.
 */
export function assertSafeUninstallPath(
  raw: string,
  options: { homeDir?: string; platform?: UninstallPlatform } = {}
): string {
  const value = raw.trim()
  const homeDir = options.homeDir ?? homedir()
  const platform = options.platform ?? process.platform
  const api = pathApi(platform)
  if (!value || value.includes('\0')) {
    throw new Error('unsafe_uninstall_path: Path is empty or contains a null byte.')
  }
  if (!api.isAbsolute(value)) {
    throw new Error('unsafe_uninstall_path: Only absolute paths can be removed.')
  }
  const resolved = api.resolve(value)
  if (resolved === api.parse(resolved).root) {
    throw new Error('unsafe_uninstall_path: A filesystem root cannot be removed.')
  }
  const comparable = comparablePath(value, homeDir, platform)
  const homeComparable = comparablePath(homeDir, homeDir, platform)
  if (comparable === homeComparable) {
    throw new Error('unsafe_uninstall_path: The user home directory cannot be removed.')
  }
  if (homeComparable.startsWith(`${comparable}${api.sep}`)) {
    throw new Error('unsafe_uninstall_path: An ancestor of the user home cannot be removed.')
  }
  return resolved
}

export function collectUninstallPaths(input: UninstallPathCollectionInput): UninstallPathItem[] {
  const homeDir = input.homeDir ?? homedir()
  const platform = input.platform ?? process.platform
  const api = pathApi(platform)
  const items: UninstallPathItem[] = []
  const seen = new Set<string>()
  const expandTilde = (raw: string): string => {
    if (raw.startsWith('~/') || raw.startsWith('~\\')) return api.join(homeDir, raw.slice(2))
    return raw
  }
  const push = (kind: UninstallPathItem['kind'], raw: string): void => {
    const path = assertSafeUninstallPath(expandTilde(raw), { homeDir, platform })
    const comparable = comparablePath(path, homeDir, platform)
    if (seen.has(comparable)) return
    seen.add(comparable)
    items.push({ kind, path, exists: false })
  }

  push('userData', input.userDataPath)
  const userDataParent = dirname(input.userDataPath)
  const currentDirName = basename(input.userDataPath)
  for (const dirName of COMPATIBLE_USER_DATA_DIR_NAMES) {
    if (dirName === currentDirName) continue
    push('legacyUserData', api.join(userDataParent, dirName))
  }

  const dataDir = input.settings?.agents?.kun?.dataDir?.trim()
  const classification = classifyCanonicalKunDataDir(dataDir, { homeDir, platform })
  if (dataDir && classification !== 'current') {
    // Custom (or legacy) configured runtime data directory.
    push(classification === 'legacy' ? 'legacyKunData' : 'customData', dataDir)
  } else {
    push('kunData', canonicalCurrentKunDataDir(homeDir, platform))
  }
  push('legacyKunData', canonicalLegacyKunDataDir(homeDir, platform))

  return items
}

export async function markExistingPaths(items: UninstallPathItem[]): Promise<UninstallPathItem[]> {
  const { access } = await import('node:fs/promises')
  return Promise.all(items.map(async (item) => {
    let exists = false
    try {
      await access(item.path)
      exists = true
    } catch {
      exists = false
    }
    return { ...item, exists }
  }))
}

/**
 * Resolve what "remove the application itself" means on this platform.
 * Returns mode `none` for unpackaged/dev builds or Linux deb installs where
 * the app cannot remove itself without elevation.
 */
export async function resolveAppRemovalTarget(input: {
  execPath: string
  isPackaged: boolean
  platform: UninstallPlatform
  appImageEnv?: string | undefined
}): Promise<UninstallAppRemovalTarget> {
  const { execPath, isPackaged, platform } = input
  if (!isPackaged) {
    return {
      mode: 'none',
      hint: 'The app is running from a development checkout. Only local data can be removed.'
    }
  }
  if (platform === 'darwin') {
    const bundleRoot = findMacBundleRoot(execPath)
    if (bundleRoot) return { mode: 'bundle', target: bundleRoot, installPath: bundleRoot }
    return { mode: 'none', hint: 'Could not locate the Kun.app bundle for removal.' }
  }
  if (platform === 'win32') {
    const installDir = dirname(execPath)
    const uninstaller = await findWindowsUninstaller(installDir)
    if (uninstaller) return { mode: 'uninstaller', target: uninstaller, installPath: installDir }
    return {
      mode: 'none',
      hint: 'Could not locate the Kun uninstaller in the installation directory.'
    }
  }
  if (platform === 'linux') {
    const appImage = input.appImageEnv?.trim()
    if (appImage) return { mode: 'appimage', target: appImage, installPath: appImage }
    return {
      mode: 'none',
      hint: 'Kun was installed via a system package (deb). Remove it with your package manager, for example: sudo dpkg -r <package>'
    }
  }
  return { mode: 'none', hint: 'Application removal is not supported on this platform.' }
}

export function findMacBundleRoot(execPath: string): string | null {
  let current = dirname(execPath)
  for (let depth = 0; depth < 8; depth += 1) {
    if (basename(current).endsWith('.app')) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
  return null
}

export async function findWindowsUninstaller(installDir: string): Promise<string | null> {
  const { readdir } = await import('node:fs/promises')
  try {
    const entries = await readdir(installDir)
    const match = entries.find((entry) => /^Uninstall .+\.exe$/iu.test(entry))
    return match ? join(installDir, match) : null
  } catch {
    return null
  }
}
