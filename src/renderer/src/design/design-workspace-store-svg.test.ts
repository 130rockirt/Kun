import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDesignWorkspaceStore } from './design-workspace-store'
import type { DesignArtifact, DesignDocument } from './design-types'
import { buildSvgArtifactSkeleton } from './svg/svg-skeleton'

const createdAt = '2026-06-20T00:00:00.000Z'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function canvasArtifact(): DesignArtifact {
  return {
    id: 'canvas',
    kind: 'canvas',
    title: 'Board',
    relativePath: '.kun-design/doc/canvas/canvas.json',
    createdAt,
    updatedAt: createdAt,
    versions: [{ id: 'canvas-v1', relativePath: '.kun-design/doc/canvas/canvas.json', createdAt, summary: '' }]
  }
}

function pendingSvgArtifact(): DesignArtifact {
  return {
    id: 'motion',
    kind: 'svg',
    title: 'Motion',
    relativePath: '.kun-design/doc/motion/v1.svg',
    designMdPath: '.kun-design/doc/motion/DESIGN.md',
    previewStatus: 'pending',
    createdAt,
    updatedAt: createdAt,
    versions: [{
      id: 'motion-v1',
      relativePath: '.kun-design/doc/motion/v1.svg',
      createdAt,
      summary: 'Skeleton reservation'
    }]
  }
}

