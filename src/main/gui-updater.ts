import { app, autoUpdater as nativeAutoUpdater, BrowserWindow, dialog, shell } from 'electron'
import type { MessageBoxOptions } from 'electron'
import type { ProgressInfo, UpdateDownloadedEvent, UpdateInfo } from 'electron-updater'
import type {
  GuiUpdateChannel,
  GuiUpdateDownloadResult,
  GuiUpdateFailureCode,
  GuiUpdateInfo,
  GuiUpdateInstallResult,
  GuiUpdateState
} from '../shared/gui-update'
import { nextGuiUpdateCheckDelay } from '../shared/gui-update-schedule'
import { DEFAULT_GUI_UPDATE_CHANNEL, normalizeGuiUpdateChannel } from '../shared/gui-update'
import type { AppLocale } from '../shared/app-locales'
import {
  autoUpdater,
  changelogUrl,
  DEVELOPMENT_APP_FLAVOR,
  DEVELOPMENT_UPDATE_MESSAGE,
  downloadPageUrl,
  envWithLegacyFallback,
  isVersionGreater,
  macAutoUpdateAllowed,
  parseYamlScalar,
  readGuiVersionState,
  readLastScheduledCheckAt,
  recordPendingUpdate,
  releaseUrlForVersion,
  resolveUpdateFeedUrl,
  sanitizeUpdaterError,
  setWindowsInstallerUpdateSource,
  unsupportedMessage,
  updateFeedManifestUrl,
  updateFeedUrl,
  writeGuiVersionState,
  writeLastScheduledCheckAt
} from './gui-updater-support'

export { setWindowsInstallerUpdateSource } from './gui-updater-support'

let initialized = false
let getMainWindow: (() => BrowserWindow | null) | null = null
let lastInfo: Extract<GuiUpdateInfo, { ok: true }> | null = null
let lastState: GuiUpdateState = { status: 'idle' }
let downloaded = false
let downloadPromise: Promise<string[]> | null = null
let configuredChannel: GuiUpdateChannel = normalizeGuiUpdateChannel(
  envWithLegacyFallback('KUN_UPDATE_CHANNEL', 'DEEPSEEK_GUI_UPDATE_CHANNEL') || undefined
)
let configuredFeedUrl = ''
let getSelectedChannel: (() => GuiUpdateChannel | Promise<GuiUpdateChannel>) | null = null
let getSelectedLocale: (() => AppLocale | Promise<AppLocale>) | null = null
let beforeInstallUpdate: (() => void | Promise<void>) | null = null
let beforeInstallUpdatePromise: Promise<void> | null = null
let beforeInstallUpdatePrepared = false
let setUpdateInstallQuitting: ((active: boolean) => void) | null = null
let pendingVersionStateWrite: Promise<void> | null = null
let backgroundCheckTimer: NodeJS.Timeout | null = null
let backgroundCheckPromise: Promise<void> | null = null
let updateInstallQuitting = false
let installPromise: Promise<GuiUpdateInstallResult> | null = null
let updateInstallHandoffPending = false
let updateInstallHandoffStarted = false
let updateInstallLaunchError: Error | null = null
let updateInstallAttemptActive = false
let updateInstallRecoveryNeeded = false
let updateInstallRecoveryScheduled = false
let restoreInstallerUpdateSourceAfterFailure: (() => void) | null = null

async function selectedLocale(): Promise<'en' | 'zh'> {
  try {
    return (await getSelectedLocale?.()) === 'zh' ? 'zh' : 'en'
  } catch {
    return app.getLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en'
  }
}
function toGuiInfo(updateInfo: UpdateInfo, hasUpdate: boolean, manualOnly = false): Extract<GuiUpdateInfo, { ok: true }> {
  const latestVersion = updateInfo.version.trim()
  return {
    ok: true,
    currentVersion: app.getVersion(),
    latestVersion,
    hasUpdate,
    releaseUrl: releaseUrlForVersion(latestVersion, configuredChannel),
    releaseDate: updateInfo.releaseDate,
    channel: configuredChannel,
    manualOnly,
    downloaded
  }
}

function emitGuiUpdateState(state: GuiUpdateState): void {
  lastState = state
  const win = getMainWindow?.()
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send('gui:update-state', state)
}

function runBeforeInstallUpdate(): Promise<void> {
  if (beforeInstallUpdatePrepared) return Promise.resolve()
  if (!beforeInstallUpdate) return Promise.resolve()
  if (!beforeInstallUpdatePromise) {
    beforeInstallUpdatePromise = Promise.resolve()
      .then(() => beforeInstallUpdate?.())
      .then(() => {
        beforeInstallUpdatePrepared = true
      })
      .finally(() => {
        beforeInstallUpdatePromise = null
      })
  }
  return beforeInstallUpdatePromise
}

