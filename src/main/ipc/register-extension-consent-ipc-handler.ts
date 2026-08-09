import { ipcMain } from 'electron'
import { extensionConsentRequestSchema } from './app-ipc-schemas/extensions'
import type { RegisterExtensionIpcHandlersOptions } from './extension-ipc-handler-options'
import {
  assertTrustedWorkbenchSender,
  consentBindingFromRequest,
  parsePayload
} from './extension-ipc-common'

export function registerExtensionConsentIpcHandler(
  options: RegisterExtensionIpcHandlersOptions
): void {
  ipcMain.handle('extension:consent:request', async (event, payload: unknown) => {
    assertTrustedWorkbenchSender(event, options.getMainWindow)
    const request = parsePayload('extension:consent:request', extensionConsentRequestSchema, payload)
    const result = await options.protectedActions.authorize(
      consentBindingFromRequest(request, event.sender.id),
      { title: request.title, message: request.message, detail: request.detail }
    )
    return result.approved
      ? {
          approved: true,
          consentRequestId: result.requestId,
          expiresAt: new Date(result.expiresAt).toISOString()
        }
      : { approved: false }
  })
}
