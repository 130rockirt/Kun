import { app } from 'electron'
import { win32 as win32Path } from 'node:path'
import type { GuiUpdateChannel, GuiUpdateInfo, GuiUpdateInstallResult, GuiUpdateState } from '../shared/gui-update'
import { setWindowsInstallerUpdateSource } from './gui-updater-support'
import {
  GUI_UPDATE_BACKUP_GRACE_MS,
  GUI_UPDATE_HEALTH_RETRY_MS,
  GUI_UPDATE_MAX_HEALTH_ATTEMPTS,
  clearGuiUpdateRecovery,
  clearPendingUpdate,
  clearPendingUpdateResult,
  cleanupPendingUpdateBackup,
  readGuiUpdateRecovery,
  readPendingUpdate,
  readPendingUpdateResult,
  setPendingUpdateEnvironment,
  writeGuiUpdateRecovery,
  writePendingUpdate
} from './gui-updater-pending'

type InstallerDetails = {
  hasDownloaded: boolean
  targetVersion: string
  channel: GuiUpdateChannel
}

type GuiUpdateInstallerDeps = {
  runExclusive: <T>(task: () => Promise<T>) => Promise<T>
  details: () => InstallerDetails
  stateInfo: () => Extract<GuiUpdateInfo, { ok: true }> | undefined
  emit: (state: GuiUpdateState) => void
  prepare: () => Promise<void>
  clearPreparation: () => void
  setQuitting: (active: boolean) => void
  quitAndInstall: () => void
  isSessionEnding: () => boolean
}

export class GuiUpdateInstaller {
  private installPromise: Promise<GuiUpdateInstallResult> | null = null
  private handoffPending = false
  private handoffStarted = false
  private attemptActive = false
  private launchError: Error | null = null
  private recoveryScheduled = false
  private recoveryTriggered = false
  private installerPath = ''
  private installerSha512 = ''

  constructor(private readonly deps: GuiUpdateInstallerDeps) {}

  setDownloadedInstaller(paths: string[], sha512: string): void {
    this.installerPath = paths[0] ?? ''
    this.installerSha512 = sha512
  }

  clearDownloadedInstaller(): void {
    this.installerPath = ''
    this.installerSha512 = ''
  }

  install(): Promise<GuiUpdateInstallResult> {
    if (this.installPromise) return this.installPromise
    if (this.attemptActive || this.handoffPending || this.handoffStarted) return Promise.resolve({ ok: true })
    const operation = this.deps.runExclusive(() => this.installOnce())
    this.installPromise = operation
    void operation.finally(() => {
      if (this.installPromise === operation) this.installPromise = null
    })
    return operation
  }

  onBeforeQuitForUpdate(): void {
    if (this.handoffPending) {
      this.handoffStarted = true
      this.handoffPending = false
    }
    this.deps.setQuitting(true)
    void this.deps.prepare().catch((error) => {
      this.deps.clearPreparation()
      this.deps.setQuitting(false)
      console.warn('[kun-gui updater] failed to stop runtimes before update quit:', error)
    })
  }

  onUpdaterError(error: unknown): boolean {
    if (!this.attemptActive) return false
    this.launchError = error instanceof Error ? error : new Error(String(error))
    this.scheduleRecovery()
    return true
  }

  async reconcile(healthCheck?: () => Promise<boolean>): Promise<void> {
    let recovery = await readGuiUpdateRecovery()
    const pending = await readPendingUpdate()
    const result = await readPendingUpdateResult()
    if (pending && result?.outcome === 'aborted') {
      await cleanupPendingUpdateBackup(result.backupDir)
      await clearPendingUpdateResult()
      await clearPendingUpdate()
      this.deps.emit({ status: 'error', info: this.deps.stateInfo(), code: 'install_failed',
        message: result.message || `The update installer stopped during ${result.phase ?? result.code}.` })
      return
    }
    if (pending) {
      const installed = app.getVersion() === pending.newVersion
      const stale = Date.now() - Date.parse(pending.writtenAt) >= 86_400_000
      if (installed && (result?.outcome === 'success' || stale)) {
        recovery = await writeGuiUpdateRecovery({
          installedVersion: pending.newVersion,
          channel: pending.channel,
          verifiedAt: new Date().toISOString(),
          healthAttempts: 0,
          backupDir: result?.backupDir,
          backupExpiresAt: new Date(Date.now() + GUI_UPDATE_BACKUP_GRACE_MS).toISOString()
        })
        await clearPendingUpdateResult()
        await clearPendingUpdate()
      } else if (!installed && stale) {
        await cleanupPendingUpdateBackup(result?.backupDir)
        await clearPendingUpdateResult()
        await clearPendingUpdate()
      }
    }
    if (!recovery) return
    if (Date.now() >= Date.parse(recovery.backupExpiresAt)) {
      await cleanupPendingUpdateBackup(recovery.backupDir)
      await clearGuiUpdateRecovery()
      return
    }
    const retryAt = recovery.nextHealthCheckAt ? Date.parse(recovery.nextHealthCheckAt) : 0
    if (recovery.healthAttempts >= GUI_UPDATE_MAX_HEALTH_ATTEMPTS || retryAt > Date.now()) {
      this.emitDegraded(recovery.healthAttempts, recovery.lastError)
      return
    }
    const healthy = await (healthCheck?.() ?? Promise.resolve(true)).catch(() => false)
    if (healthy) {
      await cleanupPendingUpdateBackup(recovery.backupDir)
      await clearGuiUpdateRecovery()
      return
    }
    const attempts = recovery.healthAttempts + 1
    const message = 'GUI update installed, but Kun Runtime health checks are still failing.'
    await writeGuiUpdateRecovery({ ...recovery, healthAttempts: attempts,
      nextHealthCheckAt: new Date(Date.now() + GUI_UPDATE_HEALTH_RETRY_MS).toISOString(), lastError: message })
    this.emitDegraded(attempts, message)
  }

