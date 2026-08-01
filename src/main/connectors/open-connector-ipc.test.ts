import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import type { OpenConnectorAdminClient } from './open-connector-admin-client'
import type { OpenConnectorSidecar } from './open-connector-sidecar'
import {
  assertTrustedWorkbenchSender,
  isTrustedWorkbenchUrl,
  registerOpenConnectorIpc
} from './open-connector-ipc'

const TRUSTED_RENDERER_URL = 'file:///Applications/Kun/resources/app.asar/renderer/index.html'

describe('OpenConnector IPC boundary', () => {
  it('accepts only the current workbench main frame', () => {
    const { event, window } = trustedFixture()
    expect(() => assertTrustedWorkbenchSender(event, window, TRUSTED_RENDERER_URL)).not.toThrow()
    expect(() => assertTrustedWorkbenchSender({
      ...event,
      senderFrame: { processId: 4, routingId: 99, url: TRUSTED_RENDERER_URL } as never
    }, window, TRUSTED_RENDERER_URL)).toThrow('Untrusted connector IPC sender')
    expect(() => assertTrustedWorkbenchSender({
      ...event,
      senderFrame: { processId: 4, routingId: 7, url: 'https://attacker.example/' } as never
    }, window, TRUSTED_RENDERER_URL)).toThrow('Untrusted connector IPC sender')
    expect(() => assertTrustedWorkbenchSender(event, null, TRUSTED_RENDERER_URL))
      .toThrow('Untrusted connector IPC sender')
  })

  it('allows UI state changes but not another entry document or origin', () => {
    expect(isTrustedWorkbenchUrl(`${TRUSTED_RENDERER_URL}?route=connectors#box`, TRUSTED_RENDERER_URL))
      .toBe(true)
    expect(isTrustedWorkbenchUrl('file:///Applications/Kun/resources/app.asar/renderer/other.html', TRUSTED_RENDERER_URL))
      .toBe(false)
    expect(isTrustedWorkbenchUrl('https://attacker.example/index.html', TRUSTED_RENDERER_URL))
      .toBe(false)
  })

  it('registers fixed channels, validates payloads, and removes every handler', async () => {
    const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>()
    const removeHandler = vi.fn((channel: string) => handlers.delete(channel))
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (event: unknown, payload?: unknown) => unknown) => {
        handlers.set(channel, handler)
      }),
      removeHandler
    } as unknown as IpcMain
    const health = vi.fn(async () => ({ state: 'stopped' }))
    const provider = vi.fn(async (service: string) => ({ service }))
    const cancelOAuth = vi.fn(async (input: unknown) => input)
    const startDeviceRegistration = vi.fn(async (input: unknown) => input)
    const openSetupHelp = vi.fn(async (service: string) => ({ opened: true, host: service }))
    const setDefault = vi.fn(async (input: unknown) => input)
    const sidecar = { health, start: health, stop: health } as unknown as OpenConnectorSidecar
    const client = new Proxy({ provider, cancelOAuth, setDefault, startDeviceRegistration, openSetupHelp }, {
      get(target, property) {
        if (property in target) return target[property as keyof typeof target]
        return vi.fn(async () => ({}))
      }
    }) as unknown as OpenConnectorAdminClient
    const { event, window } = trustedFixture()

    const dispose = registerOpenConnectorIpc({
      ipcMain,
      getMainWindow: () => window,
      getTrustedRendererUrl: () => TRUSTED_RENDERER_URL,
      getPort: () => 18_898,
      sidecar,
      client
    })

    expect(handlers.size).toBe(24)
    await expect(handlers.get('connectors:health')!(event)).resolves.toEqual({ state: 'stopped' })
    await expect(Promise.resolve().then(() =>
      handlers.get('connectors:provider')!(event, { service: '../secret' })
    )).rejects.toThrow()
    expect(provider).not.toHaveBeenCalled()
    await expect(handlers.get('connectors:provider')!(event, { service: 'gmail' })).resolves.toEqual({ service: 'gmail' })
    const cancelInput = { service: 'gmail', connectionName: 'work', state: 'state-1' }
    await expect(handlers.get('connectors:oauth:cancel')!(event, cancelInput)).resolves.toEqual(cancelInput)
    expect(cancelOAuth).toHaveBeenCalledWith(cancelInput)
    const defaultInput = { service: 'gmail', connectionName: 'work' }
    await expect(handlers.get('connectors:set-default')!(event, defaultInput)).resolves.toEqual(defaultInput)
    expect(setDefault).toHaveBeenCalledWith(defaultInput)
    const registrationInput = { service: 'feishu', connectionName: 'work' }
    await expect(handlers.get('connectors:device-registration:start')!(event, registrationInput))
      .resolves.toEqual(registrationInput)
    expect(startDeviceRegistration).toHaveBeenCalledWith(registrationInput)
    await expect(Promise.resolve().then(() => handlers.get('connectors:device-registration:poll')!(
      event,
      { flowId: '../secret' }
    ))).rejects.toThrow()
    await expect(handlers.get('connectors:setup-help')!(event, { service: 'qq_mail' }))
      .resolves.toEqual({ opened: true, host: 'qq_mail' })
    expect(openSetupHelp).toHaveBeenCalledWith('qq_mail')

    dispose()
    expect(removeHandler).toHaveBeenCalledTimes(24)
    expect(handlers.size).toBe(0)
  })
})

function trustedFixture(): {
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>
  window: BrowserWindow
} {
  const mainFrame = { processId: 4, routingId: 7, url: TRUSTED_RENDERER_URL }
  const webContents = { mainFrame }
  const window = {
    isDestroyed: () => false,
    webContents
  } as unknown as BrowserWindow
  return {
    event: { sender: webContents, senderFrame: mainFrame } as unknown as Pick<
      IpcMainInvokeEvent,
      'sender' | 'senderFrame'
    >,
    window
  }
}
