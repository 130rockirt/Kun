import { createElement, type ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWriteDocumentSession, emptyWriteEditorLayout } from '../../write/write-editor-layout'
import { useWriteWorkspaceStore } from '../../write/write-workspace-store'
import { useWriteEditorGroupFileWatches } from './use-write-editor-group-file-watches'

function WatchHarness(): ReactElement {
  const workspaceRoot = useWriteWorkspaceStore((state) => state.workspaceRoot)
  const editorLayout = useWriteWorkspaceStore((state) => state.editorLayout)
  useWriteEditorGroupFileWatches({ workspaceRoot, editorLayout })
  return createElement('div')
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.unstubAllGlobals()
  useWriteWorkspaceStore.setState({
    workspaceRoot: '',
    documentsByPath: {},
    editorLayout: emptyWriteEditorLayout()
  })
})

describe('useWriteEditorGroupFileWatches', () => {
  it('creates only one watcher when both visible groups show the same file', async () => {
    const watchWorkspaceFile = vi.fn(async () => ({
      ok: true as const,
      watchId: 'watch-1',
      path: '/work/shared.md',
      content: 'shared',
      size: 6,
      truncated: false,
      startedAt: '2026-08-12T00:00:00.000Z'
    }))
    const unwatchWorkspaceFile = vi.fn(async () => true)
    vi.stubGlobal('window', {
      kunGui: {
        watchWorkspaceFile,
        unwatchWorkspaceFile,
        onWorkspaceFileChanged: vi.fn(() => vi.fn())
      }
    })
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const document = createWriteDocumentSession({
      path: '/work/shared.md',
      kind: 'text',
      fileContent: 'shared'
    })
    useWriteWorkspaceStore.setState({
      workspaceRoot: '/work',
      documentsByPath: { '/work/shared.md': document },
      editorLayout: {
        version: 1,
        orientation: 'horizontal',
        ratio: 0.5,
        focusedGroupId: 'primary',
        groups: [
          {
            id: 'primary',
            tabs: [{ path: '/work/shared.md', viewMode: 'live' }],
            activePath: '/work/shared.md'
          },
          {
            id: 'secondary',
            tabs: [{ path: '/work/shared.md', viewMode: 'preview' }],
            activePath: '/work/shared.md'
          }
        ]
      }
    })

    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(createElement(WatchHarness))
      await flushPromises()
    })

    expect(watchWorkspaceFile).toHaveBeenCalledTimes(1)
    expect(watchWorkspaceFile).toHaveBeenCalledWith({
      workspaceRoot: '/work',
      path: '/work/shared.md'
    })

    await act(async () => {
      renderer.unmount()
      await flushPromises()
    })
    expect(unwatchWorkspaceFile).toHaveBeenCalledWith('watch-1')
  })
})