function markUpdateInstallQuitting(active: boolean): void {
  if (updateInstallQuitting === active) return
  updateInstallQuitting = active
  setUpdateInstallQuitting?.(active)
}

function clearBeforeInstallUpdatePreparation(): void {
  beforeInstallUpdatePrepared = false
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function relaunchAfterFailedUpdateInstall(): void {
  try {
    app.relaunch()
    app.exit(0)
  } catch (error) {
    console.error('[kun-gui updater] failed to relaunch after update install failure:', error)
  }
}

function resetFailedUpdateInstallState(): void {
  restoreInstallerUpdateSourceAfterFailure?.()
  restoreInstallerUpdateSourceAfterFailure = null
  updateInstallAttemptActive = false
  updateInstallHandoffPending = false
  updateInstallHandoffStarted = false
  updateInstallLaunchError = null
  clearBeforeInstallUpdatePreparation()
  markUpdateInstallQuitting(false)
}

function scheduleFailedUpdateInstallRecovery(): void {
  updateInstallRecoveryNeeded = true
  if (updateInstallRecoveryScheduled) return
  updateInstallRecoveryScheduled = true
  queueMicrotask(() => {
    updateInstallRecoveryScheduled = false
    if (!updateInstallRecoveryNeeded) return
    updateInstallRecoveryNeeded = false
    resetFailedUpdateInstallState()
    relaunchAfterFailedUpdateInstall()
  })
}

function clearBackgroundCheckTimer(): void {
  if (backgroundCheckTimer) {
    clearTimeout(backgroundCheckTimer)
    backgroundCheckTimer = null
  }
}

function shouldSkipScheduledCheck(): boolean {
  return (
    lastState.status === 'checking' ||
    lastState.status === 'downloading' ||
    lastState.status === 'downloaded' ||
    lastState.status === 'installing'
  )
}

async function scheduleNextBackgroundCheck(): Promise<void> {
  clearBackgroundCheckTimer()
  const lastCheckedAtMs = await readLastScheduledCheckAt()
  const delay = nextGuiUpdateCheckDelay(lastCheckedAtMs)
  backgroundCheckTimer = setTimeout(() => {
    void runScheduledGuiUpdateCheck()
  }, delay)
}

async function runScheduledGuiUpdateCheck(): Promise<void> {
  if (backgroundCheckPromise) return backgroundCheckPromise
  backgroundCheckPromise = (async () => {
    try {
      if (shouldSkipScheduledCheck()) return
      const nowMs = Date.now()
      await writeLastScheduledCheckAt(nowMs)
      await checkGuiUpdate()
    } catch (error) {
      console.warn('[kun-gui updater] scheduled GUI update check failed:', error)
    } finally {
      backgroundCheckPromise = null
      void scheduleNextBackgroundCheck()
    }
  })()
  return backgroundCheckPromise
}

async function resolveUpdateChannel(requested?: GuiUpdateChannel): Promise<GuiUpdateChannel> {
  if (requested) return normalizeGuiUpdateChannel(requested)
  if (getSelectedChannel) {
    return normalizeGuiUpdateChannel(await getSelectedChannel())
  }
  return DEFAULT_GUI_UPDATE_CHANNEL
}

function configureUpdaterChannel(channel: GuiUpdateChannel, feedUrl = updateFeedUrl(channel)): void {
  const normalized = normalizeGuiUpdateChannel(channel)
  const changed = normalized !== configuredChannel || feedUrl !== configuredFeedUrl
  configuredChannel = normalized
  configuredFeedUrl = feedUrl
  autoUpdater.allowPrerelease = normalized === 'frontier'
  // Switching from frontier to stable must never install an older build.
  autoUpdater.allowDowngrade = false
  autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl })
  if (!changed) return
  downloaded = false
  downloadPromise = null
  lastInfo = null
  emitGuiUpdateState({ status: 'idle' })
}

async function configureReachableUpdaterChannel(channel: GuiUpdateChannel): Promise<void> {
  configureUpdaterChannel(channel, await resolveUpdateFeedUrl(channel))
}

export function setGuiUpdateChannel(channel: GuiUpdateChannel): void {
  if (DEVELOPMENT_APP_FLAVOR) return
  configureUpdaterChannel(channel)
}

