import { afterEach, describe, expect, it, vi } from 'vitest'
import { isolateManagerDataOwnerEnvironment } from './manager-entry.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('manager entry environment', () => {
  it('drops a stale client endpoint while retaining manager bootstrap inputs', () => {
    vi.stubEnv('KUN_MANAGER_BASE_URL', 'http://127.0.0.1:19999')
    vi.stubEnv('KUN_MANAGER_TOKEN', 'new-manager-token')
    vi.stubEnv('KUN_MANAGER_DATA_DIR', '/tmp/kun-data')

    isolateManagerDataOwnerEnvironment()

    expect(process.env.KUN_MANAGER_BASE_URL).toBeUndefined()
    expect(process.env.KUN_MANAGER_TOKEN).toBe('new-manager-token')
    expect(process.env.KUN_MANAGER_DATA_DIR).toBe('/tmp/kun-data')
  })
})
