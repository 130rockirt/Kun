export type CliInstallState =
  | 'installed'
  | 'not-installed'
  | 'stale'
  | 'conflict'
  | 'unsupported'

export type CliInstallStatus = {
  state: CliInstallState
  commandPath?: string
  launcherPath?: string
  targetPath?: string
  pathConfigured?: boolean
  message?: string
}

export type CliInstallAction = 'install' | 'repair' | 'uninstall'

export type CliInstallResult = {
  ok: boolean
  status: CliInstallStatus
  message?: string
}
