import { useState } from 'react'
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer'
import { act } from 'react-test-renderer'
import { expect, vi } from 'vitest'
import { VideoEditorWorkbench } from '../../src/webview/app.js'
import type { EditorController } from '../../src/webview/controller.js'
import type { EditorState } from '../../src/webview/model.js'
export { webviewStyles } from '../support/webview-styles.js'

export function stubController(state: EditorState): EditorController {
  const asynchronous = vi.fn(async () => undefined)
  const synchronous = vi.fn()
  return {
    state,
    refreshAll: asynchronous,
    retryInitialization: asynchronous,
    setActiveWorkspace: synchronous,
    createProject: asynchronous,
    openProject: asynchronous,
    importMedia: asynchronous,
    loadMediaLibraryPage: asynchronous,
    importTranscript: asynchronous,
    checkLocalTranscriber: asynchronous,
    generateCaptions: asynchronous,
    openAsset: asynchronous,
    refreshActiveLease: asynchronous,
    recoverMedia: asynchronous,
    refreshDerived: asynchronous,
    startDerived: asynchronous,
    retryDerived: asynchronous,
    cancelDerived: asynchronous,
    cleanupDerived: asynchronous,
    refreshMediaIntelligence: asynchronous,
    setVisualOptIn: asynchronous,
    requestVisualModelInstall: asynchronous,
    indexVisual: asynchronous,
    searchVisualMoments: asynchronous,
    analyzeVad: asynchronous,
    applyVadAnalysis: asynchronous,
    importSpeakerEvidence: asynchronous,
    previewSpeakerAttribution: asynchronous,
    applySpeakerAttribution: asynchronous,
    analyzeBeats: asynchronous,
    analyzeDenoiseMetadata: asynchronous,
    previewAudioSync: asynchronous,
    applyAudioSync: asynchronous,
    cancelMediaIntelligence: asynchronous,
    refreshGeneration: asynchronous,
    requestGeneration: asynchronous,
    retryGeneration: asynchronous,
    cancelGeneration: asynchronous,
    insertGeneratedVariant: asynchronous,
    createMulticam: asynchronous,
    renameMulticamLabels: asynchronous,
    confirmMulticamSync: asynchronous,
    switchMulticam: asynchronous,
    mergeMulticam: asynchronous,
    applyMulticamLayout: asynchronous,
    previewMulticam: asynchronous,
    applyOperations: asynchronous,
    createSequence: asynchronous,
    duplicateSequence: asynchronous,
    renameSequence: asynchronous,
    selectSequence: asynchronous,
    closeSequence: asynchronous,
    deleteSequence: asynchronous,
    setSequenceView: asynchronous,
    decomposeNested: asynchronous,
    createMediaFolder: asynchronous,
    updateMediaFolder: asynchronous,
    deleteMediaFolder: asynchronous,
    organizeMedia: asynchronous,
    refreshPreviewHistory: asynchronous,
    addPreview: asynchronous,
    selectPreview: asynchronous,
    openPreviewResource: vi.fn(async () => undefined),
    comparePreviews: asynchronous,
    replaceSelectedFromPreview: asynchronous,
    attachSelection: asynchronous,
    undo: asynchronous,
    redo: asynchronous,
    readScript: asynchronous,
    editScript: synchronous,
    applyScript: asynchronous,
    seek: synchronous,
    togglePlaying: synchronous,
    selectItem: synchronous,
    selectCaption: synchronous,
    setTranscriptWindow: synchronous,
    setTimelineWindow: synchronous,
    startAgent: asynchronous,
    steerAgent: asynchronous,
    cancelAgent: asynchronous,
    startRender: asynchronous,
    cancelJob: asynchronous,
    startProjectPackage: asynchronous,
    refreshProjectPackage: asynchronous,
    cancelProjectPackage: asynchronous,
    startOtioExport: asynchronous,
    refreshOtioExport: asynchronous,
    cancelOtioExport: asynchronous,
    previewOtioImport: asynchronous,
    confirmOtioImport: asynchronous,
    cancelOtioImportPreview: asynchronous,
    openArtifact: asynchronous,
    revealArtifact: asynchronous,
    dismissNotice: synchronous
  }
}

export function StatefulWorkbench({ state }: { state: EditorState }): React.JSX.Element {
  const [activeWorkspace, setActiveWorkspace] = useState(state.activeWorkspace)
  return <VideoEditorWorkbench controller={{
    ...stubController({ ...state, activeWorkspace }),
    setActiveWorkspace
  }} />
}

export function openingTags(html: string): string[] {
  return html.match(/<[a-z][^>]*>/gu) ?? []
}

export function attribute(tag: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return tag.match(new RegExp(`\\s${escaped}="([^"]*)"`, 'u'))?.[1]
}

export function hasAttribute(tag: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`\\s${escaped}(?:="[^"]*")?(?=\\s|>)`, 'u').test(tag)
}

export function hasClass(tag: string, className: string): boolean {
  return attribute(tag, 'class')?.split(/\s+/u).includes(className) ?? false
}

export function textForOpeningTag(html: string, tag: string): string {
  const start = html.indexOf(tag)
  const elementName = tag.match(/^<([a-z]+)/u)?.[1]
  if (start < 0 || !elementName) return ''
  const end = html.indexOf(`</${elementName}>`, start + tag.length)
  if (end < 0) return ''
  return textFromStaticMarkup(html.slice(start + tag.length, end)).trim()
}

export function textFromStaticMarkup(markup: string): string {
  let text = ''
  let insideTag = false
  for (const character of markup) {
    if (insideTag) {
      if (character === '>') insideTag = false
    } else if (character === '<') {
      insideTag = true
    } else {
      text += character
    }
  }
  return text
}

export function textContent(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === 'string' ? child : textContent(child)).join('')
}

export function selectedTab(renderer: ReactTestRenderer): string | undefined {
  return renderer.root.findAll((node) => node.props.role === 'tab' && node.props['data-section'])
    .find((node) => node.props['aria-selected'] === true)?.props['data-section'] as string | undefined
}

export async function pressTabKey(renderer: ReactTestRenderer, key: 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End'): Promise<void> {
  const tabNodes = renderer.root.findAll((node) => node.props.role === 'tab' && node.props['data-section'])
  const selectedIndex = tabNodes.findIndex((node) => node.props['aria-selected'] === true)
  const fakeTabs = tabNodes.map((node) => ({
    focus: vi.fn(),
    click: (): void => node.props.onClick()
  }))
  const preventDefault = vi.fn()
  const tabList = renderer.root.find((node) => node.props.role === 'tablist' && node.props.className === 'workbench-tabs')
  await act(async () => tabList.props.onKeyDown({
    key,
    target: fakeTabs[selectedIndex],
    currentTarget: {
      ownerDocument: { dir: 'ltr' },
      querySelectorAll: () => fakeTabs
    },
    preventDefault
  }))
  expect(preventDefault).toHaveBeenCalledOnce()
}
