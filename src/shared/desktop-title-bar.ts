export const DESKTOP_TITLE_BAR_MODES = ['custom', 'system'] as const

export type DesktopTitleBarMode = typeof DESKTOP_TITLE_BAR_MODES[number]

/**
 * Windows keeps Kun's custom title bar, while Linux can opt into the window
 * manager's frame. macOS uses Electron's hiddenInset chrome and therefore has
 * no renderer-owned desktop title bar.
 */
export function resolveDesktopTitleBarMode(
  platform: string,
  useSystemTitleBar: boolean
): DesktopTitleBarMode {
  if (platform === 'win32') return 'custom'
  if (platform === 'linux') return useSystemTitleBar ? 'system' : 'custom'
  return 'system'
}

export function normalizeDesktopTitleBarMode(
  platform: string,
  value: unknown
): DesktopTitleBarMode {
  return resolveDesktopTitleBarMode(platform, platform === 'linux' && value === 'system')
}

export function usesCustomDesktopTitleBar(
  platform: string,
  mode: DesktopTitleBarMode
): boolean {
  return resolveDesktopTitleBarMode(platform, mode === 'system') === 'custom'
}
