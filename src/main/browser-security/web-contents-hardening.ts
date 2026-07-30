import type { Session, WebPreferences } from 'electron'

export function hardenedRemoteWebPreferences(partition: string): WebPreferences {
  return {
    partition,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    safeDialogs: true,
    disableDialogs: true,
    autoplayPolicy: 'document-user-activation-required',
    spellcheck: false,
    backgroundThrottling: true
  }
}

/**
 * Common deny-by-default session baseline. Callers still own navigation and
 * subresource policy and must not share partitions or ownership records.
 */
export function hardenRemoteSession(target: Session): void {
  target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  target.setPermissionCheckHandler(() => false)
  target.setDevicePermissionHandler(() => false)
  target.on('will-download', (event) => event.preventDefault())
}
