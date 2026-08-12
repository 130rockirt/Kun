import { describe, expect, it, vi } from 'vitest'
import type { RuntimeFlavor, RuntimeRegistration } from '../../kun/src/contracts/runtime-flavor.js'
import { stopSharedRuntime } from '../../kun/src/cli/shared-runtime.js'
import type { ServiceManagerConnection } from '../../kun/src/manager/manager-client.js'
import { stopAllKunBackgroundProcesses } from './restart-all-kun-processes'

const manager: ServiceManagerConnection = {
  discovery: {
    version: 1,
    protocolVersion: 1,
    instanceId: 'manager-current',
    pid: 300,
    startedAt: '2026-08-12T00:00:00.000Z',
    host: '127.0.0.1',
    port: 43000,
    baseUrl: 'http://127.0.0.1:43000',
    managerToken: 'manager-token',
    serviceVersion: '0.1.0',
    dataDir: '/tmp/kun-data',
    settingsPath: '/tmp/kun-settings.json'
  }
}

function registration(flavor: RuntimeFlavor, pid: number): RuntimeRegistration {
  return {
    flavor,
    instanceId: `${flavor}-current`,
    pid,
    startedAt: '2026-08-12T00:00:00.000Z',
    host: '127.0.0.1',
    port: flavor === 'production' ? 43001 : 43002,
    baseUrl: `http://127.0.0.1:${flavor === 'production' ? 43001 : 43002}`,
    runtimeToken: `${flavor}-token`
  }
}

describe('stopAllKunBackgroundProcesses', () => {
  it('stops production, development, and the manager without forcing healthy processes', async () => {
    const runtimes = {
      production: registration('production', 101),
      development: registration('development', 202)
    }
    const stopRuntime = vi.fn(async (..._args: Parameters<typeof stopSharedRuntime>) => true)
    const shutdownManager = vi.fn(async () => undefined)
    const terminatePid = vi.fn(async () => true)

    const result = await stopAllKunBackgroundProcesses(manager, {
      readRuntime: vi.fn(async (_manager, flavor: RuntimeFlavor) => runtimes[flavor]),
      stopRuntime,
      shutdownManager,
      terminatePid,
      waitForExit: vi.fn(async () => true)
    })

    expect(stopRuntime).toHaveBeenCalledTimes(2)
    expect(stopRuntime.mock.calls.map((call) => call[2]?.runtimeFlavor)).toEqual([
      'production',
      'development'
    ])
    expect(shutdownManager).toHaveBeenCalledWith(manager)
    expect(terminatePid).not.toHaveBeenCalled()
    expect(result).toEqual({
      stoppedRuntimePids: [101, 202],
      forcedPids: [],
      managerPid: 300
    })
  })

  it('forces only manager-registered PIDs when graceful shutdown fails', async () => {
    const alive = new Set([101, 202, 300])
    const terminatePid = vi.fn(async (pid: number) => {
      alive.delete(pid)
      return true
    })

    const result = await stopAllKunBackgroundProcesses(manager, {
      readRuntime: vi.fn(async (_manager, flavor) =>
        flavor === 'production'
          ? registration(flavor, 101)
          : registration(flavor, 202)
      ),
      stopRuntime: vi.fn(async () => {
        throw new Error('runtime unavailable')
      }),
      shutdownManager: vi.fn(async () => {
        throw new Error('manager unavailable')
      }),
      terminatePid,
      waitForExit: vi.fn(async (pid) => !alive.has(pid))
    })

    expect(terminatePid.mock.calls.map(([pid]) => pid).sort((a, b) => a - b)).toEqual([101, 202, 300])
    expect(result.forcedPids.sort((a, b) => a - b)).toEqual([101, 202, 300])
  })

  it('fails closed when an authenticated runtime PID cannot be terminated', async () => {
    await expect(stopAllKunBackgroundProcesses(manager, {
      readRuntime: vi.fn(async (_manager, flavor) =>
        flavor === 'production' ? registration(flavor, 101) : null
      ),
      stopRuntime: vi.fn(async (_dataDir, _fetch, scope) => {
        if (scope.runtimeFlavor === 'production') throw new Error('runtime unavailable')
        return false
      }),
      shutdownManager: vi.fn(async () => undefined),
      terminatePid: vi.fn(async () => false),
      waitForExit: vi.fn(async (pid) => pid !== 101)
    })).rejects.toThrow('Kun process 101 could not be terminated')
  })
})
