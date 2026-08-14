import type { KunGuiApi } from '@shared/kun-gui-api'
import type { NormalizedThread } from '../agent/types'
import type { BrowserStorageLike } from '../lib/browser-storage'
import { browserStorage } from '../lib/browser-storage'
import type { DesignDocumentTarget } from '../agent/design-task-profile'
import {
  forgetPendingDesignDocumentClone,
  markDesignDocumentCloneRuntimeRequested,
  pendingDesignDocumentClones,
  rememberPendingDesignDocumentClone
} from './design-document-clone-registry'
import {
  documentDirPath,
  documentsIndexPath,
  flushPendingDocumentsIndexes,
  parseDocumentsIndex,
  serializeDocumentsIndex
} from './design-document-persistence'
import {
  flushDesignPersistenceQueue,
  normalizeDesignPersistenceWorkspaceRoot
} from './design-persistence-coordinator'
import { createDesignDocumentId, type DesignDocument } from './design-types'
import { parseCanvasDocument, serializeCanvasDocument } from './canvas/canvas-persistence'
import type { CanvasDocument } from './canvas/canvas-types'

type DesignDocumentForkApi = Pick<
  KunGuiApi,
  | 'createWorkspaceDirectory'
  | 'deleteWorkspaceEntry'
  | 'listWorkspaceDirectory'
  | 'readWorkspaceFile'
  | 'writeWorkspaceFile'
>

export type PreparedDesignDocumentFork = {
  designDocumentTarget: DesignDocumentTarget
  cleanup: () => Promise<void>
  commit?: () => Promise<void>
  markRuntimeRequestStarted?: () => Promise<void>
  operationId?: string
}

export type CloneDesignDocumentForForkInput = {
  workspaceRoot: string
  sourceTarget: DesignDocumentTarget
  api?: DesignDocumentForkApi
  createDocumentId?: () => string
  now?: () => string
  operationStorage?: BrowserStorageLike | null
  operation?: {
    kind: 'fork' | 'resume' | 'bind'
    sourceId: string
    relation?: 'fork' | 'side' | 'resume' | 'bind'
  }
}

export type RemoveClonedDesignDocumentInput = {
  workspaceRoot: string
  documentTarget: DesignDocumentTarget
  api?: DesignDocumentForkApi
}

export type ReconcilePendingDesignDocumentClonesInput = {
  threads: readonly NormalizedThread[]
  api?: DesignDocumentForkApi
  operationStorage?: BrowserStorageLike | null
}

type SourceTree = {
  directories: string[]
  files: Array<{ path: string; content: string }>
}

function defaultApi(): DesignDocumentForkApi | undefined {
  return typeof window === 'undefined' ? undefined : window.kunGui
}

function requireResult(
  result: { ok: boolean; message?: string },
  fallback: string
): void {
  if (!result.ok) throw new Error(result.message || fallback)
}

type DesignDocumentsIndex = NonNullable<ReturnType<typeof parseDocumentsIndex>>
type DesignDocumentsIndexSnapshot = {
  index: DesignDocumentsIndex
  mtimeMs?: number
}

const indexMutationTails = new Map<string, Promise<void>>()

function toDocuments(index: DesignDocumentsIndex): DesignDocument[] {
  return index.documents.map((entry) => ({ ...entry, artifacts: [] }))
}

async function readIndex(
  api: DesignDocumentForkApi,
  workspaceRoot: string
): Promise<DesignDocumentsIndexSnapshot> {
  const read = await api.readWorkspaceFile({ workspaceRoot, path: documentsIndexPath() })
  if (!read.ok) {
    return { index: { version: 2, activeDocumentId: null, folders: [], documents: [] } }
  }
  const parsed = !read.truncated ? parseDocumentsIndex(read.content) : null
  if (!parsed) throw new Error('The Design documents index is invalid or truncated.')
  return {
    index: parsed,
    ...(typeof read.mtimeMs === 'number' ? { mtimeMs: read.mtimeMs } : {})
  }
}

