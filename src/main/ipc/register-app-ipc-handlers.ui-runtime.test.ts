import {
  cleanupAppIpcHandlerTestState,
  getAppIpcElectronMock,
  getTelegramMocks,
  getUiPluginMocks,
  handlers,
  registerOptions,
  resetAppIpcHandlerTestState,
  settings
} from './register-app-ipc-handlers.test-support'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import {
  tmpdir
} from 'node:os'
import {
  join
} from 'node:path'
import {
  registerAppIpcHandlers
} from './register-app-ipc-handlers'

const electronMock = getAppIpcElectronMock()
const telegramMocks = getTelegramMocks()
const uiPluginMocks = getUiPluginMocks()

describe('registerAppIpcHandlers UI plugins and runtime', () => {
  beforeEach(resetAppIpcHandlerTestState)
  afterEach(cleanupAppIpcHandlerTestState)

  it('rejects every UI plugin bridge outside the trusted top-level workbench frame', async () => {
    const mainFrame = { processId: 10, routingId: 20 }
    const contents = { id: 7, mainFrame }
    const mainWindow = { isDestroyed: () => false, webContents: contents }
    registerAppIpcHandlers(registerOptions({ getMainWindow: () => mainWindow as never }))
    const untrustedEvent = {
      sender: contents,
      senderFrame: { processId: 10, routingId: 21 }
    }

    for (const [channel, payload] of [
      ['ui-plugin:list', undefined],
      ['ui-plugin:install', undefined],
      ['ui-plugin:remove', { id: 'starlight' }],
      ['ui-plugin:load', { id: 'starlight' }],
      ['ui-plugin:theme:activate', { id: 'starlight' }],
      ['ui-plugin:theme:deactivate', undefined]
    ] as const) {
      await expect(handlers.get(channel)?.(untrustedEvent, payload)).rejects.toThrow(
        /trusted workbench frame/
      )
    }
  })

  it('builds presentation variables in Main before activating the fixed CDP stylesheet', async () => {
    const mainFrame = { processId: 10, routingId: 20 }
    const contents = { id: 7, mainFrame }
    const mainWindow = { isDestroyed: () => false, webContents: contents }
    uiPluginMocks.loadUiPluginFigures.mockResolvedValueOnce({
      ok: true,
      manifest: {
        id: 'portrait-theme',
        name: 'Portrait theme',
        version: '1.0.0',
        figures: { portrait: 'img/portrait.png' },
        presentation: {
          character: {
            anchor: 'right',
            size: 'hero',
            offsetX: 4,
            offsetY: -2,
            opacity: 0.93,
            frame: 'crystal',
            motion: 'float',
            contentReserve: 'wide'
          },
          readability: { scrim: 'opposite-character', strength: 'medium' },
          surfaces: {
            sidebar: 'glass',
            topbar: 'translucent',
            composer: 'strong-glass',
            cards: 'glass'
          }
        }
      },
      figures: { portrait: 'data:image/png;base64,AAAA' },
      backgrounds: {},
      sceneAssets: {}
    })
    registerAppIpcHandlers(registerOptions({ getMainWindow: () => mainWindow as never }))

    const response = await handlers.get('ui-plugin:theme:activate')?.(
      { sender: contents, senderFrame: mainFrame },
      { id: 'portrait-theme' }
    )

    expect(response).toMatchObject({
      ok: true,
      manifest: { id: 'portrait-theme' },
      figures: { portrait: 'data:image/png;base64,AAAA' }
    })
    expect(uiPluginMocks.ensureBundledUiPlugins).toHaveBeenCalledOnce()
    expect(uiPluginMocks.activate).toHaveBeenCalledOnce()
    const [pluginId, css] = uiPluginMocks.activate.mock.calls[0] ?? []
    expect(pluginId).toBe('portrait-theme')
    expect(css).toContain("html[data-ui-plugin='portrait-theme']")
    expect(css).toContain('--kun-ui-plugin-character-offset-x: 4%;')
    expect(css).toContain('--kun-ui-plugin-character-offset-y: -2%;')
    expect(css).toContain('--kun-ui-plugin-character-opacity: 0.93;')
    expect(css).not.toContain('crystal')
    expect(css).not.toContain('opposite-character')
  })

  it('returns validated scene assets while CDP receives only host numeric scene variables', async () => {
    const mainFrame = { processId: 10, routingId: 20 }
    const contents = { id: 7, mainFrame }
    const mainWindow = { isDestroyed: () => false, webContents: contents }
    const presentation = {
      character: {
        anchor: 'right',
        size: 'large',
        offsetX: 0,
        offsetY: 0,
        opacity: 1,
        frame: 'soft-card',
        motion: 'none',
        contentReserve: 'wide'
      },
      readability: { scrim: 'opposite-character', strength: 'medium' },
      surfaces: {
        sidebar: 'glass',
        topbar: 'glass',
        composer: 'strong-glass',
        cards: 'translucent'
      }
    }
    uiPluginMocks.loadUiPluginFigures.mockResolvedValueOnce({
      ok: true,
      manifest: {
        id: 'scene-theme',
        name: 'Scene theme',
        version: '1.0.0',
        figures: { portrait: 'img/portrait.png' },
        presentation,
        scene: {
          apiVersion: '1.6',
          layout: 'rail-left',
          character: {
            scale: 'hero',
            fit: 'contain',
            focalPoint: 'bottom',
            mask: 'arch',
            offsetX: 3,
            offsetY: -2,
            opacity: 0.96,
            flipX: false,
            motion: { preset: 'sway', speed: 'slow', phase: 'b' }
          },
          artwork: {
            frame: {
              path: 'scene/frame.png',
              anchor: 'center',
              size: 'large',
              fit: 'contain',
              offsetX: 1,
              offsetY: -1,
              opacity: 1,
              blend: 'normal',
              motion: { preset: 'none', speed: 'normal', phase: 'a' }
            }
          },
          chrome: {
            sidebar: 'paper',
            topbar: 'editorial',
            composer: 'hologram',
            cards: 'ticket'
          }
        }
      },
      figures: { portrait: 'data:image/png;base64,AAAA' },
      backgrounds: {},
      sceneAssets: { assets: { 'scene/frame.png': 'data:image/png;base64,AQID' } }
    })
    registerAppIpcHandlers(registerOptions({ getMainWindow: () => mainWindow as never }))

    const response = await handlers.get('ui-plugin:theme:activate')?.(
      { sender: contents, senderFrame: mainFrame },
      { id: 'scene-theme' }
    )

    expect(response).toMatchObject({
      ok: true,
      manifest: { id: 'scene-theme', scene: { layout: 'rail-left' } },
      sceneAssets: { assets: { 'scene/frame.png': 'data:image/png;base64,AQID' } }
    })
    const [, css] = uiPluginMocks.activate.mock.calls[0] ?? []
    expect(css).toContain('--kun-ui-plugin-scene-character-offset-x: 3%;')
    expect(css).toContain('--kun-ui-plugin-scene-character-offset-y: -2%;')
    expect(css).toContain('--kun-ui-plugin-scene-frame-offset-x: 1%;')
    expect(css).not.toContain('scene/frame.png')
    expect(css).not.toContain('rail-left')
    expect(css).not.toContain('sway')
  })

  it('accepts checkpoint cleanup settings patches', async () => {
    const applySettingsPatch = vi.fn(async () => settings())

    registerAppIpcHandlers(registerOptions({ applySettingsPatch }))

    const payload = {
      checkpointCleanup: {
        intervalDays: 5
      }
    }
    const handler = handlers.get('settings:set')
    await expect(handler?.({}, payload)).resolves.toEqual(settings())
    expect(applySettingsPatch).toHaveBeenCalledWith(payload)
  })

  it('rejects unsupported checkpoint cleanup intervals', async () => {
    const applySettingsPatch = vi.fn(async () => settings())

    registerAppIpcHandlers(registerOptions({ applySettingsPatch }))

    const handler = handlers.get('settings:set')
    await expect(
      handler?.({}, { checkpointCleanup: { intervalDays: 4 } })
    ).rejects.toThrow(/Invalid payload for settings:set/)
    expect(applySettingsPatch).not.toHaveBeenCalled()
  })

  it('accepts telegram phone connection settings patches', async () => {
    const applySettingsPatch = vi.fn(async () => settings())

    registerAppIpcHandlers(registerOptions({ applySettingsPatch }))

    const payload = {
      claw: {
        enabled: true,
        im: { enabled: true, workspaceRoot: '' },
        channels: [{
          id: 'telegram_1',
          provider: 'telegram' as const,
          label: 'telegram agent',
          enabled: true,
          model: 'auto',
          threadId: '',
          workspaceRoot: '',
          agentProfile: {
            name: 'telegram agent',
            description: '',
            identity: '',
            personality: '',
            userContext: '',
            replyRules: ''
          },
          platformCredential: {
            kind: 'telegram' as const,
            botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi',
            allowedChatIds: '123456789',
            botUsername: 'kun_test_bot',
            proxy: { enabled: true, url: 'socks5://127.0.0.1:1080' },
            createdAt: '2026-06-19T00:00:00.000Z'
          },
          conversations: [],
          createdAt: '2026-06-19T00:00:00.000Z',
          updatedAt: '2026-06-19T00:00:00.000Z'
        }]
      }
    }

    const handler = handlers.get('settings:set')
    await expect(handler?.({}, payload)).resolves.toEqual(settings())
    expect(applySettingsPatch).toHaveBeenCalledWith(payload)
  })

  it('passes Telegram proxy settings through the token verification IPC boundary', async () => {
    registerAppIpcHandlers(registerOptions())
    const payload = {
      botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi',
      allowedChatIds: '123456789',
      proxy: { enabled: true, url: 'socks5://user:pass@127.0.0.1:1080' }
    }

    await expect(handlers.get('claw:im-install:telegram-token')?.({}, payload)).resolves.toMatchObject({
      ok: true,
      botUsername: 'kun_test_bot'
    })
    expect(telegramMocks.verifyTelegramBotToken).toHaveBeenCalledWith(payload.botToken, payload.proxy)
  })

  it('rejects oversized Telegram proxy URLs before token verification', async () => {
    registerAppIpcHandlers(registerOptions())

    await expect(handlers.get('claw:im-install:telegram-token')?.({}, {
      botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi',
      proxy: { enabled: true, url: `socks5://${'a'.repeat(5_000)}` }
    })).rejects.toThrow(/Invalid payload for claw:im-install:telegram-token/)
    expect(telegramMocks.verifyTelegramBotToken).not.toHaveBeenCalled()
  })

  it('restarts the managed runtime through the restart IPC handler', async () => {
    const restartRuntime = vi.fn(async () => undefined)

    registerAppIpcHandlers(registerOptions({ restartRuntime }))

    await expect(handlers.get('runtime:restart')?.({})).resolves.toBeUndefined()
    expect(restartRuntime).toHaveBeenCalledTimes(1)
  })

  it('restarts Kun after an already-downloaded Claude SDK is provisioned through IPC', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'kun-agent-sdk-ipc-'))
    const binaryName = process.platform === 'win32' ? 'claude.exe' : 'claude'
    const binaryPath = join(userDataDir, 'agent-sdk', binaryName)
    const restartRuntime = vi.fn(async () => undefined)
    electronMock.userDataPath = userDataDir
    mkdirSync(join(userDataDir, 'agent-sdk'), { recursive: true })
    writeFileSync(binaryPath, 'claude binary')

    try {
      registerAppIpcHandlers(registerOptions({ restartRuntime }))

      await expect(handlers.get('claude-subscription:sdk-install')?.({})).resolves.toMatchObject({
        status: 'restarting'
      })
      await Promise.resolve()
      await Promise.resolve()
      expect(restartRuntime).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(userDataDir, { recursive: true, force: true })
    }
  })

  it('returns the current Runtime settings synchronization status', async () => {
    registerAppIpcHandlers(registerOptions({
      getRuntimeSettingsSyncStatus: () => ({
        state: 'failed',
        generation: 7,
        message: 'hot apply failed',
        at: '2026-07-22T08:00:00.000Z'
      })
    }))

    expect(handlers.get('runtime:settings-sync-status:get')?.({})).toEqual({
      state: 'failed',
      generation: 7,
      message: 'hot apply failed',
      at: '2026-07-22T08:00:00.000Z'
    })
  })

})
