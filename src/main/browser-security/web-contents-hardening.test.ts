import { describe, expect, it, vi } from 'vitest'
import {
  hardenRemoteSession,
  hardenedRemoteWebPreferences
} from './web-contents-hardening'

describe('hardenedRemoteWebPreferences', () => {
  it('keeps remote pages outside Node and Electron authority', () => {
    expect(hardenedRemoteWebPreferences('temp:isolated')).toMatchObject({
      partition: 'temp:isolated',
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      disableDialogs: true
    })
  })
})

describe('hardenRemoteSession', () => {
  it('denies permissions, devices, and downloads', () => {
    let downloadHandler: ((event: { preventDefault: () => void }) => void) | undefined
    const session = {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setDevicePermissionHandler: vi.fn(),
      on: vi.fn((_event, callback) => {
        downloadHandler = callback
      })
    }
    hardenRemoteSession(session as never)

    const decision = vi.fn()
    session.setPermissionRequestHandler.mock.calls[0]?.[0]({}, 'camera', decision)
    const preventDefault = vi.fn()
    downloadHandler?.({ preventDefault })

    expect(session.setPermissionCheckHandler.mock.calls[0]?.[0]()).toBe(false)
    expect(session.setDevicePermissionHandler.mock.calls[0]?.[0]()).toBe(false)
    expect(decision).toHaveBeenCalledWith(false)
    expect(preventDefault).toHaveBeenCalledOnce()
  })
})
