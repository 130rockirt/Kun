import { renderInspector } from './studio-inspector.js'
import { renderControls } from './studio-visual.js'
import {
  ExtensionHostClient,
  type HostMessage,
  type HostTransport,
  type JsonObject,
  type JsonValue,
  type Theme
} from '@kun/extension-api'
import {
  MAX_PRESENTATION_OPERATIONS,
  applyPresentationOperations,
  createImageElement,
  createPresentationSlide,
  createShapeElement,
  createTextElement,
  type PresentationElement,
  type PresentationFontFamily,
  type PresentationImageElement,
  type PresentationOperation,
  type PresentationProject,
  type PresentationShapeElement,
  type PresentationSlide,
  type PresentationTextElement
} from '../shared/presentation.js'
import {
  decidePresentationChange,
  latestPresentationPath,
  presentationPathsFromWorkspaceEntries
} from '../shared/presentation-sync.js'
import {
  applyEditableElementCss,
  editableCssPropertiesForElement,
  serializeEditableElementCss
} from '../shared/presentation-css.js'

declare global {
  interface Window {
    readonly kunExtension: HostTransport
  }
}

export type SaveTone = 'idle' | 'saving' | 'saved' | 'error'
export type StudioPanel = 'slides' | 'canvas' | 'properties'
export type CommandResponse = { path: string; project: PresentationProject }
export type SaveResponse = CommandResponse & {
  resultingRevision: number
  currentRevision: number
  changedIds: string[]
  warnings: Array<{ code: string; path: string; message: string }>
  idempotentReplay: boolean
}
export type ExportResponse = {
  sourcePath: string
  destinationPath: string
  revision: number
  bytes: number
}
export type PresentationChangedPayload = {
  path: string
  revision: number
  source: 'command' | 'tool'
  changedIds: string[]
}
export type HistoryEntry = {
  forward: PresentationOperation[]
  inverse: PresentationOperation[]
  label: string
}
export type PointerSession = {
  pointerId: number
  slideId: string
  elementId: string
  mode: 'move' | 'resize'
  handle?: 'nw' | 'ne' | 'se' | 'sw'
  startClientX: number
  startClientY: number
  original: PresentationElement
  preview: PresentationElement
}
export type ImageCacheEntry =
  | { state: 'loading' }
  | { state: 'ready'; url: string }
  | { state: 'error'; message: string }
export type PersistedViewState = {
  path?: string
  selectedSlideId?: string
  activePanel?: StudioPanel
}

export const SVG_NS = 'http://www.w3.org/2000/svg'
export const SAVE_DEBOUNCE_MS = 450
export const INLINE_EDIT_DOUBLE_CLICK_MS = 500
export const MAX_INLINE_TEXT_LENGTH = 12_000
export const MAX_IMAGE_BASE64_CHARS = 8 * 1024 * 1024
export const MAX_IMPORTED_IMAGE_BYTES = Math.floor(MAX_IMAGE_BASE64_CHARS / 4) * 3
export const client = new ExtensionHostClient(window.kunExtension)

export function required<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector)
  if (!node) throw new Error(`Kun PPT is missing ${selector}`)
  return node
}

export const ui = {
  studio: required<HTMLElement>('#studio'),
  path: required<HTMLInputElement>('#deck-path'),
  newDeck: required<HTMLButtonElement>('#new-deck'),
  deckMenu: required<HTMLDetailsElement>('#deck-menu'),
  loadDeck: required<HTMLButtonElement>('#load-deck'),
  openExport: required<HTMLButtonElement>('#open-copy'),
  saveState: required<HTMLElement>('#save-state'),
  conflictBanner: required<HTMLElement>('#conflict-banner'),
  conflictDetail: required<HTMLElement>('#conflict-detail'),
  reloadConflict: required<HTMLButtonElement>('#reload-conflict'),
  panelTabs: [...document.querySelectorAll<HTMLButtonElement>('[data-studio-tab]')],
  slidesPanel: required<HTMLElement>('#slides-panel'),
  canvasPanel: required<HTMLElement>('#canvas-panel'),
  propertiesPanel: required<HTMLElement>('#properties-panel'),
  deckTitle: required<HTMLElement>('#deck-title'),
  slideList: required<HTMLOListElement>('#slide-list'),
  addSlide: required<HTMLButtonElement>('#add-slide'),
  duplicateSlide: required<HTMLButtonElement>('#duplicate-slide'),
  deleteSlide: required<HTMLButtonElement>('#delete-slide'),
  undo: required<HTMLButtonElement>('#undo'),
  redo: required<HTMLButtonElement>('#redo'),
  addText: required<HTMLButtonElement>('#add-text'),
  addShape: required<HTMLButtonElement>('#add-shape'),
  openImage: required<HTMLButtonElement>('#open-image'),
  imageFilePicker: required<HTMLInputElement>('#image-file-picker'),
  selectionActions: required<HTMLElement>('#selection-actions'),
  editSelectedText: required<HTMLButtonElement>('#edit-selected-text'),
  deleteSelectedElement: required<HTMLButtonElement>('#delete-selected-element'),
  openPreview: required<HTMLButtonElement>('#open-preview'),
  canvasEmpty: required<HTMLElement>('#canvas-empty'),
  canvas: required<SVGSVGElement>('#slide-canvas'),
  canvasBackground: required<SVGRectElement>('#slide-canvas > .canvas-background'),
  canvasElements: required<SVGGElement>('#canvas-elements'),
  canvasSelection: required<SVGGElement>('#canvas-selection'),
  canvasCaption: required<HTMLElement>('#canvas-caption'),
  selectionCaption: required<HTMLElement>('#selection-caption'),
  inspectorTitle: required<HTMLElement>('#inspector-title'),
  inspectorBody: required<HTMLElement>('#inspector-body'),
  exportDialog: required<HTMLDialogElement>('#export-dialog'),
  exportForm: required<HTMLFormElement>('#export-form'),
  exportPath: required<HTMLInputElement>('#export-path'),
  exportError: required<HTMLElement>('#export-dialog-error'),
  previewDialog: required<HTMLDialogElement>('#preview-dialog'),
  previewCanvas: required<SVGSVGElement>('#preview-canvas'),
  previewBackground: required<SVGRectElement>('#preview-canvas > .canvas-background'),
  previewElements: required<SVGGElement>('#preview-elements'),
  previewPrev: required<HTMLButtonElement>('#preview-prev'),
  previewNext: required<HTMLButtonElement>('#preview-next'),
  previewPosition: required<HTMLElement>('#preview-position')
}

