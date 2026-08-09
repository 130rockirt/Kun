import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_CHECKPOINT_CLEANUP_ENABLED,
  DEFAULT_CHECKPOINT_CLEANUP_INTERVAL_DAYS,
  DEFAULT_GIT_CHECKPOINT_CREATE_ENABLED,
  defaultKunRuntimeSettings,
  defaultModelProviderSettings
} from '../shared/app-settings'
import { DEFAULT_GUI_UPDATE_CHANNEL } from '../shared/gui-update'
import { devServerHintUrl, JsonSettingsStore } from './settings-store'

type SettingsStoreModule = typeof import('./settings-store')

async function withMockedHome<T>(
  homeDir: string,
  run: (settingsStore: SettingsStoreModule) => Promise<T>
): Promise<T> {
  vi.resetModules()
  vi.doMock('node:os', () => ({ homedir: () => homeDir }))
  try {
    return await run(await import('./settings-store'))
  } finally {
    vi.doUnmock('node:os')
    vi.resetModules()
  }
}

describe('development renderer URL boundary', () => {
  it('ignores renderer URL injection in packaged applications', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'https://attacker.example/')
    try {
      expect(devServerHintUrl(true)).toBeUndefined()
      expect(devServerHintUrl(false)).toBe('https://attacker.example/')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
