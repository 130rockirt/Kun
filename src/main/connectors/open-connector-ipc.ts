import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import {
  OpenConnectorActionInputSchema,
  OpenConnectorConnectInputSchema,
  OpenConnectorDeviceRegistrationPollInputSchema,
  OpenConnectorDeviceRegistrationStartInputSchema,
  OpenConnectorDisconnectInputSchema,
  OpenConnectorOAuthCancelInputSchema,
  OpenConnectorOAuthConfigInputSchema,
  OpenConnectorOAuthPollInputSchema,
  OpenConnectorOAuthStartInputSchema,
  OpenConnectorPolicyUpdateInputSchema,
  OpenConnectorRunInputSchema,
  OpenConnectorRunQuerySchema,
  OpenConnectorServiceInputSchema
} from '../../shared/open-connector'
import type { OpenConnectorAdminClient } from './open-connector-admin-client'
import type { OpenConnectorSidecar } from './open-connector-sidecar'

const CHANNELS = [
  'connectors:health',
  'connectors:start',
  'connectors:stop',
  'connectors:catalog',
  'connectors:provider',
  'connectors:action',
  'connectors:connections',
  'connectors:connect',
  'connectors:disconnect',
  'connectors:set-default',
  'connectors:oauth-configs',
  'connectors:oauth-config:save',
  'connectors:oauth-config:delete',
  'connectors:oauth:start',
  'connectors:oauth:poll',
  'connectors:oauth:cancel',
  'connectors:device-registration:start',
  'connectors:device-registration:poll',
  'connectors:device-registration:cancel',
  'connectors:setup-help',
  'connectors:policy',
  'connectors:policy:update',
  'connectors:runs',
  'connectors:run'
] as const

export function registerOpenConnectorIpc(options: {
  ipcMain: IpcMain
  getMainWindow: () => BrowserWindow | null
  getTrustedRendererUrl: () => string
  getPort: () => number
  sidecar: OpenConnectorSidecar
  client: OpenConnectorAdminClient
}): () => void {
  const { ipcMain, sidecar, client } = options
  const handle = (
    channel: typeof CHANNELS[number],
    handler: (payload: unknown) => unknown | Promise<unknown>
  ): void => {
    ipcMain.handle(channel, (event, payload) => {
      assertTrustedWorkbenchSender(event, options.getMainWindow(), options.getTrustedRendererUrl())
      return handler(payload)
    })
  }

  handle('connectors:health', () => sidecar.health())
  handle('connectors:start', () => sidecar.start(options.getPort()))
  handle('connectors:stop', () => sidecar.stop())
  handle('connectors:catalog', () => client.catalog())
  handle('connectors:provider', (payload) =>
    client.provider(OpenConnectorServiceInputSchema.parse(payload).service))
  handle('connectors:action', (payload) =>
    client.action(OpenConnectorActionInputSchema.parse(payload).actionId))
  handle('connectors:connections', () => client.connections())
  handle('connectors:connect', (payload) =>
    client.connect(OpenConnectorConnectInputSchema.parse(payload)))
  handle('connectors:disconnect', (payload) =>
    client.disconnect(OpenConnectorDisconnectInputSchema.parse(payload)))
  handle('connectors:set-default', (payload) =>
    client.setDefault(OpenConnectorDisconnectInputSchema.parse(payload)))
  handle('connectors:oauth-configs', () => client.oauthConfigs())
  handle('connectors:oauth-config:save', (payload) =>
    client.saveOAuthConfig(OpenConnectorOAuthConfigInputSchema.parse(payload)))
  handle('connectors:oauth-config:delete', (payload) =>
    client.deleteOAuthConfig(OpenConnectorServiceInputSchema.parse(payload).service))
  handle('connectors:oauth:start', (payload) =>
    client.startOAuth(OpenConnectorOAuthStartInputSchema.parse(payload)))
  handle('connectors:oauth:poll', (payload) =>
    client.pollOAuth(OpenConnectorOAuthPollInputSchema.parse(payload)))
  handle('connectors:oauth:cancel', (payload) =>
    client.cancelOAuth(OpenConnectorOAuthCancelInputSchema.parse(payload)))
  handle('connectors:device-registration:start', (payload) =>
    client.startDeviceRegistration(OpenConnectorDeviceRegistrationStartInputSchema.parse(payload)))
  handle('connectors:device-registration:poll', (payload) =>
    client.pollDeviceRegistration(OpenConnectorDeviceRegistrationPollInputSchema.parse(payload)))
  handle('connectors:device-registration:cancel', (payload) =>
    client.cancelDeviceRegistration(OpenConnectorDeviceRegistrationPollInputSchema.parse(payload)))
  handle('connectors:setup-help', (payload) =>
    client.openSetupHelp(OpenConnectorServiceInputSchema.parse(payload).service))
  handle('connectors:policy', () => client.policy())
  handle('connectors:policy:update', (payload) =>
    client.updatePolicy(OpenConnectorPolicyUpdateInputSchema.parse(payload)))
  handle('connectors:runs', (payload) =>
    client.runs(OpenConnectorRunQuerySchema.parse(payload ?? {})))
  handle('connectors:run', (payload) =>
    client.run(OpenConnectorRunInputSchema.parse(payload).id))

  return () => {
    for (const channel of CHANNELS) ipcMain.removeHandler(channel)
  }
}

export function assertTrustedWorkbenchSender(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  window: BrowserWindow | null,
  trustedRendererUrl: string
): void {
  const mainFrame = window?.webContents.mainFrame
  const senderFrame = event.senderFrame
  if (
    !window ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    !mainFrame ||
    !senderFrame ||
    senderFrame.processId !== mainFrame.processId ||
    senderFrame.routingId !== mainFrame.routingId ||
    !isTrustedWorkbenchUrl(senderFrame.url, trustedRendererUrl)
  ) {
    throw new Error('Untrusted connector IPC sender.')
  }
}

/** Compare only the immutable renderer origin and entry document; query/hash are UI state. */
export function isTrustedWorkbenchUrl(candidate: string, trustedRendererUrl: string): boolean {
  try {
    const actual = new URL(candidate)
    const expected = new URL(trustedRendererUrl)
    return actual.protocol === expected.protocol &&
      actual.username === expected.username &&
      actual.password === expected.password &&
      actual.host === expected.host &&
      normalizePathname(actual.pathname) === normalizePathname(expected.pathname)
  } catch {
    return false
  }
}

function normalizePathname(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
}
