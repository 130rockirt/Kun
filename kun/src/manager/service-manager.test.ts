import { describe, expect, it, vi } from 'vitest'
import { dispatchRequest } from '../server/http-server.js'
import {
  buildServiceManagerRouter,
  ServiceManagerState,
  ThreadLeaseBusyError
} from './service-manager.js'

function registration(flavor: 'production' | 'development', instanceId = `${flavor}-runtime`) {
  return {
    flavor,
    instanceId,
    pid: process.pid,
    startedAt: '2026-08-01T00:00:00.000Z',
    host: '127.0.0.1',
    port: flavor === 'production' ? 18899 : 18999,
    baseUrl: `http://127.0.0.1:${flavor === 'production' ? 18899 : 18999}`,
    runtimeToken: `${flavor}-secret`
  }
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1${path}`, {
    ...init,
    headers: {
      authorization: 'Bearer manager-secret',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers
    }
  })
}

describe('service manager control plane', () => {
  it('reports health without exposing the manager token', async () => {
    const router = buildServiceManagerRouter({
      managerToken: 'manager-secret',
      instanceId: 'manager-a',
      startedAt: '2026-08-01T00:00:00.000Z',
      state: new ServiceManagerState()
    })
    const response = await dispatchRequest(router, new Request('http://127.0.0.1/health'))
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(JSON.parse(text)).toMatchObject({
      status: 'ok',
      service: 'kun-service-manager',
      protocolVersion: 1,
      instanceId: 'manager-a'
    })
    expect(text).not.toContain('manager-secret')
  })

  it('keeps independent production and development runtime slots', async () => {
    const state = new ServiceManagerState()
    const router = buildServiceManagerRouter({
      managerToken: 'manager-secret',
      instanceId: 'manager-a',
      startedAt: '2026-08-01T00:00:00.000Z',
      state
    })
    for (const flavor of ['production', 'development'] as const) {
      const response = await dispatchRequest(router, request(`/v1/runtimes/${flavor}/register`, {
        method: 'PUT',
        body: JSON.stringify(registration(flavor))
      }))
      expect(response.status).toBe(200)
    }
    expect(state.registration('production')?.port).toBe(18899)
    expect(state.registration('development')?.port).toBe(18999)
  })

  it('rejects unauthenticated registration and stale heartbeats', async () => {
    const state = new ServiceManagerState()
    const router = buildServiceManagerRouter({
      managerToken: 'manager-secret',
      instanceId: 'manager-a',
      startedAt: '2026-08-01T00:00:00.000Z',
      state
    })
    const unauthorized = await dispatchRequest(router, new Request(
      'http://127.0.0.1/v1/runtimes/production/register',
      { method: 'PUT', body: JSON.stringify(registration('production')) }
    ))
    expect(unauthorized.status).toBe(401)

    state.register(registration('production'))
    const heartbeat = await dispatchRequest(router, request('/v1/runtimes/production/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ instanceId: 'stale-runtime' })
    }))
    expect(heartbeat.status).toBe(409)
  })

  it('accepts shutdown only for the current manager instance', async () => {
    const shutdown = vi.fn()
    const router = buildServiceManagerRouter({
      managerToken: 'manager-secret',
      instanceId: 'manager-a',
      startedAt: '2026-08-01T00:00:00.000Z',
      state: new ServiceManagerState(),
      requestShutdown: shutdown
    })
    const stale = await dispatchRequest(router, request('/v1/manager/shutdown', {
      method: 'POST', body: JSON.stringify({ instanceId: 'manager-old' })
    }))
    expect(stale.status).toBe(409)
    const current = await dispatchRequest(router, request('/v1/manager/shutdown', {
      method: 'POST', body: JSON.stringify({ instanceId: 'manager-a' })
    }))
    expect(current.status).toBe(200)
    expect(shutdown).toHaveBeenCalledOnce()
  })

  it('allows only one runtime flavor to lease a thread', () => {
    const state = new ServiceManagerState()
    const now = new Date('2026-08-01T00:00:00.000Z')
    state.register(registration('production'), now)
    state.register(registration('development'), now)
    const lease = state.acquireLease({
      threadId: 'thread-shared',
      turnId: 'turn-production',
      ownerFlavor: 'production',
      ownerInstanceId: 'production-runtime'
    }, now)
    expect(lease.ownerFlavor).toBe('production')
    expect(() => state.acquireLease({
      threadId: 'thread-shared',
      turnId: 'turn-development',
      ownerFlavor: 'development',
      ownerInstanceId: 'development-runtime'
    }, now)).toThrow(ThreadLeaseBusyError)
    expect(state.releaseLease({
      threadId: 'thread-shared',
      turnId: 'turn-production',
      ownerFlavor: 'production',
      ownerInstanceId: 'production-runtime'
    })).toBe(true)
    expect(state.acquireLease({
      threadId: 'thread-shared',
      turnId: 'turn-development',
      ownerFlavor: 'development',
      ownerInstanceId: 'development-runtime'
    }, now).ownerFlavor).toBe('development')
  })

  it('expires leases when the owning runtime heartbeat disappears', () => {
    const state = new ServiceManagerState()
    const started = new Date('2026-08-01T00:00:00.000Z')
    state.register(registration('production'), started)
    state.acquireLease({
      threadId: 'thread-orphan',
      turnId: 'turn-orphan',
      ownerFlavor: 'production',
      ownerInstanceId: 'production-runtime'
    }, started)
    const expired = state.expireStale(new Date('2026-08-01T00:00:21.000Z'))
    expect(expired).toMatchObject([{ threadId: 'thread-orphan', turnId: 'turn-orphan' }])
    expect(state.lease('thread-orphan', new Date('2026-08-01T00:00:21.000Z'))).toBeNull()
  })

  it('gives production preference for singleton desktop resources', () => {
    const state = new ServiceManagerState()
    const now = new Date('2026-08-01T00:00:00.000Z')
    expect(state.acquireResource({
      resource: 'desktop-background-services',
      ownerFlavor: 'development',
      ownerInstanceId: 'dv-gui'
    }, now).acquired).toBe(true)
    const production = state.acquireResource({
      resource: 'desktop-background-services',
      ownerFlavor: 'production',
      ownerInstanceId: 'production-gui'
    }, now)
    expect(production).toMatchObject({
      acquired: true,
      lease: { ownerFlavor: 'production', ownerInstanceId: 'production-gui' }
    })
    expect(state.acquireResource({
      resource: 'desktop-background-services',
      ownerFlavor: 'development',
      ownerInstanceId: 'dv-gui'
    }, now).acquired).toBe(false)
  })

  it('does not let production preempt a development data-plane mutex', () => {
    const state = new ServiceManagerState()
    const now = new Date('2026-08-01T00:00:00.000Z')
    expect(state.acquireResource({
      resource: 'data:graph-write-coordinator',
      ownerFlavor: 'development',
      ownerInstanceId: 'development-runtime'
    }, now).acquired).toBe(true)
    expect(state.acquireResource({
      resource: 'data:graph-write-coordinator',
      ownerFlavor: 'production',
      ownerInstanceId: 'production-runtime'
    }, now).acquired).toBe(false)
  })

  it('restores runtime and lease ownership after a manager restart', () => {
    const before = new ServiceManagerState()
    const now = new Date('2026-08-01T00:00:00.000Z')
    before.register(registration('production'), now)
    before.acquireLease({
      threadId: 'thread-restart',
      turnId: 'turn-restart',
      ownerFlavor: 'production',
      ownerInstanceId: 'production-runtime'
    }, now)
    before.acquireResource({
      resource: 'desktop-background-services',
      ownerFlavor: 'production',
      ownerInstanceId: 'production-gui'
    }, now)

    const after = ServiceManagerState.restore(before.durableSnapshot())
    expect(after.registration('production')).toMatchObject({ instanceId: 'production-runtime' })
    expect(after.lease('thread-restart', new Date('2026-08-01T00:00:01.000Z'))).toMatchObject({
      turnId: 'turn-restart',
      ownerFlavor: 'production'
    })
    expect(after.acquireResource({
      resource: 'desktop-background-services',
      ownerFlavor: 'development',
      ownerInstanceId: 'development-gui'
    }, new Date('2026-08-01T00:00:01.000Z')).acquired).toBe(false)
  })
})
