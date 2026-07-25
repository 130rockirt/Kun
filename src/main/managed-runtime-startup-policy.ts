import {
  getKunRuntimeSettings,
  type AppSettingsV1
} from '../shared/app-settings'

/**
 * The managed process is the local Kun host, not one specific upstream model.
 * Provider-specific, protected, SDK, and ambient credentials are resolved
 * after the host starts, so an unrelated default DeepSeek key is not a launch
 * prerequisite.
 */
export function managedKunHostCanAutoStart(settings: AppSettingsV1): boolean {
  return getKunRuntimeSettings(settings).autoStart
}
