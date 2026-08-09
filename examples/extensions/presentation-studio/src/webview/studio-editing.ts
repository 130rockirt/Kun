import { type JsonObject } from '@kun/extension-api'
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
  MAX_INLINE_TEXT_LENGTH,
  INLINE_EDIT_DOUBLE_CLICK_MS,
  SAVE_DEBOUNCE_MS,
  clamp,
  currentElement,
  currentSlide,
  errorMessage,
  executeCommand,
  makeId,
  scheduleViewState,
  setConflict,
  setSaveStatus,
  state,
  ui,
  type HistoryEntry,
  type PointerSession,
  type SaveResponse
} from './studio-runtime.js'
import { renderInspector } from './studio-inspector.js'
import {
  focusCanvasElement,
  renderAll,
  renderCanvas,
  renderControls,
  selectElement,
  selectSlide
} from './studio-visual.js'

export function localApply(
  operations: PresentationOperation[],
  label: string,
  options: { recordHistory?: boolean } = {}
): boolean {
  if (!state.project || state.conflicted || operations.length === 0) return false
  try {
    const result = applyPresentationOperations(state.project, operations)
    state.project = result.project
    state.pendingOperations.push(...operations)
    if (options.recordHistory !== false) {
      state.undoStack.push({ forward: operations, inverse: result.inverseOperations, label })
      if (state.undoStack.length > 100) state.undoStack.shift()
      state.redoStack = []
    }
    if (state.pendingOperations.length >= MAX_PRESENTATION_OPERATIONS) scheduleSave(0)
    else scheduleSave()
    setSaveStatus(`Unsaved · ${label}`, 'saving')
    renderAll()
    return true
  } catch (error) {
    setSaveStatus(errorMessage(error), 'error')
    return false
  }
}

export function scheduleSave(delay = SAVE_DEBOUNCE_MS): void {
  if (state.saveTimer) window.clearTimeout(state.saveTimer)
  state.saveTimer = window.setTimeout(() => {
    state.saveTimer = 0
    void flushPending('autosave').catch(() => undefined)
  }, delay)
}

export async function flushPending(reason: string): Promise<void> {
  if (state.saveTimer) {
    window.clearTimeout(state.saveTimer)
    state.saveTimer = 0
  }
  if (state.savePromise) {
    await state.savePromise
    if (state.pendingOperations.length > 0 && !state.conflicted) await flushPending(reason)
    return
  }
  if (!state.project || !state.activePath || state.pendingOperations.length === 0) {
    if (state.conflicted) throw new Error('Reload the conflicted deck before continuing.')
    return
  }
  if (state.conflicted) throw new Error('Reload the conflicted deck before continuing.')

  const batch = state.pendingOperations.splice(0, MAX_PRESENTATION_OPERATIONS)
  const expectedRevision = state.project.revision
  state.ownSaveTargetRevision = expectedRevision + 1
  setSaveStatus(`Saving ${batch.length} edit${batch.length === 1 ? '' : 's'}…`, 'saving')
  state.savePromise = (async () => {
    try {
      const response = await executeCommand<SaveResponse>('presentation-save', {
        path: state.activePath,
        expectedRevision,
        operations: batch,
        operationId: makeId(`ui-${reason}`)
      } as unknown as JsonObject)
      if (!state.project) return
      if (state.pendingOperations.length === 0) {
        state.project = response.project
      } else {
        state.project = {
          ...state.project,
          revision: response.currentRevision,
          operationReceipts: response.project.operationReceipts
        }
      }
      setSaveStatus(
        response.warnings.length > 0
          ? `Saved revision ${response.currentRevision} · ${response.warnings.length} warning(s)`
          : `Saved revision ${response.currentRevision}`,
        'saved'
      )
      renderAll()
      scheduleViewState()
    } catch (error) {
      state.pendingOperations.unshift(...batch)
      const message = errorMessage(error)
      if (/revision|conflict|stale/i.test(message)) setConflict(message)
      else setSaveStatus(`Save failed: ${message}`, 'error')
      throw error
    } finally {
      state.ownSaveTargetRevision = null
      state.savePromise = null
    }
  })()
  await state.savePromise
  if (state.pendingOperations.length > 0 && !state.conflicted) await flushPending(reason)
}

export function undo(): void {
  const entry = state.undoStack.pop()
  if (!entry || !state.project || state.conflicted) return
  try {
    const result = applyPresentationOperations(state.project, entry.inverse)
    state.project = result.project
    state.pendingOperations.push(...entry.inverse)
    state.redoStack.push(entry)
    scheduleSave()
    setSaveStatus(`Unsaved · undo ${entry.label}`, 'saving')
    renderAll()
  } catch (error) {
    state.undoStack.push(entry)
    setSaveStatus(errorMessage(error), 'error')
  }
}

