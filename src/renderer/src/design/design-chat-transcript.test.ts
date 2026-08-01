import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatBlock } from '../agent/types'
import type { BrowserStorageLike } from '../lib/browser-storage'
import {
  emptyDesignThreadRegistry,
  markDesignThread,
  readDesignThreadRegistry,
  saveDesignThreadRegistry
} from './design-thread-registry'
import {
  beginDesignChatHistoryMutation,
  clearDesignChatHistoryMutationsForTests,
  deleteDesignChatDirForDoc,
  deleteDesignChatTranscriptForThread,
  designChatMetaPath,
  designChatTranscriptRelativePath,
  endDesignChatHistoryMutation,
  firstUserPromptFromDesignTranscript,
  hydrateDesignChatMetaForDoc,
  parseDesignChatMeta,
  persistDesignChatMetaForDoc,
  serializeDesignChatTranscript,
  writeDesignChatTranscriptForThread
} from './design-chat-transcript'

class MemoryStorage implements BrowserStorageLike {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

afterEach(() => {
  clearDesignChatHistoryMutationsForTests()
  vi.unstubAllGlobals()
})

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('design-chat-transcript', () => {
  it('uses a chat directory inside the owning design document', () => {
    expect(designChatMetaPath('doc_123')).toBe('.kun-design/doc_123/chat/meta.json')
    expect(designChatTranscriptRelativePath('doc_123', 'thr.design-1'))
      .toBe('.kun-design/doc_123/chat/thr.design-1.md')
    expect(designChatTranscriptRelativePath('../doc', 'thr_1')).toBeNull()
    expect(designChatTranscriptRelativePath('doc', '../thr')).toBeNull()
  })

  it('deletes only the selected document chat mirror paths', async () => {
    const deletedPaths: string[] = []
    vi.stubGlobal('window', {
      kunGui: {
        deleteWorkspaceEntry: vi.fn(async (payload: { path: string }) => {
          deletedPaths.push(payload.path)
          return {
            ok: true as const,
            path: `/workspace/app/${payload.path}`,
            deletedAt: '2026-07-01T00:00:00.000Z'
          }
        })
      }
    })

    await expect(deleteDesignChatTranscriptForThread({
      workspaceRoot: '/workspace/app',
      docId: 'doc',
      threadId: 'thr_1'
    })).resolves.toBe(true)
    await expect(deleteDesignChatDirForDoc({
      workspaceRoot: '/workspace/app',
      docId: 'doc'
    })).resolves.toBe(true)

    expect(deletedPaths).toEqual([
      '.kun-design/doc/chat/thr_1.md',
      '.kun-design/doc/chat'
    ])
    expect(deletedPaths.every((path) => path.startsWith('.kun-design/doc/chat'))).toBe(true)
  })

  it('treats already-missing chat mirrors as deleted', async () => {
    vi.stubGlobal('window', {
      kunGui: {
        deleteWorkspaceEntry: vi.fn(async () => ({
          ok: false as const,
          message: 'ENOENT: no such file or directory'
        }))
      }
    })

    await expect(deleteDesignChatDirForDoc({
      workspaceRoot: '/workspace/app',
      docId: 'doc'
    })).resolves.toBe(true)
  })

  it('serializes a readable transcript without leaking reasoning blocks', () => {
    const blocks: ChatBlock[] = [
      { kind: 'user', id: 'u1', text: 'hidden full prompt', meta: { displayText: '画一个首页' } },
      { kind: 'reasoning', id: 'r1', text: 'internal reasoning' },
      { kind: 'assistant', id: 'a1', text: '我会先做首页结构。' },
      { kind: 'tool', id: 't1', summary: '写入 v1.html', status: 'success' }
    ]

    const transcript = serializeDesignChatTranscript(blocks, {
      docId: 'doc',
      threadId: 'thr_1',
      generatedAt: '2026-07-01T00:00:00.000Z'
    })

    expect(transcript).toContain('# 设计 Agent 对话记录')
    expect(transcript).toContain('- 绘画目录: doc')
    expect(transcript).toContain('## 用户\n\n画一个首页')
    expect(transcript).toContain('## 设计 Agent\n\n我会先做首页结构。')
    expect(transcript).toContain('> [工具] 写入 v1.html')
    expect(transcript).not.toContain('internal reasoning')
    expect(transcript).not.toContain('hidden full prompt')
    expect(firstUserPromptFromDesignTranscript(transcript)).toBe('画一个首页')
  })

  it('persists per-design chat meta from the design thread registry', async () => {
    const storage = new MemoryStorage()
    saveDesignThreadRegistry(
      markDesignThread('/workspace/app', 'doc', 'thr_1', emptyDesignThreadRegistry()),
      storage
    )
    const writes: Array<{ path: string; content: string }> = []
    vi.stubGlobal('window', {
      localStorage: storage,
      kunGui: {
        readWorkspaceFile: vi.fn(async () => ({ ok: false as const, error: 'missing' })),
        writeWorkspaceFile: vi.fn(async (payload: { path: string; content: string }) => {
          writes.push(payload)
          return { ok: true as const, path: payload.path, size: payload.content.length }
        })
      }
    })

    await expect(
      persistDesignChatMetaForDoc({
        workspaceRoot: '/workspace/app',
        docId: 'doc',
        stampThreadId: 'thr_1'
      })
    ).resolves.toBe(true)

    expect(writes).toHaveLength(1)
    expect(writes[0].path).toBe('.kun-design/doc/chat/meta.json')
    expect(parseDesignChatMeta(writes[0].content)).toMatchObject({
      version: 1,
      activeThreadId: 'thr_1',
      threads: [{ id: 'thr_1' }]
    })
  })

  it('persists an explicit initial binding snapshot even if the renderer registry is lost during disk IO', async () => {
    const storage = new MemoryStorage()
    const registry = markDesignThread(
      '/workspace/app',
      'doc',
      'thr_initial',
      emptyDesignThreadRegistry()
    )
    saveDesignThreadRegistry(registry, storage)
    const record = registry.workspaces['/workspace/app\u0000doc']
    const pendingRead = deferred<{ ok: false; error: string }>()
    const writes: Array<{ path: string; content: string }> = []
    vi.stubGlobal('window', {
      localStorage: storage,
      kunGui: {
        readWorkspaceFile: vi.fn(() => pendingRead.promise),
        writeWorkspaceFile: vi.fn(async (payload: { path: string; content: string }) => {
          writes.push(payload)
          return { ok: true as const, path: payload.path, size: payload.content.length }
        })
      }
    })

    const persistence = persistDesignChatMetaForDoc({
      workspaceRoot: '/workspace/app',
      docId: 'doc',
      stampThreadId: 'thr_initial',
      record
    })
    saveDesignThreadRegistry(emptyDesignThreadRegistry(), storage)
    pendingRead.resolve({ ok: false, error: 'missing' })

    await expect(persistence).resolves.toBe(true)
    expect(readDesignThreadRegistry(storage).workspaces['/workspace/app\u0000doc']).toBeUndefined()
    expect(parseDesignChatMeta(writes[0]?.content ?? '')).toMatchObject({
      activeThreadId: 'thr_initial',
      threads: [{ id: 'thr_initial' }]
    })
  })

  it('hydrates the design thread registry from chat meta in the design document directory', async () => {
    const storage = new MemoryStorage()
    vi.stubGlobal('window', {
      localStorage: storage,
      kunGui: {
        readWorkspaceFile: vi.fn(async () => ({
          ok: true as const,
          path: '.kun-design/doc/chat/meta.json',
          content: JSON.stringify({
            version: 1,
            activeThreadId: 'thr_new',
            threads: [{ id: 'thr_old' }, { id: 'thr_new' }]
          })
        }))
      }
    })

    await expect(
      hydrateDesignChatMetaForDoc({
        workspaceRoot: '/workspace/app',
        docId: 'doc'
      })
    ).resolves.toBe(true)

    const record = readDesignThreadRegistry(storage).workspaces['/workspace/app\u0000doc']
    expect(record).toEqual({
      activeThreadId: 'thr_new',
      threadIds: ['thr_old', 'thr_new']
    })
  })

  it('does not rehydrate deleted history from a meta read that started before clearing', async () => {
    const storage = new MemoryStorage()
    const pendingRead = deferred<{
      ok: true
      path: string
      content: string
    }>()
    vi.stubGlobal('window', {
      localStorage: storage,
      kunGui: { readWorkspaceFile: vi.fn(() => pendingRead.promise) }
    })

    const hydration = hydrateDesignChatMetaForDoc({
      workspaceRoot: '/workspace/app',
      docId: 'doc'
    })
    const token = beginDesignChatHistoryMutation('/workspace/app', 'doc')
    expect(token).not.toBeNull()
    pendingRead.resolve({
      ok: true,
      path: '.kun-design/doc/chat/meta.json',
      content: JSON.stringify({
        version: 1,
        activeThreadId: 'thr_deleted',
        threads: [{ id: 'thr_deleted' }]
      })
    })

    await expect(hydration).resolves.toBe(false)
    expect(readDesignThreadRegistry(storage).workspaces['/workspace/app\u0000doc']).toBeUndefined()
    if (token) endDesignChatHistoryMutation(token)
  })

  it('does not rewrite meta from a registry snapshot captured before clearing', async () => {
    const storage = new MemoryStorage()
    saveDesignThreadRegistry(
      markDesignThread('/workspace/app', 'doc', 'thr_deleted', emptyDesignThreadRegistry()),
      storage
    )
    const pendingRead = deferred<{ ok: false; error: string }>()
    const writeWorkspaceFile = vi.fn(async () => ({ ok: true as const }))
    vi.stubGlobal('window', {
      localStorage: storage,
      kunGui: {
        readWorkspaceFile: vi.fn(() => pendingRead.promise),
        writeWorkspaceFile
      }
    })

    const persistence = persistDesignChatMetaForDoc({
      workspaceRoot: '/workspace/app',
      docId: 'doc'
    })
    const token = beginDesignChatHistoryMutation('/workspace/app', 'doc')
    expect(token).not.toBeNull()
    saveDesignThreadRegistry(emptyDesignThreadRegistry(), storage)
    pendingRead.resolve({ ok: false, error: 'missing' })

    await expect(persistence).resolves.toBe(false)
    expect(writeWorkspaceFile).not.toHaveBeenCalled()
    if (token) endDesignChatHistoryMutation(token)
  })

  it('writes transcript and updates chat meta together', async () => {
    const storage = new MemoryStorage()
    saveDesignThreadRegistry(
      markDesignThread('/workspace/app', 'doc', 'thr_1', emptyDesignThreadRegistry()),
      storage
    )
    const writes: Array<{ path: string; content: string }> = []
    vi.stubGlobal('window', {
      localStorage: storage,
      kunGui: {
        readWorkspaceFile: vi.fn(async () => ({ ok: false as const, error: 'missing' })),
        writeWorkspaceFile: vi.fn(async (payload: { path: string; content: string }) => {
          writes.push(payload)
          return { ok: true as const, path: payload.path, size: payload.content.length }
        })
      }
    })

    await expect(
      writeDesignChatTranscriptForThread({
        workspaceRoot: '/workspace/app',
        docId: 'doc',
        threadId: 'thr_1',
        blocks: [{ kind: 'assistant', id: 'a1', text: '完成首页。' }]
      })
    ).resolves.toBe(true)

    expect(writes.map((entry) => entry.path)).toEqual([
      '.kun-design/doc/chat/thr_1.md',
      '.kun-design/doc/chat/meta.json'
    ])
    expect(writes[0].content).toContain('完成首页。')
  })

  it('does not recreate a transcript after its thread is unregistered', async () => {
    const storage = new MemoryStorage()
    const writeWorkspaceFile = vi.fn(async (payload: { path: string; content: string }) => ({
      ok: true as const,
      path: payload.path,
      size: payload.content.length
    }))
    vi.stubGlobal('window', {
      localStorage: storage,
      kunGui: {
        writeWorkspaceFile,
        readWorkspaceFile: vi.fn(async () => ({ ok: false as const, error: 'missing' }))
      }
    })

    await expect(writeDesignChatTranscriptForThread({
      workspaceRoot: '/workspace/app',
      docId: 'doc',
      threadId: 'thr_deleted',
      blocks: [{ kind: 'assistant', id: 'a1', text: 'stale response' }]
    })).resolves.toBe(false)

    expect(writeWorkspaceFile).not.toHaveBeenCalled()
  })
})
