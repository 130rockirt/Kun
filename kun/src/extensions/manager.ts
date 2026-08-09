export {
  ExtensionManager
} from './manager-implementation.js'
export {
  DEFAULT_EXTENSION_CRASH_THRESHOLD,
  DEFAULT_EXTENSION_RESTART_BACKOFF_MS,
  DEFAULT_EXTENSION_RESTART_BACKOFF_MAX_MS,
  DEFAULT_EXTENSION_HEALTHY_RESET_MS,
  DEFAULT_EXTENSION_VIEW_IDLE_TIMEOUT_MS,
  isViewIdleDeactivationEligible,
  extensionHostInstanceKey
} from './manager-contracts.js'
export type {
  ExtensionHostDiagnostic,
  ExtensionHostWorkspaceScope,
  ExtensionHostNotificationScope,
  ExtensionManagerOptions
} from './manager-contracts.js'
