import type {
  BrowserWindowConstructorOptions,
  VisibleOnAllWorkspacesOptions
} from 'electron'

type TrayQuotaWindowPlatformOptions = Pick<
  BrowserWindowConstructorOptions,
  'skipTaskbar' | 'type'
>

export function resolveTrayQuotaWindowPlatformOptions(
  platform: NodeJS.Platform
): TrayQuotaWindowPlatformOptions {
  if (platform === 'darwin') return { type: 'panel' }
  return { skipTaskbar: true }
}

export function resolveTrayQuotaWorkspaceOptions(
  platform: NodeJS.Platform
): VisibleOnAllWorkspacesOptions {
  return {
    visibleOnFullScreen: true,
    // Electron otherwise temporarily changes a regular macOS app into an
    // accessory app, which removes its icon from the Dock.
    ...(platform === 'darwin' ? { skipTransformProcessType: true } : {})
  }
}
