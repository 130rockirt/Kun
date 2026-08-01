import { posix, win32 } from 'node:path'

export function sameCanonicalPath(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform === 'win32') {
    return normalizeWindowsPath(left) === normalizeWindowsPath(right)
  }
  return posix.resolve(left) === posix.resolve(right)
}

function normalizeWindowsPath(value: string): string {
  const resolved = win32.resolve(value)
  const withoutExtendedPrefix = resolved.startsWith('\\\\?\\UNC\\')
    ? `\\\\${resolved.slice(8)}`
    : resolved.startsWith('\\\\?\\')
      ? resolved.slice(4)
      : resolved
  return withoutExtendedPrefix.toLowerCase()
}
