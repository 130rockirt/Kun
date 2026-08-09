import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { AtomicJsonFile } from '../extensions/atomic-json.js'
import { extensionWorkspaceKey } from '../extensions/paths.js'
import type { ExtensionPrincipal } from './extension-agent-service.js'
import { type ExtensionMediaHandleService, MediaHandleModeSchema, MediaHandleSourceSchema, MediaHandleLifecycleSchema, FileIdentitySchema, StoredMediaHandleSchema, MediaHandleDocumentSchema, type StoredMediaHandle, type MediaHandleMode, type MediaHandleSource, type MediaHandleLifecycle, type FileIdentity, type MediaHandleProjection, type ResolvedMediaHandle, type MediaOutputCompletionTransaction, type PendingMediaOutputTransaction, type CompletedMediaOutputRecovery, ExtensionMediaHandleError, type RegisterMediaHandleInput, type RegisterCacheMediaTargetInput, emptyDocument, resolveCandidate, outputCandidate, authorizeWorkspace, assertExtensionCacheTarget, ensureCacheParent, requirePermission, requireRecordAccess, canonicalExistingDirectory, assertWithinWorkspace, canonicalOutput, fileIdentityFromStat, serializableFileSystemIdentifier, statNumber, readIdentity, refreshIdentity, assertOwnedRecord, assertOwnedTransactionRecord, assertOwnedRecordIncludingRevoked, matchesFileIdentity, identifiesSameFile, project, deleteCachePaths, completionIdentity, boundedDisplayName, stripAsciiControl, inferMediaMime } from './extension-media-handle-service-core.js'

