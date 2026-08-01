import type { AppFlavor } from '../../shared/app-environment'

export type StorageRelocationFeatureOptions = {
  platform?: NodeJS.Platform
  flavor?: AppFlavor
  isPackaged?: boolean
  environment?: NodeJS.ProcessEnv
}

export function storageRelocationFeatureEnabled(
  options: StorageRelocationFeatureOptions = {}
): boolean {
  const platform = options.platform ?? process.platform
  const flavor = options.flavor ?? 'production'
  const environment = options.environment ?? process.env
  if (platform !== 'win32' || flavor !== 'production') return false
  if (environment.KUN_STORAGE_RELOCATION_ENABLED === '0') return false
  if (environment.KUN_STORAGE_RELOCATION_ENABLED === '1') return true
  // Keep the destructive workflow internal until native packaged recovery
  // evidence is recorded. Existing relocations are still recovered even when
  // starting a new operation is disabled.
  return false
}