function rewriteDocumentPaths(content: string, sourceId: string, targetId: string): string {
  const sourcePrefix = `.kun-design/${sourceId}`
  const targetPrefix = `.kun-design/${targetId}`
  return content.split(sourcePrefix).join(targetPrefix)
}

function replayTurnIdFromKey(value: string): string | undefined {
  return value.split('\0')[1]?.trim() || undefined
}

function latestMaterializedTurnId(canvas: CanvasDocument): string | undefined {
  if (canvas.rendererReplayWatermarkTurnId) return canvas.rendererReplayWatermarkTurnId
  const durableKey = [...(canvas.rendererReplayKeys ?? [])].reverse()
    .map(replayTurnIdFromKey).find(Boolean)
  if (durableKey) return durableKey
  const replayPrefix = 'renderer_replay:'
  for (const entry of [...(canvas.operationJournal ?? [])].reverse()) {
    for (const operation of [...entry.operations].reverse()) {
      if (!operation.id.startsWith(replayPrefix)) continue
      const turnId = replayTurnIdFromKey(operation.id.slice(replayPrefix.length))
      if (turnId) return turnId
    }
  }
  return undefined
}

function cloneDocumentFileContent(content: string, sourceId: string, targetId: string): string {
  const canvas = parseCanvasDocument(content)
  if (!canvas) return rewriteDocumentPaths(content, sourceId, targetId)
  const replayWatermark = latestMaterializedTurnId(canvas)
  const operationJournal = canvas.operationJournal
    ?.map((entry) => ({
      ...entry,
      operations: entry.operations.filter(
        (operation) => !operation.id.startsWith('renderer_replay:')
      )
    }))
    .filter((entry) => entry.operations.length > 0)
  const {
    rendererReplayKeys: _rendererReplayKeys,
    operationJournal: _operationJournal,
    graph,
    ...canvasWithoutReceipts
  } = canvas
  const graphLastEntryWasRemoved = Boolean(
    graph?.lastJournalEntryId &&
    !operationJournal?.some((entry) => entry.id === graph.lastJournalEntryId)
  )
  const nextGraph = graphLastEntryWasRemoved && graph
    ? (({ lastJournalEntryId: _lastJournalEntryId, ...rest }) => rest)(graph)
    : graph
  const sanitized: CanvasDocument = {
    ...canvasWithoutReceipts,
    ...(replayWatermark ? { rendererReplayWatermarkTurnId: replayWatermark } : {}),
    ...(operationJournal?.length ? { operationJournal } : {}),
    ...(nextGraph ? { graph: nextGraph } : {})
  }
  return rewriteDocumentPaths(serializeCanvasDocument(sanitized), sourceId, targetId)
}

async function withIndexMutationLock<T>(workspaceRoot: string, run: () => Promise<T>): Promise<T> {
  const previous = indexMutationTails.get(workspaceRoot) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const tail = previous.catch(() => undefined).then(() => gate)
  indexMutationTails.set(workspaceRoot, tail)
  await previous.catch(() => undefined)
  try {
    return await run()
  } finally {
    release()
    if (indexMutationTails.get(workspaceRoot) === tail) indexMutationTails.delete(workspaceRoot)
  }
}

async function mutateDocumentsIndex(
  api: DesignDocumentForkApi,
  workspaceRoot: string,
  mutate: (index: DesignDocumentsIndex) => string | null
): Promise<void> {
  await withIndexMutationLock(workspaceRoot, async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const snapshot = await readIndex(api, workspaceRoot)
      const content = mutate(snapshot.index)
      if (content === null) return
      const written = await api.writeWorkspaceFile({
        workspaceRoot,
        path: documentsIndexPath(),
        content,
        ...(snapshot.mtimeMs === undefined ? {} : { expectedMtimeMs: snapshot.mtimeMs })
      })
      if (!written.ok && written.code === 'modified_on_disk') continue
      requireResult(written, 'Unable to update the Design documents index.')
      return
    }
    throw new Error('The Design documents index kept changing; retry the fork.')
  })
}

