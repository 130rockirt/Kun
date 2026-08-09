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
  clamp,
  clearConflict,
  client,
  currentElement,
  currentSlide,
  errorMessage,
  executeCommand,
  finite,
  html,
  makeId,
  MAX_IMAGE_BASE64_CHARS,
  MAX_IMPORTED_IMAGE_BYTES,
  scheduleViewState,
  setActivePanel,
  setSaveStatus,
  state,
  svg,
  ui,
  type ImageCacheEntry
} from './studio-runtime.js'
import {
  beginInlineEdit,
  commitInlineEdit,
  insertElement,
  reorderSlide
} from './studio-editing.js'
import { renderInspector } from './studio-inspector.js'

export function renderControls(): void {
  const loaded = state.project !== null
  const editable = loaded && !state.conflicted
  const slide = currentSlide()
  const element = currentElement()
  ui.openExport.disabled = !loaded || state.conflicted
  ui.addSlide.disabled = !editable
  ui.duplicateSlide.disabled = !editable || !slide
  ui.deleteSlide.disabled = !editable || !slide || (state.project?.slides.length ?? 0) <= 1
  ui.undo.disabled = !editable || state.undoStack.length === 0
  ui.redo.disabled = !editable || state.redoStack.length === 0
  ui.addText.disabled = !editable || !slide
  ui.addShape.disabled = !editable || !slide
  ui.openImage.disabled = !editable || !slide
  ui.selectionActions.hidden = !element
  ui.editSelectedText.hidden = element?.type !== 'text'
  ui.editSelectedText.disabled = !editable || element?.type !== 'text'
  ui.deleteSelectedElement.disabled = !editable || !element
  ui.openPreview.disabled = !loaded || !slide
}

export function fontFamily(token: PresentationFontFamily): string {
  if (token === 'serif') return 'Georgia, Times New Roman, serif'
  if (token === 'mono') return 'SFMono-Regular, Consolas, Liberation Mono, monospace'
  return 'Inter, Arial, Helvetica, sans-serif'
}

export function geometry(element: PresentationElement): { x: number; y: number; width: number; height: number } {
  return {
    x: finite(element.x, 0) * 16,
    y: finite(element.y, 0) * 9,
    width: Math.max(1, finite(element.width, 1) * 16),
    height: Math.max(1, finite(element.height, 1) * 9)
  }
}

export function setTransform(node: SVGElement, element: PresentationElement): void {
  const box = geometry(element)
  const rotation = finite(element.rotation, 0)
  if (rotation !== 0) {
    node.setAttribute(
      'transform',
      `rotate(${rotation} ${box.x + box.width / 2} ${box.y + box.height / 2})`
    )
  }
  node.setAttribute('opacity', String(clamp(finite(element.opacity, 1), 0, 1)))
}

export function renderTextElement(
  group: SVGGElement,
  element: PresentationTextElement,
  interactive: boolean
): void {
  const box = geometry(element)
  const hit = svg('rect')
  hit.setAttribute('x', String(box.x))
  hit.setAttribute('y', String(box.y))
  hit.setAttribute('width', String(box.width))
  hit.setAttribute('height', String(box.height))
  hit.setAttribute('fill', 'transparent')
  group.append(hit)

  const fontSize = clamp(finite(element.fontSize, 48), 8, 240)
  const editing = interactive && state.inlineEditingId === element.id
  const frame = svg('foreignObject')
  frame.classList.add('canvas-text-frame')
  if (editing) frame.classList.add('is-editing')
  frame.setAttribute('x', String(box.x))
  frame.setAttribute('y', String(box.y))
  frame.setAttribute('width', String(box.width))
  frame.setAttribute('height', String(box.height))

  const shell = html('div')
  shell.className = 'canvas-text-shell'
  shell.style.justifyContent = element.verticalAlign === 'bottom'
    ? 'flex-end'
    : element.verticalAlign === 'middle' ? 'center' : 'flex-start'

  const content = html('div')
  content.className = 'canvas-text-content'
  content.style.color = element.color
  content.style.fontSize = `${fontSize}px`
  content.style.fontWeight = String(element.fontWeight)
  content.style.fontFamily = fontFamily(element.fontFamily ?? state.project?.theme.fontFamily ?? 'sans')
  content.style.textAlign = element.align
  content.textContent = editing ? (state.inlineDraft ?? element.text) : element.text
  if (editing) {
    content.contentEditable = 'plaintext-only'
    content.spellcheck = false
    content.setAttribute('role', 'textbox')
    content.setAttribute('aria-label', 'Edit text on slide')
    content.setAttribute('aria-multiline', 'true')
  }
  shell.append(content)
  frame.append(shell)
  group.append(frame)
}

