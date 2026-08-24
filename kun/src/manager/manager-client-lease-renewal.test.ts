import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ManagerThreadExecutionLeaseClient,
  type ServiceManagerConnection
} from './manager-client.js'

const manager = {
  discovery: {
    baseUrl: 'http://127.0.0.1:19001',
    managerToken: 'manager-token'
  }
} as ServiceManagerConnection

describe('ManagerThreadExecutionLeaseClient renewal', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('retries a transient renewal failure instead of aborting the live turn', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let renewAttempts = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/acquire')) return leaseResponse(0)
      if (url.endsWith('/renew')) {
        renewAttempts += 1
        if (renewAttempts === 1) throw new Error('temporary manager timeout')
        return leaseResponse(10)
      }
      throw new Error(`unexpected request: ${url}`)
    }))
    const client = new ManagerThreadExecutionLeaseClient(manager, 'production', 'runtime-1')
    const leaseLost = vi.fn()
    client.setLeaseLostHandler(leaseLost)

    await client.acquire('thread-1', 'turn-1')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(renewAttempts).toBe(1)
    expect(leaseLost).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(500)
    expect(renewAttempts).toBe(2)
    expect(leaseLost).not.toHaveBeenCalled()
    client.shutdown()
  })

  it('aborts only after the manager definitively rejects the renewal', async () => {
    vi.useFakeTimers()
    let renewAttempts = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/acquire')) return leaseResponse(0)
      if (url.endsWith('/renew')) {
        renewAttempts += 1
        return new Response(JSON.stringify({ code: 'thread_lease_lost' }), {
          status: 409,
          headers: { 'content-type': 'application/json' }
        })
      }
      throw new Error(`unexpected request: ${url}`)
    }))
    const client = new ManagerThreadExecutionLeaseClient(manager, 'production', 'runtime-1')
    const leaseLost = vi.fn()
    client.setLeaseLostHandler(leaseLost)

    const lease = await client.acquire('thread-1', 'turn-1')
    await vi.advanceTimersByTimeAsync(5_000)

    expect(leaseLost).toHaveBeenCalledOnce()
    expect(leaseLost).toHaveBeenCalledWith(lease)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(renewAttempts).toBe(1)
    client.shutdown()
  })

  it('does not overlap renewals while a slow manager request is still pending', async () => {
    vi.useFakeTimers()
    let resolveRenewal!: (response: Response) => void
    const pendingRenewal = new Promise<Response>((resolve) => { resolveRenewal = resolve })
    let renewAttempts = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/acquire')) return leaseResponse(0)
      if (url.endsWith('/renew')) {
        renewAttempts += 1
        return pendingRenewal
      }
      throw new Error(`unexpected request: ${url}`)
    }))
    const client = new ManagerThreadExecutionLeaseClient(manager, 'production', 'runtime-1')

    await client.acquire('thread-1', 'turn-1')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(renewAttempts).toBe(1)

    resolveRenewal(leaseResponse(10))
    await vi.advanceTimersByTimeAsync(0)
    client.shutdown()
  })
})

function leaseResponse(seconds: number): Response {
  const acquiredAt = '2026-08-24T00:00:00.000Z'
  const expiresAt = new Date(Date.parse(acquiredAt) + (seconds + 15) * 1_000).toISOString()
  return new Response(JSON.stringify({
    lease: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      ownerFlavor: 'production',
      ownerInstanceId: 'runtime-1',
      acquiredAt,
      expiresAt
    }
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}