async function readSourceTree(
  api: DesignDocumentForkApi,
  workspaceRoot: string,
  sourceDocumentId: string
): Promise<SourceTree> {
  const root = documentDirPath(sourceDocumentId)
  const tree: SourceTree = { directories: [], files: [] }

  const visit = async (path: string, relativePath: string): Promise<void> => {
    const listed = await api.listWorkspaceDirectory({ workspaceRoot, path })
    requireResult(listed, `Unable to read Design document directory: ${path}`)
    if (!listed.ok) return
    for (const entry of listed.entries) {
      const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name
      const childPath = `${path}/${entry.name}`
      if (entry.type === 'directory') {
        tree.directories.push(childRelativePath)
        await visit(childPath, childRelativePath)
        continue
      }
      const read = await api.readWorkspaceFile({ workspaceRoot, path: childPath })
      requireResult(read, `Unable to read Design document file: ${childPath}`)
      if (!read.ok) continue
      if (read.truncated) throw new Error(`Design document file is too large to clone: ${childPath}`)
      tree.files.push({ path: childRelativePath, content: read.content })
    }
  }

  await visit(root, '')
  return tree
}

async function deleteForkDirectory(
  api: DesignDocumentForkApi,
  workspaceRoot: string,
  documentId: string
): Promise<void> {
  const deleted = await api.deleteWorkspaceEntry({
    workspaceRoot,
    path: documentDirPath(documentId)
  })
  if (!deleted.ok && !/(?:enoent|no such file|not found)/i.test(deleted.message)) {
    throw new Error(deleted.message || 'Unable to remove cloned Design document.')
  }
}

async function removeForkFromIndex(
  api: DesignDocumentForkApi,
  workspaceRoot: string,
  documentId: string
): Promise<void> {
  await flushPendingDocumentsIndexes(workspaceRoot)
  await flushDesignPersistenceQueue(workspaceRoot)
  await mutateDocumentsIndex(api, workspaceRoot, (current) => {
    if (!current.documents.some((document) => document.id === documentId)) return null
    const documents = toDocuments(current).filter((document) => document.id !== documentId)
    const activeDocumentId = documents.some((document) => document.id === current.activeDocumentId)
      ? current.activeDocumentId
      : documents[0]?.id ?? null
    return serializeDocumentsIndex(documents, activeDocumentId, current.folders)
  })
}

export async function removeClonedDesignDocument(
  input: RemoveClonedDesignDocumentInput
): Promise<void> {
  const workspaceRoot = normalizeDesignPersistenceWorkspaceRoot(input.workspaceRoot)
  const documentId = input.documentTarget.documentId.trim()
  const api = input.api ?? defaultApi()
  if (!workspaceRoot || !documentId) throw new Error('The cloned Design document target is invalid.')
  if (!api) throw new Error('Workspace file access is unavailable.')
  let cleanupError: unknown
  try {
    await removeForkFromIndex(api, workspaceRoot, documentId)
  } catch (error) {
    cleanupError = error
  }
  try {
    await deleteForkDirectory(api, workspaceRoot, documentId)
  } catch (error) {
    cleanupError ??= error
  }
  if (cleanupError) throw cleanupError
}

