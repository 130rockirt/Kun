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
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_MAX_LEASES_PER_VIEW,
  DEFAULT_MAX_RANGE_BYTES,
  DEFAULT_MAX_STREAMS_PER_LEASE,
  DEFAULT_MAX_STREAMS_TOTAL,
  ExtensionMediaLease,
  ExtensionMediaLeaseInput,
  ExtensionMediaProtocolError,
  ExtensionMediaProtocolOptions,
  KUN_MEDIA_SCHEME,
  LEASE_TOKEN,
  MAX_TIMER_MS,
  PreparedMediaProtocol,
  positiveInteger
} from './extension-media-protocol-types'
import {
  fileIdentity,
  matchesFileIdentity,
  mediaErrorResponse,
  mediaResponseHeaders,
  opaqueEtag,
  parseKunMediaUrl,
  parseMediaByteRange,
  safeMediaMimeType
} from './extension-media-protocol-utils'

/** Main-owned, per-View protocol and lease authority. */
export class ExtensionMediaProtocolRegistry {
  private readonly registrations = new Map<string, PreparedMediaProtocol>()
  private readonly leases = new Map<string, ActiveLease>()
  private readonly leaseIdsBySession = new Map<string, Set<string>>()
  private readonly deniedByCode = new Map<string, number>()
  private readonly now: () => number
  private readonly randomToken: () => string
  private readonly leaseTtlMs: number
  private readonly maxLeasesPerView: number
  private readonly maxConcurrentStreamsPerLease: number
  private readonly maxConcurrentStreamsTotal: number
  private readonly maxRangeBytes: number
  private readonly stopMainFrameObserver: () => void
  private activeStreamCount = 0

  constructor(private readonly options: ExtensionMediaProtocolOptions) {
    this.now = options.now ?? (() => Date.now())
    this.randomToken = options.randomToken ?? (() => randomBytes(32).toString('base64url'))
    this.leaseTtlMs = positiveInteger(options.leaseTtlMs, DEFAULT_LEASE_TTL_MS)
    this.maxLeasesPerView = positiveInteger(options.maxLeasesPerView, DEFAULT_MAX_LEASES_PER_VIEW)
    this.maxConcurrentStreamsPerLease = positiveInteger(
      options.maxConcurrentStreamsPerLease,
      DEFAULT_MAX_STREAMS_PER_LEASE
    )
    this.maxConcurrentStreamsTotal = positiveInteger(
      options.maxConcurrentStreamsTotal,
      DEFAULT_MAX_STREAMS_TOTAL
    )
    this.maxRangeBytes = positiveInteger(options.maxRangeBytes, DEFAULT_MAX_RANGE_BYTES)
    this.stopMainFrameObserver = options.sessions.onDidChangeMainFrame((record) => {
      this.revokeForSession(record.sessionId, 'view-navigated')
    })
  }

  prepare(record: ExtensionViewSessionRecord): void {
    if (this.registrations.has(record.sessionId)) {
      throw new ExtensionMediaProtocolError('MEDIA_PROTOCOL_DUPLICATE', 409)
    }
    const protocol = this.options.protocolForPartition(record.partition)
    try {
      protocol.unhandle(KUN_MEDIA_SCHEME)
    } catch {
      // First registration has no existing handler.
    }
    protocol.handle(KUN_MEDIA_SCHEME, (request) => this.handleRequest(record.sessionId, request))
    this.registrations.set(record.sessionId, {
      protocol,
      partition: record.partition,
      extensionId: record.extensionId,
      extensionVersion: record.extensionVersion
    })
  }

  assertPrepared(record: ExtensionViewSessionRecord): void {
    const prepared = this.registrations.get(record.sessionId)
    if (
      !prepared ||
      prepared.partition !== record.partition ||
      prepared.extensionId !== record.extensionId ||
      prepared.extensionVersion !== record.extensionVersion ||
      prepared.protocol !== this.options.protocolForPartition(record.partition)
    ) {
      throw new ExtensionMediaProtocolError('MEDIA_PROTOCOL_NOT_PREPARED', 409)
    }
  }

