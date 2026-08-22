import { ipcRenderer } from 'electron'
import type { DesktopStartupPhase } from '../shared/desktop-startup-state'

export type DesktopStartupPreloadApi = {
  getState: () => Promise<DesktopStartupPhase>
  onState: (handler: (phase: DesktopStartupPhase) => void) => () => void
}

export function createDesktopStartupPreloadApi(): DesktopStartupPreloadApi {
  return {
    getState: () => ipcRenderer.invoke('startup:state:get'),
    onState: (handler) => {
      const wrapped = (
        _: Electron.IpcRendererEvent,
        payload: Parameters<typeof handler>[0]
      ) => handler(payload)
      ipcRenderer.on('startup:state', wrapped)
      return () => ipcRenderer.removeListener('startup:state', wrapped)
    }
  }
}
