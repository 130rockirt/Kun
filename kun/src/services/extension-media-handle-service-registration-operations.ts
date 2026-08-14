import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { AtomicJsonFile } from '../extensions/atomic-json.js'
import { extensionWorkspaceKey } from '../extensions/paths.js'
import type { ExtensionPrincipal } from './extension-agent-service.js'
import { type ExtensionMediaHandleService, MediaHandleModeSchema, MediaHandleSourceSchema, MediaHandleLifecycleSchema, FileIdentitySchema, StoredMediaHandleSchema, MediaHandleDocumentSchema, type StoredMediaHandle, type MediaHandleMode, type MediaHandleSource, type MediaHandleLifecycle, type FileIdentity, type MediaHandleProjection, type ResolvedMediaHandle, type MediaOutputCompletionTransaction, type PendingMediaOutputTransaction, type CompletedMediaOutputRecovery, ExtensionMediaHandleError, type RegisterMediaHandleInput, type RegisterCacheMediaTargetInput, emptyDocument, resolveCandidate, outputCandidate, authorizeWorkspace, assertExtensionCacheTarget, ensureCacheParent, requirePermission, requireRecordAccess, canonicalExistingDirectory, assertWithinWorkspace, canonicalOutput, fileIdentityFromStat, serializableFileSystemIdentifier, statNumber, readIdentity, refreshIdentity, assertOwnedRecord, assertOwnedTransactionRecord, assertOwnedRecordIncludingRevoked, matchesFileIdentity, identifiesSameFile, project, deleteCachePaths, completionIdentity, boundedDisplayName, stripAsciiControl, inferMediaMime } from './extension-media-handle-service-core.js'