async function checkManualUpdate(
  channel: GuiUpdateChannel,
  code: GuiUpdateFailureCode = 'unsupported'
): Promise<GuiUpdateInfo> {
  const currentVersion = app.getVersion()
  try {
    const feedUrl = configuredChannel === channel && configuredFeedUrl
      ? configuredFeedUrl
      : await resolveUpdateFeedUrl(channel)
    const url = updateFeedManifestUrl(feedUrl)
    const res = await fetch(url, {
      headers: {
        Accept: 'application/x-yaml,text/yaml,text/plain,*/*',
        'User-Agent': `kun/${currentVersion}`
      }
    })
    if (!res.ok) {
      return {
        ok: false,
        currentVersion,
        code,
        message: `${unsupportedMessage()} Update metadata returned ${res.status}.`,
        releaseUrl: downloadPageUrl(configuredChannel),
        channel
      }
    }
    const text = await res.text()
    const latestVersion = parseYamlScalar(text, 'version')
    if (!latestVersion) {
      return {
        ok: false,
        currentVersion,
        code,
        message: `${unsupportedMessage()} Update metadata is missing a version.`,
        releaseUrl: downloadPageUrl(configuredChannel),
        channel
      }
    }
    const info: Extract<GuiUpdateInfo, { ok: true }> = {
      ok: true,
      currentVersion,
      latestVersion,
      hasUpdate: isVersionGreater(latestVersion, currentVersion),
      releaseUrl: releaseUrlForVersion(latestVersion, configuredChannel),
      releaseDate: parseYamlScalar(text, 'releaseDate'),
      channel,
      manualOnly: true,
      downloaded: false
    }
    lastInfo = info
    emitGuiUpdateState(info.hasUpdate ? { status: 'available', info } : { status: 'not_available', info })
    return info
  } catch (e) {
    return {
      ok: false,
      currentVersion,
      code,
      message: `${unsupportedMessage()} ${e instanceof Error ? e.message : String(e)}`,
      releaseUrl: downloadPageUrl(configuredChannel),
      channel
    }
  }
}

export function initializeGuiUpdater(
  windowGetter: () => BrowserWindow | null,
  channelGetter?: () => GuiUpdateChannel | Promise<GuiUpdateChannel>,
  beforeInstall?: () => void | Promise<void>,
  localeGetter?: () => AppLocale | Promise<AppLocale>,
  updateInstallQuittingSetter?: (active: boolean) => void
): void {
  getMainWindow = windowGetter
  getSelectedChannel = channelGetter ?? null
  beforeInstallUpdate = beforeInstall ?? null
  getSelectedLocale = localeGetter ?? null
  setUpdateInstallQuitting = updateInstallQuittingSetter ?? null
  if (initialized) return
  initialized = true

  if (DEVELOPMENT_APP_FLAVOR) return

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  configureUpdaterChannel(configuredChannel)
  if (!app.isPackaged) {
    autoUpdater.forceDevUpdateConfig = true
  }

  autoUpdater.logger = {
    info: (message?: unknown) => console.info('[kun-gui updater]', message),
    warn: (message?: unknown) => console.warn('[kun-gui updater]', message),
    error: (message?: unknown) => console.error('[kun-gui updater]', message)
  }

  autoUpdater.on('checking-for-update', () => {
    emitGuiUpdateState({ status: 'checking', info: lastInfo ?? undefined })
  })

  autoUpdater.on('update-available', (updateInfo: UpdateInfo) => {
    downloaded = false
    const info = toGuiInfo(updateInfo, true)
    lastInfo = info
    emitGuiUpdateState({ status: 'available', info })
  })

  autoUpdater.on('update-not-available', (updateInfo: UpdateInfo) => {
    downloaded = false
    const info = toGuiInfo(updateInfo, false)
    lastInfo = info
    emitGuiUpdateState({ status: 'not_available', info })
  })

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    emitGuiUpdateState({ status: 'downloading', info: lastInfo ?? undefined, progress })
  })

  autoUpdater.on('update-downloaded', (event: UpdateDownloadedEvent) => {
    downloaded = true
    const info = toGuiInfo(event, true)
    lastInfo = info
    pendingVersionStateWrite = recordPendingUpdate(event)
      .catch((error) => {
        console.warn('[kun-gui updater] failed to save release notes:', error)
      })
      .finally(() => {
        pendingVersionStateWrite = null
      })
    emitGuiUpdateState({ status: 'downloaded', info })
  })

  autoUpdater.on('error', (error) => {
    const message = error instanceof Error ? error.message : String(error)
    const installFailed = updateInstallAttemptActive
    if (installFailed) {
      updateInstallLaunchError = asError(error)
      scheduleFailedUpdateInstallRecovery()
    }
    const downloadFailed = !installFailed && (downloadPromise !== null || lastState.status === 'downloading')
    if (downloadFailed) {
      downloaded = false
      downloadPromise = null
    }
    emitGuiUpdateState({
      status: 'error',
      info: lastInfo ?? undefined,
      message,
      code: installFailed ? 'install_failed' : downloadFailed ? 'download_failed' : 'unknown'
    })
  })

  nativeAutoUpdater?.on?.('before-quit-for-update', () => {
    if (updateInstallHandoffPending) {
      updateInstallHandoffStarted = true
      updateInstallHandoffPending = false
    }
    markUpdateInstallQuitting(true)
    void runBeforeInstallUpdate().catch((error) => {
      clearBeforeInstallUpdatePreparation()
      markUpdateInstallQuitting(false)
      console.warn('[kun-gui updater] failed to stop runtimes before update quit:', error)
    })
  })

  void scheduleNextBackgroundCheck()
}

