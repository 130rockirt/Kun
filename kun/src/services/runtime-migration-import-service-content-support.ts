import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { AttachmentStore } from '../attachments/attachment-store.js'
import type { ArtifactStore } from '../artifacts/artifact-store.js'
import { artifactId } from '../artifacts/artifact-summary.js'
import { RuntimeEvent } from '../contracts/events.js'
import { TurnItem } from '../contracts/items.js'
import {
  RuntimeMigrationImportControl,
  RuntimeMigrationImportPreflight,
  RuntimeMigrationImportResult,
  RuntimeMigrationSnapshotRecord,
  type RuntimeMigrationImportControl as RuntimeMigrationImportControlType,
  type RuntimeMigrationImportPreflight as RuntimeMigrationImportPreflightType,
  type RuntimeMigrationImportResult as RuntimeMigrationImportResultType,
  type RuntimeMigrationSnapshotRecord as RuntimeMigrationSnapshotRecordType
} from '../contracts/migrations.js'
import { ThreadSchema, type ThreadRecord } from '../contracts/threads.js'
import { MemoryCreateRequest, MemoryRecord } from '../contracts/memory.js'
import { AttachmentMetadata as AttachmentMetadataSchema, type AttachmentMetadata } from '../contracts/attachments.js'
import type { AgentSession } from '../domain/session.js'
import type { MemoryStore } from '../memory/memory-store.js'
import type { ScopedMigrationMaintenanceLock } from '../ports/migration-maintenance-lock.js'
import type { SessionStore } from '../ports/session-store.js'
import type { ThreadStore } from '../ports/thread-store.js'
import { sanitizeMigrationValue } from './runtime-migration-service.js'
import { type ChunkedContentDescriptor, MAX_IMPORT_CONTENT_BYTES, MAX_IMPORT_RECORDS, type PendingChunkedContent } from './runtime-migration-import-service-core.js'

export type ArtifactMigrationMetadata = {
  id: string
  mimeType?: string
  source?: string
  origin?: string
}

export function parseArtifactMetadata(value: unknown): ArtifactMigrationMetadata {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) {
    throw new Error('invalid migration artifact metadata')
  }
  for (const key of ['mimeType', 'source', 'origin'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') {
      throw new Error('invalid migration artifact metadata')
    }
  }
  return {
    id: value.id,
    ...(typeof value.mimeType === 'string' ? { mimeType: value.mimeType } : {}),
    ...(typeof value.source === 'string' ? { source: value.source } : {}),
    ...(typeof value.origin === 'string' ? { origin: value.origin } : {})
  }
}

export function parseChunkedContentDescriptor(value: unknown): ChunkedContentDescriptor | undefined {
  if (typeof value === 'string' || value === undefined) return undefined
  if (
    !isRecord(value) ||
    value.encoding !== 'base64-chunks' ||
    !Number.isSafeInteger(value.byteSize) ||
    Number(value.byteSize) < 0 ||
    Number(value.byteSize) > MAX_IMPORT_CONTENT_BYTES ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !Number.isSafeInteger(value.chunkCount) ||
    Number(value.chunkCount) < 1 ||
    Number(value.chunkCount) > MAX_IMPORT_RECORDS
  ) {
    throw new Error('invalid migration chunked content descriptor')
  }
  return {
    encoding: 'base64-chunks',
    byteSize: Number(value.byteSize),
    sha256: value.sha256,
    chunkCount: Number(value.chunkCount)
  }
}

export function startPendingContent(
  kind: PendingChunkedContent['kind'],
  sourceId: string,
  metadata: unknown,
  record: RuntimeMigrationSnapshotRecordType,
  descriptor: ChunkedContentDescriptor
): PendingChunkedContent {
  if (!record.contentId || record.contentId !== descriptor.sha256) {
    throw new Error(`migration ${kind} descriptor hash mismatch: ${sourceId}`)
  }
  return {
    kind,
    sourceId,
    metadata,
    ...(record.ownerId ? { ownerId: record.ownerId } : {}),
    contentId: record.contentId,
    descriptor,
    nextIndex: 0,
    byteSize: 0,
    chunks: []
  }
}

export function parseContentChunk(value: unknown): {
  kind: PendingChunkedContent['kind']
  sourceId: string
  index: number
  count: number
  dataBase64: string
} {
  if (
    !isRecord(value) ||
    (value.kind !== 'attachment' && value.kind !== 'artifact') ||
    typeof value.sourceId !== 'string' ||
    !value.sourceId ||
    !Number.isSafeInteger(value.index) ||
    Number(value.index) < 0 ||
    !Number.isSafeInteger(value.count) ||
    Number(value.count) < 1 ||
    typeof value.dataBase64 !== 'string'
  ) {
    throw new Error('invalid migration content chunk')
  }
  return {
    kind: value.kind,
    sourceId: value.sourceId,
    index: Number(value.index),
    count: Number(value.count),
    dataBase64: value.dataBase64
  }
}

export function decodeBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('invalid base64 content in runtime migration')
  }
  return Buffer.from(value, 'base64')
}

export function verifyChunkedContent(pending: PendingChunkedContent, data: Buffer): void {
  const digest = createHash('sha256').update(data).digest('hex')
  if (data.byteLength !== pending.descriptor.byteSize || digest !== pending.descriptor.sha256) {
    throw new Error(`migration ${pending.kind} content integrity check failed: ${pending.sourceId}`)
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function rewriteWorkspace(value: string, workspacePathMap: Readonly<Record<string, string>>): string {
  for (const [source, destination] of Object.entries(workspacePathMap)) {
    const sourceNorm = source.replaceAll('\\', '/').replace(/\/+$/, '')
    const valueNorm = value.replaceAll('\\', '/')
    if (valueNorm === sourceNorm) return destination
    if (valueNorm.startsWith(`${sourceNorm}/`)) return join(destination, ...valueNorm.slice(sourceNorm.length + 1).split('/'))
  }
  return value
}

export function isWorkspacePathKey(key: string): boolean {
  return /^(?:workspace|workspaceRoot|localFilePath|path|project)$/i.test(key)
}

export function canonicalLine(type: string, value: unknown): string {
  return `${type}\0${JSON.stringify(value)}\n`
}

export function isThreadOwnedRecord(type: RuntimeMigrationSnapshotRecordType['type']): boolean {
  return type === 'session' ||
    type === 'item' ||
    type === 'event' ||
    type === 'historical-approval' ||
    type === 'historical-user-input' ||
    type === 'attachment' ||
    type === 'artifact' ||
    type === 'content-chunk' ||
    type === 'memory'
}

export function isSafeImportedThreadId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}

export function appendHistoricalProvider(summary: string | undefined, providerId: string): string {
  const note = `Imported history used provider "${providerId}". Select a configured provider before starting a new turn.`
  return summary ? `${summary}\n\n${note}` : note
}

export function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1
}
