import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesignArtifact, DesignDocument } from '../design-types'
import { useDesignWorkspaceStore } from '../design-workspace-store'
import { buildSvgArtifactSkeleton } from './svg-skeleton'
import {
  startSvgArtifactStatusMonitor,
  svgArtifactStatusForSource,
  useSvgArtifactStatusMonitor
} from './use-svg-artifact-status-monitor'

const now = '2026-07-10T00:00:00.000Z'

describe('SVG artifact background status', () => {
  afterEach(() => vi.restoreAllMocks())
  it('keeps an accessible reservation skeleton pending', () => {
    expect(svgArtifactStatusForSource(buildSvgArtifactSkeleton({
      title: 'Reserved motion',
      brief: 'Waiting for the SVG agent',
      width: 320,
      height: 240
    }))).toBe('pending')
  })

  it('marks a valid SVG with visible vector content ready', () => {
    expect(svgArtifactStatusForSource(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><title>Mark</title><desc>Visible mark</desc><circle id="mark" cx="32" cy="32" r="20" /></svg>'
    )).toBe('ready')
  })

  it('marks malformed SVG content as error', () => {
    expect(svgArtifactStatusForSource(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 0 64"><circle r="8" /></svg>'
    )).toBe('error')
  })

  it('keeps a sanitizable SVG with no remaining visual content pending', () => {
    expect(svgArtifactStatusForSource(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    )).toBe('pending')
  })

  it('does not create a visual element by joining text around a removed block', () => {
    expect(svgArtifactStatusForSource(
      '<svg xmlns="http://www.w3.org/2000/svg"><pa<script>alert(1)</script>th d="M0 0h1" /></svg>'
    )).toBe('pending')
  })

  it('does not dispatch or restart watches when a pending skeleton remains pending', async () => {
    const relativePath = '.kun-design/doc/motion/v1.svg'
    const motion: DesignArtifact = {
      id: 'motion', kind: 'svg', title: 'Motion', relativePath,
      createdAt: now, updatedAt: now, previewStatus: 'pending',
      versions: [{ id: 'motion-v1', relativePath, createdAt: now, summary: '' }]
    }
    const document: DesignDocument = {
      id: 'doc', title: 'Doc', createdAt: now, updatedAt: now, order: 0,
      artifacts: [motion], activeArtifactId: motion.id
    }
    useDesignWorkspaceStore.setState({
      workspaceRoot: '/workspace', documents: [document], activeDocumentId: document.id,
      artifacts: document.artifacts, activeArtifactId: motion.id
    })
    const skeleton = buildSvgArtifactSkeleton({ title: 'Motion', width: 64, height: 64 })
    const readWorkspaceFile = vi.fn(async () => ({
      ok: true as const, path: relativePath, content: skeleton,
      size: skeleton.length, truncated: false
    }))
    const watchWorkspaceFile = vi.fn(async () => ({
      ok: true as const, watchId: 'watch-motion', path: relativePath,
      content: skeleton, size: skeleton.length, truncated: false, startedAt: now
    }))
    const unwatchWorkspaceFile = vi.fn(async () => true)
    const offChanged = vi.fn()
    const onWorkspaceFileChanged = vi.fn(() => offChanged)
    const setStatus = vi.spyOn(useDesignWorkspaceStore.getState(), 'setArtifactPreviewStatus')

    const stop = startSvgArtifactStatusMonitor('/workspace', [{ id: motion.id, relativePath }], {
      readWorkspaceFile,
      watchWorkspaceFile,
      unwatchWorkspaceFile,
      onWorkspaceFileChanged
    })
    await vi.waitFor(() => {
      expect(watchWorkspaceFile).toHaveBeenCalledOnce()
    })
    await Promise.resolve()
    expect(readWorkspaceFile).not.toHaveBeenCalled()
    expect(setStatus).not.toHaveBeenCalled()

    stop()
    expect(offChanged).toHaveBeenCalledOnce()
    expect(unwatchWorkspaceFile).toHaveBeenCalledOnce()
  })

  it('does not read or persist SVG status for a read-only historical document', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const relativePath = '.kun-design/doc/motion/v1.svg'
    const artifact: DesignArtifact = {
      id: 'motion', kind: 'svg', title: 'Motion', relativePath,
      createdAt: now, updatedAt: now, previewStatus: 'pending',
      versions: [{ id: 'motion-v1', relativePath, createdAt: now, summary: '' }]
    }
    const readWorkspaceFile = vi.fn()
    vi.stubGlobal('window', { kunGui: { readWorkspaceFile } })
    const Harness = () => {
      useSvgArtifactStatusMonitor('/workspace', [artifact], false)
      return null
    }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(createElement(Harness)) })

    expect(readWorkspaceFile).not.toHaveBeenCalled()
    await act(async () => renderer.unmount())
    vi.unstubAllGlobals()
  })
})
