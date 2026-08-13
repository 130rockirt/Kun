import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyDocument } from '../../../../design/canvas/canvas-types'
import type { DesignArtifact } from '../../../../design/design-types'
import { useDesignWorkspaceStore } from '../../../../design/design-workspace-store'

const persistence = vi.hoisted(() => ({
  loadCanvasDocument: vi.fn(),
  persistCanvasDocument: vi.fn()
}))

vi.mock('../../../../design/canvas/canvas-persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../design/canvas/canvas-persistence')>(),
  loadCanvasDocument: persistence.loadCanvasDocument,
  persistCanvasDocument: persistence.persistCanvasDocument
}))

import {
  loadCanvasDocumentWithinDeadline,
  useCanvasViewportDocumentSync
} from './use-canvas-viewport-document-sync'

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('window', { localStorage: { getItem: vi.fn(() => null), setItem: vi.fn() } })
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  persistence.loadCanvasDocument.mockReset()
  persistence.persistCanvasDocument.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('loadCanvasDocumentWithinDeadline', () => {
  it('returns a resolved canvas document', async () => {
    const document = createEmptyDocument()

    await expect(loadCanvasDocumentWithinDeadline(async () => document, 100)).resolves.toEqual({
      status: 'resolved',
      document
    })
  })

  it('settles a hung historical-board read instead of loading forever', async () => {
    vi.useFakeTimers()
    const pending = new Promise<never>(() => undefined)
    const result = loadCanvasDocumentWithinDeadline(() => pending, 100)

    await vi.advanceTimersByTimeAsync(100)

    await expect(result).resolves.toEqual({ status: 'timeout', document: null })
  })

  it('normalizes rejected reads into a reconstructable result', async () => {
    await expect(
      loadCanvasDocumentWithinDeadline(async () => {
        throw new Error('read failed')
      }, 100)
    ).resolves.toEqual({ status: 'rejected', document: null })
  })

  it('mounts a stale historical board without reconciling or persisting it', async () => {
    const staleBoard = createEmptyDocument()
    const screen: DesignArtifact = {
      id: 'screen-1', kind: 'html', title: 'Screen', relativePath: '.kun-design/doc/screen/v1.html',
      createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z',
      versions: [{
        id: 'screen-v1', relativePath: '.kun-design/doc/screen/v1.html',
        createdAt: '2026-08-12T00:00:00.000Z', summary: ''
      }]
    }
    persistence.loadCanvasDocument.mockResolvedValue(staleBoard)
    useDesignWorkspaceStore.setState({ artifacts: [screen], activeArtifactId: screen.id })
    const Harness = () => {
      useCanvasViewportDocumentSync({
        workspaceRoot: '/workspace', artifactId: 'board', viewportStorageKey: 'view',
        documentKey: 'historical-board', htmlFrameSyncEnabled: true,
        designArtifacts: [screen], persistenceEnabled: false
      })
      return null
    }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(createElement(Harness)) })
    await act(async () => { await Promise.resolve() })

    expect(persistence.loadCanvasDocument).toHaveBeenCalledTimes(1)
    expect(persistence.persistCanvasDocument).not.toHaveBeenCalled()
    await act(async () => renderer.unmount())
  })
})