  async createLease(input: ExtensionMediaLeaseInput): Promise<ExtensionMediaLease> {
    const record = this.requireBoundSession(input)
    const currentLeaseIds = this.leaseIdsBySession.get(record.sessionId)
    if ((currentLeaseIds?.size ?? 0) >= this.maxLeasesPerView) {
      throw new ExtensionMediaProtocolError('MEDIA_LEASE_QUOTA_EXCEEDED', 429)
    }

    const canonicalPath = await realpath(input.absolutePath).catch(() => {
      throw new ExtensionMediaProtocolError('MEDIA_RESOURCE_UNAVAILABLE')
    })
    const metadata = await stat(canonicalPath).catch(() => {
      throw new ExtensionMediaProtocolError('MEDIA_RESOURCE_UNAVAILABLE')
    })
    if (!metadata.isFile()) throw new ExtensionMediaProtocolError('MEDIA_RESOURCE_NOT_FILE')
    const identity = fileIdentity(metadata)
    if (input.fileIdentity && !matchesFileIdentity(input.fileIdentity, identity)) {
      throw new ExtensionMediaProtocolError('MEDIA_FILE_IDENTITY_MISMATCH')
    }
    const mimeType = safeMediaMimeType(canonicalPath, input.mimeType)
    const now = this.now()
    const requestedExpiry = input.expiresAt ?? now + this.leaseTtlMs
    const expiresAt = Math.min(requestedExpiry, now + this.leaseTtlMs)
    if (!Number.isFinite(requestedExpiry) || expiresAt <= now) {
      throw new ExtensionMediaProtocolError('MEDIA_LEASE_EXPIRED')
    }
    const leaseId = this.createUniqueLeaseId()
    const timer = setTimeout(() => {
      this.revokeLease(leaseId, 'expired')
    }, Math.min(MAX_TIMER_MS, Math.max(1, expiresAt - now)))
    timer.unref?.()
    const lease: ActiveLease = {
      leaseId,
      handleId: input.handleId,
      sessionId: record.sessionId,
      extensionId: record.extensionId,
      extensionVersion: record.extensionVersion,
      contributionId: record.contributionId,
      workspaceRoot: record.workspaceRoot,
      guestWebContentsId: record.guestWebContentsId!,
      guestMainFrameProcessId: record.guestMainFrameProcessId!,
      guestMainFrameRoutingId: record.guestMainFrameRoutingId!,
      canonicalPath,
      mimeType,
      identity,
      etag: opaqueEtag(identity, mimeType),
      expiresAt,
      activeReaders: 0,
      streams: new Set(),
      timer,
      revoked: false
    }
    this.leases.set(leaseId, lease)
    const leaseIds = currentLeaseIds ?? new Set<string>()
    leaseIds.add(leaseId)
    this.leaseIdsBySession.set(record.sessionId, leaseIds)
    return {
      leaseId,
      handleId: lease.handleId,
      url: `${KUN_MEDIA_SCHEME}://lease/${leaseId}`,
      mimeType,
      expiresAt: new Date(expiresAt).toISOString()
    }
  }

  revokeLease(leaseId: string, _reason: ExtensionMediaLeaseRevocationReason = 'released'): boolean {
    const lease = this.leases.get(leaseId)
    if (!lease) return false
    lease.revoked = true
    clearTimeout(lease.timer)
    this.leases.delete(leaseId)
    const leaseIds = this.leaseIdsBySession.get(lease.sessionId)
    leaseIds?.delete(leaseId)
    if (leaseIds?.size === 0) this.leaseIdsBySession.delete(lease.sessionId)
    for (const stream of [...lease.streams]) {
      stream.destroy(new Error('MEDIA_LEASE_REVOKED'))
    }
    return true
  }

  revokeForWorkspace(workspaceRoot: string, reason: ExtensionMediaLeaseRevocationReason = 'workspace-changed'): number {
    return this.revokeMatching((lease) => lease.workspaceRoot === workspaceRoot, reason)
  }

  revokeForExtension(extensionId: string, reason: ExtensionMediaLeaseRevocationReason = 'extension-disabled'): number {
    return this.revokeMatching((lease) => lease.extensionId === extensionId, reason)
  }

  revokeForSession(
    sessionId: string,
    reason: ExtensionMediaLeaseRevocationReason = 'view-navigated'
  ): number {
    return this.revokeMatching((lease) => lease.sessionId === sessionId, reason)
  }

  disposeSession(sessionId: string, reason: ExtensionMediaLeaseRevocationReason = 'view-closed'): boolean {
    const prepared = this.registrations.get(sessionId)
    const revoked = this.revokeForSession(sessionId, reason)
    if (!prepared) return revoked > 0
    this.registrations.delete(sessionId)
    try {
      prepared.protocol.unhandle(KUN_MEDIA_SCHEME)
    } catch {
      // The temporary Electron Session may already be gone.
    }
    return true
  }