export function renderShapeElement(group: SVGGElement, element: PresentationShapeElement): void {
  const box = geometry(element)
  if (element.shape === 'ellipse') {
    const ellipse = svg('ellipse')
    ellipse.setAttribute('cx', String(box.x + box.width / 2))
    ellipse.setAttribute('cy', String(box.y + box.height / 2))
    ellipse.setAttribute('rx', String(box.width / 2))
    ellipse.setAttribute('ry', String(box.height / 2))
    ellipse.setAttribute('fill', element.fillColor)
    ellipse.setAttribute('stroke', element.strokeColor)
    ellipse.setAttribute('stroke-width', String(element.strokeWidth))
    group.append(ellipse)
    return
  }
  if (element.shape === 'line') {
    const line = svg('line')
    line.setAttribute('x1', String(box.x))
    line.setAttribute('y1', String(box.y + box.height / 2))
    line.setAttribute('x2', String(box.x + box.width))
    line.setAttribute('y2', String(box.y + box.height / 2))
    line.setAttribute('stroke', element.strokeColor)
    line.setAttribute('stroke-width', String(Math.max(1, element.strokeWidth)))
    line.setAttribute('stroke-linecap', 'round')
    group.append(line)
    return
  }
  const rect = svg('rect')
  rect.setAttribute('x', String(box.x))
  rect.setAttribute('y', String(box.y))
  rect.setAttribute('width', String(box.width))
  rect.setAttribute('height', String(box.height))
  rect.setAttribute('rx', String(Math.max(0, element.cornerRadius)))
  rect.setAttribute('fill', element.fillColor)
  rect.setAttribute('stroke', element.strokeColor)
  rect.setAttribute('stroke-width', String(element.strokeWidth))
  group.append(rect)
}

export function imageMime(path: string): string | null {
  const lower = path.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.webp')) return 'image/webp'
  return null
}

export function imageExtension(path: string): 'png' | 'jpg' | 'jpeg' | 'gif' | 'webp' | null {
  const match = path.toLowerCase().match(/\.([a-z0-9]+)$/u)
  const extension = match?.[1]
  return extension === 'png' || extension === 'jpg' || extension === 'jpeg'
    || extension === 'gif' || extension === 'webp'
    ? extension
    : null
}

export function safeAssetStem(value: string, fallback: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/\.[^.]+$/u, '')
    .replace(/[^A-Za-z0-9_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48)
  return normalized || fallback
}

export async function importedImagePath(file: File): Promise<string> {
  const extension = imageExtension(file.name)
  if (!extension || imageMime(file.name) === null) {
    throw new Error('Choose a PNG, JPEG, GIF, or WebP image.')
  }
  const declaredMime = file.type.trim().toLowerCase()
  if (declaredMime && !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(declaredMime)) {
    throw new Error('Choose a PNG, JPEG, GIF, or WebP image.')
  }
  let directory = ''
  try {
    const assets = await client.workspace.stat('assets')
    if (assets.type === 'directory') directory = 'assets/'
  } catch {
    // Extension API v1 cannot create directories. A unique root-level asset
    // remains workspace-confined when the conventional assets directory is absent.
  }
  const deck = safeAssetStem(state.activePath.replace(/\.kun-ppt\.html$/u, ''), 'presentation')
  const source = safeAssetStem(file.name, 'image')
  const nonce = globalThis.crypto?.randomUUID?.().replaceAll('-', '').slice(0, 12)
    ?? Math.random().toString(36).slice(2, 14)
  return assertImagePath(
    `${directory}kun-ppt-${deck}-${source}-${Date.now().toString(36)}-${nonce}.${extension}`
  )
}

export function readImportedImage(file: File): Promise<string> {
  if (file.size <= 0) return Promise.reject(new Error('The selected image is empty.'))
  if (file.size > MAX_IMPORTED_IMAGE_BYTES) {
    return Promise.reject(new Error('The selected image is too large. Choose an image smaller than 6 MiB.'))
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener(
      'error',
      () => reject(new Error('Kun could not read the selected image.')),
      { once: true }
    )
    reader.addEventListener('load', () => {
      const value = reader.result
      if (typeof value !== 'string') {
        reject(new Error('Kun could not read the selected image.'))
        return
      }
      const separator = value.indexOf(',')
      const content = separator >= 0 ? value.slice(separator + 1) : ''
      if (!value.slice(0, separator).endsWith(';base64') || !content
        || content.length > MAX_IMAGE_BASE64_CHARS) {
        reject(new Error('The selected image is too large or has an unsupported encoding.'))
        return
      }
      resolve(content)
    }, { once: true })
    reader.readAsDataURL(file)
  })
}

