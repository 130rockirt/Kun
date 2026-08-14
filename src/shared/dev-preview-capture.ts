import type { DevPreviewRect } from './dev-preview-context'

export const DEV_PREVIEW_PARTITION = 'persist:kun-dev-preview'
export const DEV_PREVIEW_CAPTURE_CHANNEL = 'dev-preview:capture-region'
export const DEV_PREVIEW_CAPTURE_MAX_EDGE = 1280
export const DEV_PREVIEW_CAPTURE_MAX_BYTES = 5 * 1024 * 1024

export type DevPreviewCaptureRequest = {
  guestWebContentsId: number
  url: string
  rect: DevPreviewRect
}

export type DevPreviewCaptureResult = {
  ok: true
  dataBase64: string
  mimeType: 'image/png'
  width: number
  height: number
}

