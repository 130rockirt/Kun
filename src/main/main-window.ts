import { BrowserWindow } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { reloadRenderer } from './dev-renderer-cache'
import { resolvePreloadPath } from './main-paths'
import {
  MAIN_WINDOW_RENDERER_RECOVERY_DELAY_MS,
  MAIN_WINDOW_RENDERER_RECOVERY_MAX_ATTEMPTS,
  MAIN_WINDOW_RENDERER_RECOVERY_WINDOW_MS,
  MainWindowRendererRecoveryBudget,
  shouldRecoverMainFrameLoad,
  shouldRecoverRendererProcess
} from './main-window-renderer-recovery'
import { logError, logInfo, logWarn } from './logger'
import { appWindowTitleForFlavor } from '../shared/app-environment'
import {
  __dirname,
  appEnvironment,
  appIcon,
  developmentRendererUrl,
  isTrustedWorkbenchUrl,
  mainState,
  traceStartup
} from './main-app-context'
import { isAppQuitInProgress } from './main-lifecycle'
import {
  handleMainWindowClose,
  showRendererContextMenu
} from './main-tray'
import { runtimeSupervisor } from './main-runtime-health'

function resolveMainRendererUrl(): string {
  return developmentRendererUrl() ?? pathToFileURL(join(__dirname, '../renderer/index.html')).href
}

