import { describe, expect, it } from 'vitest'
import type { BrowserStorageLike } from './browser-storage'
import {
  DEV_PREVIEW_STATE_STORAGE_KEY,
  LEGACY_DEV_PREVIEW_AUTO_FOLLOW_STORAGE_KEY,
  LEGACY_DEV_PREVIEW_URL_STORAGE_KEY,
  devPreviewViewportScale,
  readDevPreviewWorkspaceState,
  rememberDevPreviewUrl,
  resolveInitialDevPreviewUrl,
  writeDevPreviewWorkspaceState
} from './dev-preview-state'

function memoryStorage(seed: Record<string, string> = {}): BrowserStorageLike & { values: Map<string, string> } {
  const values = new Map(Object.entries(seed))
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  }
}

describe('workspace Preview state', () => {
  it('migrates legacy global preferences once without leaking them to another workspace', () => {
    const storage = memoryStorage({
      [LEGACY_DEV_PREVIEW_URL_STORAGE_KEY]: 'localhost:4173',
      [LEGACY_DEV_PREVIEW_AUTO_FOLLOW_STORAGE_KEY]: 'false'
    })
    expect(readDevPreviewWorkspaceState('/work/a', storage)).toMatchObject({
      url: 'http://localhost:4173/',
      autoFollow: false,
      recentUrls: ['http://localhost:4173/']
    })
    expect(readDevPreviewWorkspaceState('/work/b', storage)).toMatchObject({
      url: null,
      autoFollow: true,
      recentUrls: []
    })
    expect(JSON.parse(storage.values.get(DEV_PREVIEW_STATE_STORAGE_KEY) ?? '{}')).toMatchObject({
      version: 2,
      legacyMigrated: true
    })
  })

  it('isolates workspace preferences and bounds recent addresses', () => {
    const storage = memoryStorage()
    let state = readDevPreviewWorkspaceState('/work/a', storage)
    for (let port = 3000; port < 3010; port += 1) {
      state = rememberDevPreviewUrl(state, `localhost:${port}`)
    }
    writeDevPreviewWorkspaceState('/work/a', { ...state, viewport: 'phone' }, storage)
    writeDevPreviewWorkspaceState('/work/b', {
      url: 'http://localhost:5173/', autoFollow: true, viewport: 'desktop', recentUrls: []
    }, storage)
    expect(readDevPreviewWorkspaceState('/work/a', storage).recentUrls).toHaveLength(6)
    expect(readDevPreviewWorkspaceState('/work/a', storage).viewport).toBe('phone')
    expect(readDevPreviewWorkspaceState('/work/b', storage).viewport).toBe('desktop')
  })

  it('uses preferred, workspace, then detected URL priority', () => {
    expect(resolveInitialDevPreviewUrl({
      preferredUrl: 'localhost:3000', workspaceUrl: 'localhost:4000', detectedUrl: 'localhost:5000'
    })).toBe('http://localhost:3000/')
    expect(resolveInitialDevPreviewUrl({ workspaceUrl: 'localhost:4000', detectedUrl: 'localhost:5000' }))
      .toBe('http://localhost:4000/')
    expect(resolveInitialDevPreviewUrl({ detectedUrl: 'localhost:5000' }))
      .toBe('http://localhost:5000/')
  })
})

describe('Preview viewport math', () => {
  it('scales fixed sizes down uniformly and never scales above one', () => {
    expect(devPreviewViewportScale({
      availableWidth: 195, availableHeight: 422, viewportWidth: 390, viewportHeight: 844
    })).toBe(0.5)
    expect(devPreviewViewportScale({
      availableWidth: 1600, availableHeight: 900, viewportWidth: 1280, viewportHeight: 720
    })).toBe(1)
    expect(devPreviewViewportScale({
      availableWidth: 0, availableHeight: 900, viewportWidth: 1280, viewportHeight: 720
    })).toBe(1)
  })
})