  disposeAll(): void {
    this.stopMainFrameObserver()
    for (const sessionId of [...this.registrations.keys()]) {
      this.disposeSession(sessionId, 'runtime-shutdown')
    }
    for (const leaseId of [...this.leases.keys()]) {
      this.revokeLease(leaseId, 'runtime-shutdown')
    }
  }

  diagnostics(): ExtensionMediaDiagnostics {
    return {
      scheme: KUN_MEDIA_SCHEME,
      preparedViewCount: this.registrations.size,
      activeLeaseCount: this.leases.size,
      activeStreamCount: this.activeStreamCount,
      limits: {
        leaseTtlMs: this.leaseTtlMs,
        leasesPerView: this.maxLeasesPerView,
        concurrentStreamsPerLease: this.maxConcurrentStreamsPerLease,
        concurrentStreamsTotal: this.maxConcurrentStreamsTotal,
        rangeBytes: this.maxRangeBytes
      },
      deniedByCode: Object.fromEntries(this.deniedByCode)
    }
  }

  private async handleRequest(sessionId: string, request: Request): Promise<Response> {
    try {
      const leaseId = parseKunMediaUrl(request.url)
      const lease = this.requireRequestLease(sessionId, leaseId)
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        throw new ExtensionMediaProtocolError('MEDIA_METHOD_NOT_ALLOWED', 405)
      }
      if (request.method === 'HEAD') {
        const file = await this.openCurrentFile(lease)
        await file.close()
        return new Response(null, {
          status: 200,
          headers: mediaResponseHeaders(lease, lease.identity.byteSize)
        })
      }
      return await this.streamResponse(lease, request)
    } catch (error) {
      const protocolError = error instanceof ExtensionMediaProtocolError
        ? error
        : new ExtensionMediaProtocolError('MEDIA_RESOURCE_UNAVAILABLE')
      const registration = this.registrations.get(sessionId)
      this.recordDenied(protocolError.code, registration?.extensionId, sessionId)
      return mediaErrorResponse(protocolError)
    }
  }

  private async streamResponse(lease: ActiveLease, request: Request): Promise<Response> {
    this.reserveReader(lease)
    let file: FileHandle | undefined
    let readerReleased = false
    const releaseReader = (): void => {
      if (readerReleased) return
      readerReleased = true
      lease.activeReaders = Math.max(0, lease.activeReaders - 1)
      this.activeStreamCount = Math.max(0, this.activeStreamCount - 1)
    }
    try {
      file = await this.openCurrentFile(lease)
      if (lease.revoked || this.leases.get(lease.leaseId) !== lease) {
        throw new ExtensionMediaProtocolError('MEDIA_LEASE_REVOKED')
      }
      const resourceSize = lease.identity.byteSize
      const rangeHeader = request.headers.get('range')
      const range = rangeHeader === null
        ? undefined
        : parseMediaByteRange(rangeHeader, resourceSize, this.maxRangeBytes)
      if (resourceSize === 0) {
        await file.close()
        file = undefined
        releaseReader()
        return new Response(null, {
          status: 200,
          headers: mediaResponseHeaders(lease, 0)
        })
      }
      const start = range?.start ?? 0
      const end = range?.end ?? resourceSize - 1
      const stream = file.createReadStream({
        autoClose: true,
        start,
        end,
        highWaterMark: 64 * 1024
      })
      file = undefined
      lease.streams.add(stream)
      const onAbort = (): void => {
        stream.destroy(new Error('MEDIA_REQUEST_ABORTED'))
      }
      request.signal.addEventListener('abort', onAbort, { once: true })
      if (request.signal.aborted) onAbort()
      const cleanup = (): void => {
        request.signal.removeEventListener('abort', onAbort)
        lease.streams.delete(stream)
        releaseReader()
      }
      stream.once('close', cleanup)
      stream.once('error', cleanup)
      const headers = mediaResponseHeaders(lease, range?.length ?? resourceSize)
      if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${resourceSize}`
      const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>
      return new Response(body, { status: range ? 206 : 200, headers })
    } catch (error) {
      await file?.close().catch(() => undefined)
      releaseReader()
      throw error
    }
  }

  private async openCurrentFile(lease: ActiveLease): Promise<FileHandle> {
    if (lease.revoked || this.now() >= lease.expiresAt) {
      this.revokeLease(lease.leaseId, 'expired')
      throw new ExtensionMediaProtocolError('MEDIA_LEASE_EXPIRED')
    }
    const canonicalPath = await realpath(lease.canonicalPath).catch(() => {
      this.revokeLease(lease.leaseId, 'file-replaced')
      throw new ExtensionMediaProtocolError('MEDIA_FILE_IDENTITY_MISMATCH')
    })
    if (canonicalPath !== lease.canonicalPath) {
      this.revokeLease(lease.leaseId, 'file-replaced')
      throw new ExtensionMediaProtocolError('MEDIA_FILE_IDENTITY_MISMATCH')
    }
    const file = await open(canonicalPath, 'r').catch(() => {
      this.revokeLease(lease.leaseId, 'file-replaced')
      throw new ExtensionMediaProtocolError('MEDIA_RESOURCE_UNAVAILABLE')
    })
    try {
      const metadata = await file.stat()
      if (!metadata.isFile() || !matchesFileIdentity(lease.identity, fileIdentity(metadata))) {
        this.revokeLease(lease.leaseId, 'file-replaced')
        throw new ExtensionMediaProtocolError('MEDIA_FILE_IDENTITY_MISMATCH')
      }
      return file
    } catch (error) {
      await file.close().catch(() => undefined)
      throw error
    }
  }

  private requireBoundSession(input: ExtensionMediaLeaseInput): ExtensionViewSessionRecord {
    const prepared = this.registrations.get(input.viewSessionId)
    const record = this.options.sessions.get(input.viewSessionId)
    if (
      !prepared ||
      !record ||
      record.state !== 'active' ||
      record.guestWebContentsId === undefined ||
      record.guestMainFrameProcessId === undefined ||
      record.guestMainFrameRoutingId === undefined ||
      prepared.partition !== record.partition ||
      prepared.protocol !== this.options.protocolForPartition(record.partition) ||
      prepared.extensionId !== input.extensionId ||
      prepared.extensionVersion !== input.extensionVersion ||
      record.extensionId !== input.extensionId ||
      record.extensionVersion !== input.extensionVersion ||
      record.contributionId !== input.contributionId ||
      record.workspaceRoot !== input.workspaceRoot
    ) {
      throw new ExtensionMediaProtocolError('MEDIA_VIEW_BINDING_INVALID')
    }
    return record
  }

  private requireRequestLease(sessionId: string, leaseId: string): ActiveLease {
    const lease = this.leases.get(leaseId)
    const record = this.options.sessions.get(sessionId)
    const prepared = this.registrations.get(sessionId)
    if (
      !lease ||
      lease.revoked ||
      lease.sessionId !== sessionId ||
      !record ||
      record.state !== 'active' ||
      !prepared ||
      prepared.protocol !== this.options.protocolForPartition(record.partition) ||
      record.extensionId !== lease.extensionId ||
      record.extensionVersion !== lease.extensionVersion ||
      record.contributionId !== lease.contributionId ||
      record.workspaceRoot !== lease.workspaceRoot ||
      record.guestWebContentsId !== lease.guestWebContentsId ||
      record.guestMainFrameProcessId !== lease.guestMainFrameProcessId ||
      record.guestMainFrameRoutingId !== lease.guestMainFrameRoutingId
    ) {
      throw new ExtensionMediaProtocolError('MEDIA_RESOURCE_UNAVAILABLE')
    }
    if (this.now() >= lease.expiresAt) {
      this.revokeLease(leaseId, 'expired')
      throw new ExtensionMediaProtocolError('MEDIA_LEASE_EXPIRED')
    }
    return lease
  }

  private reserveReader(lease: ActiveLease): void {
    if (
      lease.activeReaders >= this.maxConcurrentStreamsPerLease ||
      this.activeStreamCount >= this.maxConcurrentStreamsTotal
    ) {
      throw new ExtensionMediaProtocolError('MEDIA_STREAM_QUOTA_EXCEEDED', 429)
    }
    lease.activeReaders += 1
    this.activeStreamCount += 1
  }

  private createUniqueLeaseId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = this.randomToken()
      if (LEASE_TOKEN.test(candidate) && !this.leases.has(candidate)) return candidate
    }
    throw new ExtensionMediaProtocolError('MEDIA_LEASE_ID_UNAVAILABLE', 503)
  }

  private revokeMatching(
    predicate: (lease: ActiveLease) => boolean,
    reason: ExtensionMediaLeaseRevocationReason
  ): number {
    const leaseIds = [...this.leases.values()].filter(predicate).map((lease) => lease.leaseId)
    for (const leaseId of leaseIds) this.revokeLease(leaseId, reason)
    return leaseIds.length
  }

  private recordDenied(code: string, extensionId?: string, sessionId?: string): void {
    this.deniedByCode.set(code, (this.deniedByCode.get(code) ?? 0) + 1)
    this.options.onDenied?.({ extensionId, sessionId, code })
  }
}