export async function importSelectedImage(file: File): Promise<void> {
  const path = await importedImagePath(file)
  const content = await readImportedImage(file)
  await client.workspace.writeFile({ path, content, encoding: 'base64' })
  await resolveImage(path)
  insertElement(createImageElement(makeId('image'), path, { alt: file.name }), 'add image')
}

export function assertImagePath(path: string): string {
  const normalized = path.trim().replaceAll('\\', '/')
  const segments = normalized.split('/')
  if (
    !normalized ||
    normalized.length > 260 ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/u.test(normalized) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(normalized) ||
    // eslint-disable-next-line no-control-regex -- path validation intentionally matches ASCII controls
    /[\u0000-\u001F\u007F%:*?"<>|#]/u.test(normalized) ||
    segments.some((part) => part === '' || part === '.' || part === '..') ||
    imageMime(normalized) === null
  ) {
    throw new Error('Use a workspace-relative PNG, JPEG, GIF, or WebP path.')
  }
  return normalized
}

export async function resolveImage(path: string): Promise<string> {
  const normalized = assertImagePath(path)
  const current = state.imageCache.get(normalized)
  if (current?.state === 'ready') return current.url
  if (current?.state === 'error') throw new Error(current.message)
  state.imageCache.set(normalized, { state: 'loading' })
  try {
    const file = await client.workspace.readFile(normalized, 'base64')
    if (file.encoding !== 'base64' || file.content.length > MAX_IMAGE_BASE64_CHARS) {
      throw new Error('The image is too large for the editor preview.')
    }
    const mime = imageMime(normalized)
    if (!mime) throw new Error('Unsupported image format.')
    const url = `data:${mime};base64,${file.content}`
    state.imageCache.set(normalized, { state: 'ready', url })
    return url
  } catch (error) {
    const message = errorMessage(error)
    state.imageCache.set(normalized, { state: 'error', message })
    throw error
  }
}

export function requestImage(path: string): ImageCacheEntry | undefined {
  const normalized = path.trim().replaceAll('\\', '/')
  const cached = state.imageCache.get(normalized)
  if (!cached) {
    void resolveImage(normalized)
      .then(() => renderAllVisuals())
      .catch(() => renderAllVisuals())
    return { state: 'loading' }
  }
  return cached
}

export function renderImageElement(group: SVGGElement, element: PresentationImageElement): void {
  const box = geometry(element)
  let cache: ImageCacheEntry | undefined
  try {
    cache = requestImage(assertImagePath(element.src))
  } catch (error) {
    cache = { state: 'error', message: errorMessage(error) }
  }
  if (cache?.state === 'ready') {
    const image = svg('image')
    image.setAttribute('x', String(box.x))
    image.setAttribute('y', String(box.y))
    image.setAttribute('width', String(box.width))
    image.setAttribute('height', String(box.height))
    image.setAttribute('href', cache.url)
    image.setAttribute('preserveAspectRatio', element.fit === 'cover' ? 'xMidYMid slice' : 'xMidYMid meet')
    image.setAttribute('aria-label', element.alt || element.src)
    group.append(image)
    return
  }
  const placeholder = svg('rect')
  placeholder.classList.add('image-placeholder')
  placeholder.setAttribute('x', String(box.x))
  placeholder.setAttribute('y', String(box.y))
  placeholder.setAttribute('width', String(box.width))
  placeholder.setAttribute('height', String(box.height))
  group.append(placeholder)
  const mark = svg('text')
  mark.classList.add('image-placeholder-mark')
  mark.setAttribute('x', String(box.x + box.width / 2))
  mark.setAttribute('y', String(box.y + box.height / 2))
  mark.textContent = cache?.state === 'error' ? '!' : '…'
  group.append(mark)
}

export function renderElement(element: PresentationElement, interactive: boolean): SVGGElement {
  const group = svg('g')
  group.classList.add('canvas-item')
  group.dataset.elementId = element.id
  group.dataset.kind = element.type
  if (interactive) {
    group.setAttribute('role', 'button')
    group.setAttribute('tabindex', '0')
    group.setAttribute('aria-label', `${element.type} element ${element.id}`)
  }
  setTransform(group, element)
  if (element.type === 'text') renderTextElement(group, element, interactive)
  else if (element.type === 'shape') renderShapeElement(group, element)
  else renderImageElement(group, element)
  return group
}

export function projectElementForRender(element: PresentationElement): PresentationElement {
  if (state.pointerSession?.elementId === element.id) return state.pointerSession.preview
  return element
}

export function renderSelection(element: PresentationElement | null): void {
  ui.canvasSelection.replaceChildren()
  if (!element || state.inlineEditingId === element.id) return
  const box = geometry(projectElementForRender(element))
  const outline = svg('rect')
  outline.classList.add('selection-outline')
  outline.setAttribute('x', String(box.x))
  outline.setAttribute('y', String(box.y))
  outline.setAttribute('width', String(box.width))
  outline.setAttribute('height', String(box.height))
  ui.canvasSelection.append(outline)
  const handles: Array<['nw' | 'ne' | 'se' | 'sw', number, number]> = [
    ['nw', box.x, box.y],
    ['ne', box.x + box.width, box.y],
    ['se', box.x + box.width, box.y + box.height],
    ['sw', box.x, box.y + box.height]
  ]
  for (const [name, x, y] of handles) {
    const handle = svg('rect')
    handle.classList.add('selection-handle')
    handle.dataset.handle = name
    handle.setAttribute('x', String(x - 9))
    handle.setAttribute('y', String(y - 9))
    handle.setAttribute('width', '18')
    handle.setAttribute('height', '18')
    handle.setAttribute('rx', '3')
    ui.canvasSelection.append(handle)
  }
}

export function renderCanvas(): void {
  const focusedElementId = document.activeElement instanceof SVGElement
    ? document.activeElement.closest<SVGGElement>('[data-element-id]')?.dataset.elementId
    : undefined
  const slide = currentSlide()
  if (!state.project || !slide) {
    ui.canvas.setAttribute('hidden', '')
    ui.canvasEmpty.hidden = false
    ui.canvasElements.replaceChildren()
    ui.canvasSelection.replaceChildren()
    return
  }
  ui.canvas.removeAttribute('hidden')
  ui.canvasEmpty.hidden = true
  ui.canvasBackground.setAttribute('fill', slide.backgroundColor ?? state.project.theme.backgroundColor)
  ui.canvasElements.replaceChildren(
    ...slide.elements.map((element) => renderElement(projectElementForRender(element), true))
  )
  const selected = currentElement()
  renderSelection(selected)
  ui.canvasCaption.textContent = `16:9 · ${slide.title} · revision ${state.project.revision}`
  ui.selectionCaption.textContent = selected
    ? `${selected.type} · ${selected.id}`
    : 'Nothing selected'
  if (focusedElementId && focusedElementId === selected?.id && state.inlineEditingId === null) {
    focusCanvasElement(focusedElementId)
  }
}

export function slideTitle(slide: PresentationSlide, index: number): string {
  return slide.title.trim() || `Slide ${index + 1}`
}

export function renderSlideList(): void {
  if (!state.project) {
    ui.slideList.replaceChildren()
    ui.deckTitle.textContent = 'Untitled presentation'
    return
  }
  ui.deckTitle.textContent = state.project.title
  const cards = state.project.slides.map((slide, index) => {
    const item = html('li')
    const card = html('button')
    card.type = 'button'
    card.className = 'slide-card'
    card.dataset.slideId = slide.id
    card.setAttribute('role', 'option')
    card.setAttribute('aria-selected', String(slide.id === state.selectedSlideId))
    card.draggable = !state.conflicted

    const number = html('span')
    number.className = 'slide-card-number'
    number.textContent = String(index + 1)
    const shell = html('span')
    shell.className = 'slide-thumbnail-shell'
    const thumbnail = html('span')
    thumbnail.className = 'slide-thumbnail'
    const preview = svg('svg')
    preview.setAttribute('viewBox', '0 0 1600 900')
    preview.setAttribute('aria-hidden', 'true')
    const background = svg('rect')
    background.setAttribute('x', '0')
    background.setAttribute('y', '0')
    background.setAttribute('width', '1600')
    background.setAttribute('height', '900')
    background.setAttribute('fill', slide.backgroundColor ?? state.project!.theme.backgroundColor)
    preview.append(background, ...slide.elements.map((element) => renderElement(element, false)))
    thumbnail.append(preview)
    const title = html('span')
    title.className = 'slide-thumbnail-title'
    title.textContent = slideTitle(slide, index)
    shell.append(thumbnail, title)
    card.append(number, shell)
    card.addEventListener('click', () => selectSlide(slide.id))
    card.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
        event.preventDefault()
        reorderSlide(slide.id, Math.max(0, index - 1))
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
        event.preventDefault()
        reorderSlide(slide.id, Math.min(state.project!.slides.length - 1, index + 1))
      }
    })
    card.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData('text/plain', slide.id)
      card.dataset.dragging = 'true'
    })
    card.addEventListener('dragend', () => {
      delete card.dataset.dragging
      for (const node of ui.slideList.querySelectorAll<HTMLElement>('[data-drop-target]')) {
        delete node.dataset.dropTarget
      }
    })
    card.addEventListener('dragover', (event) => {
      if (state.conflicted) return
      event.preventDefault()
      const before = event.clientY < card.getBoundingClientRect().top + card.getBoundingClientRect().height / 2
      card.dataset.dropTarget = before ? 'before' : 'after'
    })
    card.addEventListener('dragleave', () => delete card.dataset.dropTarget)
    card.addEventListener('drop', (event) => {
      event.preventDefault()
      const draggedId = event.dataTransfer?.getData('text/plain')
      if (!draggedId || draggedId === slide.id) return
      const remaining = state.project!.slides.filter((candidate) => candidate.id !== draggedId)
      const target = remaining.findIndex((candidate) => candidate.id === slide.id)
      const insertAfter = card.dataset.dropTarget === 'after'
      reorderSlide(draggedId, clamp(target + (insertAfter ? 1 : 0), 0, remaining.length))
    })
    item.append(card)
    return item
  })
  ui.slideList.replaceChildren(...cards)
}

