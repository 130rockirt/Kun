import { app, BrowserWindow, dialog, shell } from 'electron'
import { appIcon } from './main-app-context'
import { logError, logWarn } from './logger'
import {
  parseStartupFailureAction,
  sanitizeStartupFailureMessage,
  startupFailureHtml
} from './startup-failure-content'

export function showStartupFailureWindow(error: unknown, logDir: string): BrowserWindow | null {
  const message = sanitizeStartupFailureMessage(error)
  logError('startup', 'Kun failed before main-window creation.', {
    platform: process.platform,
    packaged: app.isPackaged,
    message
  })

  try {
    const window = new BrowserWindow({
      width: 760,
      height: 560,
      minWidth: 620,
      minHeight: 460,
      title: 'Kun startup recovery',
      icon: appIcon.isEmpty() ? undefined : appIcon,
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        webviewTag: false
      }
    })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event, targetUrl) => {
      const action = parseStartupFailureAction(targetUrl)
      if (!action) {
        event.preventDefault()
        return
      }
      event.preventDefault()
      if (action === 'retry') {
        app.relaunch()
        app.quit()
      } else if (action === 'quit') {
        app.quit()
      } else {
        void shell.openPath(logDir).then((openError) => {
          if (!openError) return
          logWarn('startup', 'Failed to open startup log directory.', { message: openError })
          dialog.showErrorBox('Could not open log folder', openError)
        })
      }
    })
    window.once('ready-to-show', () => window.show())
    void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(startupFailureHtml(message, logDir))}`)
      .catch((loadError) => {
        logError('startup', 'Failed to render startup recovery window.', {
          message: sanitizeStartupFailureMessage(loadError)
        })
        if (!window.isDestroyed()) window.show()
        dialog.showErrorBox('Kun failed to start', message)
      })
    return window
  } catch (fallbackError) {
    logError('startup', 'Failed to create startup recovery window.', {
      message: sanitizeStartupFailureMessage(fallbackError)
    })
    dialog.showErrorBox('Kun failed to start', message)
    return null
  }
}
