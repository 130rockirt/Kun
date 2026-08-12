import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceOfficePreviewSuccess } from '@shared/office-document'
import { startWriteOfficeSessionWatch } from './write-office-session-watch'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve })
  return { promise, resolve }
}

function preview(sha: string): WorkspaceOfficePreviewSuccess {
  return {
    ok: true,
    path: '/tmp/write/report.docx',
    name: 'report.docx',
    sourceFormat: 'docx',
    renderFormat: 'docx',
    viewer: 'word',
    size: 10,
    mtimeMs: 1,
    sourceSha256: sha,
    data: new Uint8Array([1])
  }
}

function watchResult(watchId: string) {
  return {
    ok: true as const,
    mode: 'signal' as const,
    watchId,
    path: '/tmp/write/report.docx',
    content: '' as const,
    size: 10,
    mtimeMs: 1,
    truncated: false as const,
    startedAt: '2026-08-12T00:00:00.000Z'
  }
}

describe('startWriteOfficeSessionWatch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    const target = new EventTarget()
    vi.stubGlobal('window', Object.assign(target, {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      kunGui: { platform: 'darwin' }
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('debounces signals, ignores late reads, and unregisters the unique watch', async () => {
    let changed: ((event: { watchId: string; ok: true }) => void) | undefined
    const first = deferred<WorkspaceOfficePreviewSuccess>()
    const second = deferred<WorkspaceOfficePreviewSuccess>()
    const readWorkspaceOfficePreview = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const unwatchWorkspaceFile = vi.fn(async () => true)
    const onPreview = vi.fn()
    const onRefreshError = vi.fn()
    const cleanup = startWriteOfficeSessionWatch({
      api: {
        readWorkspaceOfficePreview,
        watchWorkspaceFile: vi.fn(async () => watchResult('watch-1')),
        unwatchWorkspaceFile,
        onWorkspaceFileChanged: vi.fn((listener) => {
          changed = listener as typeof changed
          return vi.fn()
        })
      },
      path: '/tmp/write/report.docx',
      workspaceRoot: '/tmp/write',
      callbacks: {
        onLoading: vi.fn(),
        onAgentEditing: vi.fn(),
        onRefreshError,
        onPreview
      }
    })
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(250)
    expect(readWorkspaceOfficePreview).toHaveBeenCalledTimes(1)

    changed?.({ watchId: 'watch-1', ok: true })
    changed?.({ watchId: 'watch-1', ok: true })
    await vi.advanceTimersByTimeAsync(250)
    expect(readWorkspaceOfficePreview).toHaveBeenCalledTimes(2)

    second.resolve(preview('b'.repeat(64)))
    await Promise.resolve()
    first.resolve(preview('a'.repeat(64)))
    await Promise.resolve()
    expect(onPreview).toHaveBeenCalledTimes(1)
    expect(onPreview).toHaveBeenCalledWith(expect.objectContaining({ sourceSha256: 'b'.repeat(64) }))
    expect(onRefreshError).toHaveBeenLastCalledWith(null)

    cleanup()
    expect(unwatchWorkspaceFile).toHaveBeenCalledWith('watch-1')
  })

  it('reports a refresh failure without replacing the last successful preview', async () => {
    const onPreview = vi.fn()
    const onRefreshError = vi.fn()
    startWriteOfficeSessionWatch({
      api: {
        readWorkspaceOfficePreview: vi.fn(async () => ({
          ok: false as const,
          code: 'invalid_office_document',
          message: 'Still being written'
        })),
        watchWorkspaceFile: vi.fn(async () => watchResult('watch-2')),
        unwatchWorkspaceFile: vi.fn(async () => true),
        onWorkspaceFileChanged: vi.fn(() => vi.fn())
      },
      path: '/tmp/write/report.docx',
      workspaceRoot: '/tmp/write',
      callbacks: {
        onLoading: vi.fn(),
        onAgentEditing: vi.fn(),
        onRefreshError,
        onPreview
      }
    })
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(250)

    expect(onPreview).not.toHaveBeenCalled()
    expect(onRefreshError).toHaveBeenCalledWith('Still being written')
  })
})