export function createWindow(options: { suppressInitialShow?: boolean } = {}): void {
  traceStartup('createWindow:start')
  const preloadPath = resolvePreloadPath(__dirname)
  const usesDesktopTitleBar = process.platform === 'win32' || process.platform === 'linux'
  const windowTitle = appWindowTitleForFlavor(appEnvironment.flavor)
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: windowTitle,
    icon: appIcon.isEmpty() ? undefined : appIcon,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : usesDesktopTitleBar ? 'hidden' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 31, y: 22 } : undefined,
    autoHideMenuBar: usesDesktopTitleBar,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      webviewTag: true,
      // Pass the home dir to the sandboxed preload (it can't require node:os).
      additionalArguments: [
        `--kun-home-dir=${homedir()}`,
        `--kun-app-environment=${encodeURIComponent(JSON.stringify(appEnvironment))}`
      ]
    }
  })
  window.on('page-title-updated', (event) => {
    event.preventDefault()
    window.setTitle(windowTitle)
  })
  mainState.mainWindow = window
  const trustedRendererUrl = resolveMainRendererUrl()
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const preventUntrustedNavigation = (event: Electron.Event, targetUrl: string): void => {
    if (!isTrustedWorkbenchUrl(targetUrl, trustedRendererUrl)) event.preventDefault()
  }
  window.webContents.on('will-navigate', preventUntrustedNavigation)
  window.webContents.on('will-redirect', preventUntrustedNavigation)
  mainState.bindExtensionMainWindow?.(window)
  if (usesDesktopTitleBar) {
    window.setMenu(null)
    window.setMenuBarVisibility(false)
  }
  const recoveryBudget = new MainWindowRendererRecoveryBudget()
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null
  let rendererProcessId = 0
  const scheduleRendererRecovery = (trigger: string, detail: unknown): void => {
    if (
      recoveryTimer ||
      isAppQuitInProgress() ||
      window.isDestroyed() ||
      window.webContents.isDestroyed()
    ) return

    const attempt = recoveryBudget.reserve()
    if (attempt === null) {
      logError('renderer', 'Automatic main-window recovery stopped after repeated failures.', {
        trigger,
        detail,
        maxAttempts: MAIN_WINDOW_RENDERER_RECOVERY_MAX_ATTEMPTS,
        windowMs: MAIN_WINDOW_RENDERER_RECOVERY_WINDOW_MS
      })
      return
    }

    logWarn('renderer', 'Scheduling a main-window reload after renderer failure.', {
      trigger,
      detail,
      attempt,
      maxAttempts: MAIN_WINDOW_RENDERER_RECOVERY_MAX_ATTEMPTS
    })
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null
      if (
        isAppQuitInProgress() ||
        window.isDestroyed() ||
        window.webContents.isDestroyed()
      ) return
      logWarn('renderer', 'Reloading the main window after renderer failure.', {
        trigger,
        attempt
      })
      reloadRenderer(window.webContents, developmentRendererUrl())
    }, MAIN_WINDOW_RENDERER_RECOVERY_DELAY_MS)
    recoveryTimer.unref?.()
  }

  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[kun-gui] failed to load preload ${preloadPath}:`, error)
    logError('preload', 'Failed to load preload script', { preloadPath, message })
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    if (isAppQuitInProgress() || !shouldRecoverRendererProcess(details.reason)) return
    const detail = {
      reason: details.reason,
      exitCode: details.exitCode,
      rendererProcessId
    }
    console.error('[kun-gui] main renderer process exited unexpectedly:', detail)
    logError('renderer', 'Main renderer process exited unexpectedly.', detail)
    scheduleRendererRecovery('render-process-gone', detail)
  })
  window.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame, frameProcessId) => {
      if (
        isAppQuitInProgress() ||
        !shouldRecoverMainFrameLoad(errorCode, isMainFrame)
      ) return
      const detail = {
        errorCode,
        errorDescription,
        validatedURL,
        frameProcessId
      }
      console.error('[kun-gui] main renderer failed to load:', detail)
      logError('renderer', 'Main renderer failed to load.', detail)
      scheduleRendererRecovery('did-fail-load', detail)
    }
  )
  window.webContents.on('unresponsive', () => {
    if (isAppQuitInProgress()) return
    logWarn('renderer', 'Main renderer became unresponsive.', { rendererProcessId })
  })
  window.webContents.on('responsive', () => {
    logInfo('renderer', `Main renderer became responsive again (pid=${rendererProcessId}).`)
  })
  window.webContents.on('context-menu', (event, params) => {
    event.preventDefault()
    if (window.isDestroyed()) return
    showRendererContextMenu(window, params)
  })
  const showWindow = (): void => {
    if (options.suppressInitialShow) return
    if (window.isDestroyed() || window.isVisible()) return
    window.show()
  }
  window.on('close', (event) => {
    if (window.isDestroyed()) return
    handleMainWindowClose(window, event)
  })
  window.on('closed', () => {
    if (recoveryTimer) {
      clearTimeout(recoveryTimer)
      recoveryTimer = null
    }
    if (mainState.mainWindow === window) mainState.mainWindow = null
  })
  const devUrl = developmentRendererUrl()
  traceStartup('createWindow:load', { devUrl: devUrl ?? 'file' })
  if (devUrl) {
    void window.loadURL(devUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
  window.once('ready-to-show', () => {
    traceStartup('window:ready-to-show')
    showWindow()
  })
  window.webContents.on('did-finish-load', () => {
    traceStartup('window:did-finish-load')
    rendererProcessId = window.webContents.getOSProcessId()
    if (runtimeSupervisor.lastStatus && !window.isDestroyed()) {
      window.webContents.send('runtime:status', runtimeSupervisor.lastStatus)
    }
    if (!window.isDestroyed()) {
      window.webContents.send('runtime:settings-sync-status', mainState.runtimeSettingsSyncStatus)
    }
    showWindow()
  })
  setTimeout(() => {
    traceStartup('window:fallback-show-timeout')
    showWindow()
  }, 1500)
}

export function createStorageRelocationWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 760,
    height: 620,
    minWidth: 680,
    minHeight: 520,
    title: 'Kun Storage Migration',
    icon: appIcon.isEmpty() ? undefined : appIcon,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: resolvePreloadPath(__dirname),
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      additionalArguments: [
        `--kun-home-dir=${homedir()}`,
        `--kun-app-environment=${encodeURIComponent(JSON.stringify(appEnvironment))}`
      ]
    }
  })
  mainState.mainWindow = window
  window.setMenu(null)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.on('closed', () => {
    if (mainState.mainWindow === window) mainState.mainWindow = null
  })
  const devUrl = developmentRendererUrl()
  if (devUrl) {
    const target = new URL(devUrl)
    target.searchParams.set('storageRelocation', '1')
    void window.loadURL(target.toString())
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { storageRelocation: '1' }
    })
  }
  window.once('ready-to-show', () => window.show())
  return window
}

export function createRuntimeDataRecoveryWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 820,
    height: 700,
    minWidth: 700,
    minHeight: 560,
    title: 'Kun Runtime Data Recovery',
    icon: appIcon.isEmpty() ? undefined : appIcon,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: resolvePreloadPath(__dirname),
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      additionalArguments: [
        `--kun-home-dir=${homedir()}`,
        `--kun-app-environment=${encodeURIComponent(JSON.stringify(appEnvironment))}`
      ]
    }
  })
  mainState.mainWindow = window
  window.setMenu(null)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const trustedRendererUrl = resolveMainRendererUrl()
  const preventUntrustedNavigation = (event: Electron.Event, targetUrl: string): void => {
    if (!isTrustedWorkbenchUrl(targetUrl, trustedRendererUrl)) event.preventDefault()
  }
  window.webContents.on('will-navigate', preventUntrustedNavigation)
  window.webContents.on('will-redirect', preventUntrustedNavigation)
  window.on('closed', () => {
    if (mainState.mainWindow === window) mainState.mainWindow = null
  })
  window.once('ready-to-show', () => window.show())
  return window
}

export async function loadRuntimeDataRecoveryWindow(window: BrowserWindow): Promise<void> {
  const devUrl = developmentRendererUrl()
  if (devUrl) {
    const target = new URL(devUrl)
    target.searchParams.set('runtimeMigrationRecovery', '1')
    await window.loadURL(target.toString())
    return
  }
  await window.loadFile(join(__dirname, '../renderer/index.html'), {
    query: { runtimeMigrationRecovery: '1' }
  })
}
