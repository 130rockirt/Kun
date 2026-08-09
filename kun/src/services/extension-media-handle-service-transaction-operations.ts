import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { AtomicJsonFile } from '../extensions/atomic-json.js'
import { extensionWorkspaceKey } from '../extensions/paths.js'
import type { ExtensionPrincipal } from './extension-agent-service.js'
import { type ExtensionMediaHandleService, MediaHandleModeSchema, MediaHandleSourceSchema, MediaHandleLifecycleSchema, FileIdentitySchema, StoredMediaHandleSchema, MediaHandleDocumentSchema, type StoredMediaHandle, type MediaHandleMode, type MediaHandleSource, type MediaHandleLifecycle, type FileIdentity, type MediaHandleProjection, type ResolvedMediaHandle, type MediaOutputCompletionTransaction, type PendingMediaOutputTransaction, type CompletedMediaOutputRecovery, ExtensionMediaHandleError, type RegisterMediaHandleInput, type RegisterCacheMediaTargetInput, emptyDocument, resolveCandidate, outputCandidate, authorizeWorkspace, assertExtensionCacheTarget, ensureCacheParent, requirePermission, requireRecordAccess, canonicalExistingDirectory, assertWithinWorkspace, canonicalOutput, fileIdentityFromStat, serializableFileSystemIdentifier, statNumber, readIdentity, refreshIdentity, assertOwnedRecord, assertOwnedTransactionRecord, assertOwnedRecordIncludingRevoked, matchesFileIdentity, identifiesSameFile, project, deleteCachePaths, completionIdentity, boundedDisplayName, stripAsciiControl, inferMediaMime } from './extension-media-handle-service-core.js'