function preparedCloneForOperation(options: {
  api: DesignDocumentForkApi
  operation: ReturnType<typeof pendingDesignDocumentClones>[number]
  operationStorage: BrowserStorageLike | null
  indexCommitted: boolean
}): PreparedDesignDocumentFork {
  const { api, operation, operationStorage } = options
  let cleanupPromise: Promise<void> | null = null
  return {
    designDocumentTarget: operation.clonedTarget,
    operationId: operation.operationId,
    markRuntimeRequestStarted: async () => {
      markDesignDocumentCloneRuntimeRequested(operation.operationId, operationStorage)
    },
    commit: async () => {
      try {
        forgetPendingDesignDocumentClone(operation.operationId, operationStorage)
      } catch {
        // A stale marker is safe: startup reconciliation retains referenced clones.
      }
    },
    cleanup: () => {
      if (cleanupPromise) return cleanupPromise
      cleanupPromise = (async () => {
        if (!options.indexCommitted) {
          await deleteForkDirectory(api, operation.workspaceRoot, operation.clonedTarget.documentId)
        } else {
          await removeClonedDesignDocument({
            workspaceRoot: operation.workspaceRoot,
            documentTarget: operation.clonedTarget,
            api
          })
        }
        try {
          forgetPendingDesignDocumentClone(operation.operationId, operationStorage)
        } catch {
          // Cleanup is already complete; a stale marker is harmless.
        }
      })().catch((error) => {
        cleanupPromise = null
        throw error
      })
      return cleanupPromise
    }
  }
}

function createDesignCloneOperationId(): string {
  const randomId = globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `design-clone-${randomId}`
}

/**
 * Clone the durable Design document before asking Kun to fork its locked task.
 * The cloned board keeps artifact ids so historical turn targets remain valid,
 * while the new document id gives the fork an independent mutation boundary.
 */
export async function cloneDesignDocumentForFork(
  input: CloneDesignDocumentForForkInput
): Promise<PreparedDesignDocumentFork> {
  const workspaceRoot = normalizeDesignPersistenceWorkspaceRoot(input.workspaceRoot)
  const sourceDocumentId = input.sourceTarget.documentId.trim()
  const boardArtifactId = input.sourceTarget.boardArtifactId.trim()
  const api = input.api ?? defaultApi()
  if (!workspaceRoot || !sourceDocumentId || !boardArtifactId) {
    throw new Error('The Design task does not have a valid document target.')
  }
  if (!api) throw new Error('Workspace file access is unavailable.')
  const operationStorage = input.operationStorage === undefined
    ? browserStorage()
    : input.operationStorage
  if (!operationStorage && !input.api && typeof window !== 'undefined') {
    throw new Error('Unable to durably record the Design clone operation.')
  }
  const operationKind = input.operation?.kind ?? 'fork'
  const operationSourceId = input.operation?.sourceId.trim() || sourceDocumentId
  const operationRelation = input.operation?.relation ?? (
    operationKind === 'resume' ? 'resume' : 'fork'
  )
  const retry = pendingDesignDocumentClones(operationStorage).find((operation) =>
    operation.phase === 'runtime-requested' &&
    operation.kind === operationKind && operation.sourceId === operationSourceId &&
    operation.relation === operationRelation && operation.workspaceRoot === workspaceRoot &&
    operation.sourceTarget.documentId === sourceDocumentId &&
    operation.sourceTarget.boardArtifactId === boardArtifactId
  )
  if (retry) {
    return preparedCloneForOperation({
      api, operation: retry, operationStorage, indexCommitted: true
    })
  }

  await flushPendingDocumentsIndexes(workspaceRoot)
  await flushDesignPersistenceQueue(workspaceRoot)
  const { index } = await readIndex(api, workspaceRoot)
  const source = index.documents.find((document) => document.id === sourceDocumentId)
  if (!source) throw new Error('The Design task document is missing from the workspace index.')

  const createId = input.createDocumentId ?? createDesignDocumentId
  let documentId = ''
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = createId().trim()
    if (
      /^[a-zA-Z0-9_-]+$/.test(candidate) &&
      !index.documents.some((document) => document.id === candidate)
    ) {
      documentId = candidate
      break
    }
  }
  if (!documentId) throw new Error('Unable to allocate an independent Design document id.')

  const tree = await readSourceTree(api, workspaceRoot, sourceDocumentId)
  const now = (input.now ?? (() => new Date().toISOString()))()
  const operationId = createDesignCloneOperationId()
  const operation = {
    operationId,
    kind: operationKind,
    sourceId: operationSourceId,
    relation: operationRelation,
    workspaceRoot,
    sourceTarget: { documentId: sourceDocumentId, boardArtifactId },
    clonedTarget: { documentId, boardArtifactId },
    createdAt: now,
    phase: 'prepared' as const
  }
  rememberPendingDesignDocumentClone(operation, operationStorage)
  let indexCommitted = false
  try {
    const created = await api.createWorkspaceDirectory({
      workspaceRoot,
      path: documentDirPath(documentId)
    })
    requireResult(created, 'Unable to create the cloned Design document directory.')
    for (const directory of tree.directories) {
      const nested = await api.createWorkspaceDirectory({
        workspaceRoot,
        path: `${documentDirPath(documentId)}/${directory}`
      })
      requireResult(nested, `Unable to create cloned Design directory: ${directory}`)
    }
    for (const file of tree.files) {
      const written = await api.writeWorkspaceFile({
        workspaceRoot,
        path: `${documentDirPath(documentId)}/${file.path}`,
        content: cloneDocumentFileContent(file.content, sourceDocumentId, documentId)
      })
      requireResult(written, `Unable to clone Design document file: ${file.path}`)
    }

    await mutateDocumentsIndex(api, workspaceRoot, (current) => {
      if (current.documents.some((document) => document.id === documentId)) {
        throw new Error('The cloned Design document id was allocated concurrently.')
      }
      const currentSource = current.documents.find((document) => document.id === sourceDocumentId)
      if (!currentSource) throw new Error('The source Design document was removed during the fork.')
      const documents = [
        ...toDocuments(current),
        {
          ...currentSource,
          id: documentId,
          order: Math.max(-1, ...current.documents.map((document) => document.order)) + 1,
          createdAt: now,
          updatedAt: now,
          artifacts: []
        }
      ]
      return serializeDocumentsIndex(documents, current.activeDocumentId, current.folders)
    })
    indexCommitted = true
  } catch (error) {
    try {
      await removeClonedDesignDocument({
        workspaceRoot,
        documentTarget: { documentId, boardArtifactId },
        api
      })
      forgetPendingDesignDocumentClone(operationId, operationStorage)
    } catch {
      // Keep the durable marker so startup reconciliation retries cleanup.
    }
    throw error
  }

  return preparedCloneForOperation({ api, operation, operationStorage, indexCommitted })
}