export function redo(): void {
  const entry = state.redoStack.pop()
  if (!entry || !state.project || state.conflicted) return
  try {
    const result = applyPresentationOperations(state.project, entry.forward)
    state.project = result.project
    state.pendingOperations.push(...entry.forward)
    state.undoStack.push(entry)
    scheduleSave()
    setSaveStatus(`Unsaved · redo ${entry.label}`, 'saving')
    renderAll()
  } catch (error) {
    state.redoStack.push(entry)
    setSaveStatus(errorMessage(error), 'error')
  }
}

export function addSlide(): void {
  if (!state.project) return
  const slide = createPresentationSlide(makeId('slide'), `Slide ${state.project.slides.length + 1}`)
  const index = Math.max(0, state.project.slides.findIndex((candidate) => candidate.id === state.selectedSlideId) + 1)
  if (localApply([{ kind: 'slide.insert', slide, index }], 'add slide')) selectSlide(slide.id)
}

export function duplicateSlide(): void {
  const source = currentSlide()
  if (!source || !state.project) return
  const copy: PresentationSlide = {
    ...structuredClone(source),
    id: makeId('slide'),
    title: `${source.title.slice(0, 115)} copy`,
    elements: source.elements.map((element) => ({ ...element, id: makeId(element.type) }))
  }
  const index = state.project.slides.findIndex((slide) => slide.id === source.id) + 1
  if (localApply([{ kind: 'slide.insert', slide: copy, index }], 'duplicate slide')) selectSlide(copy.id)
}

export function deleteSlide(): void {
  const slide = currentSlide()
  if (!slide || !state.project || state.project.slides.length <= 1) return
  const index = state.project.slides.findIndex((candidate) => candidate.id === slide.id)
  const nextId = state.project.slides[index + 1]?.id ?? state.project.slides[index - 1]?.id ?? null
  if (localApply([{ kind: 'slide.delete', slideId: slide.id }], 'delete slide')) {
    state.selectedSlideId = nextId
    state.selectedElementId = null
    renderAll()
  }
}

export function reorderSlide(slideId: string, index: number): void {
  if (!state.project || state.conflicted) return
  const current = state.project.slides.findIndex((slide) => slide.id === slideId)
  if (current < 0 || current === index) return
  localApply([{ kind: 'slide.reorder', slideId, index }], 'reorder slide')
  state.selectedSlideId = slideId
  renderAll()
}

export function insertElement(element: PresentationElement, label: string): void {
  const slide = currentSlide()
  if (!slide) return
  if (localApply([{ kind: 'element.upsert', slideId: slide.id, element }], label)) {
    state.selectedElementId = element.id
    renderAll()
  }
}

export function upsertElement(element: PresentationElement, label: string): void {
  const slide = currentSlide()
  if (!slide) return
  localApply([{ kind: 'element.upsert', slideId: slide.id, element }], label)
}

export function reorderElement(elementId: string, index: number): void {
  const slide = currentSlide()
  if (!slide || state.conflicted) return
  const current = slide.elements.findIndex((element) => element.id === elementId)
  const boundedIndex = clamp(index, 0, slide.elements.length - 1)
  if (current < 0 || current === boundedIndex) return
  const element = slide.elements[current]!
  state.selectedElementId = element.id
  localApply([{
    kind: 'element.upsert',
    slideId: slide.id,
    element,
    index: boundedIndex
  }], boundedIndex > current ? 'bring layer forward' : 'send layer backward')
}

export function deleteSelectedElement(): void {
  const slide = currentSlide()
  const element = currentElement()
  if (!slide || !element) return
  state.inlineEditingId = null
  state.inlineDraft = null
  if (localApply([{ kind: 'element.delete', slideId: slide.id, elementId: element.id }], 'delete element')) {
    state.selectedElementId = null
    renderAll()
  }
}

export function beginInlineEdit(element: PresentationTextElement): void {
  if (state.conflicted) return
  if (state.inlineEditingId === element.id) {
    inlineEditorNode()?.focus()
    return
  }
  state.inlineEditingId = element.id
  state.inlineDraft = element.text
  state.selectedElementId = element.id
  renderCanvas()
  window.setTimeout(() => focusInlineEditorAtEnd(), 0)
}

export function commitInlineEdit(cancel = false): void {
  if (!state.inlineEditingId) return
  const element = currentElement()
  const currentText = element?.type === 'text' ? element.text : ''
  const nextText = inlineEditorNode()?.innerText.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
    ?? state.inlineDraft
    ?? currentText
  state.inlineEditingId = null
  state.inlineDraft = null
  if (!cancel && element?.type === 'text' && nextText !== element.text) {
    upsertElement({ ...element, text: nextText }, 'edit text')
  } else {
    renderCanvas()
  }
}