export const extensionMediaHandleServiceRegistrationOperations = {
async register(this: ExtensionMediaHandleService,
    principal: ExtensionPrincipal,
    input: RegisterMediaHandleInput
  ): Promise<MediaHandleProjection> {
    const workspaceRoot = await authorizeWorkspace(principal, input.workspaceRoot)
    requirePermission(principal, input.mode === 'read' ? 'media.read' : 'media.export')
    requirePermission(principal, input.mode === 'read' ? 'workspace.read' : 'workspace.write')
    return await this['registerAuthorized'](principal, { ...input, workspaceRoot })
  },

/**
   * Core-only cache authority used by the Host broker. A cache target is not a
   * user export grant: it is confined to the Host-owned extension cache and is
   * authorized by media processing plus workspace write access. Public callers
   * cannot choose its lifecycle, source, or access mode.
   */
async registerCacheTarget(this: ExtensionMediaHandleService,
    principal: ExtensionPrincipal,
    input: RegisterCacheMediaTargetInput
  ): Promise<MediaHandleProjection> {
    const workspaceRoot = await authorizeWorkspace(principal, input.workspaceRoot)
    requirePermission(principal, 'media.process')
    requirePermission(principal, 'workspace.write')
    const target = assertExtensionCacheTarget(principal, workspaceRoot, input.path)
    await ensureCacheParent(workspaceRoot, target)
    return await this['registerAuthorized'](principal, {
      ...input,
      workspaceRoot,
      mode: 'write',
      source: 'workspace',
      lifecycle: 'cache'
    })
  },

async registerAuthorized(this: ExtensionMediaHandleService,
    principal: ExtensionPrincipal,
    input: RegisterMediaHandleInput & { workspaceRoot: string }
  ): Promise<MediaHandleProjection> {
    const candidate = await resolveCandidate(input)
    const createdAt = this['now']().toISOString()
    const record: StoredMediaHandle = {
      id: `media_${randomUUID()}`,
      ownerExtensionId: principal.extensionId,
      ownerExtensionVersion: principal.extensionVersion,
      workspaceRoot: input.workspaceRoot,
      absolutePath: candidate.absolutePath,
      displayName: boundedDisplayName(input.displayName ?? basename(candidate.absolutePath)),
      mode: input.mode,
      source: input.source,
      lifecycle: input.lifecycle ?? 'persistent',
      mimeType: input.mimeType?.trim() || inferMediaMime(candidate.absolutePath),
      ...(candidate.identity ? { identity: candidate.identity } : {}),
      createdAt,
      lastAccessedAt: createdAt
    }
    await this['store'].update(emptyDocument, (document) => {
      const owned = Object.values(document.handles).filter(
        (handle) => handle.ownerExtensionId === principal.extensionId && !handle.revokedAt
      ).length
      if (owned >= this['maxHandlesPerExtension']) {
        throw new ExtensionMediaHandleError('handle_limit', 'Extension media handle limit reached')
      }
      return {
        ...document,
        revision: document.revision + 1,
        handles: { ...document.handles, [record.id]: record }
      }
    })
    return project(record)
  },

async stat(this: ExtensionMediaHandleService, principal: ExtensionPrincipal, handleId: string): Promise<MediaHandleProjection> {
    const record = await this['requireOwned'](principal, handleId)
    await authorizeWorkspace(principal, record.workspaceRoot)
    requireRecordAccess(principal, record, record.mode)
    return project(await refreshIdentity(record))
  },

/**
   * Runtime-only access accounting. It is called only after a protected View
   * resource lease succeeds, so metadata polling does not artificially refresh
   * cache LRU order.
   */
async touch(this: ExtensionMediaHandleService, principal: ExtensionPrincipal, handleId: string): Promise<MediaHandleProjection> {
    const current = await this['requireOwned'](principal, handleId)
    await authorizeWorkspace(principal, current.workspaceRoot)
    if (current.mode !== 'read') {
      throw new ExtensionMediaHandleError('mode_denied', 'Only readable media can be opened in a View')
    }
    requireRecordAccess(principal, current, 'read')
    await refreshIdentity(current)
    const lastAccessedAt = this['now']().toISOString()
    let touched: StoredMediaHandle | undefined
    await this['store'].update(emptyDocument, (document) => {
      const record = document.handles[handleId]
      assertOwnedRecord(record, principal)
      if (record.mode !== 'read') {
        throw new ExtensionMediaHandleError('mode_denied', 'Only readable media can be opened in a View')
      }
      if ((record.lastAccessedAt ?? record.createdAt) >= lastAccessedAt) {
        touched = record
        return document
      }
      touched = { ...record, lastAccessedAt }
      return {
        ...document,
        revision: document.revision + 1,
        handles: { ...document.handles, [handleId]: touched }
      }
    })
    return project(touched ?? current)
  },

async resolve(this: ExtensionMediaHandleService,
    principal: ExtensionPrincipal,
    handleId: string,
    requiredMode: MediaHandleMode
  ): Promise<ResolvedMediaHandle> {
    const record = await this['requireOwned'](principal, handleId)
    await authorizeWorkspace(principal, record.workspaceRoot)
    if (record.mode !== requiredMode) {
      throw new ExtensionMediaHandleError('mode_denied', 'Media handle access mode is not permitted')
    }
    requireRecordAccess(principal, record, requiredMode)
    const refreshed = await refreshIdentity(record)
    return {
      ...project(refreshed),
      absolutePath: refreshed.absolutePath,
      workspaceRoot: refreshed.workspaceRoot,
      ownerExtensionId: refreshed.ownerExtensionId,
      ownerExtensionVersion: refreshed.ownerExtensionVersion,
      ...(refreshed.identity ? { identity: refreshed.identity } : {})
    }
  },

async release(this: ExtensionMediaHandleService, principal: ExtensionPrincipal, handleId: string): Promise<boolean> {
    let released = false
    let cachePath: string | undefined
    await this['store'].update(emptyDocument, (document) => {
      const record = document.handles[handleId]
      if (!record || record.ownerExtensionId !== principal.extensionId ||
        record.ownerExtensionVersion !== principal.extensionVersion) return document
      if (record.revokedAt) return document
      released = true
      if (record.lifecycle === 'cache') cachePath = record.absolutePath
      const revokedAt = this['now']().toISOString()
      const handles = cachePath === undefined
        ? { ...document.handles, [handleId]: { ...record, revokedAt } }
        : Object.fromEntries(Object.entries(document.handles).map(([id, candidate]) => [
            id,
            candidate.ownerExtensionId === principal.extensionId &&
            candidate.ownerExtensionVersion === principal.extensionVersion &&
            candidate.lifecycle === 'cache' &&
            candidate.absolutePath === cachePath &&
            !candidate.revokedAt
              ? { ...candidate, revokedAt }
              : candidate
          ]))
      return {
        ...document,
        revision: document.revision + 1,
        handles
      }
    })
    if (cachePath !== undefined) await rm(cachePath, { force: true })
    return released
  },

async reserveOutput(this: ExtensionMediaHandleService,
    principal: ExtensionPrincipal,
    handleId: string,
    reservationId: string
  ): Promise<ResolvedMediaHandle> {
    if (!reservationId || reservationId.length > 256) {
      throw new ExtensionMediaHandleError('handle_reserved', 'Invalid output reservation')
    }
    const current = await this.resolve(principal, handleId, 'write')
    let reserved: StoredMediaHandle | undefined
    await this['store'].update(emptyDocument, (document) => {
      const record = document.handles[handleId]
      assertOwnedRecord(record, principal)
      if (record.mode !== 'write') {
        throw new ExtensionMediaHandleError('mode_denied', 'Media handle is not an export target')
      }
      if (record.completedAt) {
        throw new ExtensionMediaHandleError('handle_consumed', 'Export target was already consumed')
      }
      if (record.reservationId && record.reservationId !== reservationId) {
        throw new ExtensionMediaHandleError('handle_reserved', 'Export target is already reserved')
      }
      reserved = { ...record, reservationId }
      return {
        ...document,
        revision: document.revision + 1,
        handles: { ...document.handles, [handleId]: reserved }
      }
    })
    return { ...current, ...(reserved ? { identity: reserved.identity } : {}) }
  },

async releaseOutputReservation(this: ExtensionMediaHandleService,
    principal: ExtensionPrincipal,
    handleId: string,
    reservationId: string
  ): Promise<boolean> {
    let released = false
    await this['store'].update(emptyDocument, (document) => {
      const record = document.handles[handleId]
      if (!record || record.ownerExtensionId !== principal.extensionId ||
        record.ownerExtensionVersion !== principal.extensionVersion ||
        record.reservationId !== reservationId || record.completedAt || record.revokedAt) {
        return document
      }
      released = true
      const { reservationId: _, ...next } = record
      return {
        ...document,
        revision: document.revision + 1,
        handles: { ...document.handles, [handleId]: next }
      }
    })
    return released
  },
}
