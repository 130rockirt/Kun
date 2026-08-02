import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PRODUCTION_APP_NAME,
  appIdentityForFlavor,
  isAppFlavor,
  type AppFlavor,
  type AppIdentity
} from '../shared/app-environment'

/** Kept for production branding and compatibility tests. */
export const APP_PRODUCT_NAME = PRODUCTION_APP_NAME

export function configureDesktopSmokeAppDataPath(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  if (env.KUN_PACKAGED_EXTENSION_DESKTOP_SMOKE !== '1') return undefined
  const appDataPath = env.APPDATA?.trim()
  if (!appDataPath) {
    throw new Error('The isolated desktop smoke requires an APPDATA path')
  }
  app.setPath('appData', appDataPath)
  return appDataPath
}

export function configureAppIdentity(options: {
  flavor?: AppFlavor
  appDataPath?: string
} = {}): AppIdentity {
  const identity = appIdentityForFlavor(options.flavor ?? 'production')
  app.setName(identity.appName)
  if (identity.flavor === 'development') {
    const appDataPath = options.appDataPath ?? app.getPath('appData')
    app.setPath('userData', join(appDataPath, identity.appName))
  }
  return identity
}

/** Read the build flavor embedded by electron-builder's extraMetadata. */
export function readPackagedAppFlavor(appPath: string): AppFlavor | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(appPath, 'package.json'), 'utf8')) as {
      kunAppFlavor?: unknown
    }
    return isAppFlavor(parsed.kunAppFlavor) ? parsed.kunAppFlavor : undefined
  } catch {
    return undefined
  }
}
