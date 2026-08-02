import { afterEach, describe, expect, it, vi } from 'vitest'
import { AtomicJsonFile } from './atomic-json.js'

function validateCounter(value: unknown): { count: number } {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as { count?: unknown }).count !== 'number'
  ) throw new Error('invalid counter')
  return value as { count: number }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('AtomicJsonFile manager data plane', () => {
  it('uses manager CAS and retries against the latest shared revision', async () => {
    vi.stubEnv('KUN_MANAGER_BASE_URL', 'http://127.0.0.1:19000')
    vi.stubEnv('KUN_MANAGER_TOKEN', 'manager-secret')
    vi.stubEnv('KUN_MANAGER_DATA_DIR', '/tmp/kun-shared-data')
    const responses = [
      new Response(JSON.stringify({ snapshot: { revision: 1, value: { count: 2 } } })),
      new Response(JSON.stringify({ code: 'revision_conflict', currentRevision: 2 }), { status: 409 }),
      new Response(JSON.stringify({ snapshot: { revision: 2, value: { count: 3 } } })),
      new Response(JSON.stringify({ snapshot: { revision: 3, value: { count: 4 } } }))
    ]
    const fetchMock = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit
    ) => responses.shift() ?? new Response(null, { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)

    const file = new AtomicJsonFile('/tmp/kun-shared-data/extensions/state.json', validateCounter)
    await expect(file.update(() => ({ count: 0 }), (current) => ({
      count: current.count + 1
    }))).resolves.toEqual({ count: 4 })

    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:19000/v1/data/atomic-json/read')
    const finalWrite = fetchMock.mock.calls[3]?.[1] as RequestInit
    expect(finalWrite.headers).toMatchObject({ authorization: 'Bearer manager-secret' })
    expect(JSON.parse(String(finalWrite.body))).toMatchObject({
      expectedRevision: 2,
      value: { count: 4 }
    })
  })

  it('does not route profile-local JSON outside the canonical data directory', async () => {
    vi.stubEnv('KUN_MANAGER_BASE_URL', 'http://127.0.0.1:19000')
    vi.stubEnv('KUN_MANAGER_TOKEN', 'manager-secret')
    vi.stubEnv('KUN_MANAGER_DATA_DIR', '/tmp/kun-shared-data')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const file = new AtomicJsonFile('/tmp/kun-dv-profile/view-state.json', validateCounter)
    await expect(file.read(() => ({ count: 9 }))).resolves.toEqual({ count: 9 })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
