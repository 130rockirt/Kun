import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  session: { fromPartition: vi.fn() },
  webContents: { fromId: vi.fn() }
}))

import { captureAuthorizedDevPreviewRegion } from './dev-preview-capture'
import {
  DEV_PREVIEW_CAPTURE_MAX_BYTES
} from '../shared/dev-preview-capture'

function image(options: { width?: number; height?: number; bytes?: number } = {}) {
  const width = options.width ?? 200
  const height = options.height ?? 100
  const value = {
    isEmpty: vi.fn(() => false),
    getSize: vi.fn(() => ({ width, height })),
    resize: vi.fn((size: { width: number }) => image({
      width: size.width,
      height: Math.max(1, Math.round(height * size.width / width)),
      bytes: options.bytes
    })),
    toPNG: vi.fn(() => Buffer.alloc(options.bytes ?? 32))
  }
  return value
}

function harness(overrides: Record<string, unknown> = {}) {
  const captured = image()
  const host = { id: 10 }
  const dedicatedSession = {}
  const guest = {
    id: 20,
    getType: vi.fn(() => 'webview'),
    getURL: vi.fn(() => 'http://localhost:3000/page'),
    hostWebContents: host,
    session: dedicatedSession,
    executeJavaScript: vi.fn(async () => ({ width: 390, height: 844 })),
    capturePage: vi.fn(async () => captured),
    isDestroyed: vi.fn(() => false),
    ...overrides
  }
  const mainWindow = {
    isDestroyed: vi.fn(() => false),
    webContents: host
  }
  return {
    event: { sender: host },
    request: {
      guestWebContentsId: 20,
      url: 'http://localhost:3000/page',
      rect: { x: 10, y: 20, width: 200, height: 100 }
    },
    guest,
    captured,
    dependencies: {
      getMainWindow: () => mainWindow,
      fromId: () => guest,
      isDedicatedPartition: (candidate: typeof guest) => candidate.session === dedicatedSession
    }
  }
}

describe('restricted development Preview capture', () => {
  beforeEach(() => vi.clearAllMocks())

  it('captures a valid owned local region and returns bounded PNG data', async () => {
    const value = harness()
    await expect(captureAuthorizedDevPreviewRegion(
      value.event as never,
      value.request,
      value.dependencies as never
    )).resolves.toMatchObject({
      ok: true,
      mimeType: 'image/png',
      width: 200,
      height: 100
    })
    expect(value.guest.capturePage).toHaveBeenCalledWith(value.request.rect)
  })

  it('resizes a large valid crop to a maximum 1280 pixel edge', async () => {
    const large = image({ width: 2000, height: 1000 })
    const value = harness({
      executeJavaScript: vi.fn(async () => ({ width: 3000, height: 2000 })),
      capturePage: vi.fn(async () => large)
    })
    const result = await captureAuthorizedDevPreviewRegion(
      value.event as never,
      { ...value.request, rect: { x: 0, y: 0, width: 2000, height: 1000 } },
      value.dependencies as never
    )
    expect(result).toMatchObject({ width: 1280, height: 640 })
  })

  it.each([
    ['wrong sender', () => harness(), (value: ReturnType<typeof harness>) => ({
      event: { sender: { id: 99 } }, request: value.request
    })],
    ['external guest type', () => harness({ getType: vi.fn(() => 'window') }), (value: ReturnType<typeof harness>) => ({ event: value.event, request: value.request })],
    ['wrong owner', () => harness({ hostWebContents: { id: 99 } }), (value: ReturnType<typeof harness>) => ({ event: value.event, request: value.request })],
    ['wrong partition', () => harness({ session: {} }), (value: ReturnType<typeof harness>) => ({ event: value.event, request: value.request })],
    ['non-local URL', () => harness({ getURL: vi.fn(() => 'https://example.com/') }), (value: ReturnType<typeof harness>) => ({ event: value.event, request: { ...value.request, url: 'https://example.com/' } })],
    ['URL race', () => harness({ getURL: vi.fn(() => 'http://localhost:3001/') }), (value: ReturnType<typeof harness>) => ({ event: value.event, request: value.request })],
    ['out of bounds crop', () => harness(), (value: ReturnType<typeof harness>) => ({ event: value.event, request: { ...value.request, rect: { x: 300, y: 800, width: 200, height: 100 } } })]
  ])('rejects %s', async (_label, make, select) => {
    const value = make()
    const chosen = select(value)
    await expect(captureAuthorizedDevPreviewRegion(
      chosen.event as never,
      chosen.request,
      value.dependencies as never
    )).rejects.toThrow()
    expect(value.guest.capturePage).not.toHaveBeenCalled()
  })

  it('rejects oversized encoded output', async () => {
    const oversized = image({ bytes: DEV_PREVIEW_CAPTURE_MAX_BYTES + 1 })
    const value = harness({ capturePage: vi.fn(async () => oversized) })
    await expect(captureAuthorizedDevPreviewRegion(
      value.event as never,
      value.request,
      value.dependencies as never
    )).rejects.toThrow('size limit')
  })

  it('rejects a navigation that races with the capture', async () => {
    let currentUrl = 'http://localhost:3000/page'
    const value = harness({
      getURL: vi.fn(() => currentUrl),
      executeJavaScript: vi.fn(async () => {
        currentUrl = 'http://localhost:3001/'
        return { width: 390, height: 844 }
      })
    })
    await expect(captureAuthorizedDevPreviewRegion(
      value.event as never,
      value.request,
      value.dependencies as never
    )).rejects.toThrow('changed during capture')
    expect(value.guest.capturePage).not.toHaveBeenCalled()
  })

  it('rejects a navigation that completes while pixels are captured', async () => {
    let currentUrl = 'http://localhost:3000/page'
    const value = harness({
      getURL: vi.fn(() => currentUrl),
      capturePage: vi.fn(async () => {
        currentUrl = 'http://localhost:3001/'
        return image()
      })
    })
    await expect(captureAuthorizedDevPreviewRegion(
      value.event as never,
      value.request,
      value.dependencies as never
    )).rejects.toThrow('changed during capture')
  })
})