export function renderPreview(): void {
  if (!state.project || state.project.slides.length === 0) return
  state.previewIndex = clamp(state.previewIndex, 0, state.project.slides.length - 1)
  const slide = state.project.slides[state.previewIndex]
  ui.previewBackground.setAttribute('fill', slide.backgroundColor ?? state.project.theme.backgroundColor)
  ui.previewElements.replaceChildren(...slide.elements.map((element) => renderElement(element, false)))
  ui.previewPosition.textContent = `${state.previewIndex + 1} / ${state.project.slides.length}`
  ui.previewPrev.disabled = state.previewIndex === 0
  ui.previewNext.disabled = state.previewIndex === state.project.slides.length - 1
  ui.previewCanvas.setAttribute('aria-label', `Preview: ${slideTitle(slide, state.previewIndex)}`)
}

export function renderAllVisuals(): void {
  renderSlideList()
  renderCanvas()
  if (ui.previewDialog.open) renderPreview()
}

export function commitProject(next: PresentationProject, responsePath: string, selectedId?: string): void {
  state.project = next
  state.activePath = responsePath
  ui.path.value = responsePath
  state.selectedSlideId = next.slides.some((slide) => slide.id === selectedId)
    ? selectedId!
    : next.slides[0]?.id ?? null
  state.selectedElementId = null
  state.pendingOperations = []
  state.undoStack = []
  state.redoStack = []
  state.pointerSession = null
  state.inlineEditingId = null
  state.imageCache.clear()
  clearConflict()
  setSaveStatus(`Loaded revision ${next.revision}`, 'saved')
  renderAll()
  scheduleViewState()
}

export function renderAll(): void {
  renderAllVisuals()
  renderInspector()
  renderControls()
}

export function selectSlide(slideId: string): void {
  if (!state.project?.slides.some((slide) => slide.id === slideId)) return
  commitInlineEdit()
  state.selectedSlideId = slideId
  state.selectedElementId = null
  state.previewIndex = state.project.slides.findIndex((slide) => slide.id === slideId)
  setActivePanel('canvas')
  renderAll()
  scheduleViewState()
}

export function selectElement(elementId: string | null): void {
  if (state.inlineEditingId && state.inlineEditingId !== elementId) commitInlineEdit()
  state.selectedElementId = elementId
  renderCanvas()
  renderInspector()
  renderControls()
}

export function focusCanvasElement(elementId: string): void {
  const node = [...ui.canvasElements.querySelectorAll<SVGGElement>('[data-element-id]')]
    .find((candidate) => candidate.dataset.elementId === elementId)
  node?.focus({ preventScroll: true })
}
