import { type JsonObject } from '@kun/extension-api'
import {
  createShapeElement,
  createTextElement,
  type PresentationTextElement
} from '../shared/presentation.js'
import {
  INLINE_EDIT_DOUBLE_CLICK_MS,
  MAX_INLINE_TEXT_LENGTH,
  client,
  clamp,
  currentElement,
  currentSlide,
  errorMessage,
  executeCommand,
  isStudioPanel,
  makeId,
  normalizePath,
  setActivePanel,
  setSaveStatus,
  state,
  ui,
  type ExportResponse,
  type PersistedViewState
} from './studio-runtime.js'
import {
  addSlide,
  beginInlineEdit,
  beginPointer,
  commitInlineEdit,
  deleteSlide,
  deleteSelectedElement,
  duplicateSlide,
  endPointer,
  flushPending,
  focusInlineEditorAtEnd,
  insertElement,
  redo,
  undo,
  updatePointer,
  upsertElement
} from './studio-editing.js'
import {
  renderAll,
  renderControls,
  renderPreview,
  selectSlide,
  importSelectedImage
} from './studio-visual.js'
import {
  applyTheme,
  createDeck,
  handleHostMessage,
  latestWorkspaceDeckPath,
  loadDeck
} from './studio-host.js'

export function bindEvents(): void {
  for (const [index, tab] of ui.panelTabs.entries()) {
    const panel = tab.dataset.studioTab
    if (!isStudioPanel(panel)) continue
    tab.addEventListener('click', () => setActivePanel(panel))
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const lastIndex = ui.panelTabs.length - 1
      const nextIndex = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? lastIndex
          : (index + (event.key === 'ArrowLeft' ? -1 : 1) + ui.panelTabs.length) % ui.panelTabs.length
      const nextPanel = ui.panelTabs[nextIndex]?.dataset.studioTab
      if (isStudioPanel(nextPanel)) setActivePanel(nextPanel, true)
    })
  }
  ui.newDeck.addEventListener('click', () => {
    void createDeck(normalizePath(ui.path.value)).catch((error) => setSaveStatus(errorMessage(error), 'error'))
  })
  ui.loadDeck.addEventListener('click', () => {
    ui.deckMenu.open = false
    void loadDeck(normalizePath(ui.path.value)).catch((error) => setSaveStatus(errorMessage(error), 'error'))
  })
  ui.reloadConflict.addEventListener('click', () => {
    state.pendingOperations = []
    void loadDeck(state.activePath, state.selectedSlideId ?? undefined).catch((error) => setSaveStatus(errorMessage(error), 'error'))
  })
  ui.addSlide.addEventListener('click', addSlide)
  ui.duplicateSlide.addEventListener('click', duplicateSlide)
  ui.deleteSlide.addEventListener('click', deleteSlide)
  ui.undo.addEventListener('click', undo)
  ui.redo.addEventListener('click', redo)
  ui.addText.addEventListener('click', () => {
    if (!state.project) return
    insertElement(createTextElement(makeId('text'), { color: state.project.theme.textColor }), 'add text')
  })
  ui.addShape.addEventListener('click', () => {
    if (!state.project) return
    insertElement(createShapeElement(makeId('shape'), {
      fillColor: state.project.theme.accentColor,
      strokeColor: state.project.theme.accentColor
    }), 'add shape')
  })
  ui.openImage.addEventListener('click', () => {
    ui.imageFilePicker.value = ''
    ui.imageFilePicker.click()
  })
  ui.imageFilePicker.addEventListener('change', () => {
    const file = ui.imageFilePicker.files?.item(0)
    if (!file) return
    ui.openImage.disabled = true
    setSaveStatus(`Importing ${file.name}…`, 'saving')
    void importSelectedImage(file)
      .catch((error) => setSaveStatus(errorMessage(error), 'error'))
      .finally(() => {
        ui.imageFilePicker.value = ''
        renderControls()
      })
  })
  ui.editSelectedText.addEventListener('click', () => {
    const element = currentElement()
    if (element?.type === 'text') beginInlineEdit(element)
  })
  ui.deleteSelectedElement.addEventListener('click', deleteSelectedElement)
  ui.openExport.addEventListener('click', () => {
    ui.deckMenu.open = false
    ui.exportError.textContent = ''
    ui.exportPath.value = state.activePath.replace(/\.kun-ppt\.html$/u, '-copy.kun-ppt.html')
    ui.exportDialog.showModal()
    ui.exportPath.focus()
  })
  ui.exportForm.addEventListener('submit', (event) => {
    event.preventDefault()
    void (async () => {
      if (!state.project) return
      await flushPending('before-copy')
      const destinationPath = normalizePath(ui.exportPath.value)
      if (destinationPath === state.activePath) throw new Error('Choose a different destination filename.')
      const response = await executeCommand<ExportResponse>('presentation-export-copy', {
        path: state.activePath,
        destinationPath,
        expectedRevision: state.project.revision
      })
      ui.exportDialog.close()
      setSaveStatus(`Exported ${response.destinationPath} · ${response.bytes} bytes`, 'saved')
    })().catch((error) => { ui.exportError.textContent = errorMessage(error) })
  })
  for (const close of document.querySelectorAll<HTMLButtonElement>('[data-close-dialog]')) {
    close.addEventListener('click', () => {
      const dialog = document.getElementById(close.dataset.closeDialog ?? '')
      if (dialog instanceof HTMLDialogElement) dialog.close()
    })
  }
  ui.openPreview.addEventListener('click', () => {
    if (!state.project) return
    state.previewIndex = Math.max(0, state.project.slides.findIndex((slide) => slide.id === state.selectedSlideId))
    renderPreview()
    ui.previewDialog.showModal()
  })
  ui.previewPrev.addEventListener('click', () => { state.previewIndex -= 1; renderPreview() })
  ui.previewNext.addEventListener('click', () => { state.previewIndex += 1; renderPreview() })
  ui.previewDialog.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') { event.preventDefault(); state.previewIndex -= 1; renderPreview() }
    if (event.key === 'ArrowRight') { event.preventDefault(); state.previewIndex += 1; renderPreview() }
  })

  ui.canvas.addEventListener('pointerdown', beginPointer)
  ui.canvas.addEventListener('pointermove', updatePointer)
  ui.canvas.addEventListener('pointerup', endPointer)
  ui.canvas.addEventListener('pointercancel', endPointer)
  ui.canvas.addEventListener('dblclick', (event) => {
    if (event.target instanceof Element
      && event.target.closest('.canvas-text-content[contenteditable]')) return
    const target = event.target instanceof Element ? event.target.closest<SVGElement>('[data-element-id]') : null
    const element = currentSlide()?.elements.find((candidate) => candidate.id === target?.dataset.elementId)
    if (element?.type === 'text') beginInlineEdit(element)
  })
  ui.canvas.addEventListener('keydown', (event) => {
    const inlineEditor = event.target instanceof Element
      ? event.target.closest<HTMLElement>('.canvas-text-content[contenteditable]')
      : null
    if (inlineEditor) {
      if (event.key === 'Escape') {
        event.preventDefault()
        commitInlineEdit(true)
      } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        commitInlineEdit()
      }
      return
    }
    if (state.inlineEditingId) return
    const element = currentElement()
    if ((event.key === 'Delete' || event.key === 'Backspace') && element) {
      event.preventDefault()
      deleteSelectedElement()
      return
    }
    if (event.key === 'Enter' && element?.type === 'text') {
      event.preventDefault()
      beginInlineEdit(element)
      return
    }
    if (!element || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    const step = event.shiftKey ? 1 : 0.25
    const next = {
      ...element,
      x: clamp(element.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0), 0, 100 - element.width),
      y: clamp(element.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0), 0, 100 - element.height)
    }
    upsertElement(next, 'nudge element')
  })
  ui.canvas.addEventListener('input', (event) => {
    const editor = event.target instanceof HTMLElement
      ? event.target.closest<HTMLElement>('.canvas-text-content[contenteditable]')
      : null
    if (!editor || !state.inlineEditingId) return
    const value = editor.innerText.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
    if (value.length <= MAX_INLINE_TEXT_LENGTH) {
      state.inlineDraft = value
      return
    }
    state.inlineDraft = value.slice(0, MAX_INLINE_TEXT_LENGTH)
    editor.textContent = state.inlineDraft
    focusInlineEditorAtEnd()
  })
  ui.canvas.addEventListener('focusout', (event) => {
    const editor = event.target instanceof HTMLElement
      ? event.target.closest<HTMLElement>('.canvas-text-content[contenteditable]')
      : null
    if (!editor || !state.inlineEditingId) return
    window.setTimeout(() => {
      if (document.activeElement !== editor && state.inlineEditingId) commitInlineEdit()
    }, 0)
  })
  document.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement
      || event.target instanceof HTMLTextAreaElement
      || event.target instanceof HTMLSelectElement
      || (event.target instanceof HTMLElement && event.target.isContentEditable)) return
    const modifier = event.metaKey || event.ctrlKey
    if (modifier && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      if (event.shiftKey) redo()
      else undo()
    }
  })

  client.ui.onDidReceiveMessage((message) => void handleHostMessage(message))
  client.ui.onDidChangeTheme(applyTheme)
  client.ui.onDidChangeLocale((locale) => {
    document.documentElement.lang = locale.language
    document.documentElement.dir = locale.direction
  })
}

export async function initialize(): Promise<void> {
  bindEvents()
  const [theme, locale, restored] = await Promise.all([
    client.ui.getTheme(),
    client.ui.getLocale(),
    client.ui.getViewState<PersistedViewState & JsonObject>()
  ])
  applyTheme(theme)
  document.documentElement.lang = locale.language
  document.documentElement.dir = locale.direction
  setActivePanel(isStudioPanel(restored?.activePanel) ? restored.activePanel : 'canvas')
  renderAll()
  let initialPath = restored?.path
  if (!initialPath) {
    try {
      initialPath = await latestWorkspaceDeckPath()
    } catch {
      // Workspace discovery is a convenience; an empty editor remains usable when it is unavailable.
    }
  }
  if (initialPath) {
    ui.path.value = initialPath
    try {
      await loadDeck(normalizePath(initialPath), restored?.selectedSlideId)
    } catch (error) {
      setSaveStatus(`Could not restore deck: ${errorMessage(error)}`, 'error')
    }
  }
}

window.addEventListener('pagehide', () => {
  void (async () => {
    try {
      await flushPending('pagehide')
    } catch {
      // The visible conflict/error state already explains why the save was not completed.
    }
    await client.dispose()
  })()
}, { once: true })

await initialize()
