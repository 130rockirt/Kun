import { contextBridge, ipcRenderer } from 'electron'
import {
  TRAY_PROVIDER_QUOTA_CHANNELS,
  type KunTrayProviderQuotaApi
} from '../shared/tray-provider-quota'

const api: KunTrayProviderQuotaApi = {
  list: () => ipcRenderer.invoke(TRAY_PROVIDER_QUOTA_CHANNELS.list),
  context: () => ipcRenderer.invoke(TRAY_PROVIDER_QUOTA_CHANNELS.context),
  action: (action) => ipcRenderer.invoke(TRAY_PROVIDER_QUOTA_CHANNELS.action, action),
  openExternal: (url) => ipcRenderer.invoke(TRAY_PROVIDER_QUOTA_CHANNELS.openExternal, url),
  onRefresh: (handler) => {
    const wrapped = (): void => handler()
    ipcRenderer.on(TRAY_PROVIDER_QUOTA_CHANNELS.refresh, wrapped)
    return () => ipcRenderer.removeListener(TRAY_PROVIDER_QUOTA_CHANNELS.refresh, wrapped)
  }
}

contextBridge.exposeInMainWorld('kunTrayQuota', api)
