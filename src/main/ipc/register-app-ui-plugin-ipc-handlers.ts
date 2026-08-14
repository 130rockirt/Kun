import {
  dialog,
  ipcMain
} from 'electron'
import {
  homedir
} from 'node:os'
import {
  join,
  resolve
} from 'node:path'
import {
  uiPluginIdPayloadSchema
} from './app-ipc-schemas'
import {
  installUiPluginFromDirectory,
  listUiPlugins,
  loadUiPluginFigures,
  removeUiPlugin
} from '../services/ui-plugin-service'
import {
  UiPluginCdpThemeController
} from '../services/ui-plugin-cdp-theme-controller'
import {
  buildUiPluginBackgroundCss,
  buildUiPluginPresentationCss,
  buildUiPluginSceneCss,
  buildUiPluginTokenCss
} from '../../shared/ui-plugin'
import {
  ensureBundledUiPlugins
} from '../ui-plugin-bundled'
import type { RegisterAppIpcHandlersOptions } from './app-ipc-handler-options'
import { assertTrustedWorkbenchSender, parseIpcPayload } from './app-ipc-handler-utils'

export function registerAppUiPluginIpcHandlers(options: RegisterAppIpcHandlersOptions): void {
  const { getMainWindow, logError } = options
  const uiPluginThemeController = new UiPluginCdpThemeController({
    getWebContents: () => {
      const window = getMainWindow()
      return window && !window.isDestroyed() ? window.webContents : null
    },
    onBackgroundError: (scope, error) => {
      logError('ui-plugin-cdp', `UI plugin CDP theme ${scope} failed`, {
        message: error instanceof Error ? error.message : String(error)
      })
    }
  })
  let uiPluginOperationQueue: Promise<void> = Promise.resolve()
  const enqueueUiPluginOperation = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = uiPluginOperationQueue.then(operation, operation)
    uiPluginOperationQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
  ipcMain.handle('ui-plugin:list', async (event) => {
    assertTrustedWorkbenchSender(event, getMainWindow)
    const kunHomeDir = join(homedir(), '.kun')
    await ensureBundledUiPlugins(kunHomeDir)
    return { plugins: await listUiPlugins(kunHomeDir) }
  })

  ipcMain.handle('ui-plugin:install', async (event) => {
    assertTrustedWorkbenchSender(event, getMainWindow)
    const mainWindow = getMainWindow()
    const options: Electron.OpenDialogOptions = {
      title: 'Select a UI plugin folder',
      properties: ['openDirectory', 'dontAddToRecent']
    }
    const picked = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    const sourceDir = picked.filePaths[0]
    if (picked.canceled || !sourceDir) {
      return { canceled: true as const }
    }
    const result = await enqueueUiPluginOperation(() =>
      installUiPluginFromDirectory(join(homedir(), '.kun'), sourceDir)
    )
    if (!result.ok) {
      return { canceled: false as const, ok: false as const, errors: result.errors }
    }
    return { canceled: false as const, ok: true as const, plugin: result.plugin }
  })

  ipcMain.handle('ui-plugin:remove', async (event, payload: unknown) => {
    assertTrustedWorkbenchSender(event, getMainWindow)
    const request = parseIpcPayload('ui-plugin:remove', uiPluginIdPayloadSchema, payload)
    return enqueueUiPluginOperation(async () => {
      if (uiPluginThemeController.activePluginId === request.id) {
        try {
          await uiPluginThemeController.deactivate()
        } catch (error) {
          logError('ui-plugin-cdp', 'Could not deactivate the UI plugin before removal', {
            pluginId: request.id,
            message: error instanceof Error ? error.message : String(error)
          })
          return { ok: false }
        }
      }
      return { ok: await removeUiPlugin(join(homedir(), '.kun'), request.id) }
    })
  })

  ipcMain.handle('ui-plugin:load', async (event, payload: unknown) => {
    assertTrustedWorkbenchSender(event, getMainWindow)
    const request = parseIpcPayload('ui-plugin:load', uiPluginIdPayloadSchema, payload)
    const kunHomeDir = join(homedir(), '.kun')
    await ensureBundledUiPlugins(kunHomeDir)
    return loadUiPluginFigures(kunHomeDir, request.id)
  })

  ipcMain.handle('ui-plugin:theme:activate', async (event, payload: unknown) => {
    assertTrustedWorkbenchSender(event, getMainWindow)
    const request = parseIpcPayload(
      'ui-plugin:theme:activate',
      uiPluginIdPayloadSchema,
      payload
    )
    return enqueueUiPluginOperation(async () => {
      const kunHomeDir = join(homedir(), '.kun')
      await ensureBundledUiPlugins(kunHomeDir)
      const loaded = await loadUiPluginFigures(kunHomeDir, request.id)
      if (!loaded.ok) return { ok: false as const, error: loaded.error }

      // Only normalized manifest fields and main-validated image data reach the
      // CSS builders. The renderer cannot supply CSS or executable payloads.
      const css = [
        buildUiPluginTokenCss(loaded.manifest),
        buildUiPluginPresentationCss(loaded.manifest),
        buildUiPluginSceneCss(loaded.manifest),
        buildUiPluginBackgroundCss(loaded.manifest, loaded.backgrounds)
      ]
        .filter(Boolean)
        .join('\n\n')
      try {
        await uiPluginThemeController.activate(loaded.manifest.id, css)
        return {
          ok: true as const,
          manifest: loaded.manifest,
          figures: loaded.figures,
          sceneAssets: loaded.sceneAssets
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logError('ui-plugin-cdp', 'Could not activate a UI plugin theme', {
          pluginId: loaded.manifest.id,
          message
        })
        return { ok: false as const, error: message }
      }
    })
  })

  ipcMain.handle('ui-plugin:theme:deactivate', async (event) => {
    assertTrustedWorkbenchSender(event, getMainWindow)
    return enqueueUiPluginOperation(async () => {
      try {
        await uiPluginThemeController.deactivate()
        return { ok: true as const }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logError('ui-plugin-cdp', 'Could not deactivate the UI plugin theme', { message })
        return { ok: false as const, error: message }
      }
    })
  })

}