describe('SVG design workspace versions', () => {
  const files = new Map<string, string>()
  const createWorkspaceFile = vi.fn(async ({ path, content }: { path: string; content?: string }) => {
    if (files.has(path)) return { ok: false as const, message: 'File already exists.' }
    files.set(path, content ?? '')
    return { ok: true as const, path, createdAt }
  })
  const readWorkspaceFile = vi.fn(async ({ path }: { path: string }) => {
    const content = files.get(path)
    return content === undefined
      ? { ok: false as const, message: 'missing' }
      : { ok: true as const, path, content, size: content.length, truncated: false }
  })
  const listWorkspaceDirectory = vi.fn(async ({ path }: { path?: string }) => ({
    ok: true as const,
    path: path ?? '',
    entries: [...files.keys()]
      .filter((file) => file.startsWith(`${path}/`) && !file.slice((path?.length ?? 0) + 1).includes('/'))
      .map((file) => ({ name: file.slice((path?.length ?? 0) + 1), path: file, type: 'file' as const, ext: '.svg' }))
  }))
  const writeWorkspaceFile = vi.fn(async ({ path, content }: { path: string; content: string }) => {
    files.set(path, content)
    return { ok: true as const, path, savedAt: createdAt } as
      | { ok: true; path: string; savedAt: string }
      | { ok: false; message: string }
  })
  const deleteWorkspaceEntry = vi.fn(async ({ path }: { path: string }) => {
    for (const file of [...files.keys()]) {
      if (file === path || file.startsWith(`${path}/`)) files.delete(file)
    }
    return { ok: true as const }
  })

  beforeEach(() => {
    files.clear()
    files.set('.kun-design/doc/motion/v1.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle id="dot" cx="32" cy="32" r="8" /></svg>')
    createWorkspaceFile.mockClear()
    readWorkspaceFile.mockClear()
    listWorkspaceDirectory.mockClear()
    writeWorkspaceFile.mockClear()
    deleteWorkspaceEntry.mockClear()
    vi.stubGlobal('window', {
      kunGui: {
        createWorkspaceFile,
        readWorkspaceFile,
        listWorkspaceDirectory,
        writeWorkspaceFile,
        deleteWorkspaceEntry
      }
    })
    const canvas = canvasArtifact()
    const motion = pendingSvgArtifact()
    const document: DesignDocument = {
      id: 'doc',
      title: 'Doc',
      createdAt,
      updatedAt: createdAt,
      order: 0,
      artifacts: [canvas, motion],
      activeArtifactId: canvas.id
    }
    useDesignWorkspaceStore.setState({
      workspaceRoot: '/workspace',
      documents: [document],
      activeDocumentId: document.id,
      artifacts: document.artifacts,
      activeArtifactId: canvas.id,
      designContext: { designTarget: 'web' }
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('reuses a freshly reserved SVG v1, then versions later edits after it becomes ready', async () => {
    files.set('.kun-design/doc/motion/v1.svg', buildSvgArtifactSkeleton({
      title: 'Motion',
      brief: 'Reserved motion',
      width: 64,
      height: 64
    }))
    const initial = await useDesignWorkspaceStore.getState().prepareSvgTurn('Build the real motion', {
      artifactId: 'motion',
      activate: false,
      reusePendingInitial: true
    })
    expect(initial).toEqual({
      artifactId: 'motion',
      relativePath: '.kun-design/doc/motion/v1.svg',
      designMdPath: '.kun-design/doc/motion/DESIGN.md',
      newlyCreated: false,
      versionCreated: false
    })
    expect(useDesignWorkspaceStore.getState().artifacts.find((item) => item.id === 'motion')?.versions).toHaveLength(1)

    files.set('.kun-design/doc/motion/v1.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle r="8" /></svg>')
    useDesignWorkspaceStore.getState().setArtifactPreviewStatus('motion', 'ready')
    const iteration = await useDesignWorkspaceStore.getState().prepareSvgTurn('Slow the loop down', {
      artifactId: 'motion',
      activate: false,
      reusePendingInitial: true
    })
    expect(iteration).toMatchObject({
      artifactId: 'motion',
      relativePath: '.kun-design/doc/motion/v2.svg',
      basePath: '.kun-design/doc/motion/v1.svg'
    })
  })

  it('creates v2 when visible v1 content is ready on disk before pending metadata catches up', async () => {
    const iteration = await useDesignWorkspaceStore.getState().prepareSvgTurn('Continue visible motion', {
      artifactId: 'motion',
      activate: false,
      reusePendingInitial: true
    })

    expect(iteration).toMatchObject({
      relativePath: '.kun-design/doc/motion/v2.svg',
      basePath: '.kun-design/doc/motion/v1.svg',
      versionCreated: true
    })
  })

  it('uses the highest disk SVG version instead of overwriting a version missing from metadata', async () => {
    const sparse: DesignArtifact = {
      ...pendingSvgArtifact(),
      relativePath: '.kun-design/doc/motion/v3.svg',
      previewStatus: 'ready',
      versions: [
        { id: 'motion-v3', relativePath: '.kun-design/doc/motion/v3.svg', createdAt, summary: 'Latest hand-authored version' },
        { id: 'motion-v1', relativePath: '.kun-design/doc/motion/v1.svg', createdAt, summary: 'Initial version' }
      ]
    }
    const document: DesignDocument = {
      id: 'doc',
      title: 'Doc',
      createdAt,
      updatedAt: createdAt,
      order: 0,
      artifacts: [canvasArtifact(), sparse],
      activeArtifactId: sparse.id
    }
    useDesignWorkspaceStore.setState({
      documents: [document],
      activeDocumentId: document.id,
      artifacts: document.artifacts,
      activeArtifactId: sparse.id
    })
    files.set('.kun-design/doc/motion/v3.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" /></svg>')
    files.set('.kun-design/doc/motion/v4.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M0 0h64v64z" /></svg>')

    const iteration = await useDesignWorkspaceStore.getState().prepareSvgTurn('Refine the hand-authored motion', {
      artifactId: sparse.id,
      activate: false
    })

    expect(iteration).toMatchObject({
      relativePath: '.kun-design/doc/motion/v5.svg',
      basePath: '.kun-design/doc/motion/v3.svg'
    })
    expect(files.get('.kun-design/doc/motion/v4.svg')).toContain('<path')
  })

  it('retries the next version when an exclusive create loses a post-list race', async () => {
    useDesignWorkspaceStore.getState().setArtifactPreviewStatus('motion', 'ready')
    createWorkspaceFile.mockResolvedValueOnce({ ok: false, message: 'File already exists.' })

    const iteration = await useDesignWorkspaceStore.getState().prepareSvgTurn('Allocate after a race', {
      artifactId: 'motion',
      activate: false
    })

    expect(iteration.relativePath).toBe('.kun-design/doc/motion/v3.svg')
    expect(createWorkspaceFile.mock.calls.map(([payload]) => payload.path)).toEqual([
      '.kun-design/doc/motion/v2.svg',
      '.kun-design/doc/motion/v3.svg'
    ])
  })

  it('reuses a stable force-new artifact id without creating a duplicate artifact or file', async () => {
    const first = await useDesignWorkspaceStore.getState().prepareSvgTurn('Create stable motion', {
      forceNew: true,
      artifactId: 'svg-stable',
      title: 'Stable motion'
    })
    const replay = await useDesignWorkspaceStore.getState().prepareSvgTurn('Create stable motion', {
      forceNew: true,
      artifactId: 'svg-stable',
      title: 'Stable motion'
    })

    expect(first).toMatchObject({ artifactId: 'svg-stable', newlyCreated: true })
    expect(replay).toMatchObject({ artifactId: 'svg-stable', newlyCreated: false, relativePath: first.relativePath })
    expect(useDesignWorkspaceStore.getState().artifacts.filter((item) => item.id === 'svg-stable')).toHaveLength(1)
    expect(createWorkspaceFile.mock.calls.filter(([payload]) => payload.path === first.relativePath)).toHaveLength(1)
  })

  it('removes an allocated version and restores metadata when the metadata write fails', async () => {
    useDesignWorkspaceStore.getState().setArtifactPreviewStatus('motion', 'ready')
    writeWorkspaceFile.mockResolvedValueOnce({ ok: false, message: 'disk full' })

    await expect(useDesignWorkspaceStore.getState().prepareSvgTurn('Create a safer v2', {
      artifactId: 'motion',
      activate: false
    })).rejects.toThrow('Could not persist SVG metadata: disk full')

    const motion = useDesignWorkspaceStore.getState().artifacts.find((item) => item.id === 'motion')
    expect(motion).toMatchObject({
      relativePath: '.kun-design/doc/motion/v1.svg',
      previewStatus: 'ready'
    })
    expect(motion?.versions).toHaveLength(1)
    expect(files.has('.kun-design/doc/motion/v2.svg')).toBe(false)
    expect(deleteWorkspaceEntry).toHaveBeenCalledWith(expect.objectContaining({
      path: '.kun-design/doc/motion/v2.svg'
    }))
  })

  it('removes a newly reserved artifact directory when its metadata cannot be committed', async () => {
    writeWorkspaceFile.mockResolvedValueOnce({ ok: false, message: 'metadata unavailable' })

    await expect(useDesignWorkspaceStore.getState().prepareSvgTurn('Reserve an atomic SVG', {
      forceNew: true,
      artifactId: 'svg-atomic'
    })).rejects.toThrow('Could not persist SVG metadata: metadata unavailable')

    expect(useDesignWorkspaceStore.getState().artifacts.some((item) => item.id === 'svg-atomic')).toBe(false)
    expect([...files.keys()].some((path) => path.includes('/svg-atomic/'))).toBe(false)
    expect(deleteWorkspaceEntry).toHaveBeenCalledWith(expect.objectContaining({
      path: '.kun-design/doc/svg-atomic/v1.svg'
    }))
    expect(deleteWorkspaceEntry).not.toHaveBeenCalledWith(expect.objectContaining({
      path: '.kun-design/doc/svg-atomic'
    }))
  })

  it('preserves pre-existing side files when an initial metadata commit fails', async () => {
    files.set('.kun-design/doc/svg-with-notes/DESIGN.md', '# User notes\n')
    writeWorkspaceFile.mockResolvedValueOnce({ ok: false, message: 'metadata unavailable' })

    await expect(useDesignWorkspaceStore.getState().prepareSvgTurn('Reserve safely', {
      forceNew: true,
      artifactId: 'svg-with-notes'
    })).rejects.toThrow('metadata unavailable')

    expect(files.get('.kun-design/doc/svg-with-notes/DESIGN.md')).toBe('# User notes\n')
    expect(files.has('.kun-design/doc/svg-with-notes/v1.svg')).toBe(false)
  })

  it('aborts and removes a new reservation if the active document changes during file creation', async () => {
    const gate = deferred()
    createWorkspaceFile.mockImplementationOnce(async ({ path, content }) => {
      await gate.promise
      files.set(path, content ?? '')
      return { ok: true as const, path, createdAt }
    })
    const operation = useDesignWorkspaceStore.getState().prepareSvgTurn('Do not cross documents', {
      forceNew: true,
      artifactId: 'svg-context'
    })
    await vi.waitFor(() => expect(createWorkspaceFile).toHaveBeenCalled())
    const original = useDesignWorkspaceStore.getState().documents[0]
    const otherCanvas = { ...canvasArtifact(), id: 'other-canvas', relativePath: '.kun-design/other/other-canvas/canvas.json' }
    const other: DesignDocument = {
      id: 'other',
      title: 'Other',
      createdAt,
      updatedAt: createdAt,
      order: 1,
      artifacts: [otherCanvas],
      activeArtifactId: otherCanvas.id
    }
    useDesignWorkspaceStore.setState({
      documents: [original, other],
      activeDocumentId: other.id,
      artifacts: other.artifacts,
      activeArtifactId: other.activeArtifactId
    })
    gate.resolve()

    await expect(operation).rejects.toThrow('active workspace or drawing changed')
    expect(useDesignWorkspaceStore.getState().documents.flatMap((document) => document.artifacts)
      .some((artifact) => artifact.id === 'svg-context')).toBe(false)
    expect(files.has('.kun-design/doc/svg-context/v1.svg')).toBe(false)
  })

  it('rolls back a prepared version before runtime dispatch', async () => {
    useDesignWorkspaceStore.getState().setArtifactPreviewStatus('motion', 'ready')
    const prepared = await useDesignWorkspaceStore.getState().prepareSvgTurn('Prepare reversible v2', {
      artifactId: 'motion',
      activate: false
    })

    await prepared.rollbackPreparedVersion?.()

    expect(useDesignWorkspaceStore.getState().artifacts.find((artifact) => artifact.id === 'motion')).toMatchObject({
      relativePath: '.kun-design/doc/motion/v1.svg',
      versions: [{ relativePath: '.kun-design/doc/motion/v1.svg' }]
    })
    expect(files.has('.kun-design/doc/motion/v2.svg')).toBe(false)
  })

  it('rolls back a duplicate copy if the active document changes before insertion', async () => {
    const gate = deferred()
    createWorkspaceFile.mockImplementationOnce(async ({ path, content }) => {
      await gate.promise
      files.set(path, content ?? '')
      return { ok: true as const, path, createdAt }
    })
    const operation = useDesignWorkspaceStore.getState().duplicateArtifact('motion')
    await vi.waitFor(() => expect(createWorkspaceFile).toHaveBeenCalled())
    const original = useDesignWorkspaceStore.getState().documents[0]
    const otherCanvas = { ...canvasArtifact(), id: 'copy-canvas', relativePath: '.kun-design/copy/copy-canvas/canvas.json' }
    const other: DesignDocument = {
      id: 'copy', title: 'Copy target', createdAt, updatedAt: createdAt, order: 1,
      artifacts: [otherCanvas], activeArtifactId: otherCanvas.id
    }
    useDesignWorkspaceStore.setState({
      documents: [original, other], activeDocumentId: other.id,
      artifacts: other.artifacts, activeArtifactId: other.activeArtifactId
    })
    gate.resolve()
    await operation

    expect(useDesignWorkspaceStore.getState().documents.flatMap((document) => document.artifacts)
      .filter((artifact) => artifact.kind === 'svg')).toHaveLength(1)
    expect([...files.keys()].filter((path) => path.endsWith('/v1.svg'))).toEqual([
      '.kun-design/doc/motion/v1.svg'
    ])
  })

  it('infers SVG dimensions when valid legacy metadata has no node', async () => {
    const artifactId = 'svg-legacy-node'
    const relativePath = `.kun-design/doc/${artifactId}/v1.svg`
    const documentsIndex = JSON.stringify({
      version: 1,
      activeDocumentId: 'doc',
      documents: [{
        id: 'doc', title: 'Doc', order: 0, createdAt, updatedAt: createdAt,
        activeArtifactId: artifactId
      }]
    })
    const meta = JSON.stringify({
      id: artifactId, kind: 'svg', title: 'Legacy SVG', relativePath,
      createdAt, updatedAt: createdAt,
      versions: [{ id: `${artifactId}-v1`, relativePath, createdAt, summary: '' }]
    })
    const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 160"><rect width="320" height="160" /></svg>'
    const rehydrateRead = vi.fn(async ({ path }: { path: string }) => {
      if (path === '.kun-design/documents.json') return { ok: true as const, content: documentsIndex }
      if (path === `.kun-design/doc/${artifactId}/meta.json`) return { ok: true as const, content: meta }
      if (path === relativePath) {
        return { ok: true as const, path, content: source, size: source.length, truncated: false }
      }
      return { ok: false as const, message: 'missing' }
    })
    const rehydrateList = vi.fn(async ({ path }: { path: string }) => {
      if (path === '.kun-design') return { ok: true as const, entries: [{ name: 'doc', type: 'directory' as const }] }
      if (path === '.kun-design/doc') {
        return { ok: true as const, entries: [{ name: artifactId, type: 'directory' as const }] }
      }
      return { ok: true as const, entries: [] }
    })
    vi.stubGlobal('window', {
      kunGui: { writeWorkspaceFile, readWorkspaceFile: rehydrateRead, listWorkspaceDirectory: rehydrateList }
    })

    await useDesignWorkspaceStore.getState().rehydrateArtifacts()

    expect(useDesignWorkspaceStore.getState().artifacts.find((item) => item.id === artifactId)?.node)
      .toMatchObject({ width: 320, height: 160, sizeMode: 'manual' })
  })

  it.each([
    {
      label: 'reservation skeleton',
      source: buildSvgArtifactSkeleton({ title: 'Motion', brief: 'Pending work', width: 64, height: 64 }),
      expected: 'pending'
    },
    {
      label: 'visible SVG',
      source: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="8" /></svg>',
      expected: 'ready'
    },
    {
      label: 'malformed SVG',
      source: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 0 64"><circle r="8" /></svg>',
      expected: 'error'
    }
  ] as const)('derives $expected status when duplicating a $label', async ({ source, expected }) => {
    files.set('.kun-design/doc/motion/v1.svg', source)

    await useDesignWorkspaceStore.getState().duplicateArtifact('motion')

    const copy = useDesignWorkspaceStore.getState().artifacts.find(
      (item) => item.kind === 'svg' && item.id !== 'motion'
    )
    expect(copy).toMatchObject({ previewStatus: expected })
    expect(files.get(copy!.relativePath)).toBe(source)
  })
})
