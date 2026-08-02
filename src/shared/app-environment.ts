export const APP_FLAVORS = ['production', 'development'] as const
export type AppFlavor = (typeof APP_FLAVORS)[number]

export type RuntimeFlavor = AppFlavor

export const PRODUCTION_APP_NAME = 'Kun'
export const DEVELOPMENT_APP_NAME = 'kun-dv'
export const DEVELOPMENT_WINDOW_TITLE = 'kun-dv · DV'
export const PRODUCTION_APP_ID = 'com.xingyuzhong.deepseekgui'
export const DEVELOPMENT_APP_ID = 'com.xingyuzhong.deepseekgui.dv'

export type AppIdentity = {
  flavor: AppFlavor
  appName: string
  appId: string
  runtimeFlavor: RuntimeFlavor
}

export type AppEnvironmentInfo = AppIdentity & {
  profilePath: string
  isPackaged: boolean
}

export type RuntimeRegistration = {
  flavor: RuntimeFlavor
  instanceId: string
  pid: number
  startedAt: string
  host: string
  port: number
  baseUrl: string
  runtimeToken: string
  buildId?: string
  logPath?: string
}

export type ThreadExecutionLease = {
  threadId: string
  turnId: string
  ownerFlavor: RuntimeFlavor
  ownerInstanceId: string
  acquiredAt: string
  expiresAt: string
}

export type RevisionedSnapshot<T> = {
  revision: number
  value: T
}

export type AppFlavorResolutionInput = {
  argv?: readonly string[]
  env?: Record<string, string | undefined>
  packagedFlavor?: unknown
}

export function isAppFlavor(value: unknown): value is AppFlavor {
  return value === 'production' || value === 'development'
}

export function appIdentityForFlavor(flavor: AppFlavor): AppIdentity {
  return flavor === 'development'
    ? {
        flavor,
        appName: DEVELOPMENT_APP_NAME,
        appId: DEVELOPMENT_APP_ID,
        runtimeFlavor: 'development'
      }
    : {
        flavor,
        appName: PRODUCTION_APP_NAME,
        appId: PRODUCTION_APP_ID,
        runtimeFlavor: 'production'
      }
}

export function appWindowTitleForFlavor(flavor: AppFlavor): string {
  return flavor === 'development' ? DEVELOPMENT_WINDOW_TITLE : PRODUCTION_APP_NAME
}

export function resolveAppFlavor(input: AppFlavorResolutionInput = {}): AppFlavor {
  const argument = appFlavorArgument(input.argv ?? [])
  const environment = input.env?.KUN_APP_FLAVOR?.trim()
  const candidate = argument ?? environment ?? input.packagedFlavor ?? 'production'
  if (!isAppFlavor(candidate)) {
    throw new Error(`invalid Kun application flavor: ${String(candidate)}`)
  }
  return candidate
}

export function createAppEnvironmentInfo(input: {
  identity: AppIdentity
  profilePath: string
  isPackaged: boolean
}): AppEnvironmentInfo {
  return Object.freeze({
    ...input.identity,
    profilePath: input.profilePath,
    isPackaged: input.isPackaged
  })
}

function appFlavorArgument(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--kun-app-flavor') return argv[index + 1]?.trim()
    if (argument.startsWith('--kun-app-flavor=')) {
      return argument.slice('--kun-app-flavor='.length).trim()
    }
  }
  return undefined
}