export async function showPostUpdateReleaseNotes(): Promise<void> {
  if (DEVELOPMENT_APP_FLAVOR) return
  if (!app.isPackaged) return

  const currentVersion = app.getVersion().trim()
  const state = await readGuiVersionState()
  if (!state.lastSeenVersion) {
    await writeGuiVersionState({ ...state, lastSeenVersion: currentVersion })
    return
  }
  if (state.lastSeenVersion === currentVersion) return
  if (!isVersionGreater(currentVersion, state.lastSeenVersion)) return

  const pendingUpdate =
    state.pendingUpdate?.version === currentVersion ? state.pendingUpdate : undefined
  await writeGuiVersionState({ lastSeenVersion: currentVersion })

  const locale = await selectedLocale()
  const isZh = locale === 'zh'
  const options: MessageBoxOptions = {
    type: 'info',
    title: isZh ? 'Kun 已更新' : 'Kun updated',
    message: isZh ? `已更新到 Kun ${currentVersion}` : `Kun has been updated to ${currentVersion}`,
    detail:
      pendingUpdate?.releaseNotes ??
      (isZh
        ? '此版本的完整更新内容可在 Kun 更新日志中查看。'
        : 'See the Kun changelog for the complete release notes.'),
    buttons: isZh ? ['查看更新日志', '稍后'] : ['View changelog', 'Later'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  }
  const window = getMainWindow?.()
  const result =
    window && !window.isDestroyed()
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options)
  if (result.response === 0) {
    await shell.openExternal(changelogUrl(currentVersion))
  }
}

export function getGuiUpdateState(): GuiUpdateState {
  return lastState
}

export async function checkGuiUpdate(channel?: GuiUpdateChannel): Promise<GuiUpdateInfo> {
  const selectedChannel = await resolveUpdateChannel(channel)
  if (DEVELOPMENT_APP_FLAVOR) {
    return {
      ok: false,
      currentVersion: app.getVersion(),
      channel: selectedChannel,
      code: 'unsupported',
      message: DEVELOPMENT_UPDATE_MESSAGE
    }
  }
  await configureReachableUpdaterChannel(selectedChannel)

  if (!macAutoUpdateAllowed()) {
    return checkManualUpdate(selectedChannel, 'unsupported')
  }

  emitGuiUpdateState({ status: 'checking', info: lastInfo ?? undefined })
  try {
    const result = await autoUpdater.checkForUpdates()
    if (!result) {
      return checkManualUpdate(selectedChannel, 'not_configured')
    }
    const info = toGuiInfo(result.updateInfo, result.isUpdateAvailable)
    lastInfo = info
    emitGuiUpdateState(info.hasUpdate ? { status: 'available', info } : { status: 'not_available', info })
    return info
  } catch (e) {
    const message = sanitizeUpdaterError(e instanceof Error ? e.message : String(e), selectedChannel)
    const info: GuiUpdateInfo = {
      ok: false,
      currentVersion: app.getVersion(),
      message,
      code: 'unknown',
      releaseUrl: downloadPageUrl(configuredChannel),
      channel: selectedChannel
    }
    emitGuiUpdateState({ status: 'error', info, message, code: 'unknown' })
    return info
  }
}

