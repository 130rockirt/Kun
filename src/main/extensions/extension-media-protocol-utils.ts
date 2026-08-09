import { createHash, randomBytes } from 'node:crypto'
import type { ReadStream } from 'node:fs'
import { open, realpath, stat, type FileHandle } from 'node:fs/promises'
import { extname } from 'node:path'
import { Readable } from 'node:stream'
import type { Protocol } from 'electron'
import type {
  ExtensionMediaDiagnostics,
  ExtensionMediaFileIdentity,
  ExtensionMediaLeaseRevocationReason
} from '../../shared/extension-media-ipc'
import type {
  ExtensionViewSessionRecord,
  ExtensionViewSessionRegistry
} from './extension-view-sessions'
import { KUN_EXTENSION_PRIVILEGED_SCHEME } from './extension-resource-protocol'
import { KUN_WORKSPACE_PREVIEW_PRIVILEGED_SCHEME } from '../services/workspace-preview-protocol'

import {
  ActiveLease,
  ExtensionMediaProtocolError,
  KUN_MEDIA_SCHEME,
  ParsedMediaByteRange
} from './extension-media-protocol-types'

export function parseMediaByteRange(
  value: string,
  resourceSize: number,
  maxRangeBytes: number
): ParsedMediaByteRange {
  if (
    !Number.isSafeInteger(resourceSize) ||
    resourceSize < 0 ||
    !Number.isSafeInteger(maxRangeBytes) ||
    maxRangeBytes <= 0 ||
    value.length > 256 ||
    value.includes(',')
  ) {
    throw new ExtensionMediaProtocolError('MEDIA_RANGE_INVALID', 416, resourceSize)
  }
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim())
  if (!match || (!match[1] && !match[2]) || resourceSize === 0) {
    throw new ExtensionMediaProtocolError('MEDIA_RANGE_INVALID', 416, resourceSize)
  }
  let start: number
  let end: number
  if (!match[1]) {
    const suffixLength = parseRangeInteger(match[2]!, resourceSize)
    if (suffixLength <= 0) {
      throw new ExtensionMediaProtocolError('MEDIA_RANGE_INVALID', 416, resourceSize)
    }
    start = Math.max(0, resourceSize - suffixLength)
    end = resourceSize - 1
  } else {
    start = parseRangeInteger(match[1], resourceSize)
    if (start >= resourceSize) {
      throw new ExtensionMediaProtocolError('MEDIA_RANGE_INVALID', 416, resourceSize)
    }
    end = match[2] ? Math.min(parseRangeInteger(match[2], resourceSize), resourceSize - 1) : resourceSize - 1
    if (end < start) {
      throw new ExtensionMediaProtocolError('MEDIA_RANGE_INVALID', 416, resourceSize)
    }
  }
  const length = end - start + 1
  if (!Number.isSafeInteger(length) || length <= 0 || length > maxRangeBytes) {
    throw new ExtensionMediaProtocolError('MEDIA_RANGE_LIMIT_EXCEEDED', 416, resourceSize)
  }
  return { start, end, length }
}

export function parseRangeInteger(value: string, resourceSize: number): number {
  if (!/^\d{1,16}$/.test(value)) {
    throw new ExtensionMediaProtocolError('MEDIA_RANGE_INVALID', 416, resourceSize)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ExtensionMediaProtocolError('MEDIA_RANGE_INVALID', 416, resourceSize)
  }
  return parsed
}

export function parseKunMediaUrl(rawUrl: string): string {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new ExtensionMediaProtocolError('MEDIA_URL_INVALID')
  }
  if (
    url.protocol !== `${KUN_MEDIA_SCHEME}:` ||
    url.hostname !== 'lease' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    throw new ExtensionMediaProtocolError('MEDIA_URL_INVALID')
  }
  const match = /^\/([A-Za-z0-9_-]{32,128})$/.exec(url.pathname)
  if (!match) throw new ExtensionMediaProtocolError('MEDIA_URL_INVALID')
  return match[1]!
}

export function mediaResponseHeaders(
  lease: Pick<ActiveLease, 'mimeType' | 'etag'>,
  contentLength: number
): Record<string, string> {
  return {
    'Accept-Ranges': 'bytes',
    'Content-Length': String(contentLength),
    'Content-Type': lease.mimeType,
    'Cache-Control': 'private, no-store',
    // The protected resource intentionally crosses from kun-extension://<id>
    // to kun-media://lease. Access remains bound to the View's unique Session
    // partition and opaque lease; CORP must permit that media embed.
    'Cross-Origin-Resource-Policy': 'cross-origin',
    ETag: lease.etag,
    'X-Content-Type-Options': 'nosniff'
  }
}

export function mediaErrorResponse(error: ExtensionMediaProtocolError): Response {
  const headers: Record<string, string> = {
    'Cache-Control': 'no-store',
    'Content-Length': '0',
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff'
  }
  if (error.status === 405) headers.Allow = 'GET, HEAD'
  if (error.status === 416 && error.resourceSize !== undefined) {
    headers['Accept-Ranges'] = 'bytes'
    headers['Content-Range'] = `bytes */${Math.max(0, error.resourceSize)}`
  }
  return new Response(null, { status: error.status, headers })
}

export function fileIdentity(metadata: {
  size: number
  mtimeMs: number
  dev: number
  ino: number
}): ExtensionMediaFileIdentity {
  return {
    byteSize: metadata.size,
    modifiedAtMs: metadata.mtimeMs,
    device: metadata.dev,
    inode: metadata.ino
  }
}

export function matchesFileIdentity(
  expected: ExtensionMediaFileIdentity,
  actual: ExtensionMediaFileIdentity
): boolean {
  return expected.byteSize === actual.byteSize &&
    expected.modifiedAtMs === actual.modifiedAtMs &&
    (expected.device === undefined || expected.device === actual.device) &&
    (expected.inode === undefined || expected.inode === actual.inode)
}

export function opaqueEtag(identity: ExtensionMediaFileIdentity, mimeType: string): string {
  return `"${createHash('sha256')
    .update(`${identity.device ?? ''}\0${identity.inode ?? ''}\0${identity.byteSize}\0${identity.modifiedAtMs}\0${mimeType}`)
    .digest('base64url')
    .slice(0, 32)}"`
}

export function safeMediaMimeType(path: string, requested?: string): string {
  const inferred = MEDIA_MIME_TYPES.get(extname(path).toLowerCase())
  if (!inferred) throw new ExtensionMediaProtocolError('MEDIA_TYPE_UNSUPPORTED', 415)
  if (requested && requested !== inferred) {
    throw new ExtensionMediaProtocolError('MEDIA_TYPE_MISMATCH', 415)
  }
  return inferred
}

export const MEDIA_MIME_TYPES = new Map<string, string>([
  ['.mp4', 'video/mp4'],
  ['.m4v', 'video/mp4'],
  ['.mov', 'video/quicktime'],
  ['.webm', 'video/webm'],
  ['.ogv', 'video/ogg'],
  ['.mp3', 'audio/mpeg'],
  ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.wav', 'audio/wav'],
  ['.flac', 'audio/flac'],
  ['.ogg', 'audio/ogg'],
  ['.opus', 'audio/ogg'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.vtt', 'text/vtt']
])
