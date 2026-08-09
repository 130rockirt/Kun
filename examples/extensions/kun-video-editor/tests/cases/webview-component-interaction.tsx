import type { JobSnapshot } from '@kun/extension-api'
import { useState } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import {
  canImportMedia,
  PreviewComparisonViewer,
  syncDocumentPresentation,
  themeStyle,
  VideoEditorWorkbench
} from '../../src/webview/app.js'
import type { EditorController } from '../../src/webview/controller.js'
import { INITIAL_EDITOR_STATE, VIEW_LIMITS, editorReducer, type EditorState } from '../../src/webview/model.js'
import { makeArtifact, makeJob, makeSubtitleArtifact, makeViewProject } from '../webview-fixtures.js'
import {
  StatefulWorkbench,
  attribute,
  hasAttribute,
  hasClass,
  openingTags,
  pressTabKey,
  selectedTab,
  stubController,
  textContent,
  textForOpeningTag,
  webviewStyles
} from './webview-component-support.js'

describe('video editor docked workbench', () => {
  it('renders two protected resources for real side-by-side and wipe preview comparison', () => {
    const messages = {
      compareLeft: 'Left',
      compareRight: 'Right'
    } as Parameters<typeof PreviewComparisonViewer>[0]['messages']
    const left = {
      entryId: 'preview-left',
      title: 'Source take',
      url: 'kun-media://lease/preview-left',
      mediaKind: 'video' as const
    }
    const right = {
      entryId: 'preview-right',
      title: 'Generated take',
      url: 'kun-media://lease/preview-right',
      mediaKind: 'image' as const
    }
    for (const mode of ['side-by-side', 'wipe'] as const) {
      const html = renderToStaticMarkup(
        <PreviewComparisonViewer left={left} right={right} mode={mode} messages={messages} />
      )
      expect(html).toContain(`mode-${mode}`)
      expect(html).toContain(left.url)
      expect(html).toContain(right.url)
      expect(html).toContain('Source take')
      expect(html).toContain('Generated take')
      expect(html).not.toMatch(/(?:file:\/\/|\/Users\/|workspaceRelativePath)/u)
    }
  })

  it('keeps the no-project state focused on a primary first-screen action', () => {
    const state = editorReducer(INITIAL_EDITOR_STATE, { type: 'initialized' })
    const html = renderToStaticMarkup(<VideoEditorWorkbench controller={stubController(state)} />)
    const tags = openingTags(html)
    const main = tags.find((tag) => attribute(tag, 'id') === 'video-editor-main')
    const primaryAction = tags.find((tag) => hasClass(tag, 'empty-project-primary'))

    expect(main).toBeDefined()
    expect(hasClass(main!, 'empty-project')).toBe(true)
    expect(primaryAction).toBeDefined()
    expect(tags.some((tag) => hasClass(tag, 'workbench-tabs'))).toBe(false)
    expect(tags.some((tag) => hasClass(tag, 'onboarding-project-card'))).toBe(true)
    expect(html).toContain('Start your first story')
    expect(html).toContain('Canvas ratio')
    expect(html).toContain('Three-step editing workflow')
    expect(html).toContain('Create or open a project')
  })

  it('renders localized initialization recovery guidance and retries through the controller', async () => {
    const state: EditorState = {
      ...editorReducer(INITIAL_EDITOR_STATE, { type: 'initialized' }),
      connection: 'offline',
      locale: { language: 'zh-CN', direction: 'ltr', messages: {} },
      notices: [{
        id: 'initialization-failed',
        severity: 'error',
        message: 'The editor could not initialize.',
        messageKey: 'editorInitializeFailed'
      }]
    }
    const retryInitialization = vi.fn(async () => undefined)
    const mediaQuery = { matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }
    vi.stubGlobal('document', {
      documentElement: {
        dataset: {}, dir: 'ltr', lang: '',
        style: { setProperty: vi.fn(), removeProperty: vi.fn() }
      },
      title: ''
    })
    vi.stubGlobal('window', {
      innerWidth: 280,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      confirm: vi.fn(() => false), matchMedia: vi.fn(() => mediaQuery)
    })
    let renderer: ReactTestRenderer | undefined
    try {
      await act(async () => {
        renderer = create(<VideoEditorWorkbench controller={{
          ...stubController(state), retryInitialization
        }} />)
        await Promise.resolve()
      })
      const rendered = JSON.stringify(renderer!.toJSON())
      expect(rendered).toContain('视频编辑器初始化失败。')
      expect(rendered).toContain('请检查工作区信任与扩展权限，然后重试初始化')
      expect(rendered).toContain('现有项目和媒体不会被修改')
      expect(rendered).not.toContain('创建或打开项目')

      const retry = renderer!.root.findAllByType('button').find(({ props }) =>
        props.children === '重试初始化'
      )
      expect(retry).toBeDefined()
      await act(async () => {
        retry!.props.onClick()
        await Promise.resolve()
      })
      expect(retryInitialization).toHaveBeenCalledOnce()

      await act(async () => {
        renderer!.update(<VideoEditorWorkbench controller={{
          ...stubController({ ...state, notices: [] }), retryInitialization
        }} />)
        await Promise.resolve()
      })
      expect(JSON.stringify(renderer!.toJSON())).toContain('重试初始化')
    } finally {
      await act(async () => renderer?.unmount())
      vi.unstubAllGlobals()
    }
  })

  it('keeps one roving tab selection across keyboard navigation and sidebar resize', async () => {
    const project = makeViewProject()
    const state = editorReducer(
      editorReducer(INITIAL_EDITOR_STATE, { type: 'initialized' }),
      { type: 'project', value: project }
    )
    let compact = true
    let mediaListener: (() => void) | undefined
    const mediaQuery = {
      get matches() { return compact },
      media: '(max-width: 1180px)',
      onchange: null,
      addEventListener: vi.fn((_type: string, listener: () => void) => { mediaListener = listener }),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true)
    }
    const documentElement = {
      dataset: {},
      dir: 'ltr',
      lang: '',
      style: { setProperty: vi.fn(), removeProperty: vi.fn() }
    }
    vi.stubGlobal('document', { documentElement, title: '' })
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      confirm: vi.fn(() => false),
      matchMedia: vi.fn(() => mediaQuery)
    })
    let renderer: ReactTestRenderer | undefined
    try {
      await act(async () => {
        renderer = create(<StatefulWorkbench state={state} />)
        await Promise.resolve()
      })
      expect(selectedTab(renderer!)).toBe('script')

      await pressTabKey(renderer!, 'ArrowRight')
      expect(selectedTab(renderer!)).toBe('clips')
      await pressTabKey(renderer!, 'End')
      expect(selectedTab(renderer!)).toBe('output')
      await pressTabKey(renderer!, 'Home')
      expect(selectedTab(renderer!)).toBe('script')

      const timeline = renderer!.root.findAll((node) => node.props.role === 'tab')
        .find((node) => node.props['data-section'] === 'timeline')
      await act(async () => timeline?.props.onClick())
      expect(selectedTab(renderer!)).toBe('timeline')

      compact = false
      await act(async () => mediaListener?.())
      compact = true
      await act(async () => mediaListener?.())
      expect(selectedTab(renderer!)).toBe('timeline')
      expect(renderer!.root.findAll((node) => node.props.role === 'tab' && node.props['data-section'] && node.props.tabIndex === 0)).toHaveLength(1)
      expect(renderer!.root.findAll((node) => node.props.role === 'tabpanel' && node.props.hidden !== true)).toHaveLength(1)
    } finally {
      await act(async () => renderer?.unmount())
      vi.unstubAllGlobals()
    }
  })

  it('supports keyboard-only project, playback, timeline edit, and job-control traversal with visible focus semantics', async () => {
    const project = makeViewProject()
    const base = editorReducer(
      editorReducer(INITIAL_EDITOR_STATE, { type: 'initialized' }),
      { type: 'project', value: project }
    )
    const importMedia = vi.fn(async () => undefined)
    const togglePlaying = vi.fn()
    const setActiveWorkspace = vi.fn()
    const selectItem = vi.fn()
    const seek = vi.fn()
    const applyOperations = vi.fn(async () => undefined)
    const cancelJob = vi.fn(async () => undefined)
    const mediaQuery = { matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }
    vi.stubGlobal('document', {
      documentElement: {
        dataset: {}, dir: 'ltr', lang: '',
        style: { setProperty: vi.fn(), removeProperty: vi.fn() }
      },
      title: ''
    })
    vi.stubGlobal('window', {
      innerWidth: 280,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      confirm: vi.fn(() => true), matchMedia: vi.fn(() => mediaQuery)
    })
    const controllerFor = (state: EditorState): EditorController => ({
      ...stubController(state),
      importMedia,
      togglePlaying,
      setActiveWorkspace,
      selectItem,
      seek,
      applyOperations,
      cancelJob
    })
    let renderer: ReactTestRenderer | undefined
    try {
      await act(async () => {
        renderer = create(<VideoEditorWorkbench controller={controllerFor(base)} />)
        await Promise.resolve()
      })

      const tablist = renderer!.root.find((node) => node.props.role === 'tablist' && node.props.className === 'workbench-tabs')
      const tabs = tablist.findAll((node) => node.props.role === 'tab')
      expect(tablist.props['aria-label']).toBe('Editing workspaces')
      expect(tabs).toHaveLength(5)
      expect(tabs.filter(({ props }) => props['aria-selected'] === true && props.tabIndex === 0)).toHaveLength(1)
      await pressTabKey(renderer!, 'ArrowRight')
      expect(setActiveWorkspace).toHaveBeenCalledWith('clips')

      const importButton = renderer!.root.findAllByType('button').find(({ props }) => props.children === 'Import media')
      expect(importButton?.props).toMatchObject({ type: 'button', disabled: false })
      await act(async () => importButton!.props.onClick())
      expect(importMedia).toHaveBeenCalledOnce()

      const playButton = renderer!.root.findAllByType('button').find(({ props }) => props['aria-label'] === 'Play')
      expect(playButton?.props).toMatchObject({ type: 'button', 'aria-pressed': false })
      await act(async () => playButton!.props.onClick())
      expect(togglePlaying).toHaveBeenCalledOnce()

      const timelineState: EditorState = { ...base, activeWorkspace: 'timeline' }
      await act(async () => {
        renderer!.update(<VideoEditorWorkbench controller={controllerFor(timelineState)} />)
        await Promise.resolve()
      })
      let timelineClip = renderer!.root.findAll((node) => node.type === 'button' && node.props.className === 'timeline-clip-body')
        .find(({ props }) => String(props['aria-label']).includes('0–90 frames'))!
      expect(timelineClip.props.type).toBe('button')
      expect(timelineClip.props['aria-label']).toBe('Interview.mp4, 0–90 frames')
      expect(timelineClip.props['aria-pressed']).toBe(false)
      await act(async () => timelineClip.props.onClick())
      expect(selectItem).toHaveBeenCalledWith(project.items[0]!.id)
      expect(seek).toHaveBeenCalledWith(project.items[0]!.timelineStartFrame)

      const selectedTimelineState: EditorState = {
        ...timelineState,
        selectedItemId: project.items[0]!.id,
        playheadFrame: 15
      }
      await act(async () => {
        renderer!.update(<VideoEditorWorkbench controller={controllerFor(selectedTimelineState)} />)
        await Promise.resolve()
      })
      timelineClip = renderer!.root.findAll((node) => node.type === 'button' && node.props.className === 'timeline-clip-body')
        .find(({ props }) => String(props['aria-label']).includes('0–90 frames'))!
      expect(timelineClip.props['aria-pressed']).toBe(true)
      const preventDefault = vi.fn()
      await act(async () => timelineClip.props.onKeyDown({ key: 'ArrowRight', shiftKey: false, preventDefault }))
      expect(preventDefault).toHaveBeenCalledOnce()
      expect(applyOperations).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ type: 'move-item', itemId: project.items[0]!.id })]),
        expect.any(String)
      )

      applyOperations.mockClear()
      const splitButton = renderer!.root.findAllByType('button').find(({ props }) => props['aria-label'] === 'Split at playhead')
      expect(splitButton?.props).toMatchObject({ type: 'button', disabled: false })
      await act(async () => splitButton!.props.onClick())
      expect(applyOperations).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ type: 'split-item', itemId: project.items[0]!.id })]),
        expect.any(String)
      )

      const runningJob = makeJob('running')
      const outputState: EditorState = {
        ...base,
        activeWorkspace: 'output',
        jobs: [runningJob],
        renderTickets: [{
          jobId: runningJob.id,
          projectId: project.id,
          pinnedRevision: project.currentRevision,
          renderKind: 'preview',
          createdAt: runningJob.createdAt
        }]
      }
      await act(async () => {
        renderer!.update(<VideoEditorWorkbench controller={controllerFor(outputState)} />)
        await Promise.resolve()
      })
      const cancelButton = renderer!.root.findAllByType('button').find(({ props }) => props.children === 'Cancel job')
      expect(cancelButton?.props.type).toBe('button')
      expect(cancelButton?.props.disabled).toBe(false)
      await act(async () => cancelButton!.props.onClick())
      expect(cancelJob).toHaveBeenCalledWith(runningJob.id)

      const css = webviewStyles()
      expect(css).toMatch(/button:focus-visible[\s\S]{0,360}outline: 3px solid var\(--focus\)/u)
      expect(css).toContain('[tabindex]:focus-visible')
      expect(css).toContain('.timeline-trim-handle:focus-visible { opacity: 0.72; }')
    } finally {
      await act(async () => renderer?.unmount())
      vi.unstubAllGlobals()
    }
  })

  it('disables both media import entry points when ffprobe is explicitly unavailable', () => {
    const project = makeViewProject()
    const state: EditorState = {
      ...editorReducer(
        editorReducer(INITIAL_EDITOR_STATE, { type: 'initialized' }),
        { type: 'project', value: project }
      ),
      mediaCapabilities: {
        probedAt: '2026-01-01T00:00:00.000Z',
        ffmpeg: { name: 'ffmpeg', available: true, features: ['libx264-encoder', 'aac-encoder'] },
        ffprobe: { name: 'ffprobe', available: false, features: [] }
      }
    }

    expect(canImportMedia(state)).toBe(false)
    const html = renderToStaticMarkup(<VideoEditorWorkbench controller={stubController(state)} />)
    expect(html.match(/<button[^>]*disabled=""[^>]*>Import media<\/button>/gu)).toHaveLength(2)
  })

  it('renders every editing region with accessible landmarks and supported boundaries', () => {
    const project = makeViewProject()
    const job = {
      ...makeJob('completed'),
      result: {
        schemaVersion: 1 as const,
        generatedArtifacts: [makeArtifact('job_12345678'), makeSubtitleArtifact('job_12345678')]
      }
    }
    const state = editorReducer(
      editorReducer(INITIAL_EDITOR_STATE, { type: 'initialized' }),
      { type: 'project', value: project }
    )
    const html = renderToStaticMarkup(<VideoEditorWorkbench controller={stubController({
      ...state,
      jobs: [job],
      renderTickets: [{
        jobId: job.id,
        projectId: project.id,
        pinnedRevision: project.currentRevision,
        renderKind: 'proof-frame',
        createdAt: job.createdAt
      }]
    })} />)
    for (const label of ['Media library', 'Player', 'Transcript', 'Timeline', 'Inspector', 'Captions', 'Revisions', 'Preview and proof', 'Agent sync', 'Export jobs']) {
      expect(html).toContain(label)
    }
    expect(html).toContain('href="#video-editor-main"')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('aria-label="Ordered timeline tracks"')
    for (const manualControl of ['Split at playhead', 'Apply trim', 'Move to track', 'Reorder', 'Add caption', 'Canvas and fit']) {
      expect(html).toContain(manualControl)
    }
    expect(html).toContain('does not perform arbitrary visual-scene understanding')
    expect(html).toContain('Technically validated by FFmpeg/ffprobe; not visually reviewed.')
    expect(html).toContain('Preview')
    expect(html).toContain('Open with system app')
    expect(html).toContain('Show in folder')
    expect(html).toContain('local path stays hidden from the extension View')
    expect(html).toContain('Edit with the main Kun Agent')
    expect(html).toContain('video-project · active')
    expect(html).not.toContain('Creative brief and review checkpoint')
  })

  it('renders local derived-media controls, progress, storage, and recovery state inside Clips', () => {
    const project = makeViewProject()
    const base = editorReducer(
      editorReducer(INITIAL_EDITOR_STATE, { type: 'initialized' }),
      { type: 'project', value: project }
    )
    const state: EditorState = {
      ...base,
      mediaCapabilities: {
        probedAt: '2026-01-01T00:00:00.000Z',
        ffmpeg: { name: 'ffmpeg', available: true, features: [] },
        ffprobe: { name: 'ffprobe', available: true, features: [] }
      },
      derivedUsage: {
        quotaBytes: 2_000,
        usedBytes: 400,
        readyBytes: 0,
        recordCount: 1,
        pinnedCount: 0,
        evictableCount: 0
      },
      derivedRecoveryDiagnostics: ['Recovered bounded metadata'],
      derivedRecords: [{
        schemaVersion: 1,
        id: 'derived-waveform',
        generation: 4,
        statusGeneration: 3,
        kind: 'waveform',
        projectId: project.id,
        assetId: project.assets[0]!.id,
        status: 'running',
        priority: 'interactive',
        bytes: 400,
        pinned: false,
        attempt: 1,
        progress: { completed: 2, total: 4, unit: 'phase', message: 'Deriving waveform' },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:01.000Z'
      }]
    }
    const html = renderToStaticMarkup(<VideoEditorWorkbench controller={stubController(state)} />)
    for (const label of [
      'Derived media', 'Waveform', 'Thumbnail', 'Filmstrip', 'Proxy',
      'Running', 'Cancel', 'Clean failed', 'Clear unpinned cache'
    ]) expect(html).toContain(label)
    expect(html).toContain('<progress')
    expect(html).toContain('400 B of 2.0 KB used')
    expect(html).toContain('Some derived metadata was unreadable')
    expect(html).toContain('no local path is exposed')
  })

  it('keeps partial filmstrip progress visible during export without blocking timeline edits', async () => {
    const project = makeViewProject()
    const selectedItem = project.items[0]!
    const exportJob = { ...makeJob('running'), id: 'job_export_with_partial_filmstrip' }
    const reduced = editorReducer(
      editorReducer(INITIAL_EDITOR_STATE, { type: 'initialized' }),
      { type: 'project', value: project }
    )
    const state: EditorState = {
      ...reduced,
      activeWorkspace: 'clips',
      selectedItemId: selectedItem.id,
      jobs: [exportJob],
      renderTickets: [{
        jobId: exportJob.id,
        projectId: project.id,
        pinnedRevision: project.currentRevision,
        renderKind: 'h264-mp4',
        createdAt: exportJob.createdAt
      }],
      derivedRecords: [{
        schemaVersion: 1,
        id: 'derived-filmstrip-partial-during-export',
        generation: 2,
        statusGeneration: 2,
        kind: 'filmstrip',
        projectId: project.id,
        assetId: selectedItem.assetId,
        status: 'partial',
        priority: 'background',
        bytes: 1_024,
        pinned: false,
        attempt: 1,
        progress: { completed: 2, total: 8, unit: 'frame', message: 'Partial filmstrip ready' },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:01:00.000Z'
      }]
    }
    const applyOperations = vi.fn(async () => undefined)
    const mediaQuery = {
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }
    vi.stubGlobal('document', {
      documentElement: {
        dataset: {}, dir: 'ltr', lang: '',
        style: { setProperty: vi.fn(), removeProperty: vi.fn() }
      },
      title: ''
    })
    vi.stubGlobal('window', {
      innerWidth: 280,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      confirm: vi.fn(() => false),
      matchMedia: vi.fn(() => mediaQuery)
    })

    function ProgressiveVisualsScenario(): React.JSX.Element {
      const [activeWorkspace, setActiveWorkspace] = useState(state.activeWorkspace)
      return <VideoEditorWorkbench controller={{
        ...stubController({ ...state, activeWorkspace }),
        setActiveWorkspace,
        applyOperations
      }} />
    }

    let renderer: ReactTestRenderer | undefined
    try {
      await act(async () => {
        renderer = create(<ProgressiveVisualsScenario />)
        await Promise.resolve()
      })

      const clipsPane = renderer!.root.find((node) => node.props.id === 'video-editor-pane-clips')
      expect(clipsPane.props.hidden).not.toBe(true)
      const partialFilmstrip = clipsPane.find((node) => node.props['data-status'] === 'partial')
      expect(textContent(partialFilmstrip)).toContain('Filmstrip')
      expect(textContent(partialFilmstrip)).toContain('Partial')
      expect(partialFilmstrip.findByType('progress').props).toMatchObject({ max: 8, value: 2 })

      await act(async () => {
        renderer!.root.find((node) => node.props.role === 'tab' && node.props['data-section'] === 'output').props.onClick()
      })
      const outputPane = renderer!.root.find((node) => node.props.id === 'video-editor-pane-output')
      expect(outputPane.props.hidden).not.toBe(true)
      expect(outputPane.find((node) => node.props.className === 'job job-running')).toBeDefined()
      expect(textContent(outputPane)).toContain('Encoding')

      await act(async () => {
        renderer!.root.find((node) => node.props.role === 'tab' && node.props['data-section'] === 'timeline').props.onClick()
      })
      const timelinePane = renderer!.root.find((node) => node.props.id === 'video-editor-pane-timeline')
      expect(timelinePane.props.hidden).not.toBe(true)
      const reorder = timelinePane.findAllByType('button').find(({ props }) => props.children === 'Reorder')
      expect(reorder?.props.disabled).toBe(false)
      await act(async () => reorder!.props.onClick())
      expect(applyOperations).toHaveBeenCalledWith(
        [{ type: 'reorder-item', itemId: selectedItem.id }],
        expect.any(String)
      )
      expect(renderer!.root.find((node) => node.props.className === 'job job-running')).toBeDefined()
    } finally {
      await act(async () => renderer?.unmount())
      vi.unstubAllGlobals()
    }
  })

})
