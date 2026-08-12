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
})
