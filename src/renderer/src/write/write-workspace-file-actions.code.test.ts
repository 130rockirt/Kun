import { afterEach, describe, expect, it, vi } from 'vitest'
import { useWriteWorkspaceStore } from './write-workspace-store'

const WORKSPACE = '/tmp/write'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve })
  return { promise, resolve }
}

function installFileReader(content: string): ReturnType<typeof vi.fn> {
  const readWorkspaceFile = vi.fn(async ({ path }: { path: string }) => ({
    ok: true as const,
    path,
    content,
    size: content.length,
    truncated: false as const
  }))
  vi.stubGlobal('window', { kunGui: { readWorkspaceFile } })
  return readWorkspaceFile
}

afterEach(() => {
  useWriteWorkspaceStore.getState().resetWorkspace()
  vi.unstubAllGlobals()
})

describe('write workspace code-file actions', () => {
  it('opens TypeScript through the bounded text reader as a read-only code session', async () => {
    const path = `${WORKSPACE}/src/main.ts`
    const content = 'export const answer = 42\n'
    const readWorkspaceFile = installFileReader(content)
    useWriteWorkspaceStore.setState({ workspaceRoot: WORKSPACE })

    await useWriteWorkspaceStore.getState().openFile(WORKSPACE, path)

    expect(readWorkspaceFile).toHaveBeenCalledWith({ path, workspaceRoot: WORKSPACE })
    expect(useWriteWorkspaceStore.getState()).toMatchObject({
      activeFilePath: path,
      activeFileKind: 'code',
      fileContent: content,
      saveStatus: 'saved'
    })
    expect(useWriteWorkspaceStore.getState().documentsByPath[path]).toMatchObject({
      path,
      kind: 'code',
      fileContent: content,
      saveStatus: 'saved'
    })
  })

  it('keeps Markdown in the editable text document path', async () => {
    const path = `${WORKSPACE}/notes.md`
    const content = '# Notes\n'
    const readWorkspaceFile = installFileReader(content)
    useWriteWorkspaceStore.setState({ workspaceRoot: WORKSPACE })

    await useWriteWorkspaceStore.getState().openFile(WORKSPACE, path)

    expect(readWorkspaceFile).toHaveBeenCalledWith({ path, workspaceRoot: WORKSPACE })
    expect(useWriteWorkspaceStore.getState()).toMatchObject({
      activeFilePath: path,
      activeFileKind: 'text',
      fileContent: content
    })
    expect(useWriteWorkspaceStore.getState().documentsByPath[path]).toMatchObject({
      kind: 'text',
      fileContent: content
    })
  })

  it('rejects unsupported files before invoking the text reader', async () => {
    const readWorkspaceFile = installFileReader('not actually text')
    useWriteWorkspaceStore.setState({ workspaceRoot: WORKSPACE })

    await useWriteWorkspaceStore.getState().openFile(WORKSPACE, `${WORKSPACE}/archive.zip`)

    expect(readWorkspaceFile).not.toHaveBeenCalled()
    expect(useWriteWorkspaceStore.getState()).toMatchObject({
      activeFilePath: null,
      documentsByPath: {},
      fileLoading: false
    })
    expect(useWriteWorkspaceStore.getState().fileError).toBeTruthy()
  })

  it('saves and reclassifies an open Markdown document renamed to TypeScript', async () => {
    const previousPath = `${WORKSPACE}/notes.md`
    const nextPath = `${WORKSPACE}/notes.ts`
    const writeWorkspaceFile = vi.fn(async () => ({
      ok: true as const,
      path: previousPath,
      savedAt: '2026-08-13T00:00:00.000Z'
    }))
    const renameResult = {
      ok: true as const,
      path: nextPath,
      previousPath,
      renamedAt: '2026-08-13T00:00:01.000Z'
    }
    const pendingRename = deferred<typeof renameResult>()
    const renameWorkspaceEntry = vi.fn(() => pendingRename.promise)
    vi.stubGlobal('window', {
      kunGui: {
        readWorkspaceFile: vi.fn(async () => ({
          ok: true as const,
          path: previousPath,
          content: '# Notes\n',
          size: 8,
          truncated: false as const
        })),
        writeWorkspaceFile,
        renameWorkspaceEntry,
        listWorkspaceDirectory: vi.fn(async () => ({
          ok: true as const,
          root: WORKSPACE,
          entries: [{ name: 'notes.ts', path: nextPath, type: 'file' as const, ext: '.ts' }]
        }))
      }
    })
    useWriteWorkspaceStore.setState({
      workspaceRoot: WORKSPACE,
      rootDirectory: WORKSPACE,
      autoSaveEnabled: false
    })
    await useWriteWorkspaceStore.getState().openFile(WORKSPACE, previousPath)
    useWriteWorkspaceStore.getState().setDocumentContent(previousPath, 'const answer = 42\n')

    const rename = useWriteWorkspaceStore.getState()
      .renameEntry(WORKSPACE, previousPath, 'notes.ts')
    await vi.waitFor(() => expect(renameWorkspaceEntry).toHaveBeenCalledOnce())

    expect(useWriteWorkspaceStore.getState().activeFileKind).toBe('code')
    useWriteWorkspaceStore.getState().setDocumentContent(previousPath, 'unsaved during rename\n')
    expect(useWriteWorkspaceStore.getState().documentsByPath[previousPath]?.fileContent)
      .toBe('const answer = 42\n')

    pendingRename.resolve(renameResult)
    await rename

    expect(writeWorkspaceFile).toHaveBeenCalledWith({
      path: previousPath,
      workspaceRoot: WORKSPACE,
      content: 'const answer = 42\n'
    })
    expect(writeWorkspaceFile.mock.invocationCallOrder[0])
      .toBeLessThan(renameWorkspaceEntry.mock.invocationCallOrder[0])
    expect(useWriteWorkspaceStore.getState()).toMatchObject({
      activeFilePath: nextPath,
      activeFileKind: 'code',
      saveStatus: 'saved'
    })
    expect(useWriteWorkspaceStore.getState().documentsByPath[previousPath]).toBeUndefined()
    expect(useWriteWorkspaceStore.getState().documentsByPath[nextPath]).toMatchObject({
      kind: 'code',
      fileContent: 'const answer = 42\n',
      persistedContent: 'const answer = 42\n',
      saveStatus: 'saved'
    })
  })

  it('makes an open code preview editable after renaming it to Markdown', async () => {
    const previousPath = `${WORKSPACE}/notes.ts`
    const nextPath = `${WORKSPACE}/notes.md`
    vi.stubGlobal('window', {
      kunGui: {
        readWorkspaceFile: vi.fn(async () => ({
          ok: true as const,
          path: previousPath,
          content: '# Notes\n',
          size: 8,
          truncated: false as const
        })),
        renameWorkspaceEntry: vi.fn(async () => ({
          ok: true as const,
          path: nextPath,
          previousPath,
          renamedAt: '2026-08-13T00:00:00.000Z'
        })),
        listWorkspaceDirectory: vi.fn(async () => ({
          ok: true as const,
          root: WORKSPACE,
          entries: [{ name: 'notes.md', path: nextPath, type: 'file' as const, ext: '.md' }]
        }))
      }
    })
    useWriteWorkspaceStore.setState({ workspaceRoot: WORKSPACE, rootDirectory: WORKSPACE })
    await useWriteWorkspaceStore.getState().openFile(WORKSPACE, previousPath)

    await useWriteWorkspaceStore.getState().renameEntry(WORKSPACE, previousPath, 'notes.md')

    expect(useWriteWorkspaceStore.getState()).toMatchObject({
      activeFilePath: nextPath,
      activeFileKind: 'text'
    })
    expect(useWriteWorkspaceStore.getState().documentsByPath[nextPath]).toMatchObject({
      kind: 'text',
      fileContent: '# Notes\n'
    })
  })

  it('restores the editable document when a text-to-code rename fails', async () => {
    const path = `${WORKSPACE}/notes.md`
    vi.stubGlobal('window', {
      kunGui: {
        readWorkspaceFile: vi.fn(async () => ({
          ok: true as const,
          path,
          content: '# Notes\n',
          size: 8,
          truncated: false as const
        })),
        renameWorkspaceEntry: vi.fn(async () => ({
          ok: false as const,
          message: 'rename failed'
        }))
      }
    })
    useWriteWorkspaceStore.setState({ workspaceRoot: WORKSPACE })
    await useWriteWorkspaceStore.getState().openFile(WORKSPACE, path)

    await expect(useWriteWorkspaceStore.getState()
      .renameEntry(WORKSPACE, path, 'notes.ts')).resolves.toBeNull()

    expect(useWriteWorkspaceStore.getState()).toMatchObject({
      activeFilePath: path,
      activeFileKind: 'text',
      fileContent: '# Notes\n',
      fileError: 'rename failed'
    })
    expect(useWriteWorkspaceStore.getState().documentsByPath[path]?.kind).toBe('text')
  })
})
