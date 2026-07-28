import type {
  BrowserWindow,
  IpcMain,
  IpcMainInvokeEvent,
  WebContents
} from 'electron'
import {
  TRAY_PROVIDER_QUOTA_ACTIONS,
  TRAY_PROVIDER_QUOTA_CHANNELS,
  type TrayProviderQuotaAction,
  type TrayProviderQuotaContext
} from '../shared/tray-provider-quota'
import type { ProviderQuotaListResult } from '../shared/provider-quota'

type TrayQuotaIpcDependencies = {
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>
  getWindow: () => BrowserWindow | null
  list: () => Promise<ProviderQuotaListResult>
  context: () => Promise<TrayProviderQuotaContext>
  action: (action: TrayProviderQuotaAction) => void | Promise<void>
  openExternal: (url: string) => void | Promise<void>
}

export function registerTrayQuotaIpc({
  ipcMain,
  getWindow,
  list,
  context,
  action,
  openExternal
}: TrayQuotaIpcDependencies): () => void {
  ipcMain.handle(TRAY_PROVIDER_QUOTA_CHANNELS.list, async (event) => {
    assertTrustedTrayQuotaSender(event, getWindow())
    return list()
  })
  ipcMain.handle(TRAY_PROVIDER_QUOTA_CHANNELS.context, async (event) => {
    assertTrustedTrayQuotaSender(event, getWindow())
    return context()
  })
  ipcMain.handle(TRAY_PROVIDER_QUOTA_CHANNELS.action, async (event, value: unknown) => {
    assertTrustedTrayQuotaSender(event, getWindow())
    if (!isTrayProviderQuotaAction(value)) {
      throw new Error('Invalid tray provider quota action.')
    }
    await action(value)
  })
  ipcMain.handle(TRAY_PROVIDER_QUOTA_CHANNELS.openExternal, async (event, value: unknown) => {
    assertTrustedTrayQuotaSender(event, getWindow())
    await openExternal(parseTrayQuotaDashboardUrl(value))
  })

  return () => {
    ipcMain.removeHandler(TRAY_PROVIDER_QUOTA_CHANNELS.list)
    ipcMain.removeHandler(TRAY_PROVIDER_QUOTA_CHANNELS.context)
    ipcMain.removeHandler(TRAY_PROVIDER_QUOTA_CHANNELS.action)
    ipcMain.removeHandler(TRAY_PROVIDER_QUOTA_CHANNELS.openExternal)
  }
}

export function isTrustedTrayQuotaSender(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  window: BrowserWindow | null
): boolean {
  if (!window || window.isDestroyed() || event.sender.isDestroyed()) return false
  return event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame
}

export function parseTrayQuotaDashboardUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2_048) {
    throw new Error('Invalid provider dashboard URL.')
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('Invalid provider dashboard URL.')
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Provider dashboard URLs must use HTTPS.')
  }
  return parsed.toString()
}

function assertTrustedTrayQuotaSender(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  window: BrowserWindow | null
): void {
  if (!isTrustedTrayQuotaSender(event, window)) {
    throw new Error('Untrusted tray provider quota IPC sender.')
  }
}

function isTrayProviderQuotaAction(value: unknown): value is TrayProviderQuotaAction {
  return typeof value === 'string' &&
    (TRAY_PROVIDER_QUOTA_ACTIONS as readonly string[]).includes(value)
}

export type TrayQuotaSenderForTest = Pick<WebContents, 'isDestroyed'>
