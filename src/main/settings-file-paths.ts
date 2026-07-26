import { basename, dirname, join } from 'node:path'

export const SETTINGS_FILE_NAME = 'kun-settings.json'
export const LEGACY_SETTINGS_FILE_NAME = 'deepseek-gui-settings.json'
export const COMPATIBLE_USER_DATA_DIR_NAMES = ['deepseek-gui', 'DeepSeek GUI'] as const

/**
 * Return settings read candidates in exactly the order used by JsonSettingsStore:
 * current file, legacy filename in current userData, then both filenames in each
 * compatible Electron userData directory.
 */
export function settingsReadCandidates(userDataPath: string): string[] {
  const currentPath = join(userDataPath, SETTINGS_FILE_NAME)
  const currentDirName = basename(userDataPath)
  const parentDir = dirname(userDataPath)
  const candidates = [
    currentPath,
    join(userDataPath, LEGACY_SETTINGS_FILE_NAME)
  ]
  for (const dirName of COMPATIBLE_USER_DATA_DIR_NAMES) {
    if (dirName === currentDirName) continue
    candidates.push(join(parentDir, dirName, SETTINGS_FILE_NAME))
    candidates.push(join(parentDir, dirName, LEGACY_SETTINGS_FILE_NAME))
  }
  return candidates
}
