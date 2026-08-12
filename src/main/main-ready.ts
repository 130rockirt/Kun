import { app } from 'electron'
import { shouldStartHidden } from './desktop-behavior'
import { maybePromptCliInstall } from './cli-install-service'
import { managedKunHostCanAutoStart } from './managed-runtime-startup-policy'
import { kunRuntimeAdapter } from './runtime/kun-adapter'
import { configureLogger, logError, logInfo, pruneOnStartup, logWarn } from './logger'
import {
  gotSingleInstanceLock,
  mainState,
  traceStartup
} from './main-app-context'
import {
  loadGuiUpdaterModule
} from './main-lifecycle'
import {
  assertCanonicalRuntimeMigrationReady,
  shutdownActiveServiceManagerForUpdate
} from './main-migrations'
import {
  applyManagedRuntimeSettingsHot
} from './main-runtime-settings'
import {
  runtimeSupervisor
} from './main-runtime-health'
import {
  ensureRuntime,
  reconcileBundledRuntimeAfterInstall,
  restartRuntime
} from './main-runtime-startup'
import { createWindow } from './main-window'
import { MainWindowActivationCoordinator } from './main-window-activation'
import { initializeMainServices } from './main-ready-services'
import { registerMainIpc } from './main-ready-ipc'
import { revealMainWindow } from './main-tray'
import { resolveLogDirectory } from './main-paths'
import { showStartupFailureWindow } from './startup-failure-window'
import { sanitizeStartupFailureMessage } from './startup-failure-content'
import { resolveManagedRuntimeStartupTarget } from './runtime/managed-runtime-startup-attach'

export function startMainApp(): void {
  mainState.createWindow = createWindow
  mainState.ensureRuntime = ensureRuntime
  mainState.restartRuntime = restartRuntime
  mainState.assertCanonicalRuntimeMigrationReady = assertCanonicalRuntimeMigrationReady
  mainState.shutdownActiveServiceManagerForUpdate = shutdownActiveServiceManagerForUpdate

  try {
    mainState.logDir = resolveLogDirectory(app)
    configureLogger({ dir: mainState.logDir, enabled: true })
    logInfo('startup', 'Desktop startup entered.', {
      platform: process.platform,
      packaged: app.isPackaged
    })
  } catch (error) {
    console.warn('[kun-gui] failed to configure bootstrap startup logging:', error)
  }

  const activation = new MainWindowActivationCoordinator(
    () => mainState.mainWindow,
    revealMainWindow
  )
  app.on('second-instance', () => activation.requestReveal())

  app.whenReady().then(async () => {
    traceStartup('app.whenReady:start')
    if (!gotSingleInstanceLock) return

    const services = await initializeMainServices()
    if (!services) return
    const { initial } = services
    registerMainIpc(services)

    createWindow({
      suppressInitialShow: shouldStartHidden(initial),
      useSystemTitleBar: initial.appBehavior.useSystemTitleBar
    })
    activation.windowAvailable()
    void maybePromptCliInstall(() => mainState.mainWindow).catch((error) => {
      console.warn('[kun-gui] CLI install prompt failed:', error)
    })
    traceStartup('createWindow:returned')
    void loadGuiUpdaterModule()
      .then((module) => module.showPostUpdateReleaseNotes())
      .catch((error) => {
        console.warn('[kun-gui updater] failed to show post-update release notes:', error)
      })

    void pruneOnStartup().catch((err) => {
      console.warn('[kun-gui] prune logs:', err)
    })

    setTimeout(() => {
      void reconcileBundledRuntimeAfterInstall(initial)
        .then(() => resolveManagedRuntimeStartupTarget(
          initial,
          managedKunHostCanAutoStart(initial),
          {
            ensure: ensureRuntime,
            resolveExisting: (settings) => kunRuntimeAdapter.resolveConnection(settings)
          }
        ))
        .then((current) => {
          if (!current) return
          runtimeSupervisor.enqueueSettingsApply(async () => {
            const startupSettings = mainState.settledRuntimeSettings ?? current
            const applied = await applyManagedRuntimeSettingsHot(startupSettings, 'startup-settings')
            if (applied === 'restart_required') {
              logWarn(
                'startup-settings',
                'Kun attached successfully, but the configured default model could not be hot-applied.'
              )
            }
          }, (error) => {
            logWarn('startup-settings', 'Kun startup settings apply failed', {
              message: error instanceof Error ? error.message : String(error)
            })
          }, 'startup-settings')
        })
        .catch((err) => {
          console.warn('[kun-gui] failed to start, attach, or configure the shared Kun runtime:', err)
        })
    }, 1500)

    app.on('activate', () => {
      if (!mainState.mainWindow || mainState.mainWindow.isDestroyed()) createWindow()
      else revealMainWindow()
    })
  }).catch((error) => {
    const message = sanitizeStartupFailureMessage(error)
    console.error('[kun-gui] startup failed:', message)
    logError('startup', 'Desktop startup failed.', {
      platform: process.platform,
      packaged: app.isPackaged,
      message
    })
    const recoveryWindow = showStartupFailureWindow(error, mainState.logDir)
    if (recoveryWindow) {
      mainState.mainWindow = recoveryWindow
      recoveryWindow.on('closed', () => {
        if (mainState.mainWindow === recoveryWindow) mainState.mainWindow = null
      })
      activation.windowAvailable()
    }
  })
}
