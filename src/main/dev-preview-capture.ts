import {
  ipcMain,
  session,
  webContents,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type NativeImage,
  type WebContents
} from 'electron'
import { z } from 'zod'
import {
  DEV_PREVIEW_CAPTURE_CHANNEL,
  DEV_PREVIEW_CAPTURE_MAX_BYTES,
  DEV_PREVIEW_CAPTURE_MAX_EDGE,
  DEV_PREVIEW_PARTITION,
  type DevPreviewCaptureRequest,
  type DevPreviewCaptureResult
} from '../shared/dev-preview-capture'
import { normalizeDevPreviewUrlInput } from '../shared/dev-preview-url'

const MAX_SOURCE_AREA = 4096 * 4096

const requestSchema = z.strictObject({
  guestWebContentsId: z.number().int().positive(),
  url: z.string().trim().min(1).max(32_768),
  rect: z.strictObject({
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
    width: z.number().finite().positive().max(4096),
    height: z.number().finite().positive().max(4096)
  })
})

type PreviewCaptureGuest = Pick<
  WebContents,
  'id' | 'getType' | 'getURL' | 'hostWebContents' | 'session' | 'executeJavaScript' | 'capturePage' | 'isDestroyed'
>

export type DevPreviewCaptureDependencies = {
  getMainWindow: () => BrowserWindow | null
  fromId: (id: number) => PreviewCaptureGuest | undefined
  isDedicatedPartition: (guest: PreviewCaptureGuest) => boolean
}

function assertAuthorizedGuest(
  event: Pick<IpcMainInvokeEvent, 'sender'>,
  request: DevPreviewCaptureRequest,
  dependencies: DevPreviewCaptureDependencies
): PreviewCaptureGuest {
  const mainWindow = dependencies.getMainWindow()
  if (!mainWindow || mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id) {
    throw new Error('Preview capture sender is not authorized')
  }
  const guest = dependencies.fromId(request.guestWebContentsId)
  if (!guest || guest.isDestroyed() || guest.getType() !== 'webview') {
    throw new Error('Preview capture guest is unavailable')
  }
  if (guest.hostWebContents?.id !== event.sender.id) {
    throw new Error('Preview capture guest does not belong to this window')
  }
  if (!dependencies.isDedicatedPartition(guest)) {
    throw new Error('Preview capture guest uses an invalid partition')
  }
  const assertedUrl = normalizeDevPreviewUrlInput(request.url)
  const currentUrl = normalizeDevPreviewUrlInput(guest.getURL())
  if (!assertedUrl || !currentUrl || assertedUrl !== currentUrl) {
    throw new Error('Preview capture URL is not authorized')
  }
  return guest
}

function assertGuestRemainsAuthorized(
  event: Pick<IpcMainInvokeEvent, 'sender'>,
  guest: PreviewCaptureGuest,
  requestUrl: string,
  dependencies: DevPreviewCaptureDependencies
): void {
  if (
    guest.isDestroyed() ||
    guest.getType() !== 'webview' ||
    guest.hostWebContents?.id !== event.sender.id ||
    !dependencies.isDedicatedPartition(guest)
  ) {
    throw new Error('Preview capture guest changed during capture')
  }
  const assertedUrl = normalizeDevPreviewUrlInput(requestUrl)
  const currentUrl = normalizeDevPreviewUrlInput(guest.getURL())
  if (!assertedUrl || !currentUrl || assertedUrl !== currentUrl) {
    throw new Error('Preview capture URL changed during capture')
  }
}

function resizedWithinLimit(image: NativeImage): NativeImage {
  const { width, height } = image.getSize()
  const maxEdge = Math.max(width, height)
  if (maxEdge <= DEV_PREVIEW_CAPTURE_MAX_EDGE) return image
  const scale = DEV_PREVIEW_CAPTURE_MAX_EDGE / maxEdge
  return image.resize({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    quality: 'best'
  })
}

export async function captureAuthorizedDevPreviewRegion(
  event: Pick<IpcMainInvokeEvent, 'sender'>,
  rawRequest: unknown,
  dependencies: DevPreviewCaptureDependencies
): Promise<DevPreviewCaptureResult> {
  const request = requestSchema.parse(rawRequest) as DevPreviewCaptureRequest
  if (request.rect.width * request.rect.height > MAX_SOURCE_AREA) {
    throw new Error('Preview capture region is too large')
  }
  const guest = assertAuthorizedGuest(event, request, dependencies)
  const viewport = await guest.executeJavaScript(
    'Object.freeze({width: window.innerWidth, height: window.innerHeight})',
    true
  ) as { width?: unknown; height?: unknown }
  const viewportWidth = typeof viewport?.width === 'number' ? viewport.width : Number.NaN
  const viewportHeight = typeof viewport?.height === 'number' ? viewport.height : Number.NaN
  if (
    !Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight) ||
    viewportWidth <= 0 || viewportHeight <= 0 ||
    request.rect.x + request.rect.width > viewportWidth ||
    request.rect.y + request.rect.height > viewportHeight
  ) {
    throw new Error('Preview capture region is outside the viewport')
  }

  assertGuestRemainsAuthorized(event, guest, request.url, dependencies)

  const captured = await guest.capturePage({
    x: Math.floor(request.rect.x),
    y: Math.floor(request.rect.y),
    width: Math.ceil(request.rect.width),
    height: Math.ceil(request.rect.height)
  })
  assertGuestRemainsAuthorized(event, guest, request.url, dependencies)
  if (captured.isEmpty()) throw new Error('Preview capture returned no pixels')
  const output = resizedWithinLimit(captured)
  const png = output.toPNG()
  if (png.byteLength === 0 || png.byteLength > DEV_PREVIEW_CAPTURE_MAX_BYTES) {
    throw new Error('Preview capture output exceeds the size limit')
  }
  const size = output.getSize()
  return {
    ok: true,
    dataBase64: png.toString('base64'),
    mimeType: 'image/png',
    width: size.width,
    height: size.height
  }
}

export function registerDevPreviewCaptureIpc(options: {
  getMainWindow: () => BrowserWindow | null
}): void {
  ipcMain.handle(DEV_PREVIEW_CAPTURE_CHANNEL, (event, request) =>
    captureAuthorizedDevPreviewRegion(event, request, {
      getMainWindow: options.getMainWindow,
      fromId: (id) => webContents.fromId(id),
      isDedicatedPartition: (guest) => guest.session === session.fromPartition(DEV_PREVIEW_PARTITION)
    })
  )
}
