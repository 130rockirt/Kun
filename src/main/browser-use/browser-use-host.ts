import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import {
  DEFAULT_KUN_DATA_DIR,
  resolveKunRuntimeSettings,
  type AppSettingsV1,
  type KunBrowserUseSettingsV1
} from '../../shared/app-settings'
import {
  BrowserUseAuditEntrySchema,
  type BrowserUseAuditEntry,
  type BrowserUseViewState
} from '../../shared/browser-use'
import { expandHomePath } from '../settings-store'
import { appendBrowserUseAuditLine } from './browser-use-audit-log'
import { BrowserUseBridgeService, type BrowserUseBridgeLaunch } from './browser-use-bridge-service'
import { BrowserUseManager } from './browser-use-manager'

type BrowserUseHostOptions = {
  settings: AppSettingsV1
  getMainWindow: () => BrowserWindow | null
}

let currentSettings: KunBrowserUseSettingsV1 | undefined
let currentAuditPath: string | undefined
let getMainWindow: (() => BrowserWindow | null) | undefined
let manager: BrowserUseManager | undefined
let bridge: BrowserUseBridgeService | undefined
let auditQueue: Promise<void> = Promise.resolve()
let lifecycleQueue: Promise<void> = Promise.resolve()
let hostShuttingDown = false
let lastIssuedBinding: BrowserUseBridgeLaunch | undefined

export function configureBrowserUseHost(options: BrowserUseHostOptions): BrowserUseManager {
  hostShuttingDown = false
  lastIssuedBinding = undefined
  currentSettings = resolveKunRuntimeSettings(options.settings).browserUse
  currentAuditPath = browserUseAuditPath(options.settings)
  getMainWindow = options.getMainWindow
  if (!manager) {
    manager = new BrowserUseManager({
      settings: () => currentSettings ?? disabledSettings(),
      onState: publishUnboundState,
      onAudit: queueAuditWrite
    })
    bridge = new BrowserUseBridgeService(manager)
  }
  return manager
}

export function updateBrowserUseHostSettings(settings: AppSettingsV1): void {
  const nextSettings = resolveKunRuntimeSettings(settings).browserUse
  const resetSessions = currentSettings !== undefined && browserSessionPolicyChanged(
    currentSettings,
    nextSettings
  )
  currentSettings = nextSettings
  currentAuditPath = browserUseAuditPath(settings)
  if (resetSessions && bridge) {
    // Mode, tab ownership, enablement, and idle lifetime are session-scoped.
    // Queue teardown ahead of the subsequent hot-bind so an existing session
    // cannot retain authority from the previous policy snapshot.
    void queueLifecycle(async () => {
      await bridge?.stop()
    })
  }
}

export function getBrowserUseManager(): BrowserUseManager | undefined {
  return manager
}

export async function prepareBrowserUseHostForKunLaunch(
  settings?: AppSettingsV1
): Promise<
  BrowserUseBridgeLaunch | undefined
> {
  if (hostShuttingDown) return undefined
  if (settings) updateBrowserUseHostSettings(settings)
  return queueLifecycle(async () => {
    if (hostShuttingDown || !manager || !bridge || !currentSettings?.enabled) {
      await bridge?.stop()
      return undefined
    }
    // A managed runtime restart receives a fresh token and no reusable browser
    // session or pending authority.
    await bridge.stop()
    if (hostShuttingDown) return undefined
    const binding = await bridge.start()
    if (hostShuttingDown) {
      await bridge.stop()
      return undefined
    }
    return rememberBinding(binding)
  })
}

/** Return the current launch authority, creating it without rotating live sessions. */
export async function ensureBrowserUseHostForRuntime(): Promise<
  BrowserUseBridgeLaunch | undefined
> {
  return queueLifecycle(async () => {
    if (hostShuttingDown || !manager || !bridge || !currentSettings?.enabled) {
      await bridge?.stop()
      return undefined
    }
    const binding = await bridge.start()
    if (hostShuttingDown) {
      await bridge.stop()
      return undefined
    }
    return rememberBinding(binding)
  })
}