  private emitDegraded(attempts: number, message?: string): void {
    this.deps.emit({ status: 'error', info: this.deps.stateInfo(), code: 'install_failed',
      message: `${message || 'Kun Runtime needs repair after the GUI update.'} Health attempts: ${attempts}.` })
  }

  private async installOnce(): Promise<GuiUpdateInstallResult> {
    if (this.deps.isSessionEnding()) return deferredResult()
    const details = this.deps.details()
    if (!details.hasDownloaded) return failedResult('The update has not finished downloading yet.')
    this.deps.emit({ status: 'installing', info: this.deps.stateInfo() })
    this.deps.setQuitting(true)
    let quittingMarked = true
    let restoreEnvironment = (): void => undefined
    try {
      await this.deps.prepare()
      const current = this.deps.details()
      if (!current.hasDownloaded) {
        this.deps.clearPreparation()
        this.deps.setQuitting(false)
        quittingMarked = false
        return failedResult('The selected update is no longer eligible for installation.')
      }
      if (this.deps.isSessionEnding()) {
        throw Object.assign(new Error('Windows is ending this session. The downloaded update will remain available next launch.'), {
          code: 'install_deferred'
        })
      }
      if (!this.installerPath) throw new Error('The downloaded installer path is unavailable.')
      const restoreUpdateSource = setWindowsInstallerUpdateSource()
      const restorePendingEnvironment = setPendingUpdateEnvironment()
      restoreEnvironment = () => {
        restorePendingEnvironment()
        restoreUpdateSource()
      }
      await clearPendingUpdateResult()
      await writePendingUpdate({
        oldVersion: app.getVersion(),
        newVersion: current.targetVersion,
        installDir: process.platform === 'win32' ? win32Path.dirname(process.execPath) : '',
        installerPath: this.installerPath,
        installerSha512: this.installerSha512 || undefined,
        channel: current.channel
      })
      this.attemptActive = true
      this.handoffPending = true
      this.handoffStarted = false
      this.launchError = null
      this.deps.quitAndInstall()
      if (this.launchError) throw this.launchError
      return { ok: true }
    } catch (error) {
      const deferred = (error as { code?: unknown })?.code === 'install_deferred'
      restoreEnvironment()
      this.reset(false)
      if (quittingMarked) {
        this.deps.clearPreparation()
        this.deps.setQuitting(false)
      }
      if (!deferred) await clearPendingUpdate()
      const message = error instanceof Error ? error.message : String(error)
      this.deps.emit({ status: 'error', info: this.deps.stateInfo(), message, code: deferred ? 'install_deferred' : 'install_failed' })
      if (quittingMarked && !deferred) this.scheduleRecovery()
      return deferred ? deferredResult() : failedResult(message)
    }
  }

  private reset(clearPending: boolean): void {
    if (clearPending) void clearPendingUpdate()
    this.attemptActive = false
    this.handoffPending = false
    this.handoffStarted = false
    this.launchError = null
  }

  private scheduleRecovery(): void {
    if (this.recoveryScheduled || this.recoveryTriggered) return
    this.recoveryScheduled = true
    this.recoveryTriggered = true
    queueMicrotask(() => {
      this.recoveryScheduled = false
      this.reset(true)
      this.deps.clearPreparation()
      this.deps.setQuitting(false)
      try {
        app.relaunch()
        app.exit(0)
      } catch (error) {
        console.error('[kun-gui updater] failed to relaunch after update install failure:', error)
      }
    })
  }
}

function failedResult(message: string): GuiUpdateInstallResult {
  return { ok: false, currentVersion: app.getVersion(), code: 'install_failed', message }
}

function deferredResult(): GuiUpdateInstallResult {
  return {
    ok: false,
    currentVersion: app.getVersion(),
    code: 'install_deferred',
    message: 'Windows is ending this session. The downloaded update will remain available next launch.'
  }
}
