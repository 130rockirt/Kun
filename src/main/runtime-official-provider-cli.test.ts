import { describe, expect, it, vi } from 'vitest'
import {
  requestOfficialProviderCliInstall,
  requestOfficialProviderCliModels,
  requestOfficialProviderCliStatus
} from './runtime-official-provider-cli'

describe('runtime official provider CLI forwarding', () => {
  it('forwards legacy Main calls to the Runtime-owned API', async () => {
    const runtimeRequest = vi.fn(async (path: string, method?: string) => ({
      ok: true,
      status: 200,
      body: JSON.stringify(path.endsWith('/status')
        ? { installed: true, version: '1.1.8', directory: '/runtime/cli', download: null }
        : path.endsWith('/install')
          ? { status: 'done', receivedBytes: 1, totalBytes: 1 }
          : { models: [] })
    }))

    await expect(requestOfficialProviderCliStatus(runtimeRequest)).resolves.toMatchObject({ installed: true })
    await expect(requestOfficialProviderCliInstall(runtimeRequest)).resolves.toMatchObject({ status: 'done' })
    await expect(requestOfficialProviderCliModels(runtimeRequest)).resolves.toEqual({ models: [] })
    expect(runtimeRequest.mock.calls).toEqual([
      ['/v1/model-connections/official-cli/status', 'GET'],
      ['/v1/model-connections/official-cli/install', 'POST'],
      ['/v1/model-connections/official-cli/models', 'GET']
    ])
  })

  it('fails closed on malformed or failed Runtime responses', async () => {
    await expect(requestOfficialProviderCliStatus(async () => ({
      ok: true, status: 200, body: 'not-json'
    }))).rejects.toThrow('malformed')
    await expect(requestOfficialProviderCliModels(async () => ({
      ok: false,
      status: 503,
      body: JSON.stringify({ error: { message: 'official provider CLI is unavailable' } })
    }))).rejects.toThrow('official provider CLI is unavailable')
  })
})