export async function downloadGuiUpdate(channel?: GuiUpdateChannel): Promise<GuiUpdateDownloadResult> {
  const selectedChannel = await resolveUpdateChannel(channel)
  if (DEVELOPMENT_APP_FLAVOR) {
    return {
      ok: false,
      currentVersion: app.getVersion(),
      code: 'unsupported',
      message: DEVELOPMENT_UPDATE_MESSAGE
    }
  }
  await configureReachableUpdaterChannel(selectedChannel)

  if (!macAutoUpdateAllowed()) {
    return {
      ok: false,
      currentVersion: app.getVersion(),
      code: 'unsupported',
      message: unsupportedMessage()
    }
  }

  try {
    if (!lastInfo?.hasUpdate || lastInfo.channel !== selectedChannel) {
      const checked = await checkGuiUpdate(selectedChannel)
      if (!checked.ok) return checked
      if (!checked.hasUpdate || checked.manualOnly) {
        return {
          ok: false,
          currentVersion: app.getVersion(),
          code: checked.manualOnly ? 'unsupported' : 'unknown',
          message: checked.manualOnly
            ? unsupportedMessage()
            : 'No downloadable GUI update is available.'
        }
      }
    }

    if (!downloadPromise) {
      let tracked: Promise<string[]>
      tracked = autoUpdater.downloadUpdate().finally(() => {
        if (downloadPromise === tracked) downloadPromise = null
      })
      downloadPromise = tracked
    }
    const paths = await downloadPromise
    return { ok: true, paths }
  } catch (e) {
    downloaded = false
    downloadPromise = null
    const message = e instanceof Error ? e.message : String(e)
    emitGuiUpdateState({ status: 'error', info: lastInfo ?? undefined, message, code: 'download_failed' })
    return {
      ok: false,
      currentVersion: app.getVersion(),
      code: 'download_failed',
      message
    }
  }
}

export function installGuiUpdate(): Promise<GuiUpdateInstallResult> {
  if (installPromise) return installPromise
  if (updateInstallAttemptActive || updateInstallHandoffPending || updateInstallHandoffStarted) {
    return Promise.resolve({ ok: true })
  }
  const operation = installGuiUpdateOnce()
  installPromise = operation
  void operation.then(
    () => {
      if (installPromise === operation) installPromise = null
    },
    () => {
      if (installPromise === operation) installPromise = null
    }
  )
  return operation
}

async function installGuiUpdateOnce(): Promise<GuiUpdateInstallResult> {
  if (DEVELOPMENT_APP_FLAVOR) {
    return {
      ok: false,
      currentVersion: app.getVersion(),
      code: 'unsupported',
      message: DEVELOPMENT_UPDATE_MESSAGE
    }
  }
  let updateInstallQuitMarked = false
  let restoreInstallerUpdateSource = (): void => undefined
  try {
    if (!downloaded) {
      return {
        ok: false,
        currentVersion: app.getVersion(),
        code: 'install_failed',
        message: 'The update has not finished downloading yet.'
      }
    }
    emitGuiUpdateState({ status: 'installing', info: lastInfo ?? undefined })
    markUpdateInstallQuitting(true)
    updateInstallQuitMarked = true
    await Promise.all([pendingVersionStateWrite, runBeforeInstallUpdate()])
    restoreInstallerUpdateSource = setWindowsInstallerUpdateSource()
    restoreInstallerUpdateSourceAfterFailure = restoreInstallerUpdateSource
    // In-app updates must stay silent on Windows. The assisted NSIS UI can
    // surface its old-uninstaller retry dialog even though our overwrite
    // fallback can safely continue; silent mode applies that dialog's default
    // cancel action instead of asking the user to make the counter-intuitive
    // choice. Manually launched installers remain interactive.
    updateInstallLaunchError = null
    updateInstallAttemptActive = true
    updateInstallHandoffPending = true
    updateInstallHandoffStarted = false
    autoUpdater.quitAndInstall(true, true)
    if (updateInstallLaunchError) throw updateInstallLaunchError
    return { ok: true }
  } catch (e) {
    const relaunchRequired = updateInstallQuitMarked
    restoreInstallerUpdateSource()
    if (restoreInstallerUpdateSourceAfterFailure === restoreInstallerUpdateSource) {
      restoreInstallerUpdateSourceAfterFailure = null
    }
    updateInstallAttemptActive = false
    updateInstallHandoffPending = false
    updateInstallHandoffStarted = false
    updateInstallLaunchError = null
    if (updateInstallQuitMarked) {
      clearBeforeInstallUpdatePreparation()
      markUpdateInstallQuitting(false)
    }
    const message = e instanceof Error ? e.message : String(e)
    emitGuiUpdateState({ status: 'error', info: lastInfo ?? undefined, message, code: 'install_failed' })
    if (relaunchRequired) scheduleFailedUpdateInstallRecovery()
    return {
      ok: false,
      currentVersion: app.getVersion(),
      code: 'install_failed',
      message
    }
  }
}
