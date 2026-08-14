import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWriteDocumentSession, emptyWriteEditorLayout } from './write-editor-layout'
import { clearWriteWorkspaceSaveQueueForTests } from './write-save-coordinator'
import { useWriteWorkspaceStore } from './write-workspace-store'
import { initialState } from './write-workspace-store-helpers'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

function installDocuments(): void {
  const a = createWriteDocumentSession({
    path: '/work/a.md',
    kind: 'text',
    fileContent: 'draft a',
    persistedContent: 'saved a',
    saveStatus: 'dirty',
    documentEpoch: 1,
    contentRevision: 1
  })
  const b = createWriteDocumentSession({
    path: '/work/b.md',
    kind: 'text',
    fileContent: 'saved b',
    persistedContent: 'saved b',
    documentEpoch: 2
  })
  const layout = {
    ...emptyWriteEditorLayout(),
    groups: [{
      id: 'primary' as const,
      tabs: [
        { path: '/work/a.md', viewMode: 'live' as const },
        { path: '/work/b.md', viewMode: 'rich' as const }
      ],
      activePath: '/work/a.md'
    }]
  }
  useWriteWorkspaceStore.setState({
    ...initialState(),
    workspaceRoot: '/work',
    documentsByPath: { '/work/a.md': a, '/work/b.md': b },
    editorLayout: layout,
    activeFilePath: a.path,
    activeFileKind: a.kind,
    fileContent: a.fileContent,
    persistedContent: a.persistedContent,
    saveStatus: a.saveStatus,
    documentEpoch: a.documentEpoch,
    contentRevision: a.contentRevision
  })
}

beforeEach(() => {
  vi.stubGlobal('window', {
    localStorage: { getItem: () => null, setItem: () => undefined },
    confirm: () => true,
    kunGui: { writeWorkspaceFile: vi.fn() }
  })
  installDocuments()
})

afterEach(() => {
  clearWriteWorkspaceSaveQueueForTests()
  vi.unstubAllGlobals()
})

describe('write editor group actions', () => {
  it('does not apply a split ratio while the layout still has one group', () => {
    useWriteWorkspaceStore.getState().setSplitRatio(0.25)
    expect(useWriteWorkspaceStore.getState().editorLayout).toMatchObject({
      orientation: 'single',
      ratio: 0.5,
      groups: [{ id: 'primary' }]
    })
  })

  it('splits the active document into a preview occurrence', () => {
    useWriteWorkspaceStore.getState().splitEditorGroup('horizontal')
    const state = useWriteWorkspaceStore.getState()
    expect(state.editorLayout).toMatchObject({
      orientation: 'horizontal',
      focusedGroupId: 'secondary'
    })
    expect(state.editorLayout.groups[1]).toMatchObject({
      activePath: '/work/a.md',
      tabs: [{ path: '/work/a.md', viewMode: 'preview' }]
    })
    expect(Object.keys(state.documentsByPath)).toHaveLength(2)
  })

  it('shares content across two occurrences of the same path', () => {
    const state = useWriteWorkspaceStore.getState()
    state.splitEditorGroup('vertical')
    state.setDocumentContent('/work/a.md', 'new shared draft')
    expect(useWriteWorkspaceStore.getState().documentsByPath['/work/a.md']).toMatchObject({
      fileContent: 'new shared draft',
      saveStatus: 'dirty'
    })
  })

  it('updates only the saved session when focus changes during an in-flight save', async () => {
    const pending = deferred<{ ok: true; path: string; savedAt: string }>()
    const writeWorkspaceFile = vi.fn(() => pending.promise)
    vi.stubGlobal('window', {
      localStorage: { getItem: () => null, setItem: () => undefined },
      confirm: () => true,
      kunGui: { writeWorkspaceFile }
    })
    const saving = useWriteWorkspaceStore.getState().saveDocument('/work', '/work/a.md')
    await vi.waitFor(() => expect(writeWorkspaceFile).toHaveBeenCalledOnce())
    useWriteWorkspaceStore.getState().activateTab('primary', '/work/b.md')
    pending.resolve({ ok: true, path: '/work/a.md', savedAt: '2026-08-12T00:00:00.000Z' })
    await expect(saving).resolves.toBe(true)
    const state = useWriteWorkspaceStore.getState()
    expect(state.activeFilePath).toBe('/work/b.md')
    expect(state.documentsByPath['/work/a.md'].saveStatus).toBe('saved')
    expect(state.documentsByPath['/work/b.md'].fileContent).toBe('saved b')
  })

  it('activates and closes a whiteboard tab without reading or deleting a file session', async () => {
    const board = {
      id: 'board-1',
      title: 'Review board',
      workspaceRoot: '/work',
      threadId: null,
      phase: 'blank' as const,
      revision: 0,
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z'
    }
    useWriteWorkspaceStore.setState((state) => ({
      whiteboards: { [board.id]: board },
      editorLayout: {
        ...state.editorLayout,
        groups: [{
          ...state.editorLayout.groups[0],
          tabs: [
            ...state.editorLayout.groups[0].tabs,
            { kind: 'whiteboard', boardId: board.id, viewMode: 'rich' }
          ]
        }]
      }
    }))

    useWriteWorkspaceStore.getState().activateTab('primary', 'whiteboard:board-1')
    let state = useWriteWorkspaceStore.getState()
    expect(state.activeWhiteboardId).toBe('board-1')
    expect(state.activeFilePath).toBeNull()
    expect(Object.keys(state.documentsByPath)).toEqual(['/work/a.md', '/work/b.md'])

    await expect(state.closeTab('primary', 'whiteboard:board-1')).resolves.toBe(true)
    state = useWriteWorkspaceStore.getState()
    expect(state.activeWhiteboardId).toBeNull()
    expect(state.activeFilePath).toBe('/work/b.md')
    expect(state.whiteboards['board-1']).toBe(board)
    expect(Object.keys(state.documentsByPath)).toEqual(['/work/a.md', '/work/b.md'])
  })

  it('moves a typed whiteboard item between groups without creating a pseudo document', () => {
    useWriteWorkspaceStore.setState((state) => ({
      editorLayout: {
        ...state.editorLayout,
        orientation: 'horizontal',
        groups: [
          {
            id: 'primary',
            activePath: 'whiteboard:board-1',
            tabs: [{ kind: 'whiteboard', boardId: 'board-1', viewMode: 'rich' }]
          },
          {
            id: 'secondary',
            activePath: '/work/b.md',
            tabs: [{ path: '/work/b.md', viewMode: 'preview' }]
          }
        ]
      }
    }))

    useWriteWorkspaceStore.getState().moveTab(
      'whiteboard:board-1',
      'primary',
      'secondary',
      0
    )
    const state = useWriteWorkspaceStore.getState()
    expect(state.editorLayout.focusedGroupId).toBe('secondary')
    expect(state.editorLayout.groups[0]).toMatchObject({ tabs: [], activePath: null })
    expect(state.editorLayout.groups[1]).toMatchObject({
      activePath: 'whiteboard:board-1',
      tabs: [
        { kind: 'whiteboard', boardId: 'board-1' },
        { path: '/work/b.md' }
      ]
    })
    expect(state.activeWhiteboardId).toBe('board-1')
    expect(state.documentsByPath['whiteboard:board-1']).toBeUndefined()
  })
})