export async function reconcileBrowserUseHostForRuntime(
  settings: AppSettingsV1,
  isCurrent: () => boolean = () => true
): Promise<{ current: boolean; binding?: BrowserUseBridgeLaunch }> {
  return queueLifecycle(async () => {
    const stillCurrent = (): boolean => isCurrent() && !hostShuttingDown
    if (!stillCurrent()) return { current: false }
    const nextSettings = resolveKunRuntimeSettings(settings).browserUse
    const resetSessions = currentSettings !== undefined && browserSessionPolicyChanged(
      currentSettings,
      nextSettings
    )
    currentSettings = nextSettings
    currentAuditPath = browserUseAuditPath(settings)
    if (resetSessions) await bridge?.stop()
    if (!stillCurrent()) return { current: false }
    if (!manager || !bridge || !currentSettings.enabled) {
      await bridge?.stop()
      return { current: true }
    }
    const binding = rememberBinding(await bridge.start())
    if (!stillCurrent()) {
      await bridge.stop()
      return { current: false }
    }
    return { current: true, binding }
  })
}

/** Fence shutdown synchronously so no later settings task can issue authority. */
export function beginBrowserUseHostShutdown(): BrowserUseBridgeLaunch | undefined {
  const owner = lastIssuedBinding
  if (hostShuttingDown) return owner
  hostShuttingDown = true
  void queueLifecycle(async () => {
    await bridge?.stop()
  })
  return owner
}

/** Wait until every already-entered host lifecycle operation has observed the fence. */
export function waitForBrowserUseHostLifecycle(): Promise<void> {
  return queueLifecycle(async () => undefined)
}

export async function stopBrowserUseHost(): Promise<void> {
  await queueLifecycle(async () => {
    await bridge?.stop()
    await auditQueue.catch(() => undefined)
  })
}

function queueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const task = lifecycleQueue.catch(() => undefined).then(operation)
  lifecycleQueue = task.then(() => undefined, () => undefined)
  return task
}

function rememberBinding(binding: BrowserUseBridgeLaunch): BrowserUseBridgeLaunch {
  lastIssuedBinding = binding
  return binding
}

function publishUnboundState(state: BrowserUseViewState): void {
  const window = getMainWindow?.()
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
  // The Renderer uses this only to activate the matching thread's Browser tab.
  // Session ownership is revalidated again when the protected mount IPC runs.
  window.webContents.send('browser-use:state', state)
}

function queueAuditWrite(entry: BrowserUseAuditEntry): void {
  const auditPath = currentAuditPath
  if (!auditPath) return
  const record = BrowserUseAuditEntrySchema.parse(entry)
  auditQueue = auditQueue.then(async () => {
    await appendBrowserUseAuditLine(auditPath, JSON.stringify(record))
  }).catch(() => undefined)
}

function browserUseAuditPath(settings: AppSettingsV1): string {
  const dataDir = resolveKunRuntimeSettings(settings).dataDir.trim() || DEFAULT_KUN_DATA_DIR
  return join(expandHomePath(dataDir), 'browser-use', 'audit.jsonl')
}

function disabledSettings(): KunBrowserUseSettingsV1 {
  return {
    enabled: false,
    mode: 'public',
    approvalMode: 'auto-safe',
    maxTabs: 2,
    maxObservationActionsPerTurn: 30,
    maxInteractionActionsPerTurn: 12,
    maxSnapshotNodes: 250,
    maxSnapshotTextChars: 20_000,
    maxImageDimension: 1280,
    idleTimeoutMs: 300_000
  }
}

function browserSessionPolicyChanged(
  previous: KunBrowserUseSettingsV1,
  next: KunBrowserUseSettingsV1
): boolean {
  return previous.enabled !== next.enabled ||
    previous.mode !== next.mode ||
    previous.approvalMode !== next.approvalMode ||
    previous.maxTabs !== next.maxTabs ||
    previous.idleTimeoutMs !== next.idleTimeoutMs
}
