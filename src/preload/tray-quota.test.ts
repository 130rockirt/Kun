import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('tray quota preload boundary', () => {
  it('exposes only the dedicated tray quota API surface', async () => {
    const source = await readFile(new URL('./tray-quota.ts', import.meta.url), 'utf8')

    expect(source).toContain("contextBridge.exposeInMainWorld('kunTrayQuota', api)")
    expect(source).not.toContain("exposeInMainWorld('kunGui'")
    expect(source).not.toContain('runtimeRequest')
    expect(source).not.toContain('getSettings')
  })
})
