import type {
  ExtensionIpcRegistration,
  RegisterExtensionIpcHandlersOptions
} from './extension-ipc-handler-options'
import { ExtensionViewRequestLimiter } from './extension-view-request-limiter'
import { registerExtensionAccountIpcHandlers } from './register-extension-account-ipc-handlers'
import { registerExtensionConsentIpcHandler } from './register-extension-consent-ipc-handler'
import { registerExtensionManagementIpcHandlers } from './register-extension-management-ipc-handlers'
import { registerExtensionViewIpcHandlers } from './register-extension-view-ipc-handlers'

export type {
  ExtensionIpcRegistration,
  ExtensionWorkbenchEnvironment,
  RegisterExtensionIpcHandlersOptions
} from './extension-ipc-handler-options'
export {
  startExtensionNotificationPump,
  startExtensionSecretRevealConsentPump
} from './extension-ipc-pumps'

export function registerExtensionIpcHandlers(
  options: RegisterExtensionIpcHandlersOptions
): ExtensionIpcRegistration {
  const limiter = new ExtensionViewRequestLimiter()
  return registerExtensionManagementIpcHandlers(options, () => {
    const viewRegistration = registerExtensionViewIpcHandlers(options, limiter)
    registerExtensionAccountIpcHandlers(options)
    registerExtensionConsentIpcHandler(options)
    return viewRegistration
  })
}
