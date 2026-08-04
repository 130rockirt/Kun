import { beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'

const setName = vi.fn()
const setAppUserModelId = vi.fn()
const getPath = vi.fn(() => '/profiles')
const setPath = vi.fn()

vi.mock('electron', () => ({
  app: {
    setName,
    setAppUserModelId,
    getPath,
    setPath
  }
}))

describe('app identity bootstrap', () => {
  beforeEach(() => {
    setName.mockReset()
    setAppUserModelId.mockReset()
    getPath.mockClear()
    setPath.mockReset()
    vi.resetModules()
  })

  it('calls app.setName with the project productName', async () => {
    const { configureAppIdentity, APP_PRODUCT_NAME } = await import('./app-identity')
    configureAppIdentity()
    expect(setName).toHaveBeenCalledTimes(1)
    expect(setName).toHaveBeenCalledWith(APP_PRODUCT_NAME)
    expect(APP_PRODUCT_NAME).toBe('Kun')
    expect(setPath).not.toHaveBeenCalled()
  })

  it('uses a separate kun-dv identity and profile', async () => {
    const { configureAppIdentity } = await import('./app-identity')
    const identity = configureAppIdentity({ flavor: 'development', appDataPath: '/app-data' })
    expect(identity).toEqual({
      flavor: 'development',
      appName: 'kun-dv',
      appId: 'com.xingyuzhong.deepseekgui.dv',
      runtimeFlavor: 'development'
    })
    expect(setName).toHaveBeenCalledWith('kun-dv')
    expect(setPath).toHaveBeenCalledWith('userData', join('/app-data', 'kun-dv'))
  })

  it('does not call app.setAppUserModelId (caller responsibility on win32)', async () => {
    // setAppUserModelId 仍然由 main/index.ts 里的 win32 分支调用,
    // 这里只验证 configureAppIdentity 自己不重复设置。
    const { configureAppIdentity } = await import('./app-identity')
    configureAppIdentity()
    expect(setAppUserModelId).not.toHaveBeenCalled()
  })

  it('pins appData to the existing isolated desktop smoke directory', async () => {
    const { configureDesktopSmokeAppDataPath } = await import('./app-identity')
    expect(configureDesktopSmokeAppDataPath({
      KUN_PACKAGED_EXTENSION_DESKTOP_SMOKE: '1',
      APPDATA: ' C:\\smoke\\app-data '
    })).toBe('C:\\smoke\\app-data')
    expect(setPath).toHaveBeenCalledWith('appData', 'C:\\smoke\\app-data')
    expect(getPath).not.toHaveBeenCalled()
  })

  it('leaves appData untouched outside isolated desktop smoke launches', async () => {
    const { configureDesktopSmokeAppDataPath } = await import('./app-identity')
    expect(configureDesktopSmokeAppDataPath({ APPDATA: 'C:\\ordinary\\app-data' })).toBeUndefined()
    expect(setPath).not.toHaveBeenCalled()
  })

  it('fails closed when an isolated desktop smoke omits APPDATA', async () => {
    const { configureDesktopSmokeAppDataPath } = await import('./app-identity')
    expect(() => configureDesktopSmokeAppDataPath({
      KUN_PACKAGED_EXTENSION_DESKTOP_SMOKE: '1'
    })).toThrow('requires an APPDATA path')
    expect(setPath).not.toHaveBeenCalled()
  })
})
