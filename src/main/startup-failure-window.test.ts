import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  parseStartupFailureAction,
  sanitizeStartupFailureMessage,
  startupFailureHtml
} from './startup-failure-content'

const electron = vi.hoisted(() => {
  const webHandlers = new Map<string, (...args: unknown[]) => void>()
  const windowHandlers = new Map<string, (...args: unknown[]) => void>()
  const window = {
    webContents: {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn((name: string, handler: (...args: unknown[]) => void) => {
        webHandlers.set(name, handler)
      })
    },
    once: vi.fn((name: string, handler: (...args: unknown[]) => void) => {
      windowHandlers.set(name, handler)
    }),
    loadURL: vi.fn().mockResolvedValue(undefined),
    isDestroyed: vi.fn(() => false),
    show: vi.fn()
  }
  return {
    app: {
      isPackaged: true,
      relaunch: vi.fn(),
      quit: vi.fn()
    },
    BrowserWindow: vi.fn(function MockBrowserWindow() {
      return window
    }),
    dialog: { showErrorBox: vi.fn() },
    shell: { openPath: vi.fn().mockResolvedValue('') },
    webHandlers,
    windowHandlers,
    window
  }
})

vi.mock('electron', () => ({
  app: electron.app,
  BrowserWindow: electron.BrowserWindow,
  dialog: electron.dialog,
  shell: electron.shell
}))

vi.mock('./main-app-context', () => ({
  appIcon: { isEmpty: () => true }
}))

vi.mock('./logger', () => ({
  logError: vi.fn(),
  logWarn: vi.fn()
}))

import { showStartupFailureWindow } from './startup-failure-window'

beforeEach(() => {
  vi.clearAllMocks()
  electron.webHandlers.clear()
  electron.windowHandlers.clear()
  electron.window.loadURL.mockResolvedValue(undefined)
  electron.window.isDestroyed.mockReturnValue(false)
  electron.shell.openPath.mockResolvedValue('')
})

describe('startup failure recovery helpers', () => {
  it('redacts credentials and OAuth secrets from startup diagnostics', () => {
    const message = sanitizeStartupFailureMessage(
      'failed https://user:pass@proxy.test/?access_token=secret Bearer abc.def '
      + '{"refresh_token":"hidden"}'
    )

    expect(message).not.toContain('user:pass')
    expect(message).not.toContain('secret')
    expect(message).not.toContain('abc.def')
    expect(message).not.toContain('hidden')
    expect(message).toContain('[redacted]')
  })

  it('escapes diagnostic content before rendering static recovery HTML', () => {
    const html = startupFailureHtml('<script>alert(1)</script>', 'C:\\Users\\<name>')

    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('C:\\Users\\&lt;name&gt;')
  })

  it('accepts only known recovery actions', () => {
    expect(parseStartupFailureAction('kun-startup-action:retry')).toBe('retry')
    expect(parseStartupFailureAction('kun-startup-action:open-logs')).toBe('open-logs')
    expect(parseStartupFailureAction('kun-startup-action:quit')).toBe('quit')
    expect(parseStartupFailureAction('kun-startup-action:erase-data')).toBeNull()
    expect(parseStartupFailureAction('https://example.test')).toBeNull()
  })
})

describe('showStartupFailureWindow', () => {
  it('keeps a real recovery window alive without automatically quitting', () => {
    const window = showStartupFailureWindow(new Error('manager failed'), 'C:\\Kun\\logs')

    expect(window).toBe(electron.window)
    expect(electron.BrowserWindow).toHaveBeenCalledOnce()
    expect(electron.window.loadURL).toHaveBeenCalledWith(expect.stringMatching(/^data:text\/html/))
    expect(electron.app.quit).not.toHaveBeenCalled()

    electron.windowHandlers.get('ready-to-show')?.()
    expect(electron.window.show).toHaveBeenCalledOnce()
  })

  it('runs only an explicit recovery action from intercepted navigation', async () => {
    showStartupFailureWindow(new Error('manager failed'), 'C:\\Kun\\logs')
    const preventDefault = vi.fn()
    const navigate = electron.webHandlers.get('will-navigate')

    navigate?.({ preventDefault }, 'kun-startup-action:open-logs')
    await Promise.resolve()
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(electron.shell.openPath).toHaveBeenCalledWith('C:\\Kun\\logs')
    expect(electron.app.quit).not.toHaveBeenCalled()

    navigate?.({ preventDefault }, 'kun-startup-action:retry')
    expect(electron.app.relaunch).toHaveBeenCalledOnce()
    expect(electron.app.quit).toHaveBeenCalledOnce()
  })
})
