import { afterEach, describe, expect, it, vi } from 'vitest'
import { withManagerDataMutex } from './data-mutex.js'

const BASE_URL = 'http://127.0.0.1:19001'

function stubManagerEnv(): void {
  vi.stubEnv('KUN_MANAGER_BASE_URL', BASE_URL)
  vi.stubEnv('KUN_MANAGER_TOKEN', 'manager-token')
  vi.stubEnv('KUN_RUNTIME_INSTANCE_ID', 'runtime-1')
  vi.stubEnv('KUN_RUNTIME_FLAVOR', 'production')
}

describe('withManagerDataMutex', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('runs the operation while renewals keep the lease alive', async () => {
    vi.useFakeTimers()
    stubManagerEnv()
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/acquire')) {
        calls.push('acquire')
        return acquireResponse(true)
      }
      if (url.endsWith('/release')) {
        calls.push('release')
        return releaseResponse()
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    const result = await withManagerDataMutex('retention', async () => {
      await vi.advanceTimersByTimeAsync(7_000)
      return 'done'
    })

    expect(result).toBe('done')
    expect(calls.filter((call) => call === 'acquire').length).toBeGreaterThan(1)
    expect(calls).toContain('release')
  })

  it('rejects at the lease deadline without waiting for the operation', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    stubManagerEnv()
    let acquireCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/acquire')) {
        acquireCalls += 1
        if (acquireCalls === 1) return acquireResponse(true)
        throw new Error('manager unreachable')
      }
      if (url.endsWith('/release')) return releaseResponse()
      throw new Error(`unexpected request: ${url}`)
    }))

    const promise = withManagerDataMutex('retention', () => new Promise<string>((resolve) => {
      setTimeout(() => resolve('too late'), 60_000)
    }))
    const assertion = expect(promise).rejects.toThrow('shared data resource lease expired: retention')

    // Resource lease TTL is 10s; the operation is still pending then.
    await vi.advanceTimersByTimeAsync(10_000)
    await assertion
  })

  it('tolerates a transient renewal failure within the lease TTL', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    stubManagerEnv()
    let acquireCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/acquire')) {
        acquireCalls += 1
        // The first renewal (t=3s) fails transiently; the next one recovers.
        if (acquireCalls === 2) throw new Error('temporary manager 502')
        return acquireResponse(true)
      }
      if (url.endsWith('/release')) return releaseResponse()
      throw new Error(`unexpected request: ${url}`)
    }))

    const result = await withManagerDataMutex('retention', async () => {
      await vi.advanceTimersByTimeAsync(7_000)
      return 'done'
    })

    expect(result).toBe('done')
    expect(warn).toHaveBeenCalled()
  })

  it('rejects as soon as the manager reports the lease was taken over', async () => {
    vi.useFakeTimers()
    stubManagerEnv()
    let acquireCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/acquire')) {
        acquireCalls += 1
        if (acquireCalls === 1) return acquireResponse(true)
        return acquireResponse(false, 10, 'runtime-2')
      }
      if (url.endsWith('/release')) return releaseResponse()
      throw new Error(`unexpected request: ${url}`)
    }))

    const promise = withManagerDataMutex('retention', () => new Promise<string>((resolve) => {
      setTimeout(() => resolve('too late'), 60_000)
    }))
    const assertion = expect(promise).rejects.toThrow('shared data resource lease was lost: retention')

    // First renewal at t=3s reports acquired=false; fail fast from there.
    await vi.advanceTimersByTimeAsync(3_000)
    await assertion
  })

  it('ignores a renewal that settles after the operation already completed', async () => {
    vi.useFakeTimers()
    stubManagerEnv()
    let acquireCalls = 0
    let resolveRenewal!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/acquire')) {
        acquireCalls += 1
        if (acquireCalls === 1) return acquireResponse(true)
        return new Promise<Response>((resolve) => { resolveRenewal = resolve })
      }
      if (url.endsWith('/release')) return releaseResponse()
      throw new Error(`unexpected request: ${url}`)
    }))

    const result = await withManagerDataMutex('retention', async () => {
      await vi.advanceTimersByTimeAsync(5_000)
      return 'done'
    })
    expect(result).toBe('done')

    // A late "lease lost" answer after completion must not surface anywhere.
    resolveRenewal(acquireResponse(false, 10, 'runtime-2'))
    await vi.advanceTimersByTimeAsync(10_000)
  })
})

function acquireResponse(acquired: boolean, ttlSeconds = 10, ownerInstanceId = 'runtime-1'): Response {
  const now = Date.now()
  return new Response(JSON.stringify({
    acquired,
    lease: {
      resource: 'data:test',
      ownerFlavor: 'production',
      ownerInstanceId,
      acquiredAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlSeconds * 1_000).toISOString()
    }
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

function releaseResponse(): Response {
  return new Response(JSON.stringify({ released: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}
