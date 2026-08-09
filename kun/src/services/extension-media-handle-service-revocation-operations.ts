import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { AtomicJsonFile } from '../extensions/atomic-json.js'
import { extensionWorkspaceKey } from '../extensions/paths.js'
import type { ExtensionPrincipal } from './extension-agent-service.js'
import { type ExtensionMediaHandleService, MediaHandleModeSchema, MediaHandleSourceSchema, MediaHandleLifecycleSchema, FileIdentitySchema, StoredMediaHandleSchema, MediaHandleDocumentSchema, type StoredMediaHandle, type MediaHandleMode, type MediaHandleSource, type MediaHandleLifecycle, type FileIdentity, type MediaHandleProjection, type ResolvedMediaHandle, type MediaOutputCompletionTransaction, type PendingMediaOutputTransaction, type CompletedMediaOutputRecovery, ExtensionMediaHandleError, type RegisterMediaHandleInput, type RegisterCacheMediaTargetInput, emptyDocument, resolveCandidate, outputCandidate, authorizeWorkspace, assertExtensionCacheTarget, ensureCacheParent, requirePermission, requireRecordAccess, canonicalExistingDirectory, assertWithinWorkspace, canonicalOutput, fileIdentityFromStat, serializableFileSystemIdentifier, statNumber, readIdentity, refreshIdentity, assertOwnedRecord, assertOwnedTransactionRecord, assertOwnedRecordIncludingRevoked, matchesFileIdentity, identifiesSameFile, project, deleteCachePaths, completionIdentity, boundedDisplayName, stripAsciiControl, inferMediaMime } from './extension-media-handle-service-core.js'

export const extensionMediaHandleServiceRevocationOperations = {
async revokeExtension(this: ExtensionMediaHandleService, extensionId: string): Promise<number> {
    let count = 0
    const cachePaths = new Set<string>()
    await this['store'].update(emptyDocument, (document) => {
      const revokedAt = this['now']().toISOString()
      const handles = Object.fromEntries(Object.entries(document.handles).map(([id, record]) => {
        if (record.ownerExtensionId !== extensionId || record.revokedAt) return [id, record]
        count += 1
        if (record.lifecycle === 'cache') cachePaths.add(record.absolutePath)
        return [id, { ...record, revokedAt }]
      }))
      return count === 0 ? document : { ...document, revision: document.revision + 1, handles }
    })
    await deleteCachePaths(cachePaths)
    return count
  },

/** Revoke handles owned by one extension in one workspace, leaving peers intact. */
async revokeExtensionWorkspace(this: ExtensionMediaHandleService,
    extensionId: string,
    workspaceId: string,
    workspaceRoot?: string
  ): Promise<number> {
    const canonicalWorkspace = workspaceRoot === undefined
      ? undefined
      : await canonicalExistingDirectory(workspaceRoot)
    let count = 0
    const cachePaths = new Set<string>()
    await this['store'].update(emptyDocument, (document) => {
      const revokedAt = this['now']().toISOString()
      const handles = Object.fromEntries(Object.entries(document.handles).map(([id, record]) => {
        if (
          record.ownerExtensionId !== extensionId ||
          (
            extensionWorkspaceKey(record.workspaceRoot) !== workspaceId &&
            record.workspaceRoot !== canonicalWorkspace
          ) ||
          record.revokedAt
        ) return [id, record]
        count += 1
        if (record.lifecycle === 'cache') cachePaths.add(record.absolutePath)
        return [id, { ...record, revokedAt }]
      }))
      return count === 0 ? document : { ...document, revision: document.revision + 1, handles }
    })
    await deleteCachePaths(cachePaths)
    return count
  },

async revokeWorkspace(this: ExtensionMediaHandleService, workspaceRoot: string): Promise<number> {
    const canonical = await canonicalExistingDirectory(workspaceRoot)
    let count = 0
    const cachePaths = new Set<string>()
    await this['store'].update(emptyDocument, (document) => {
      const revokedAt = this['now']().toISOString()
      const handles = Object.fromEntries(Object.entries(document.handles).map(([id, record]) => {
        if (record.workspaceRoot !== canonical || record.revokedAt) return [id, record]
        count += 1
        if (record.lifecycle === 'cache') cachePaths.add(record.absolutePath)
        return [id, { ...record, revokedAt }]
      }))
      return count === 0 ? document : { ...document, revision: document.revision + 1, handles }
    })
    await deleteCachePaths(cachePaths)
    return count
  },

async list(this: ExtensionMediaHandleService, principal: ExtensionPrincipal, workspaceRoot?: string): Promise<MediaHandleProjection[]> {
    const workspace = workspaceRoot ? await authorizeWorkspace(principal, workspaceRoot) : undefined
    const document = await this['store'].read(emptyDocument)
    return Object.values(document.handles)
      .filter((record) => record.ownerExtensionId === principal.extensionId)
      .filter((record) => record.ownerExtensionVersion === principal.extensionVersion)
      .filter((record) => !workspace || record.workspaceRoot === workspace)
      .map(project)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
  },

async requireOwned(this: ExtensionMediaHandleService,
    principal: ExtensionPrincipal,
    handleId: string
  ): Promise<StoredMediaHandle> {
    const record = (await this['store'].read(emptyDocument)).handles[handleId]
    if (!record || record.revokedAt || record.ownerExtensionId !== principal.extensionId ||
      record.ownerExtensionVersion !== principal.extensionVersion) {
      throw new ExtensionMediaHandleError('not_found', 'Media handle is not available')
    }
    return record
  },
}
