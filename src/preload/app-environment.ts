import type { AppEnvironmentInfo } from '../shared/app-environment'

export function parseAppEnvironment(encoded: string | undefined): AppEnvironmentInfo {
  if (encoded) {
    try {
      const parsed = JSON.parse(decodeURIComponent(encoded)) as Partial<AppEnvironmentInfo>
      if (
        (parsed.flavor === 'production' || parsed.flavor === 'development') &&
        parsed.runtimeFlavor === parsed.flavor &&
        typeof parsed.appName === 'string' &&
        typeof parsed.appId === 'string' &&
        typeof parsed.profilePath === 'string' &&
        typeof parsed.isPackaged === 'boolean'
      ) return Object.freeze(parsed as AppEnvironmentInfo)
    } catch {
      // Fall through to a safe production-shaped snapshot.
    }
  }
  return Object.freeze({
    flavor: 'production',
    appName: 'Kun',
    appId: 'com.xingyuzhong.deepseekgui',
    runtimeFlavor: 'production',
    profilePath: '',
    isPackaged: false
  })
}
