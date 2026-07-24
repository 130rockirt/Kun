import { AttachmentUploadRequest } from '../../contracts/attachments.js'
import type { AttachmentStore } from '../../attachments/attachment-store.js'
import { jsonResponse, type JsonResponse } from '../response.js'
import { readJsonBody } from '../read-json-body.js'
import { ERRORS } from './runtime-error.js'

/**
 * A 10 MiB decoded file is the largest built-in attachment allowance. Keep a
 * small fixed transport envelope around it for base64, fallback, and metadata
 * rather than accepting an arbitrarily large JSON representation first.
 */
export const MAX_ATTACHMENT_UPLOAD_DATA_BYTES = 10 * 1024 * 1024
export const MAX_ATTACHMENT_UPLOAD_BODY_BYTES = 16 * 1024 * 1024
const MAX_INFLIGHT_ATTACHMENT_UPLOAD_BYTES = MAX_ATTACHMENT_UPLOAD_BODY_BYTES

type UploadLease = () => void

class AttachmentUploadBudget {
  private reservedBytes = 0

  tryAcquire(bytes: number): UploadLease | null {
    if (this.reservedBytes + bytes > MAX_INFLIGHT_ATTACHMENT_UPLOAD_BYTES) return null
    this.reservedBytes += bytes
    let released = false
    return () => {
      if (released) return
      released = true
      this.reservedBytes = Math.max(0, this.reservedBytes - bytes)
    }
  }
}

// Scope admission to each attachment store/runtime. A full request-body
// reservation is intentional: Content-Length is advisory and must not be used
// to admit several large chunked uploads concurrently.
const uploadBudgets = new WeakMap<AttachmentStore, AttachmentUploadBudget>()

export async function uploadAttachment(
  store: AttachmentStore | undefined,
  request: Request
): Promise<JsonResponse | Response> {
  if (!store) return ERRORS.unavailable('attachment store is unavailable')

  const release = reserveUpload(store)
  if (!release) {
    // Do not keep a rejected chunked upload flowing into the process while a
    // bounded upload is already being decoded and persisted.
    void request.body?.cancel().catch(() => undefined)
    return ERRORS.rateLimited('an attachment upload is already in progress')
  }

  try {
    const body = await readJsonBody(request, MAX_ATTACHMENT_UPLOAD_BODY_BYTES)
    if (!body.ok) return body.response
    const parsed = AttachmentUploadRequest.safeParse(body.value)
    if (!parsed.success) return ERRORS.attachmentValidation('invalid attachment upload body', parsed.error.issues)
    const data = decodeBase64(parsed.data.dataBase64)
    const attachment = await store.create({
      name: parsed.data.name,
      mimeType: parsed.data.mimeType,
      data,
      documentText: parsed.data.documentText,
      documentFormat: parsed.data.documentFormat,
      sourceSha256: parsed.data.sourceSha256,
      pageCount: parsed.data.pageCount,
      localFilePath: parsed.data.localFilePath,
      textFallback: parsed.data.textFallback,
      visualPreview: parsed.data.visualPreview,
      threadId: parsed.data.threadId,
      workspace: parsed.data.workspace
    })
    return jsonResponse({ attachment }, 201)
  } catch (error) {
    return ERRORS.attachmentValidation(errorMessage(error))
  } finally {
    release()
  }
}

function reserveUpload(store: AttachmentStore): UploadLease | null {
  let budget = uploadBudgets.get(store)
  if (!budget) {
    budget = new AttachmentUploadBudget()
    uploadBudgets.set(store, budget)
  }
  return budget.tryAcquire(MAX_ATTACHMENT_UPLOAD_BODY_BYTES)
}

function decodeBase64(value: string, maxBytes = MAX_ATTACHMENT_UPLOAD_DATA_BYTES): Buffer {
  const byteLength = decodedBase64ByteLength(value)
  if (byteLength > maxBytes) {
    throw new Error(`attachment data exceeds ${maxBytes} byte limit`)
  }
  return Buffer.from(value, 'base64')
}

function decodedBase64ByteLength(value: string): number {
  let dataChars = 0
  let padding = 0
  let sawPadding = false
  let lastDataChar = -1

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (isBase64Whitespace(code)) continue
    if (code === 0x3d) { // '='
      sawPadding = true
      padding += 1
      if (padding > 2) throw new Error('attachment data is not valid base64')
      continue
    }
    if (sawPadding || base64Value(code) < 0) {
      throw new Error('attachment data is not valid base64')
    }
    dataChars += 1
    lastDataChar = code
  }

  if (dataChars === 0 || (dataChars + padding) % 4 !== 0) {
    throw new Error('attachment data is not valid base64')
  }
  const finalValue = base64Value(lastDataChar)
  if (
    (padding === 1 && (finalValue & 0b11) !== 0) ||
    (padding === 2 && (finalValue & 0b1111) !== 0)
  ) {
    throw new Error('attachment data is not valid base64')
  }
  return ((dataChars + padding) / 4) * 3 - padding
}

function base64Value(code: number): number {
  if (code >= 0x41 && code <= 0x5a) return code - 0x41 // A-Z
  if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 26 // a-z
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 52 // 0-9
  if (code === 0x2b) return 62 // '+'
  if (code === 0x2f) return 63 // '/'
  return -1
}

function isBase64Whitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d
}

export async function getAttachmentMetadata(
  store: AttachmentStore | undefined,
  id: string
): Promise<JsonResponse> {
  if (!store) return ERRORS.unavailable('attachment store is unavailable')
  const attachment = await store.get(id)
  if (!attachment) return ERRORS.notFound(`attachment not found: ${id}`)
  return jsonResponse({ attachment })
}

export async function getAttachmentContent(
  store: AttachmentStore | undefined,
  id: string,
  request: Request
): Promise<JsonResponse> {
  if (!store) return ERRORS.unavailable('attachment store is unavailable')
  const url = new URL(request.url)
  try {
    const attachment = await store.resolveContent(id, {
      threadId: url.searchParams.get('thread_id') ?? undefined,
      workspace: url.searchParams.get('workspace') ?? undefined
    })
    return jsonResponse({
      attachment: {
        ...attachment,
        data: undefined
      },
      dataBase64: attachment.data.toString('base64')
    })
  } catch (error) {
    const message = errorMessage(error)
    return /not authorized/i.test(message) ? ERRORS.forbidden(message) : ERRORS.notFound(message)
  }
}

export async function attachmentDiagnostics(
  store: AttachmentStore | undefined
): Promise<JsonResponse> {
  if (!store) {
    return jsonResponse({ enabled: false, rootDir: '', count: 0, totalBytes: 0 })
  }
  return jsonResponse(await store.diagnostics())
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const _internal = { decodeBase64, decodedBase64ByteLength }