export const state = {
  project: null as PresentationProject | null,
  activePath: '',
  selectedSlideId: null as string | null,
  selectedElementId: null as string | null,
  pendingOperations: [] as PresentationOperation[],
  undoStack: [] as HistoryEntry[],
  redoStack: [] as HistoryEntry[],
  saveTimer: 0,
  savePromise: null as Promise<void> | null,
  ownSaveTargetRevision: null as number | null,
  conflicted: false,
  pointerSession: null as PointerSession | null,
  recentPointerSelection: null as { elementId: string; at: number } | null,
  inlineEditingId: null as string | null,
  inlineDraft: null as string | null,
  previewIndex: 0,
  idCounter: 0,
  viewStateTimer: 0,
  activePanel: 'canvas' as StudioPanel,
  imageCache: new Map<string, ImageCacheEntry>()
}

export function svg<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag)
}

export function html<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
  return document.createElement(tag)
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function makeId(prefix: string): string {
  state.idCounter += 1
  const random = globalThis.crypto?.randomUUID?.().replaceAll('-', '').slice(0, 12)
    ?? Math.random().toString(36).slice(2, 14)
  return `${prefix}-${Date.now().toString(36)}-${state.idCounter.toString(36)}-${random}`
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function normalizePath(value: string): string {
  const path = value.trim()
  if (
    !path ||
    path.length > 240 ||
    !/^[A-Za-z0-9][A-Za-z0-9._ -]*\.kun-ppt\.html$/u.test(path)
  ) {
    throw new Error('Use a root-level filename ending in .kun-ppt.html.')
  }
  if (path.includes('/') || path.includes('\\') || path === '.' || path === '..') {
    throw new Error('Presentation files must use a root-level workspace filename.')
  }
  return path
}

export function setSaveStatus(message: string, tone: SaveTone = 'idle'): void {
  ui.saveState.textContent = message
  ui.saveState.dataset.tone = tone
}

export function setConflict(message: string): void {
  state.conflicted = true
  ui.conflictDetail.textContent = message
  ui.conflictBanner.hidden = false
  setSaveStatus('Revision conflict — reload required', 'error')
  renderControls()
  renderInspector()
}

export function clearConflict(): void {
  state.conflicted = false
  ui.conflictBanner.hidden = true
  ui.conflictDetail.textContent = 'Reload before making more edits.'
}

export function currentSlide(): PresentationSlide | null {
  if (!state.project) return null
  return state.project.slides.find((slide) => slide.id === state.selectedSlideId) ?? state.project.slides[0] ?? null
}

export function currentElement(): PresentationElement | null {
  const slide = currentSlide()
  if (!slide || !state.selectedElementId) return null
  return slide.elements.find((element) => element.id === state.selectedElementId) ?? null
}

export function executeCommand<T>(id: string, args: JsonObject): Promise<T> {
  return client.commands.executeCommand(id, args).then((value) => value as unknown as T)
}

export function scheduleViewState(): void {
  if (state.viewStateTimer) window.clearTimeout(state.viewStateTimer)
  state.viewStateTimer = window.setTimeout(() => {
    state.viewStateTimer = 0
    const viewState: PersistedViewState = {
      ...(state.activePath ? { path: state.activePath } : {}),
      ...(state.selectedSlideId ? { selectedSlideId: state.selectedSlideId } : {}),
      activePanel: state.activePanel
    }
    void client.ui.setViewState(viewState as unknown as JsonValue).catch(() => undefined)
  }, 150)
}

export function isStudioPanel(value: unknown): value is StudioPanel {
  return value === 'slides' || value === 'canvas' || value === 'properties'
}

export function setActivePanel(panel: StudioPanel, focus = false): void {
  ui.deckMenu.open = false
  state.activePanel = panel
  ui.studio.dataset.activePanel = panel
  // The slide rail stays visible beside Canvas and Properties at normal sidebar
  // widths. CSS collapses it back into the Slides tab on very narrow Views.
  ui.slidesPanel.hidden = false
  ui.canvasPanel.hidden = panel !== 'canvas'
  ui.propertiesPanel.hidden = panel !== 'properties'
  for (const tab of ui.panelTabs) {
    const selected = tab.dataset.studioTab === panel
    tab.setAttribute('aria-selected', String(selected))
    tab.tabIndex = selected ? 0 : -1
    if (selected && focus) tab.focus()
  }
  scheduleViewState()
}