export async function reconcilePendingDesignDocumentClones(
  input: ReconcilePendingDesignDocumentClonesInput
): Promise<{ retained: number; removed: number; failed: number }> {
  const operationStorage = input.operationStorage === undefined
    ? browserStorage()
    : input.operationStorage
  const operations = pendingDesignDocumentClones(operationStorage)
  let retained = 0
  let removed = 0
  let failed = 0
  for (const operation of operations) {
    if (operation.phase === 'prepared') {
      try {
        await removeClonedDesignDocument({
          workspaceRoot: operation.workspaceRoot,
          documentTarget: operation.clonedTarget,
          ...(input.api ? { api: input.api } : {})
        })
        forgetPendingDesignDocumentClone(operation.operationId, operationStorage)
        removed += 1
      } catch {
        failed += 1
      }
      continue
    }
    const referenced = input.threads.some((thread) => {
      if (thread.designCloneOperation?.operationId === operation.operationId) return true
      const target = thread.designProfile?.documentTarget
      return target?.documentId === operation.clonedTarget.documentId &&
        target.boardArtifactId === operation.clonedTarget.boardArtifactId
    })
    if (referenced) {
      retained += 1
      try {
        forgetPendingDesignDocumentClone(operation.operationId, operationStorage)
      } catch {
        failed += 1
      }
      continue
    }
    // The renderer may have timed out before Kun commits. An empty inventory is
    // not proof of rejection, so keep both the target and marker for later probes.
    retained += 1
  }
  return { retained, removed, failed }
}
