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
  textForOpeningTag
} from './webview-component-support.js'

describe('video editor docked workbench', () => {
  it('renders structured affected-node guidance from a Host render refusal', () => {
    const project = makeViewProject()
    const state: EditorState = {
      ...editorReducer(
        editorReducer(INITIAL_EDITOR_STATE, { type: 'initialized' }),
        { type: 'project', value: project }
      ),
      notices: [{
        id: 'render-capability-unavailable',
        severity: 'warning',
        message: 'Render unavailable',
        messageKey: 'mediaCapabilitiesUnavailable',
        capabilityDetails: [{
          nodeId: 'item-interview:effect-blur',
          nodeType: 'effect',
          capability: 'filter:boxblur',
          guidance: 'Install an FFmpeg build with boxblur or disable this effect.'
        }]
      }]
    }
    const html = renderToStaticMarkup(<VideoEditorWorkbench controller={stubController(state)} />)

    expect(html).toContain('1 affected render node(s)')
    expect(html).toContain('item-interview:effect-blur')
    expect(html).toContain('filter:boxblur')
    expect(html).toContain('Install an FFmpeg build with boxblur or disable this effect.')
  })

  it('renders one bounded sidebar workspace instead of stacking every editor surface', () => {
    const project = makeViewProject()
    const state = editorReducer(
      editorReducer(INITIAL_EDITOR_STATE, { type: 'initialized' }),
      { type: 'project', value: project }
    )
    const html = renderToStaticMarkup(<VideoEditorWorkbench controller={stubController(state)} />)
    const tags = openingTags(html)
    const workbench = tags.find((tag) => attribute(tag, 'data-layout') === 'responsive-sidebar')
    const tabs = tags.filter((tag) => attribute(tag, 'role') === 'tab' && attribute(tag, 'data-section') !== undefined)
    const panes = tags.filter((tag) => attribute(tag, 'role') === 'tabpanel')
    const sections = ['script', 'clips', 'timeline', 'properties', 'output'] as const
    const expectedLabels = ['Script', 'Clips', 'Timeline', 'Properties', 'Output']

    expect(workbench).toBeDefined()
    expect(attribute(workbench!, 'data-workspace')).toBe('script')
    expect(tags.some((tag) => attribute(tag, 'role') === 'tablist')).toBe(true)
    expect(tabs).toHaveLength(sections.length)
    expect(panes).toHaveLength(sections.length)
    expect(tabs.filter((tag) => attribute(tag, 'aria-selected') === 'true')).toHaveLength(1)
    expect(panes.filter((tag) => attribute(tag, 'data-sidebar-active') === 'true')).toHaveLength(1)
    expect(panes.filter((tag) => !hasAttribute(tag, 'hidden'))).toHaveLength(1)
    expect(tags.some((tag) => hasClass(tag, 'preview-drawer'))).toBe(true)
    expect(tags.find((tag) => hasClass(tag, 'preview-drawer')) && attribute(tags.find((tag) => hasClass(tag, 'preview-drawer'))!, 'role')).toBeUndefined()
    expect(tags.some((tag) => hasClass(tag, 'project-health'))).toBe(true)
    expect(tags.some((tag) => hasClass(tag, 'project-action-buttons'))).toBe(true)
    expect((html.match(/class="workbench-icon"/gu) ?? []).length).toBeGreaterThanOrEqual(5)
    expect(html).toContain('class="selection-quick-summary"')
    for (const disclosure of ['Background processing', 'Local intelligence', 'Caption editing', 'Multicam', 'Proof and preview', 'Revision history', 'Generated variants', 'Professional interchange', 'Project package']) {
      expect(html).toContain(`<strong>${disclosure}</strong>`)
    }
    expect(tabs.map((tag) => textForOpeningTag(html, tag))).toEqual(expectedLabels)

    for (const section of sections) {
      const tabId = `video-editor-tab-${section}`
      const paneId = `video-editor-pane-${section}`
      const tab = tabs.find((tag) => attribute(tag, 'id') === tabId)
      const pane = panes.find((tag) => attribute(tag, 'id') === paneId)
      expect(tab, `${section} tab`).toBeDefined()
      expect(attribute(tab!, 'data-section')).toBe(section)
      expect(attribute(tab!, 'aria-controls')).toBe(paneId)
      expect(pane, `${section} panel`).toBeDefined()
      expect(attribute(pane!, 'aria-labelledby')).toBe(tabId)
      expect(hasAttribute(pane!, 'hidden')).toBe(attribute(tab!, 'aria-selected') !== 'true')
    }
  })

  it('renders the persisted Output workspace and a completed atomic project package without sensitive references', () => {
    const project = makeViewProject()
    const ticket = {
      schemaVersion: 1 as const,
      jobId: 'job_project_package_component_1',
      projectId: project.id,
      sequenceId: project.activeSequenceId,
      pinnedRevision: project.currentRevision,
      packageId: `pkg-${'a'.repeat(32)}`,
      manifestDigest: 'b'.repeat(64),
      complete: false,
      selectedAssetCount: 2,
      embeddedAssetCount: 1,
      uniqueMediaCount: 1,
      deduplicatedAssetCount: 0,
      missingAssetIds: ['asset-offline'],
      missingMediaPolicy: 'omit' as const,
      mediaScope: 'selected' as const,
      receiptsRequested: true,
      agentProvenanceRequested: true,
      createdAt: '2026-07-14T00:00:00.000Z'
    }
    const archiveJob: JobSnapshot = {
      ...makeJob('completed'),
      id: ticket.jobId,
      kind: 'media.archive',
      initiatingOperation: 'media.startArchiveJob',
      progress: { percentage: 100, phase: 'finalizing', message: 'Complete', updatedAt: '2026-07-14T00:00:01.000Z' },
      result: {
        schemaVersion: 1 as const,
        generatedArtifacts: [],
        data: {
          schemaVersion: 1,
          format: 'zip',
          entryCount: 7,
          inputBytes: 1024,
          archiveBytes: 768,
          sha256: 'c'.repeat(64),
          generatedMedia: {
            handleId: 'media_secret_archive_handle_1',
            mode: 'export',
            kind: 'data',
            displayName: '/Users/zxy/private/interview.kun-video.zip',
            mimeType: 'application/zip',
            byteSize: 768,
            completionIdentity: 'secret-completion-identity',
            workspaceRelativeDisplayLocation: 'private/output/interview.kun-video.zip',
            revoked: false
          }
        }
      }
    }
    const reduced = editorReducer(
      editorReducer(INITIAL_EDITOR_STATE, { type: 'initialized' }),
      { type: 'project', value: project }
    )
    const state: EditorState = {
      ...reduced,
      activeWorkspace: 'output',
      projectPackageTickets: [ticket],
      jobs: [archiveJob]
    }
    const html = renderToStaticMarkup(<VideoEditorWorkbench controller={stubController(state)} />)
    const outputTab = openingTags(html).find((tag) => attribute(tag, 'data-section') === 'output')

    expect(attribute(outputTab!, 'aria-selected')).toBe('true')
    expect(html).toContain('Self-contained project package')
    expect(html).toContain('Generate and upscale')
    expect(html).toContain('Generation unavailable')
    expect(html).toContain('Manual editing, transcript workflows, proof, and export remain available')
    expect(html).toContain('Explicitly incomplete media snapshot')
    expect(html).toContain('Missing media IDs: asset-offline')
    expect(html).toContain('interview.kun-video.zip')
    expect(html).toContain('SHA-256')
    expect(html).not.toContain('media_secret_archive_handle_1')
    expect(html).not.toContain('secret-completion-identity')
    expect(html).not.toContain('private/output')
    expect(html).not.toContain('/Users/')
    expect(html).not.toContain('chatText')
  })

  it('renders localized OTIO export and explicit two-step import without exposing the picker grant', () => {
    const project = makeViewProject()
    const manifest = {
      adapterId: 'kun.otio-json' as const,
      adapterVersion: '1.0.0' as const,
      portableLossless: false,
      kunRoundTripLossless: true,
      entries: [{
        code: 'effects-custom-metadata', severity: 'warning' as const, feature: 'effects',
        nodeId: 'item-interview', preservation: 'kun-metadata' as const,
        message: 'Effect parameters use Kun metadata.'
      }],
      truncated: 2
    }
    const ticket = {
      schemaVersion: 1 as const,
      jobId: 'job_otio_component_123456',
      projectId: project.id,
      sequenceId: project.activeSequenceId,
      pinnedRevision: project.currentRevision,
      adapterId: 'kun.otio-json' as const,
      adapterVersion: '1.0.0' as const,
      documentDigest: 'a'.repeat(64),
      projectDigest: 'b'.repeat(64),
      documentBytes: 4096,
      lossManifest: manifest,
      createdAt: '2026-07-14T00:00:00.000Z'
    }
    const state: EditorState = {
      ...editorReducer(
        editorReducer(INITIAL_EDITOR_STATE, { type: 'initialized' }),
        { type: 'project', value: project }
      ),
      locale: { language: 'zh-CN', direction: 'ltr', messages: {} },
      activeWorkspace: 'output',
      otioExportTickets: [ticket],
      otioImportPreview: {
        inputHandleId: 'opaque_secret_otio_handle_1',
        displayName: 'external-cut.otio',
        sourceDocumentDigest: 'c'.repeat(64),
        sourceProjectId: 'external-cut',
        sourceProjectRevision: 4,
        suggestedProjectId: 'external-cut-import',
        fidelity: 'portable-otio',
        project: {
          id: 'external-cut', name: 'External cut', revision: 4, activeSequenceId: 'sequence-main',
          counts: { assets: 1, sequences: 1, tracks: 3, items: 2, captions: 0, transcripts: 0 }
        },
        mediaRelinkRequired: ['external-asset'],
        timecodeMappings: [{
          id: 'external-item', sequenceId: 'sequence-main', startFrame: 0, endFrame: 30,
          startTimecode: '00:00:00:00', endTimecode: '00:00:01:00',
          frameRate: { numerator: 30, denominator: 1 }
        }],
        timecodeMappingsTruncated: 0,
        lossManifest: manifest
      },
      jobs: [{ ...makeJob('running'), id: ticket.jobId }]
    }
    const html = renderToStaticMarkup(<VideoEditorWorkbench controller={stubController(state)} />)

    expect(html).toContain('OpenTimelineIO 交换')
    expect(html).toContain('选择 .otio 目标并导出')
    expect(html).toContain('导入预览')
    expect(html).toContain('标准 OTIO 子集')
    expect(html).toContain('创建新项目')
    expect(html).toContain('受限报告还省略了 2 条损失记录')
    expect(html).toContain('00:00:00:00–00:00:01:00')
    expect(html).not.toContain('opaque_secret_otio_handle_1')
    expect(html).not.toContain('/Users/')
  })

  it('maps the project-package controls to selected-media and omit policy options', async () => {
    const project = makeViewProject()
    const reduced = editorReducer(
      editorReducer(INITIAL_EDITOR_STATE, { type: 'initialized' }),
      { type: 'project', value: project }
    )
    const state: EditorState = { ...reduced, activeWorkspace: 'output' }
    const startProjectPackage = vi.fn(async () => undefined)
    const controller = { ...stubController(state), startProjectPackage }
    const mediaQuery = { matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }
    vi.stubGlobal('document', {
      documentElement: {
        dataset: {}, dir: 'ltr', lang: '',
        style: { setProperty: vi.fn(), removeProperty: vi.fn() }
      },
      title: ''
    })
    vi.stubGlobal('window', {
      addEventListener: vi.fn(), removeEventListener: vi.fn(), confirm: vi.fn(() => false),
      matchMedia: vi.fn(() => mediaQuery)
    })
    let renderer: ReactTestRenderer | undefined
    try {
      await act(async () => {
        renderer = create(<VideoEditorWorkbench controller={controller} />)
        await Promise.resolve()
      })
      const submit = renderer!.root.findAllByType('form').find(({ props }) =>
        String(props.className).includes('project-package-form')
      )
      const selects = submit!.findAllByType('select')
      const mediaScope = selects.find(({ props }) => props.value === 'all')
      const missingPolicy = selects.find(({ props }) => props.value === 'fail')
      const provenance = submit!.findAllByType('input').find(({ props }) =>
        props.type === 'checkbox' && props.checked === false
      )
      expect(mediaScope).toBeDefined()
      expect(missingPolicy).toBeDefined()
      expect(provenance).toBeDefined()
      await act(async () => {
        mediaScope!.props.onChange({ target: { value: 'selected' } })
        missingPolicy!.props.onChange({ target: { value: 'omit' } })
        provenance!.props.onChange({ target: { checked: true } })
        await Promise.resolve()
      })
      await act(async () => submit!.props.onSubmit({ preventDefault: vi.fn() }))
      expect(startProjectPackage).toHaveBeenCalledWith({
        missingMediaPolicy: 'omit',
        includeReceipts: true,
        includeAgentProvenance: true,
        mediaScope: 'selected',
        assetIds: [project.assets[0]!.id]
      })
    } finally {
      await act(async () => renderer?.unmount())
      vi.unstubAllGlobals()
    }
  })

  it('keeps the narrow Chinese transcript heading and readiness status separate from edit actions', () => {
    const project = makeViewProject()
    const reduced = editorReducer(
      editorReducer(INITIAL_EDITOR_STATE, { type: 'initialized' }),
      { type: 'project', value: project }
    )
    const state: EditorState = {
      ...reduced,
      locale: { language: 'zh-CN', direction: 'ltr', messages: {} },
      activeWorkspace: 'script'
    }
    const html = renderToStaticMarkup(<VideoEditorWorkbench controller={stubController(state)} />)

    expect(html).toMatch(/<header class="panel-header"><h2>智能脚本<\/h2><div class="panel-actions"><span class="local-ready-status">/u)
    expect(html).toContain('class="transcript-toolbar"')
    expect(html).toContain('本地转写就绪')
    expect(html).toContain('导入逐字稿')
  })

  it('keeps a 280px long transcript locally scrollable and its edit actions reachable', async () => {
    const project = makeViewProject()
    project.currentRevision = 1
    project.selection = { ...project.selection, revision: 1 }
    project.playback = { ...project.playback, revision: 1 }
    project.revisions.push({
      revision: 1,
      parentRevision: 0,
      author: 'manual',
      sourceOperation: 'test.transcript-edit',
      timestamp: '2026-01-01T00:01:00.000Z',
      summary: 'Edited transcript'
    })
    project.transcripts[0] = {
      ...project.transcripts[0]!,
      segmentCount: 181,
      segments: Array.from({ length: 181 }, (_, index) => ({
        id: `segment-${index + 1}`,
        startUs: index * 1_000_000,
        endUs: (index + 1) * 1_000_000,
        text: index === 0
          ? `A-long-editable-transcript-token-${'x'.repeat(160)}`
          : `Transcript segment ${index + 1}`,
        ...(index === 0 ? { tags: ['filler'] as const } : {})
      }))
    }
    const reduced = editorReducer(
      editorReducer(INITIAL_EDITOR_STATE, { type: 'initialized' }),
      { type: 'project', value: project }
    )
    const proofJob: JobSnapshot = {
      ...makeJob('completed'),
      result: {
        schemaVersion: 1,
        generatedArtifacts: [makeArtifact('job_12345678')]
      }
    }
    const state: EditorState = {
      ...reduced,
      activeWorkspace: 'script',
      playheadFrame: 42,
      jobs: [proofJob],
      renderTickets: [{
        jobId: proofJob.id,
        projectId: project.id,
        pinnedRevision: 0,
        renderKind: 'proof-frame',
        createdAt: proofJob.createdAt
      }]
    }
    const seek = vi.fn()
    const applyScript = vi.fn(async () => undefined)
    const setTranscriptWindow = vi.fn()
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
          ...stubController(state), seek, applyScript, setTranscriptWindow
        }} />)
        await Promise.resolve()
      })
      const preview = renderer!.root.find((node) => node.type === 'details' && node.props.className === 'preview-drawer')
      expect(preview.props.open).toBe(false)
      const status = renderer!.root.find((node) => node.props.role === 'status' && node.props.className === 'project-status-strip')
      expect(status.props['aria-label']).toBe('Project, playhead, and proof freshness')
      expect(status.props['data-proof-state']).toBe('stale')
      expect(textContent(status.find((node) => node.props['data-status-kind'] === 'project'))).toContain('Demo Project · r1')
      expect(textContent(status.find((node) => node.props['data-status-kind'] === 'playhead'))).toContain('42f · 00:01')
      expect(textContent(status.find((node) => node.props['data-status-kind'] === 'proof'))).toContain('Stale · r0')

      await act(async () => preview.props.onToggle({ currentTarget: { open: true } }))
      expect(renderer!.root.find((node) => node.type === 'details' && node.props.className === 'preview-drawer').props.open).toBe(true)
      await act(async () => renderer!.root.find((node) => node.type === 'details' && node.props.className === 'preview-drawer')
        .props.onToggle({ currentTarget: { open: false } }))
      expect(renderer!.root.find((node) => node.type === 'details' && node.props.className === 'preview-drawer').props.open).toBe(false)
      expect(textContent(renderer!.root.find((node) => node.props['data-status-kind'] === 'proof'))).toContain('Stale · r0')

      const list = renderer!.root.find((node) => node.props['data-scroll-region'] === 'transcript')
      expect(list.props['data-total']).toBe(181)
      expect(list.props.tabIndex).toBe(0)
      expect(list.findAllByType('li')).toHaveLength(VIEW_LIMITS.virtualWindow)

      const segmentButton = list.findAllByType('button').find(({ props }) =>
        String(props.className).includes('transcript-segment')
      )
      const cutButton = list.findAllByType('button').find(({ props }) =>
        String(props.className).includes('transcript-cut')
      )
      await act(async () => segmentButton!.props.onClick())
      expect(seek).toHaveBeenCalledWith(0)
      await act(async () => cutButton!.props.onClick())
      expect(applyScript).toHaveBeenCalledWith([{
        assetId: project.transcripts[0]!.assetId,
        startUs: 0,
        endUs: 1_000_000,
        reason: 'filler'
      }])

      const next = renderer!.root.findAllByType('button').find(({ props }) => props.children === 'Next')
      expect(next).toBeDefined()
      await act(async () => next!.props.onClick())
      expect(setTranscriptWindow).toHaveBeenCalledWith(VIEW_LIMITS.virtualWindow)
    } finally {
      await act(async () => renderer?.unmount())
      vi.unstubAllGlobals()
    }
  })

  it('renders the sequence, rich-media, animation, effects, and preview-history P0 workbench without raw paths', () => {
    const project = makeViewProject()
    const nestedSequenceId = 'sequence-broll'
    project.sequences.push({
      id: nestedSequenceId,
      name: 'B-roll selects',
      durationFrames: 90,
      itemCount: 2,
      captionCount: 0,
      nestedByCount: 1,
      viewState: { zoom: 1, scrollFrame: 0, open: false }
    })
    project.mediaFolders.push({ id: 'folder-generated', name: 'Generated takes' })
    project.assets.push({
      id: 'asset-generated-still',
      name: 'Generated skyline.png',
      kind: 'image',
      mediaHandleId: 'media_generated_still',
      durationUs: 2_000_000,
      container: 'png',
      still: { width: 1920, height: 1080, format: 'png', animated: false },
      folderId: 'folder-generated',
      generatedLineage: {
        providerId: 'local-fixture',
        modelId: 'fixture-image',
        jobId: 'job-generated-still',
        referenceAssetIds: [project.assets[0]!.id]
      },
      availability: 'online',
      transcriptIds: []
    })
    project.items[0] = {
      ...project.items[0]!,
      nestedSequenceId,
      crop: { left: 0.05, top: 0, right: 0.05, bottom: 0 },
      blendMode: 'screen',
      effects: [{ id: 'effect-color', type: 'color.basic', enabled: true, parameters: { brightness: 0.1 } }],
      keyframes: [{ id: 'opacity-track', property: 'opacity', interpolation: 'ease', points: [{ id: 'opacity-0', frame: 0, value: 0 }] }]
    }
    project.captions[0] = {
      ...project.captions[0]!,
      animation: { kind: 'word-highlight', durationFrames: 4 }
    }
    const reduced = editorReducer(
      editorReducer(INITIAL_EDITOR_STATE, { type: 'initialized' }),
      { type: 'project', value: project }
    )
    const state: EditorState = {
      ...reduced,
      selectedItemId: project.items[0]!.id,
      selectedAssetId: 'asset-generated-still',
      previewHistory: {
        schemaVersion: 1,
        generation: 2,
        activeEntryId: 'preview-generated',
        entries: [{
          id: 'preview-source', projectId: project.id, createdAt: '2026-01-01T00:00:00.000Z',
          label: 'Source interview', source: { kind: 'asset', assetId: project.assets[0]!.id, startUs: 0, endUs: 1_000_000 }
        }, {
          id: 'preview-generated', projectId: project.id, createdAt: '2026-01-01T00:01:00.000Z',
          label: 'Generated skyline', source: { kind: 'generated', assetId: 'asset-generated-still', jobId: 'job-generated-still', variantIndex: 0 }
        }]
      },
      previewComparison: { leftEntryId: 'preview-source', rightEntryId: 'preview-generated', mode: 'side-by-side', sameRevision: true }
    }
    const html = renderToStaticMarkup(<VideoEditorWorkbench controller={stubController(state)} />)

    for (const label of [
      'Manage sequences', 'B-roll selects', 'Generated takes', 'Generated skyline.png',
      'Nested sequence', 'Decompose to clips', 'Basic color', 'Keyframes',
      'Text animation', 'Word highlight', 'Preview history', 'Generated skyline',
      'Replace selected clip', 'Attach selection to Agent', 'Side by side'
    ]) expect(html).toContain(label)
    expect(html).not.toContain('/Users/')
    expect(html).not.toContain('workspaceRelativePath')
    expect(html).not.toContain('file://')
  })

  it('renders a Host-backed media page that is absent from the bounded project projection', () => {
    const project = makeViewProject()
    project.mediaFolders = [{ id: 'folder-generated', name: 'Generated takes' }]
    project.assets = Array.from({ length: 100 }, (_, index) => ({
      ...project.assets[0]!,
      id: `asset-${String(index).padStart(4, '0')}`,
      name: `asset-${String(index).padStart(4, '0')}.mp4`
    }))
    project.truncated = true
    const reduced = editorReducer(
      editorReducer(INITIAL_EDITOR_STATE, { type: 'initialized' }),
      { type: 'project', value: project }
    )
    const state = editorReducer(reduced, {
      type: 'media-library',
      value: {
        projectId: project.id,
        revision: project.currentRevision,
        query: '',
        offset: 0,
        limit: VIEW_LIMITS.virtualWindow,
        total: 101,
        hiddenBefore: 0,
        hiddenAfter: 100,
        assets: [{
          ...project.assets[0]!,
          id: 'asset-0100',
          name: 'Generated page 101.mp4',
          mediaHandleId: 'media_page_0100_000000',
          folderId: 'folder-generated',
          generatedLineage: {
            providerId: 'fixture-provider', modelId: 'fixture-model', jobId: 'job-page-101',
            referenceAssetIds: ['asset-0000']
          }
        }]
      }
    })
    const html = renderToStaticMarkup(<VideoEditorWorkbench controller={stubController(state)} />)

    expect(html).toContain('Generated page 101.mp4')
    expect(html).toContain('Generated takes')
    expect(html).toContain('Generated')
    expect(html).not.toContain('/Users/')
    expect(html).not.toContain('workspaceRelativePath')
  })

  it('requests the next media window from Host instead of slicing the bounded project locally', async () => {
    const project = makeViewProject()
    const reduced = editorReducer(
      editorReducer(INITIAL_EDITOR_STATE, { type: 'initialized' }),
      { type: 'project', value: project }
    )
    const state = editorReducer(reduced, {
      type: 'media-library',
      value: {
        projectId: project.id,
        revision: project.currentRevision,
        query: '',
        offset: 0,
        limit: VIEW_LIMITS.virtualWindow,
        total: 101,
        hiddenBefore: 0,
        hiddenAfter: 100,
        assets: [project.assets[0]!]
      }
    })
    const loadMediaLibraryPage = vi.fn(async () => undefined)
    const controller = { ...stubController(state), loadMediaLibraryPage }
    const mediaQuery = {
      matches: true,
      addEventListener: vi.fn(), removeEventListener: vi.fn()
    }
    vi.stubGlobal('document', {
      documentElement: {
        dataset: {}, dir: 'ltr', lang: '',
        style: { setProperty: vi.fn(), removeProperty: vi.fn() }
      },
      title: ''
    })
    vi.stubGlobal('window', {
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      confirm: vi.fn(() => false), matchMedia: vi.fn(() => mediaQuery)
    })
    let renderer: ReactTestRenderer | undefined
    try {
      await act(async () => {
        renderer = create(<VideoEditorWorkbench controller={controller} />)
        await Promise.resolve()
      })
      expect(loadMediaLibraryPage).toHaveBeenCalledWith({ offset: 0, limit: VIEW_LIMITS.virtualWindow })
      const next = renderer!.root.findAllByType('button').find(({ props }) => props.children === 'Next')
      expect(next).toBeDefined()
      await act(async () => {
        next!.props.onClick()
        await Promise.resolve()
      })
      expect(loadMediaLibraryPage).toHaveBeenCalledWith({ offset: 80, limit: VIEW_LIMITS.virtualWindow })
    } finally {
      await act(async () => renderer?.unmount())
      vi.unstubAllGlobals()
    }
  })

})
