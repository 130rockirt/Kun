import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
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

export function configureBrowserUseHost(options: BrowserUseHostOptions): BrowserUseManager {
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
  currentSettings = resolveKunRuntimeSettings(settings).browserUse
  currentAuditPath = browserUseAuditPath(settings)
}

export function getBrowserUseManager(): BrowserUseManager | undefined {
  return manager
}

export async function prepareBrowserUseHostForKunLaunch(): Promise<
  BrowserUseBridgeLaunch | undefined
> {
  return queueLifecycle(async () => {
    if (!manager || !bridge || !currentSettings?.enabled) {
      await bridge?.stop()
      return undefined
    }
    // A managed runtime restart receives a fresh token and no reusable browser
    // session or pending authority.
    await bridge.stop()
    return bridge.start()
  })
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
    await mkdir(dirname(auditPath), { recursive: true })
    await appendFile(auditPath, `${JSON.stringify(record)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
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
