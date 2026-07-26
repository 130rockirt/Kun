import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

export const LEGACY_KUN_DATA_DIR_TILDE = '~/.deepseekgui/kun'
export const CURRENT_KUN_DATA_DIR_TILDE = '~/.kun/data'

export type CanonicalKunDataDirKind = 'legacy' | 'current' | 'custom'

type Platform = NodeJS.Platform

function pathApi(platform: Platform): typeof posix | typeof win32 {
  return platform === 'win32' ? win32 : posix
}

function expandForPlatform(raw: string, homeDir: string, platform: Platform): string {
  const api = pathApi(platform)
  const trimmed = raw.trim()
  if (trimmed === '~') return homeDir
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    const relative = trimmed.slice(2).replace(/[\\/]+/g, api.sep)
    return api.join(homeDir, relative)
  }
  return trimmed.replace(/[\\/]+/g, api.sep)
}

function comparablePath(raw: string, homeDir: string, platform: Platform): string {
  const api = pathApi(platform)
  const expanded = expandForPlatform(raw, homeDir, platform)
  const resolved = api.resolve(expanded)
  const withoutTrailingSeparators = resolved.length > api.parse(resolved).root.length
    ? resolved.replace(/[\\/]+$/, '')
    : resolved
  return platform === 'win32'
    ? withoutTrailingSeparators.toLocaleLowerCase('en-US')
    : withoutTrailingSeparators
}

export function canonicalLegacyKunDataDir(
  homeDir = homedir(),
  platform: Platform = process.platform
): string {
  return pathApi(platform).join(homeDir, '.deepseekgui', 'kun')
}

export function canonicalCurrentKunDataDir(
  homeDir = homedir(),
  platform: Platform = process.platform
): string {
  return pathApi(platform).join(homeDir, '.kun', 'data')
}

export function classifyCanonicalKunDataDir(
  raw: string | null | undefined,
  options: { homeDir?: string; platform?: Platform } = {}
): CanonicalKunDataDirKind {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) return 'custom'
  const homeDir = options.homeDir ?? homedir()
  const platform = options.platform ?? process.platform
  const comparable = comparablePath(value, homeDir, platform)
  if (comparable === comparablePath(canonicalLegacyKunDataDir(homeDir, platform), homeDir, platform)) {
    return 'legacy'
  }
  if (comparable === comparablePath(canonicalCurrentKunDataDir(homeDir, platform), homeDir, platform)) {
    return 'current'
  }
  return 'custom'
}

export function isCanonicalLegacyKunDataDir(
  raw: string | null | undefined,
  options: { homeDir?: string; platform?: Platform } = {}
): boolean {
  return classifyCanonicalKunDataDir(raw, options) === 'legacy'
}

export function assertManagedKunDataDirIsCurrent(
  dataDir: string,
  options: { homeDir?: string; platform?: Platform } = {}
): void {
  if (!isCanonicalLegacyKunDataDir(dataDir, options)) return
  throw new Error(
    `Kun Runtime data migration is required before managed writes can continue: ` +
    `${LEGACY_KUN_DATA_DIR_TILDE} -> ${CURRENT_KUN_DATA_DIR_TILDE}`
  )
}
