import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWriteFileActions } from './write-workspace-file-actions'
import { persistWriteEditorLayout } from './write-editor-layout'
import { initialState } from './write-workspace-store-helpers'
import type {
  WriteWorkspaceGet,
  WriteWorkspaceSet,
  WriteWorkspaceState
} from './write-workspace-store-types'
import { MemoryStorage } from './write-workspace-file-actions-test-support'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('write workspace whiteboard restoration', () => {
  it('loads whiteboard metadata before restoring a typed whiteboard tab', async () => {
    vi.stubGlobal('window', { localStorage: new MemoryStorage() })
    persistWriteEditorLayout('/tmp/write', {
      version: 1,
      orientation: 'single',
      ratio: 0.5,
      focusedGroupId: 'primary',
      groups: [{
        id: 'primary',
        activePath: 'whiteboard:board-1',
        tabs: [{ kind: 'whiteboard', boardId: 'board-1', viewMode: 'rich' }]
      }]
    })

    const loadDirectory = vi.fn(async () => '/tmp/write')
    const loadWhiteboards = vi.fn(async () => {
      set({
        whiteboards: {
          'board-1': {
            id: 'board-1',
            title: 'Review board',
            workspaceRoot: '/tmp/write',
            threadId: 'thread-1',
            phase: 'review',
            revision: 2,
            createdAt: '2026-08-13T00:00:00.000Z',
            updatedAt: '2026-08-13T00:00:00.000Z'
          }
        }
      })
    })
    const openFile = vi.fn(async () => undefined)
    const refreshWorkspace = vi.fn(async () => undefined)
    const saveAllDocuments = vi.fn(async () => true)
    let state = {
      ...initialState(),
      loadDirectory,
      loadWhiteboards,
      openFile,
      refreshWorkspace,
      saveAllDocuments
    } as unknown as WriteWorkspaceState
    const get: WriteWorkspaceGet = () => state
    const set: WriteWorkspaceSet = (partial) => {
      const patch = typeof partial === 'function' ? partial(state) : partial
      state = { ...state, ...patch }
    }
    const actions = createWriteFileActions({
      get,
      set,
      cancelExternalSyncAnimation: vi.fn()
    })
    state = {
      ...state,
      ...actions,
      loadDirectory,
      loadWhiteboards,
      openFile,
      refreshWorkspace,
      saveAllDocuments
    }

    await actions.initializeWorkspace('/tmp/write')

    expect(state.loadWhiteboards).toHaveBeenCalledWith('/tmp/write')
    expect(state.openFile).not.toHaveBeenCalled()
    expect(state).toMatchObject({
      activeWhiteboardId: 'board-1',
      activeFilePath: null,
      editorLayout: {
        focusedGroupId: 'primary',
        groups: [{
          activePath: 'whiteboard:board-1',
          tabs: [{ kind: 'whiteboard', boardId: 'board-1' }]
        }]
      }
    })
  })
})
