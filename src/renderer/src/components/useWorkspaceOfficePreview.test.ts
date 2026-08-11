import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceOfficePreviewResult } from '@shared/office-document'
import type { WorkspaceFileChangePayload } from '@shared/workspace-file'
import type { LiveOfficePreviewDetail } from '../lib/live-office-preview'
import {
  LIVE_OFFICE_PREVIEW_EVENT,
  publishLiveOfficePreview
} from '../lib/live-office-preview'
import { useWorkspaceOfficePreview } from './useWorkspaceOfficePreview'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function preview(sha: string, text: string): WorkspaceOfficePreviewResult {
  return {
    ok: true,
    path: '/repo/reports/brief.docx',
    name: 'brief.docx',
    sourceFormat: 'docx',
    renderFormat: 'docx',
    viewer: 'word',
    size: 128,
    mtimeMs: 100,
    sourceSha256: sha,
    data: new TextEncoder().encode(text)
  }
}

let latestPreview: ReturnType<typeof useWorkspaceOfficePreview>
const officeTarget = { path: 'reports/brief.docx', workspaceRoot: '/repo' }

function PreviewHarness() {
  latestPreview = useWorkspaceOfficePreview({
    target: officeTarget,
    workspaceRoot: '/repo',
    enabled: true
  })
  return null
}