export const extensionMediaHandleServiceCompletionOperations = {
/**
   * Consumes an export grant after atomic promotion and returns a new readable
   * generated-media handle. The destination path never leaves this service.
   */
async completeOutput(this: ExtensionMediaHandleService,
    principal: ExtensionPrincipal,
    handleId: string,
    reservationId: string
  ): Promise<MediaHandleProjection> {
    return (await this.completeOutputs(principal, [{ handleId, reservationId }]))[0]!
  },

/**
   * Completes a set of already-promoted outputs in one store revision. All
   * filesystem identities and reservations are validated before any export
   * grant is consumed, so callers can safely roll the file promotion back if
   * this method rejects.
   */
async completeOutputs(this: ExtensionMediaHandleService,
    principal: ExtensionPrincipal,
    outputs: Array<{ handleId: string; reservationId: string }>,
    options: { signal?: AbortSignal } = {}
  ): Promise<MediaHandleProjection[]> {
    const transaction = await this.completeOutputsReversibly(principal, outputs, options)
    await transaction.commit()
    return transaction.generatedMedia
  },

/**
   * Completes output grants atomically but retains enough core-private state to
   * undo that completion until the owning durable job commits successfully.
   * The caller must invoke exactly one of commit or rollback; both operations
   * are idempotent for the same terminal choice and reject conflicting choices.
   */
async completeOutputsReversibly(this: ExtensionMediaHandleService,
    principal: ExtensionPrincipal,
    outputs: Array<{ handleId: string; reservationId: string }>,
    options: { signal?: AbortSignal } = {}
  ): Promise<MediaOutputCompletionTransaction> {
    options.signal?.throwIfAborted()
    if (outputs.length < 1 || outputs.length > 16 ||
      new Set(outputs.map(({ handleId }) => handleId)).size !== outputs.length) {
      throw new ExtensionMediaHandleError('handle_reserved', 'Export target completion set is invalid')
    }
    const prepared = await Promise.all(outputs.map(async ({ handleId, reservationId }) => {
      const before = await this['requireOwned'](principal, handleId)
      if (before.mode !== 'write' || before.reservationId !== reservationId || before.completedAt) {
        throw new ExtensionMediaHandleError('handle_reserved', 'Export target reservation is not active')
      }
      return { handleId, reservationId, before, identity: await readIdentity(before.absolutePath) }
    }))
    options.signal?.throwIfAborted()
    const createdAt = this['now']().toISOString()
    const generated = prepared.map(({ before, identity }) => {
      const record: StoredMediaHandle = {
        ...before,
        id: `media_${randomUUID()}`,
        mode: 'read',
        source: 'generated',
        identity,
        createdAt,
        lastAccessedAt: createdAt
      }
      delete record.completedAt
      delete record.revokedAt
      delete record.previousIdentity
      return record
    })
    const completed = prepared.map(({ before, identity }) => {
      const record: StoredMediaHandle = {
        ...before,
        identity,
        ...(before.identity ? { previousIdentity: before.identity } : {}),
        completedAt: createdAt,
        revokedAt: createdAt
      }
      return record
    })
    await this['store'].update(emptyDocument, (document) => {
      options.signal?.throwIfAborted()
      const handles = { ...document.handles }
      for (let index = 0; index < prepared.length; index += 1) {
        const { handleId, reservationId } = prepared[index]!
        const record = handles[handleId]
        assertOwnedRecord(record, principal)
        if (record.mode !== 'write' || record.reservationId !== reservationId || record.completedAt) {
          throw new ExtensionMediaHandleError('handle_reserved', 'Export target reservation is not active')
        }
        handles[handleId] = completed[index]!
        const readable = generated[index]!
        if (handles[readable.id] !== undefined) {
          throw new ExtensionMediaHandleError('handle_limit', 'Generated media handle identity collided')
        }
        handles[readable.id] = readable
      }
      return {
        ...document,
        revision: document.revision + 1,
        handles
      }
    })
    const generatedMedia = generated.map(project)
    let state: 'pending' | 'committed' | 'rolled-back' = 'pending'
    let transition = Promise.resolve()
    const serialize = async (
      target: 'committed' | 'rolled-back',
      operation: () => Promise<void>
    ): Promise<void> => {
      const prior = transition
      let release!: () => void
      transition = new Promise<void>((resolvePromise) => { release = resolvePromise })
      await prior
      try {
        if (state === target) return
        if (state !== 'pending') {
          throw new ExtensionMediaHandleError(
            'handle_consumed',
            'Output completion transaction already reached another terminal state'
          )
        }
        await operation()
        state = target
      } finally {
        release()
      }
    }
    return {
      generatedMedia,
      commit: () => serialize('committed', async () => {
        await this['store'].update(emptyDocument, (document) => {
          const handles = { ...document.handles }
          for (let index = 0; index < prepared.length; index += 1) {
            const original = prepared[index]!.before
            const generatedRecord = generated[index]!
            const currentOriginal = handles[original.id]
            const currentGenerated = handles[generatedRecord.id]
            if (
              !currentOriginal ||
              !currentGenerated ||
              !isDeepStrictEqual(currentOriginal, completed[index]!) ||
              !isDeepStrictEqual(currentGenerated, generatedRecord)
            ) {
              throw new ExtensionMediaHandleError(
                'handle_consumed',
                'Output completion changed before commit'
              )
            }
            const finalizedOriginal = { ...currentOriginal }
            const finalizedGenerated = { ...currentGenerated }
            delete finalizedOriginal.reservationId
            delete finalizedOriginal.previousIdentity
            delete finalizedGenerated.reservationId
            handles[original.id] = finalizedOriginal
            handles[generatedRecord.id] = finalizedGenerated
          }
          return {
            ...document,
            revision: document.revision + 1,
            handles
          }
        })
      }),
      rollback: () => serialize('rolled-back', async () => {
        await this['store'].update(emptyDocument, (document) => {
          const handles = { ...document.handles }
          for (let index = 0; index < prepared.length; index += 1) {
            const original = prepared[index]!.before
            const completedRecord = completed[index]!
            const generatedRecord = generated[index]!
            if (
              !isDeepStrictEqual(handles[original.id], completedRecord) ||
              !isDeepStrictEqual(handles[generatedRecord.id], generatedRecord)
            ) {
              throw new ExtensionMediaHandleError(
                'handle_consumed',
                'Output completion changed before rollback'
              )
            }
          }
          for (let index = 0; index < prepared.length; index += 1) {
            const original = prepared[index]!.before
            handles[original.id] = original
            delete handles[generated[index]!.id]
          }
          return {
            ...document,
            revision: document.revision + 1,
            handles
          }
        })
      })
    }
  },
}
