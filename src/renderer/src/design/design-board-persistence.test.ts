import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureDesignBoardArtifact } from './design-board'
import { installDesignDocument } from './design-board.test-helpers'
import { useDesignWorkspaceStore } from './design-workspace-store'

afterEach(() => vi.unstubAllGlobals())

function deferredWrite() {
  let resolve: (value: { ok: true }) => void = () => undefined
  return {
    promise: new Promise<{ ok: true }>((done) => { resolve = done }),
    resolve
  }
}

describe('design board persistence', () => {
  it('does not register a board artifact when its initial durable write fails', async () => {
    installDesignDocument([], null)
    const writeWorkspaceFile = vi.fn(async () => ({ ok: false as const, message: 'disk full' }))
    vi.stubGlobal('window', { kunGui: { writeWorkspaceFile } })

    await expect(ensureDesignBoardArtifact('/workspace')).resolves.toBeNull()

    expect(useDesignWorkspaceStore.getState().artifacts).toEqual([])
    expect(useDesignWorkspaceStore.getState().fileError).toContain('disk full')
  })

  it('coalesces simultaneous board creation for one document', async () => {
    installDesignDocument([], null)
    const write = deferredWrite()
    const writeWorkspaceFile = vi.fn(() => write.promise)
    vi.stubGlobal('window', { kunGui: { writeWorkspaceFile } })

    const first = ensureDesignBoardArtifact('/workspace', 'doc')
    const second = ensureDesignBoardArtifact('/workspace', 'doc')
    expect(writeWorkspaceFile).toHaveBeenCalledTimes(1)
    write.resolve({ ok: true })

    const [firstBoard, secondBoard] = await Promise.all([first, second])
    expect(secondBoard?.id).toBe(firstBoard?.id)
    expect(useDesignWorkspaceStore.getState().artifacts).toHaveLength(1)
  })

  it('does not attach a completed board write after the active document changes', async () => {
    installDesignDocument([], null)
    const write = deferredWrite()
    vi.stubGlobal('window', { kunGui: { writeWorkspaceFile: vi.fn(() => write.promise) } })
    const creating = ensureDesignBoardArtifact('/workspace', 'doc')
    const original = useDesignWorkspaceStore.getState().documents[0]
    const other = { ...original, id: 'other-doc', title: 'Other', artifacts: [] }
    useDesignWorkspaceStore.setState({
      documents: [original, other], activeDocumentId: other.id,
      artifacts: [], activeArtifactId: null
    })
    write.resolve({ ok: true })

    await expect(creating).resolves.toBeNull()
    expect(useDesignWorkspaceStore.getState().artifacts).toEqual([])
  })
})
