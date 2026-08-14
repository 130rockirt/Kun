import type { JobSnapshot } from '@kun/extension-api'
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
  it('renders explicit empty, interaction-required, reconnect and legacy-run states', () => {
    let state: EditorState = editorReducer(INITIAL_EDITOR_STATE, { type: 'initialized' })
    state = {
      ...state,
      connection: 'reconnecting',
      notices: [{ id: 'picker', severity: 'warning', message: 'Select a file', interactionRequired: true }]
    }
    const emptyHtml = renderToStaticMarkup(<VideoEditorWorkbench controller={stubController(state)} />)
    expect(emptyHtml).toContain('Create or open a project')
    expect(emptyHtml).toContain('A protected Kun desktop interaction is required.')

    const project = makeViewProject()
    const waitingState: EditorState = {
      ...editorReducer(state, { type: 'project', value: project }),
      jobs: [makeJob('running')],
      renderTickets: [{
        jobId: 'job_12345678',
        projectId: project.id,
        pinnedRevision: project.currentRevision,
        renderKind: 'preview',
        createdAt: '2026-01-01T00:00:00.000Z'
      }],
      agentRun: {
        id: 'run-1',
        threadId: 'thread-1',
        ownerExtensionId: 'kun-examples.kun-video-editor',
        ownerExtensionVersion: '0.1.0',
        extensionVisibility: 'private',
        extensionBudget: {},
        toolCatalogEpoch: 'epoch-1',
        state: 'waiting-approval',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:01:00.000Z'
      }
    }
    const waitingHtml = renderToStaticMarkup(<VideoEditorWorkbench controller={stubController(waitingState)} />)
    expect(waitingHtml).toContain('Existing private run')
    expect(waitingHtml).toContain('Waiting for approval')
    expect(waitingHtml).toContain('Ready for main-Agent edits')
    expect(waitingHtml).toContain('Cancel job')
  })

  it('renders the workbench in Simplified Chinese and follows the Kun theme', () => {
    const project = makeViewProject()
    project.revisions[0] = {
      ...project.revisions[0]!,
      sourceOperation: 'project.create',
      summary: 'Created project'
    }
    project.transcripts[0]!.segments[1]!.tags = ['filler']
    project.transcripts[0]!.segments[2]!.tags = ['silence']
    const initialized = editorReducer(
      editorReducer(INITIAL_EDITOR_STATE, { type: 'initialized' }),
      { type: 'project', value: project }
    )
    const job = makeJob('running')
    const state: EditorState = {
      ...initialized,
      theme: { kind: 'light', tokens: {}, zoomFactor: 1, reducedMotion: false },
      locale: { language: 'zh-CN', direction: 'ltr', messages: {} },
      jobs: [job],
      renderTickets: [{
        jobId: job.id,
        projectId: project.id,
        pinnedRevision: project.currentRevision,
        renderKind: 'preview',
        createdAt: job.createdAt
      }],
      lastProjectChange: {
        schemaVersion: 1,
        projectId: project.id,
        revision: project.currentRevision,
        reason: 'active-project-changed',
        changedIds: []
      },
      notices: [{
        id: 'initialization-failed',
        severity: 'error',
        message: 'The editor could not initialize.',
        messageKey: 'editorInitializeFailed'
      }]
    }
    const html = renderToStaticMarkup(<VideoEditorWorkbench controller={stubController(state)} />)
    const localizedTabs = openingTags(html).filter((tag) => attribute(tag, 'role') === 'tab' && attribute(tag, 'data-section') !== undefined)

    expect(html).toContain('data-theme="light"')
    expect(html).toContain('lang="zh-CN"')
    expect(localizedTabs.map((tag) => textForOpeningTag(html, tag))).toEqual(['脚本', '素材', '时间线', '属性', '输出'])
    expect(html).toContain('展开预览')
    expect(html).toContain('aria-label="项目、播放头与校样时效"')
    expect(html).toContain('校样时效')
    expect(html).toContain('暂无已完成校样')
    for (const label of ['Kun 视频剪辑', '媒体库', '播放器', '逐字稿', '时间线', '检查器', '字幕', '版本', '预览与校样', 'Agent 协作', '导出任务']) {
      expect(html).toContain(label)
    }
    expect(html).toContain('生成与超分')
    expect(html).toContain('生成能力不可用')
    expect(html).toContain('手动剪辑、逐字稿、校验和导出仍可正常使用')
    for (const persistedProjectLabel of ['视频 1', '视频 2', '音频 1', '已创建项目']) {
      expect(html).toContain(persistedProjectLabel)
    }
    for (const control of ['在播放头处拆分', '应用裁剪', '移动到轨道', '重新排序', '添加字幕', '画布与适配']) {
      expect(html).toContain(control)
    }
    for (const localizedStatus of ['video-project · 当前项目', '已切换当前项目', '填充词', '静音', '正在编码媒体…']) {
      expect(html).toContain(localizedStatus)
    }
    expect(html).not.toContain('Transcript-first workbench')
    expect(html).not.toContain('Select a project')
    expect(html).not.toContain('video-project · active')
    expect(html).not.toContain('active-project-changed')
    expect(html).not.toContain('Encoding')
    expect(html).not.toContain('>filler<')
    expect(html).not.toContain('>Video 1<')
    expect(html).not.toContain('>Audio 1<')
    expect(html).not.toContain('>Created project<')
    expect(html).toContain('视频编辑器初始化失败。')
    expect(html).not.toContain('The editor could not initialize.')
  })

  it('propagates presentation state to the document root and keeps light colors theme-driven', () => {
    const setProperty = vi.fn()
    const removeProperty = vi.fn()
    const documentRoot = {
      dataset: {},
      dir: '',
      lang: '',
      style: { setProperty, removeProperty }
    } as unknown as Pick<HTMLElement, 'dataset' | 'dir' | 'lang' | 'style'>
    const theme = {
      kind: 'light' as const,
      tokens: {
        background: '#fafbff',
        surface: '#ffffff',
        foreground: '#233659',
        accent: '#3b82d8'
      },
      zoomFactor: 1.25,
      reducedMotion: true
    }
    syncDocumentPresentation(
      documentRoot,
      theme,
      { language: 'zh-CN', direction: 'ltr', messages: {} }
    )

    expect(documentRoot.dataset.theme).toBe('light')
    expect(documentRoot.dataset.reducedMotion).toBe('true')
    expect(documentRoot.dataset.zoomFactor).toBe('1.25')
    expect(documentRoot.lang).toBe('zh-CN')
    expect(documentRoot.dir).toBe('ltr')
    expect(setProperty).toHaveBeenCalledWith('--bg', '#fafbff')
    expect(setProperty).toHaveBeenCalledWith('--surface', '#ffffff')
    expect(setProperty).toHaveBeenCalledWith('--text', '#233659')
    expect(setProperty).toHaveBeenCalledWith('--accent', '#3b82d8')
    expect(setProperty).toHaveBeenCalledWith('font-size', '20px')
    expect(setProperty).toHaveBeenCalledWith('color-scheme', 'light')
    expect(themeStyle(theme)).toMatchObject({
      '--bg': '#fafbff',
      '--surface': '#ffffff',
      '--text': '#233659',
      '--accent': '#3b82d8',
      colorScheme: 'light'
    })

    const css = webviewStyles()
    expect(css).toMatch(/:root\[data-theme="light"\],\s*\.editor-app\[data-theme="light"\]/u)
    expect(css).toMatch(/\.editor-app\s*\{[^}]*color: var\(--text\);[^}]*var\(--app-glow\)/su)
    expect(css).toContain('body { min-height: 100vh; overflow-x: hidden; background: var(--bg); color: var(--text); }')
    expect(css).not.toContain('#222b3c 0')
    expect(css).not.toContain('background: #0b0f16')
  })

  it('opens timeline media only once while the first lease request is still pending', async () => {
    const project = makeViewProject()
    const state = editorReducer(
      editorReducer(INITIAL_EDITOR_STATE, { type: 'initialized' }),
      { type: 'project', value: project }
    )
    const openAsset = vi.fn(() => new Promise<void>(() => undefined))
    const documentElement = {
      dataset: {},
      dir: '',
      lang: '',
      style: { setProperty: vi.fn(), removeProperty: vi.fn() }
    }
    vi.stubGlobal('document', { documentElement, title: '' })
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      confirm: vi.fn(() => false)
    })
    let renderer: ReactTestRenderer | undefined
    try {
      await act(async () => {
        renderer = create(<VideoEditorWorkbench controller={{ ...stubController(state), openAsset }} />)
        await Promise.resolve()
      })
      expect(openAsset).toHaveBeenCalledTimes(1)
      expect(openAsset).toHaveBeenCalledWith(project.assets[0]!.id)

      await act(async () => {
        renderer?.update(
          <VideoEditorWorkbench controller={{
            ...stubController({ ...state, busy: true }),
            openAsset
          }} />
        )
        await Promise.resolve()
      })
      expect(openAsset).toHaveBeenCalledTimes(1)
    } finally {
      await act(async () => renderer?.unmount())
      vi.unstubAllGlobals()
    }
  })

  it('refuses inaccurate direct-source playback when the compiler requires a composed preview', async () => {
    const project = makeViewProject()
    project.playback = {
      mode: 'composed-proof',
      projectId: project.id,
      sequenceId: 'sequence-main',
      revision: project.currentRevision,
      irDigest: 'a'.repeat(64),
      reasons: ['visual-layer-count']
    }
    const state = editorReducer(
      editorReducer(INITIAL_EDITOR_STATE, { type: 'initialized' }),
      { type: 'project', value: project }
    )
    const controller = stubController(state)
    const openAsset = vi.fn(async () => undefined)
    const documentElement = {
      dataset: {},
      dir: '',
      lang: '',
      style: { setProperty: vi.fn(), removeProperty: vi.fn() }
    }
    vi.stubGlobal('document', { documentElement, title: '' })
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      confirm: vi.fn(() => false)
    })
    let renderer: ReactTestRenderer | undefined
    try {
      await act(async () => {
        renderer = create(<VideoEditorWorkbench controller={{ ...controller, openAsset }} />)
        await Promise.resolve()
      })
      expect(openAsset).not.toHaveBeenCalled()
      expect(JSON.stringify(renderer?.toJSON())).toContain('revision-bound composed preview')
      const renderButton = renderer?.root.findAllByType('button').find(({ props }) =>
        props.children === 'Render composed preview'
      )
      expect(renderButton).toBeDefined()
      await act(async () => renderButton?.props.onClick())
      expect(controller.startRender).toHaveBeenCalledWith('preview', 'none')
    } finally {
      await act(async () => renderer?.unmount())
      vi.unstubAllGlobals()
    }
  })
})