export const extensionMediaHandleServiceTransactionOperations = {
/** Core-only recovery projection for an interrupted output reservation. */
async inspectOutputTransaction(this: ExtensionMediaHandleService,
    principal: ExtensionPrincipal,
    handleId: string,
    reservationId: string
  ): Promise<PendingMediaOutputTransaction> {
    const record = (await this['store'].read(emptyDocument)).handles[handleId]
    assertOwnedTransactionRecord(record, principal)
    await authorizeWorkspace(principal, record.workspaceRoot)
    if (record.mode !== 'write' || record.reservationId !== reservationId) {
      throw new ExtensionMediaHandleError('handle_reserved', 'Output transaction is not active')
    }
    const originalIdentity = record.completedAt === undefined
      ? record.identity
      : record.previousIdentity
    return {
      handleId,
      absolutePath: record.absolutePath,
      completed: record.completedAt !== undefined,
      hadTarget: originalIdentity !== undefined,
      ...(originalIdentity ? { originalIdentity } : {}),
      ...(record.completedAt !== undefined && record.identity
        ? { completedIdentity: record.identity }
        : {})
    }
  },

/** Core-only projection used to remove deterministic recovery files. */
async inspectCompletedOutput(this: ExtensionMediaHandleService,
    principal: ExtensionPrincipal,
    handleId: string
  ): Promise<CompletedMediaOutputRecovery> {
    const record = (await this['store'].read(emptyDocument)).handles[handleId]
    assertOwnedRecordIncludingRevoked(record, principal)
    await authorizeWorkspace(principal, record.workspaceRoot)
    if (record.mode !== 'write' || record.completedAt === undefined || record.identity === undefined) {
      throw new ExtensionMediaHandleError('handle_consumed', 'Output handle is not completed')
    }
    return {
      handleId,
      absolutePath: record.absolutePath,
      completedIdentity: record.identity
    }
  },

/**
   * Finalizes provisional handles after a completed durable job is recovered.
   * Already-finalized handles are ignored so the operation is restart-safe.
   */
async commitOutputTransaction(this: ExtensionMediaHandleService,
    principal: ExtensionPrincipal,
    handleIds: readonly string[],
    reservationId: string
  ): Promise<void> {
    if (handleIds.length < 1 || handleIds.length > 16 ||
      new Set(handleIds).size !== handleIds.length) {
      throw new ExtensionMediaHandleError('handle_reserved', 'Output commit set is invalid')
    }
    await this['store'].update(emptyDocument, (document) => {
      const handles = { ...document.handles }
      let changed = false
      for (const handleId of handleIds) {
        const record = handles[handleId]
        if (record === undefined) continue
        assertOwnedRecordIncludingRevoked(record, principal)
        if (record.reservationId !== reservationId) continue
        if (record.mode !== 'write' || record.completedAt === undefined || record.identity === undefined) {
          throw new ExtensionMediaHandleError(
            'handle_consumed',
            'Output transaction is not completed'
          )
        }
        const generated = Object.values(handles).filter((candidate) =>
          candidate.ownerExtensionId === principal.extensionId &&
          candidate.ownerExtensionVersion === principal.extensionVersion &&
          candidate.source === 'generated' &&
          candidate.mode === 'read' &&
          candidate.reservationId === reservationId &&
          candidate.absolutePath === record.absolutePath &&
          candidate.identity !== undefined && matchesFileIdentity(candidate.identity, record.identity!)
        )
        if (generated.length !== 1) {
          throw new ExtensionMediaHandleError(
            'handle_consumed',
            'Provisional generated handle set changed before recovery commit'
          )
        }
        const finalizedOriginal = { ...record }
        const finalizedGenerated = { ...generated[0]! }
        delete finalizedOriginal.reservationId
        delete finalizedOriginal.previousIdentity
        delete finalizedGenerated.reservationId
        handles[handleId] = finalizedOriginal
        handles[generated[0]!.id] = finalizedGenerated
        changed = true
      }
      if (!changed) return document
      return {
        ...document,
        revision: document.revision + 1,
        handles
      }
    })
  },

/**
   * Restores persisted handle state for a reservation after its filesystem
   * targets have been rolled back. This also removes any provisional generated
   * read handles created before the durable job terminal fence.
   */
async rollbackOutputTransaction(this: ExtensionMediaHandleService,
    principal: ExtensionPrincipal,
    handleIds: readonly string[],
    reservationId: string
  ): Promise<void> {
    if (handleIds.length < 1 || handleIds.length > 16 ||
      new Set(handleIds).size !== handleIds.length) {
      throw new ExtensionMediaHandleError('handle_reserved', 'Output rollback set is invalid')
    }
    await this['store'].update(emptyDocument, (document) => {
      const handles = { ...document.handles }
      let changed = false
      for (const handleId of handleIds) {
        const record = handles[handleId]
        if (record === undefined) continue
        assertOwnedTransactionRecord(record, principal)
        if (record.reservationId !== reservationId) continue
        if (record.mode !== 'write') throw new ExtensionMediaHandleError(
          'handle_reserved',
          'Output transaction changed before recovery'
        )
        if (record.completedAt === undefined) {
          const restored = { ...record }
          delete restored.reservationId
          handles[handleId] = restored
          changed = true
          continue
        }
        const generated = Object.values(handles).filter((candidate) =>
          candidate.ownerExtensionId === principal.extensionId &&
          candidate.ownerExtensionVersion === principal.extensionVersion &&
          candidate.source === 'generated' &&
          candidate.mode === 'read' &&
          candidate.reservationId === reservationId &&
          candidate.absolutePath === record.absolutePath
        )
        if (generated.length !== 1) {
          throw new ExtensionMediaHandleError(
            'handle_consumed',
            'Provisional generated handle set changed before recovery'
          )
        }
        const restored = { ...record }
        if (record.previousIdentity) restored.identity = record.previousIdentity
        else delete restored.identity
        delete restored.previousIdentity
        delete restored.reservationId
        delete restored.completedAt
        delete restored.revokedAt
        handles[handleId] = restored
        delete handles[generated[0]!.id]
        changed = true
      }
      if (!changed) return document
      return {
        ...document,
        revision: document.revision + 1,
        handles
      }
    })
  },
}