describe('useWorkspaceOfficePreview', () => {
  let renderer: ReactTestRenderer
  let readWorkspaceOfficePreview: ReturnType<typeof vi.fn>
  let listeners: Map<string, Set<(event: Event) => void>>
  let workspaceChangeListener: ((event: WorkspaceFileChangePayload) => void) | undefined

  const emit = async (detail: LiveOfficePreviewDetail): Promise<void> => {
    await act(async () => {
      for (const listener of listeners.get(LIVE_OFFICE_PREVIEW_EVENT) ?? []) {
        listener({ detail } as unknown as Event)
      }
    })
  }

  const mount = async (): Promise<void> => {
    await act(async () => {
      renderer = create(createElement(PreviewHarness))
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  const waitForRefresh = async (): Promise<void> => {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 300))
    })
  }

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    listeners = new Map()
    workspaceChangeListener = undefined
    readWorkspaceOfficePreview = vi.fn()
    const addEventListener = (type: string, listener: EventListenerOrEventListenerObject): void => {
      const callback = typeof listener === 'function' ? listener : listener.handleEvent.bind(listener)
      const handlers = listeners.get(type) ?? new Set<(event: Event) => void>()
      handlers.add(callback)
      listeners.set(type, handlers)
    }
    const removeEventListener = (type: string, listener: EventListenerOrEventListenerObject): void => {
      const callback = typeof listener === 'function' ? listener : listener.handleEvent.bind(listener)
      listeners.get(type)?.delete(callback)
    }
    vi.stubGlobal('window', {
      kunGui: {
        readWorkspaceOfficePreview,
        watchWorkspaceFile: vi.fn(async () => ({ ok: true, watchId: 'office-watch' })),
        unwatchWorkspaceFile: vi.fn(async () => ({ ok: true })),
        onWorkspaceFileChanged: vi.fn((listener: (event: WorkspaceFileChangePayload) => void) => {
          workspaceChangeListener = listener
          return () => { workspaceChangeListener = undefined }
        })
      },
      addEventListener,
      removeEventListener,
      dispatchEvent: vi.fn(),
      setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer)
    })
  })

  afterEach(async () => {
    if (renderer) await act(async () => renderer.unmount())
    vi.unstubAllGlobals()
  })

  it('keeps the stable preview while an edit is underway and after a failed refresh', async () => {
    readWorkspaceOfficePreview
      .mockResolvedValueOnce(preview('a'.repeat(64), 'before'))
      .mockResolvedValueOnce({ ok: false, code: 'source_changed', message: 'Source changed during render.' })
    await mount()
    expect(latestPreview.officeResult).toMatchObject({ ok: true, sourceSha256: 'a'.repeat(64) })

    await emit({
      path: 'reports/brief.docx',
      workspaceRoot: '/repo',
      turnId: 'turn-1',
      phase: 'editing'
    })
    expect(latestPreview.officeAgentEditing).toBe(true)
    expect(latestPreview.officeResult).toMatchObject({ ok: true, sourceSha256: 'a'.repeat(64) })

    await emit({
      path: 'reports/brief.docx',
      workspaceRoot: '/repo',
      turnId: 'turn-1',
      phase: 'committed',
      expectedSha256: 'b'.repeat(64)
    })
    await waitForRefresh()

    expect(readWorkspaceOfficePreview).toHaveBeenLastCalledWith({
      path: 'reports/brief.docx',
      workspaceRoot: '/repo',
      expectedSha256: 'b'.repeat(64)
    })
    expect(latestPreview.officeAgentEditing).toBe(false)
    expect(latestPreview.officeResult).toMatchObject({ ok: true, sourceSha256: 'a'.repeat(64) })
    expect(latestPreview.officeRefreshError).toBe('Source changed during render.')
  })

  it('tail-debounces consecutive commits and requests only the newest source SHA', async () => {
    readWorkspaceOfficePreview
      .mockResolvedValueOnce(preview('a'.repeat(64), 'before'))
      .mockResolvedValueOnce(preview('d'.repeat(64), 'after'))
    await mount()

    for (const expectedSha256 of ['b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64)]) {
      await emit({
        path: 'reports/brief.docx',
        workspaceRoot: '/repo',
        turnId: 'turn-1',
        phase: 'committed',
        expectedSha256
      })
    }
    await waitForRefresh()

    expect(readWorkspaceOfficePreview).toHaveBeenCalledTimes(2)
    expect(readWorkspaceOfficePreview).toHaveBeenLastCalledWith({
      path: 'reports/brief.docx',
      workspaceRoot: '/repo',
      expectedSha256: 'd'.repeat(64)
    })
    expect(latestPreview.officeResult).toMatchObject({ ok: true, sourceSha256: 'd'.repeat(64) })
  })

  it('coalesces signal-only watcher bursts after an atomic or continuous write', async () => {
    readWorkspaceOfficePreview
      .mockResolvedValueOnce(preview('a'.repeat(64), 'before'))
      .mockResolvedValueOnce(preview('b'.repeat(64), 'after'))
    await mount()

    const changed: WorkspaceFileChangePayload = {
      ok: true,
      mode: 'signal',
      watchId: 'office-watch',
      workspaceRoot: '/repo',
      path: 'reports/brief.docx',
      content: '',
      size: 129,
      mtimeMs: 101,
      truncated: false,
      changedAt: new Date().toISOString()
    }
    await act(async () => {
      workspaceChangeListener?.(changed)
      workspaceChangeListener?.({ ...changed, mtimeMs: 102 })
      workspaceChangeListener?.({ ...changed, mtimeMs: 103 })
    })
    await waitForRefresh()

    expect(readWorkspaceOfficePreview).toHaveBeenCalledTimes(2)
    expect(latestPreview.officeResult).toMatchObject({ ok: true, sourceSha256: 'b'.repeat(64) })
  })

  it('discards an older render when a newer Office revision completes first', async () => {
    const staleRender = createDeferred<WorkspaceOfficePreviewResult>()
    const currentRender = createDeferred<WorkspaceOfficePreviewResult>()
    readWorkspaceOfficePreview
      .mockResolvedValueOnce(preview('a'.repeat(64), 'before'))
      .mockImplementationOnce(() => staleRender.promise)
      .mockImplementationOnce(() => currentRender.promise)
    await mount()

    await emit({
      path: 'reports/brief.docx',
      workspaceRoot: '/repo',
      turnId: 'turn-1',
      phase: 'committed',
      expectedSha256: 'b'.repeat(64)
    })
    await waitForRefresh()

    await emit({
      path: 'reports/brief.docx',
      workspaceRoot: '/repo',
      turnId: 'turn-1',
      phase: 'committed',
      expectedSha256: 'c'.repeat(64)
    })
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 300))
      currentRender.resolve(preview('c'.repeat(64), 'current'))
      await Promise.resolve()
    })
    expect(latestPreview.officeResult).toMatchObject({ ok: true, sourceSha256: 'c'.repeat(64) })

    await act(async () => {
      staleRender.resolve(preview('b'.repeat(64), 'stale'))
      await Promise.resolve()
    })
    expect(latestPreview.officeResult).toMatchObject({ ok: true, sourceSha256: 'c'.repeat(64) })
  })

  it('inherits an editing state cached before the preview hook mounts', async () => {
    publishLiveOfficePreview({
      path: 'reports/brief.docx',
      workspaceRoot: '/repo',
      turnId: 'turn-1',
      phase: 'editing'
    })
    readWorkspaceOfficePreview.mockResolvedValueOnce(preview('a'.repeat(64), 'before'))

    await mount()

    expect(latestPreview.officeAgentEditing).toBe(true)
    expect(latestPreview.officeResult).toMatchObject({ ok: true, sourceSha256: 'a'.repeat(64) })
  })

  it('accepts an absolute committed path after a relative Office edit call', async () => {
    readWorkspaceOfficePreview
      .mockResolvedValueOnce(preview('a'.repeat(64), 'before'))
      .mockResolvedValueOnce(preview('b'.repeat(64), 'after'))
    await mount()

    await emit({
      path: 'reports/brief.docx',
      workspaceRoot: '/repo',
      turnId: 'turn-1',
      phase: 'editing'
    })
    await emit({
      path: '/repo/reports/brief.docx',
      workspaceRoot: '/repo',
      turnId: 'turn-1',
      phase: 'committed',
      expectedSha256: 'b'.repeat(64)
    })
    await waitForRefresh()

    expect(readWorkspaceOfficePreview).toHaveBeenLastCalledWith({
      path: 'reports/brief.docx',
      workspaceRoot: '/repo',
      expectedSha256: 'b'.repeat(64)
    })
    expect(latestPreview.officeResult).toMatchObject({ ok: true, sourceSha256: 'b'.repeat(64) })
  })

  it('keeps page and worksheet navigation out of the binary IPC contract', async () => {
    readWorkspaceOfficePreview.mockResolvedValueOnce(preview('a'.repeat(64), 'before'))
    await mount()

    expect(readWorkspaceOfficePreview).toHaveBeenCalledWith({
      path: 'reports/brief.docx',
      workspaceRoot: '/repo'
    })
  })
})
