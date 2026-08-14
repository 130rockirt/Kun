import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KunGuiApi } from '@shared/kun-gui-api'
import type { BrowserStorageLike } from '../lib/browser-storage'
import { parseDocumentsIndex, serializeDocumentsIndex } from './design-document-persistence'
import {
  cloneDesignDocumentForFork,
  reconcilePendingDesignDocumentClones
} from './design-document-fork'
import { pendingDesignDocumentClones } from './design-document-clone-registry'
import type { DesignDocument } from './design-types'
import { parseCanvasDocument, serializeCanvasDocument } from './canvas/canvas-persistence'
import { createEmptyDocument } from './canvas/canvas-types'

class MemoryStorage implements BrowserStorageLike {
  private readonly values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
}

function sourceDocument(): DesignDocument {
  return {
    id: 'doc_source',
    title: 'Checkout concept',
    order: 2,
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
    artifacts: [],
    activeArtifactId: 'board_main',
    folderId: null
  }
}

function installMemoryApi() {
  const sourceCanvas = createEmptyDocument()
  sourceCanvas.rendererReplayKeys = ['thread_source\0turn_1\0doc_source\0board_main\0assistant:0']
  sourceCanvas.operationJournal = [{
    id: 'replay_journal',
    label: 'renderer replay',
    createdAt: '2026-08-12T00:00:00.000Z',
    status: 'applied',
    affectedIds: [],
    errors: [],
    operations: [{
      id: 'renderer_replay:old-key:0',
      type: 'create_shape',
      label: 'renderer replay',
      source: 'agent',
      createdAt: '2026-08-12T00:00:00.000Z',
      targetIds: [],
      payload: { rendererReplayKey: 'old-key' }
    }]
  }]
  const files = new Map<string, string>([
    ['.kun-design/documents.json', serializeDocumentsIndex([sourceDocument()], 'doc_source')],
    ['.kun-design/doc_source/board_main/meta.json', JSON.stringify({
      id: 'board_main',
      relativePath: '.kun-design/doc_source/board_main/board.json'
    })],
    ['.kun-design/doc_source/board_main/board.json', serializeCanvasDocument(sourceCanvas)]
  ])
  const mtimes = new Map([...files.keys()].map((path) => [path, 1]))
  const directories = new Set([
    '.kun-design',
    '.kun-design/doc_source',
    '.kun-design/doc_source/board_main'
  ])
  const listWorkspaceDirectory = vi.fn(async ({ path = '' }: { path?: string }) => {
    if (!directories.has(path)) return { ok: false as const, message: 'not found' }
    const prefix = path ? `${path}/` : ''
    const children = new Map<string, 'file' | 'directory'>()
    for (const directory of directories) {
      if (!directory.startsWith(prefix) || directory === path) continue
      const rest = directory.slice(prefix.length)
      if (!rest || rest.includes('/')) continue
      children.set(rest, 'directory')
    }
    for (const file of files.keys()) {
      if (!file.startsWith(prefix)) continue
      const rest = file.slice(prefix.length)
      if (!rest || rest.includes('/')) continue
      children.set(rest, 'file')
    }
    return {
      ok: true as const,
      root: `/workspace/${path}`,
      entries: [...children].map(([name, type]) => ({
        name,
        type,
        path: `/workspace/${prefix}${name}`,
        ext: type === 'file' ? name.split('.').pop() ?? '' : ''
      }))
    }
  })
  const readWorkspaceFile = vi.fn(async ({ path }: { path: string }) => {
    const content = files.get(path)
    return content === undefined
      ? { ok: false as const, message: 'not found' }
      : {
          ok: true as const,
          path: `/workspace/${path}`,
          content,
          size: content.length,
          mtimeMs: mtimes.get(path),
          truncated: false
        }
  })
  const writeWorkspaceFileImpl = async ({
    path,
    content,
    expectedMtimeMs
  }: { path: string; content: string; expectedMtimeMs?: number }) => {
    if (expectedMtimeMs !== undefined && mtimes.get(path) !== expectedMtimeMs) {
      return { ok: false as const, code: 'modified_on_disk' as const, message: 'changed' }
    }
    files.set(path, content)
    const mtimeMs = (mtimes.get(path) ?? 0) + 1
    mtimes.set(path, mtimeMs)
    return {
      ok: true as const,
      path: `/workspace/${path}`,
      savedAt: '2026-08-12T01:00:00.000Z',
      mtimeMs
    }
  }
  const writeWorkspaceFile = vi.fn(writeWorkspaceFileImpl)
  const createWorkspaceDirectory = vi.fn(async ({ path }: { path: string }) => {
    if (directories.has(path)) return { ok: false as const, message: 'already exists' }
    directories.add(path)
    return {
      ok: true as const,
      path: `/workspace/${path}`,
      createdAt: '2026-08-12T01:00:00.000Z'
    }
  })
  const deleteWorkspaceEntry = vi.fn(async ({ path }: { path: string }) => {
    for (const file of [...files.keys()]) {
      if (file === path || file.startsWith(`${path}/`)) files.delete(file)
    }
    for (const directory of [...directories]) {
      if (directory === path || directory.startsWith(`${path}/`)) directories.delete(directory)
    }
    return {
      ok: true as const,
      path: `/workspace/${path}`,
      deletedAt: '2026-08-12T01:00:00.000Z'
    }
  })
  const api = {
    listWorkspaceDirectory,
    readWorkspaceFile,
    writeWorkspaceFile,
    createWorkspaceDirectory,
    deleteWorkspaceEntry
  } as unknown as KunGuiApi
  vi.stubGlobal('window', { kunGui: api })
  return {
    api,
    files,
    mtimes,
    directories,
    writeWorkspaceFile,
    writeWorkspaceFileImpl,
    deleteWorkspaceEntry
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Design document fork clone', () => {
  it('copies the document tree, rewrites durable paths, and indexes an independent target', async () => {
    const { api, files } = installMemoryApi()

    const prepared = await cloneDesignDocumentForFork({
      workspaceRoot: '/workspace',
      sourceTarget: { documentId: 'doc_source', boardArtifactId: 'board_main' },
      api,
      createDocumentId: () => 'doc_fork',
      now: () => '2026-08-12T01:00:00.000Z'
    })

    expect(prepared.designDocumentTarget).toEqual({
      documentId: 'doc_fork',
      boardArtifactId: 'board_main'
    })
    expect(files.get('.kun-design/doc_fork/board_main/meta.json'))
      .toContain('.kun-design/doc_fork/board_main/board.json')
    const clonedCanvas = parseCanvasDocument(
      files.get('.kun-design/doc_fork/board_main/board.json') ?? ''
    )
    expect(clonedCanvas?.rendererReplayKeys).toBeUndefined()
    expect(clonedCanvas?.operationJournal).toBeUndefined()
    expect(clonedCanvas?.rendererReplayWatermarkTurnId).toBe('turn_1')
    const index = parseDocumentsIndex(files.get('.kun-design/documents.json') ?? '')
    expect(index).toMatchObject({
      activeDocumentId: 'doc_source',
      documents: [
        { id: 'doc_source', order: 2 },
        { id: 'doc_fork', order: 3, activeArtifactId: 'board_main' }
      ]
    })
  })

  it('removes the cloned index entry and directory when cleanup runs', async () => {
    const { api, files, directories, deleteWorkspaceEntry } = installMemoryApi()
    const prepared = await cloneDesignDocumentForFork({
      workspaceRoot: '/workspace',
      sourceTarget: { documentId: 'doc_source', boardArtifactId: 'board_main' },
      api,
      createDocumentId: () => 'doc_fork'
    })

    await prepared.cleanup()
    await prepared.cleanup()

    expect(parseDocumentsIndex(files.get('.kun-design/documents.json') ?? '')?.documents)
      .toEqual([expect.objectContaining({ id: 'doc_source' })])
    expect(directories.has('.kun-design/doc_fork')).toBe(false)
    expect(deleteWorkspaceEntry).toHaveBeenCalledTimes(1)
  })

  it('serializes concurrent clone index commits without losing either document', async () => {
    const { api, files } = installMemoryApi()

    await Promise.all([
      cloneDesignDocumentForFork({
        workspaceRoot: '/workspace',
        sourceTarget: { documentId: 'doc_source', boardArtifactId: 'board_main' },
        api,
        createDocumentId: () => 'doc_fork_a'
      }),
      cloneDesignDocumentForFork({
        workspaceRoot: '/workspace',
        sourceTarget: { documentId: 'doc_source', boardArtifactId: 'board_main' },
        api,
        createDocumentId: () => 'doc_fork_b'
      })
    ])

    expect(parseDocumentsIndex(files.get('.kun-design/documents.json') ?? '')?.documents
      .map((document) => document.id)).toEqual([
      'doc_source', 'doc_fork_a', 'doc_fork_b'
    ])
  })

  it('retries a compare-and-swap conflict and preserves the concurrent index entry', async () => {
    const {
      api, files, mtimes, writeWorkspaceFile, writeWorkspaceFileImpl
    } = installMemoryApi()
    let injected = false
    writeWorkspaceFile.mockImplementation(async (payload) => {
      if (payload.path === '.kun-design/documents.json' && !injected) {
        injected = true
        const current = parseDocumentsIndex(files.get(payload.path) ?? '')!
        files.set(payload.path, serializeDocumentsIndex([
          ...current.documents.map((document) => ({ ...document, artifacts: [] })),
          { ...sourceDocument(), id: 'doc_concurrent', order: 3, artifacts: [] }
        ], current.activeDocumentId, current.folders))
        mtimes.set(payload.path, (mtimes.get(payload.path) ?? 0) + 1)
      }
      return writeWorkspaceFileImpl(payload)
    })

    await cloneDesignDocumentForFork({
      workspaceRoot: '/workspace',
      sourceTarget: { documentId: 'doc_source', boardArtifactId: 'board_main' },
      api,
      createDocumentId: () => 'doc_fork'
    })

    expect(parseDocumentsIndex(files.get('.kun-design/documents.json') ?? '')?.documents
      .map((document) => document.id)).toEqual([
      'doc_source', 'doc_concurrent', 'doc_fork'
    ])
  })

  it('reconciles a crash marker without deleting a runtime-referenced clone', async () => {
    const storage = new MemoryStorage()
    const orphan = installMemoryApi()
    await cloneDesignDocumentForFork({
      workspaceRoot: '/workspace',
      sourceTarget: { documentId: 'doc_source', boardArtifactId: 'board_main' },
      api: orphan.api, operationStorage: storage,
      createDocumentId: () => 'doc_orphan'
    })
    expect(pendingDesignDocumentClones(storage)).toHaveLength(1)

    await reconcilePendingDesignDocumentClones({
      threads: [], api: orphan.api, operationStorage: storage
    })
    expect(pendingDesignDocumentClones(storage)).toEqual([])
    expect(parseDocumentsIndex(orphan.files.get('.kun-design/documents.json') ?? '')?.documents)
      .toEqual([expect.objectContaining({ id: 'doc_source' })])

    const committed = installMemoryApi()
    const prepared = await cloneDesignDocumentForFork({
      workspaceRoot: '/workspace',
      sourceTarget: { documentId: 'doc_source', boardArtifactId: 'board_main' },
      api: committed.api, operationStorage: storage,
      createDocumentId: () => 'doc_committed'
    })
    await prepared.markRuntimeRequestStarted?.()
    const retried = await cloneDesignDocumentForFork({
      workspaceRoot: '/workspace',
      sourceTarget: { documentId: 'doc_source', boardArtifactId: 'board_main' },
      api: committed.api, operationStorage: storage,
      createDocumentId: () => 'doc_duplicate'
    })
    expect(retried.operationId).toBe(prepared.operationId)
    expect(retried.designDocumentTarget).toEqual(prepared.designDocumentTarget)
    expect(parseDocumentsIndex(committed.files.get('.kun-design/documents.json') ?? '')?.documents
      .map((document) => document.id)).not.toContain('doc_duplicate')
    await expect(reconcilePendingDesignDocumentClones({
      threads: [], api: committed.api, operationStorage: storage
    })).resolves.toMatchObject({ retained: 1, removed: 0 })
    expect(pendingDesignDocumentClones(storage)).toHaveLength(1)
    expect(parseDocumentsIndex(committed.files.get('.kun-design/documents.json') ?? '')?.documents
      .map((document) => document.id)).toContain('doc_committed')
    await reconcilePendingDesignDocumentClones({
      threads: [{
        id: 'thr_committed', title: 'Committed', updatedAt: '', model: 'test',
        mode: 'agent', workspace: '/workspace', status: 'idle', agentSurface: 'code',
        designProfile: {
          version: 1, documentTarget: prepared.designDocumentTarget,
          outputMedium: 'html', target: 'web', preset: 'none', context: { tone: [] },
          lockedAtTurnId: 'turn_committed'
        }
      }],
      api: committed.api,
      operationStorage: storage
    })
    expect(pendingDesignDocumentClones(storage)).toEqual([])
    expect(parseDocumentsIndex(committed.files.get('.kun-design/documents.json') ?? '')?.documents
      .map((document) => document.id)).toContain('doc_committed')
  })
})
