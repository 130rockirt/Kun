import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { RemoteHostController } from '../../../kun/src/adapters/computer-use/remote-host-control.js'
import type { HostControlController } from '../../../kun/src/adapters/computer-use/host-control.js'
import {
  COMPUTER_USE_BRIDGE_CONTRACT_VERSION
} from '../../../kun/src/contracts/computer-use-bridge.js'
import { ComputerUseBridgeService } from './computer-use-bridge-service'

function fakeController(): HostControlController {
  return {
    ensureReady: vi.fn(async () => ({ available: true })),
    screenSize: vi.fn(async () => ({ width: 1280, height: 720 })),
    capture: vi.fn(async () => ({
      mimeType: 'image/png',
      dataBase64: 'cG5n',
      width: 1280,
      height: 720
    })),
    cursorPosition: vi.fn(async () => ({ x: 10, y: 20 })),
    moveTo: vi.fn(async () => undefined),
    click: vi.fn(async () => undefined),
    drag: vi.fn(async () => undefined),
    scroll: vi.fn(async () => undefined),
    typeText: vi.fn(async () => undefined),
    pressHotkey: vi.fn(async () => undefined),
    wait: vi.fn(async () => undefined)
  }
}

describe('ComputerUseBridgeService', () => {
  it('requires the launch bearer and validates the request contract', async () => {
    const controller = fakeController()
    const service = new ComputerUseBridgeService(controller)
    const launch = await service.start()
    try {
      const unauthorized = await fetch(`${launch.url}/v1/actions`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer wrong-token',
          'content-type': 'application/json'
        },
        body: '{}'
      })
      expect(unauthorized.status).toBe(401)

      const invalid = await fetch(`${launch.url}/v1/actions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${launch.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          contractVersion: 999,
          requestId: randomUUID(),
          operation: 'ready'
        })
      })
      expect(invalid.status).toBe(400)
      expect(controller.ensureReady).not.toHaveBeenCalled()
    } finally {
      await service.stop()
    }
  })

  it('routes authenticated runtime actions through the GUI-owned controller', async () => {
    const controller = fakeController()
    const service = new ComputerUseBridgeService(controller)
    const launch = await service.start()
    const remote = new RemoteHostController(launch.url, launch.token)
    try {
      await expect(remote.ensureReady()).resolves.toEqual({ available: true })
      await expect(remote.screenSize()).resolves.toEqual({ width: 1280, height: 720 })
      await expect(remote.capture()).resolves.toMatchObject({
        mimeType: 'image/png',
        width: 1280,
        height: 720
      })
      await remote.click(32, 48, 'right', 2, ['Shift'])
      expect(controller.click).toHaveBeenCalledWith(32, 48, 'right', 2, ['Shift'])
    } finally {
      await service.stop()
    }

    await expect(remote.ensureReady()).resolves.toMatchObject({
      available: false,
      reason: expect.stringContaining('initiating GUI computer-use bridge is unavailable')
    })
  })

  it('does not reflect its token in successful responses', async () => {
    const service = new ComputerUseBridgeService(fakeController())
    const launch = await service.start()
    try {
      const requestId = randomUUID()
      const response = await fetch(`${launch.url}/v1/actions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${launch.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          contractVersion: COMPUTER_USE_BRIDGE_CONTRACT_VERSION,
          requestId,
          operation: 'cursor_position'
        })
      })
      const text = await response.text()
      expect(response.status).toBe(200)
      expect(text).toContain(requestId)
      expect(text).not.toContain(launch.token)
    } finally {
      await service.stop()
    }
  })
})