export function inlineEditorNode(): HTMLElement | null {
  if (!state.inlineEditingId) return null
  for (const editor of ui.canvasElements.querySelectorAll<HTMLElement>(
    '.canvas-text-content[contenteditable]'
  )) {
    const item = editor.closest<SVGGElement>('[data-element-id]')
    if (item?.dataset.elementId === state.inlineEditingId) return editor
  }
  return null
}

export function focusInlineEditorAtEnd(): void {
  const editor = inlineEditorNode()
  if (!editor) return
  editor.focus()
  const selection = window.getSelection()
  if (!selection) return
  const range = document.createRange()
  range.selectNodeContents(editor)
  range.collapse(false)
  selection.removeAllRanges()
  selection.addRange(range)
}

export function beginPointer(event: PointerEvent): void {
  if (event.button !== 0 || state.conflicted) return
  if (event.target instanceof Element
    && event.target.closest('.canvas-text-content[contenteditable]')) return
  const slide = currentSlide()
  if (!slide) return
  const target = event.target instanceof Element ? event.target : null
  const handle = target?.closest<SVGElement>('[data-handle]')?.dataset.handle as PointerSession['handle']
  const elementNode = target?.closest<SVGElement>('[data-element-id]')
  const elementId = handle ? state.selectedElementId : elementNode?.dataset.elementId
  const element = slide.elements.find((candidate) => candidate.id === elementId)
  if (!element) {
    state.recentPointerSelection = null
    if (!handle) selectElement(null)
    return
  }
  const isRepeatedTextSelection = !handle
    && element.type === 'text'
    && state.recentPointerSelection?.elementId === element.id
    && event.timeStamp - state.recentPointerSelection.at <= INLINE_EDIT_DOUBLE_CLICK_MS
  state.recentPointerSelection = handle ? null : { elementId: element.id, at: event.timeStamp }
  if (isRepeatedTextSelection && element.type === 'text') {
    event.preventDefault()
    beginInlineEdit(element)
    return
  }
  event.preventDefault()
  state.selectedElementId = element.id
  state.pointerSession = {
    pointerId: event.pointerId,
    slideId: slide.id,
    elementId: element.id,
    mode: handle ? 'resize' : 'move',
    ...(handle ? { handle } : {}),
    startClientX: event.clientX,
    startClientY: event.clientY,
    original: structuredClone(element),
    preview: structuredClone(element)
  }
  ui.canvas.setPointerCapture(event.pointerId)
  renderCanvas()
  renderInspector()
  focusCanvasElement(element.id)
}

export function updatePointer(event: PointerEvent): void {
  const session = state.pointerSession
  if (!session || session.pointerId !== event.pointerId) return
  event.preventDefault()
  const rect = ui.canvas.getBoundingClientRect()
  const dx = ((event.clientX - session.startClientX) / Math.max(1, rect.width)) * 100
  const dy = ((event.clientY - session.startClientY) / Math.max(1, rect.height)) * 100
  const original = session.original
  let x = original.x
  let y = original.y
  let width = original.width
  let height = original.height
  if (session.mode === 'move') {
    x = clamp(original.x + dx, 0, 100 - original.width)
    y = clamp(original.y + dy, 0, 100 - original.height)
  } else {
    const min = 2
    if (session.handle === 'nw' || session.handle === 'sw') {
      x = clamp(original.x + dx, 0, original.x + original.width - min)
      width = original.width + (original.x - x)
    } else {
      width = clamp(original.width + dx, min, 100 - original.x)
    }
    if (session.handle === 'nw' || session.handle === 'ne') {
      y = clamp(original.y + dy, 0, original.y + original.height - min)
      height = original.height + (original.y - y)
    } else {
      height = clamp(original.height + dy, min, 100 - original.y)
    }
  }
  session.preview = { ...original, x, y, width, height }
  renderCanvas()
}

export function endPointer(event: PointerEvent): void {
  const session = state.pointerSession
  if (!session || session.pointerId !== event.pointerId) return
  state.pointerSession = null
  if (ui.canvas.hasPointerCapture(event.pointerId)) ui.canvas.releasePointerCapture(event.pointerId)
  const changed = ['x', 'y', 'width', 'height'].some(
    (key) => session.preview[key as 'x'] !== session.original[key as 'x']
  )
  if (changed) upsertElement(session.preview, session.mode === 'move' ? 'move element' : 'resize element')
  else renderAll()
  focusCanvasElement(session.elementId)
}
