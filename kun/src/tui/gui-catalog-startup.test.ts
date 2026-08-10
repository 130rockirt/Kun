import { describe, expect, it, vi } from 'vitest'
import type { GuiConfigSyncResult, GuiSharedSettings } from '../cli/gui-settings-bridge.js'
import type { SharedRuntimeConnection } from '../cli/shared-runtime.js'
import {
  importGuiProviderCatalogForTui,
  isDataDirLeaseConflictError
} from './gui-catalog-startup.js'

const settings = {
  settingsPath: '/tmp/kun-settings.json',
  dataDir: '/tmp/kun-data',
  defaultModel: '',
  defaultProviderId: '',
  providers: [],
  legacyRuntimePort: 18899,
  legacyRuntimeToken: ''
} satisfies GuiSharedSettings

const syncResult = {
  changed: true,
  config: {},
  applyRequest: {}
} as unknown as GuiConfigSyncResult

const liveConnection = {
  baseUrl: 'http://127.0.0.1:18899',
  runtimeToken: 'token',
  discovery: { pid: 1 }
} as unknown as SharedRuntimeConnection

describe('isDataDirLeaseConflictError', () => {
  it('matches active owner and config synchronization conflicts', () => {
    expect(isDataDirLeaseConflictError(
      new Error('Kun Runtime data directory is already owned by active process 55976: C:\\Users\\zhaid\\.kun\\data')
    )).toBe(true)
    expect(isDataDirLeaseConflictError(new Error('config synchronization is active'))).toBe(true)
    expect(isDataDirLeaseConflictError(new Error('disk full'))).toBe(false)
  })
})

describe('importGuiProviderCatalogForTui', () => {
  it('skips file sync when a live shared runtime already serves the data dir', async () => {
    const syncCatalog = vi.fn(async () => syncResult)
    const result = await importGuiProviderCatalogForTui({
      dataDir: settings.dataDir,
      settings,
      fetch: vi.fn() as unknown as typeof fetch,
      resolveLiveSharedRuntime: vi.fn(async () => liveConnection),
      syncCatalog
    })
    expect(result).toEqual({ sync: null, warning: '' })
    expect(syncCatalog).not.toHaveBeenCalled()
  })

  it('imports the GUI catalog on cold start when no shared runtime is live', async () => {
    const syncCatalog = vi.fn(async () => syncResult)
    const result = await importGuiProviderCatalogForTui({
      dataDir: settings.dataDir,
      settings,
      fetch: vi.fn() as unknown as typeof fetch,
      resolveLiveSharedRuntime: vi.fn(async () => null),
      syncCatalog
    })
    expect(result).toEqual({ sync: syncResult, warning: '' })
    expect(syncCatalog).toHaveBeenCalledOnce()
  })

  it('silently ignores lease conflicts that race after the live probe', async () => {
    const result = await importGuiProviderCatalogForTui({
      dataDir: settings.dataDir,
      settings,
      fetch: vi.fn() as unknown as typeof fetch,
      resolveLiveSharedRuntime: vi.fn(async () => null),
      syncCatalog: vi.fn(async () => {
        throw new Error('Kun Runtime data directory is already owned by active process 55976: /tmp/kun-data')
      })
    })
    expect(result).toEqual({ sync: null, warning: '' })
  })

  it('surfaces non-lease import failures as warnings', async () => {
    const result = await importGuiProviderCatalogForTui({
      dataDir: settings.dataDir,
      settings,
      fetch: vi.fn() as unknown as typeof fetch,
      resolveLiveSharedRuntime: vi.fn(async () => null),
      syncCatalog: vi.fn(async () => {
        throw new Error('permission denied')
      })
    })
    expect(result).toEqual({
      sync: null,
      warning: 'could not import GUI model catalog: permission denied'
    })
  })
})
