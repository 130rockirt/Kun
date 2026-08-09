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
  applyEditableElementCss,
  editableCssPropertiesForElement,
  serializeEditableElementCss
} from '../shared/presentation-css.js'
import {
  clamp,
  currentElement,
  currentSlide,
  errorMessage,
  html,
  setSaveStatus,
  state,
  ui
} from './studio-runtime.js'
import {
  deleteSelectedElement,
  localApply,
  reorderElement,
  upsertElement
} from './studio-editing.js'
import { assertImagePath, selectElement } from './studio-visual.js'

export function field(
  labelText: string,
  value: string,
  onChange: (value: string) => void,
  options: { type?: string; min?: string; max?: string; step?: string; multiline?: boolean } = {}
): HTMLLabelElement {
  const label = html('label')
  label.className = 'field'
  const caption = html('span')
  caption.textContent = labelText
  const control = options.multiline ? html('textarea') : html('input')
  if (control instanceof HTMLInputElement) {
    control.type = options.type ?? 'text'
    if (options.min) control.min = options.min
    if (options.max) control.max = options.max
    if (options.step) control.step = options.step
  }
  control.value = value
  control.disabled = state.conflicted
  if (options.multiline) {
    control.addEventListener('blur', () => {
      if (control.value !== value) onChange(control.value)
    })
  } else {
    control.addEventListener('change', () => onChange(control.value))
  }
  label.append(caption, control)
  return label
}

export function selectField<T extends string>(
  labelText: string,
  value: T,
  choices: readonly T[],
  onChange: (value: T) => void
): HTMLLabelElement {
  const label = html('label')
  label.className = 'field'
  const caption = html('span')
  caption.textContent = labelText
  const select = html('select')
  select.disabled = state.conflicted
  for (const choice of choices) {
    const option = html('option')
    option.value = choice
    option.textContent = choice
    option.selected = choice === value
    select.append(option)
  }
  select.addEventListener('change', () => onChange(select.value as T))
  label.append(caption, select)
  return label
}

export function section(titleText: string, ...children: HTMLElement[]): HTMLElement {
  const node = html('section')
  node.className = 'inspector-section'
  const title = html('h3')
  title.textContent = titleText
  node.append(title, ...children)
  return node
}

export function elementTag(element: PresentationElement): 'div' | 'img' {
  return element.type === 'image' ? 'img' : 'div'
}

export function layerSection(slide: PresentationSlide): HTMLElement {
  const list = html('div')
  list.className = 'layer-tree'
  if (slide.elements.length === 0) {
    const empty = html('p')
    empty.className = 'muted'
    empty.textContent = 'This slide has no editable DIV or image elements yet.'
    list.append(empty)
    return section('DOM / Layers', list)
  }

  const layers = slide.elements.map((element, index) => ({ element, index })).reverse()
  for (const { element, index } of layers) {
    const row = html('div')
    row.className = 'layer-row'
    row.dataset.selected = String(element.id === state.selectedElementId)

    const select = html('button')
    select.type = 'button'
    select.className = 'layer-select'
    select.setAttribute('aria-pressed', String(element.id === state.selectedElementId))
    select.title = `Select ${element.type} ${element.id}`
    const tag = html('code')
    tag.className = 'layer-tag'
    tag.textContent = `<${elementTag(element)}>`
    const name = html('span')
    name.className = 'layer-name'
    name.textContent = `${element.type} · ${element.id}`
    select.append(tag, name)
    select.addEventListener('click', () => selectElement(element.id))

    const actions = html('span')
    actions.className = 'layer-actions'
    const forward = html('button')
    forward.type = 'button'
    forward.className = 'layer-order-button'
    forward.textContent = '↑'
    forward.title = 'Bring forward'
    forward.setAttribute('aria-label', `Bring ${element.id} forward`)
    forward.disabled = state.conflicted || index === slide.elements.length - 1
    forward.addEventListener('click', () => reorderElement(element.id, index + 1))
    const backward = html('button')
    backward.type = 'button'
    backward.className = 'layer-order-button'
    backward.textContent = '↓'
    backward.title = 'Send backward'
    backward.setAttribute('aria-label', `Send ${element.id} backward`)
    backward.disabled = state.conflicted || index === 0
    backward.addEventListener('click', () => reorderElement(element.id, index - 1))
    actions.append(forward, backward)
    row.append(select, actions)
    list.append(row)
  }
  return section('DOM / Layers', list)
}

export function cssEditorSection(element: PresentationElement): HTMLElement {
  const editor = html('div')
  editor.className = 'css-editor'
  const selector = html('code')
  selector.className = 'css-selector'
  selector.textContent = `${elementTag(element)}[data-kun-element-id="${element.id}"]`
  const textarea = html('textarea')
  textarea.className = 'css-declarations'
  textarea.value = serializeEditableElementCss(element)
  textarea.spellcheck = false
  textarea.disabled = state.conflicted
  textarea.setAttribute('aria-label', `Editable CSS declarations for ${element.id}`)
  const help = html('small')
  help.className = 'css-help'
  help.textContent = `Allowed: ${editableCssPropertiesForElement(element).join(', ')}`
  const error = html('p')
  error.className = 'field-error css-error'
  error.setAttribute('role', 'alert')
  const apply = html('button')
  apply.type = 'button'
  apply.className = 'button button-primary button-compact'
  apply.textContent = 'Apply CSS'
  apply.disabled = state.conflicted
  apply.addEventListener('click', () => {
    try {
      const slide = currentSlide()
      if (!slide) return
      applyEditableElementCss(element, textarea.value)
      error.textContent = ''
      localApply([{
        kind: 'element.style',
        slideId: slide.id,
        elementId: element.id,
        css: textarea.value
      }], 'edit element CSS')
    } catch (cause) {
      error.textContent = errorMessage(cause)
    }
  })
  editor.append(selector, textarea, help, error, apply)
  return section('Safe CSS', editor)
}

export function geometryFields(element: PresentationElement): HTMLElement {
  const grid = html('div')
  grid.className = 'inspector-grid'
  const number = (name: 'x' | 'y' | 'width' | 'height', label: string): HTMLLabelElement => {
    const min = name === 'width' || name === 'height' ? 0.1 : 0
    const max = name === 'x'
      ? 100 - element.width
      : name === 'y'
        ? 100 - element.height
        : name === 'width'
          ? 100 - element.x
          : 100 - element.y
    return field(
      label,
      String(element[name]),
      (value) => upsertElement({ ...element, [name]: clamp(Number(value), min, max) }, `change ${label}`),
      { type: 'number', min: String(min), max: String(max), step: '0.1' }
    )
  }
  grid.append(number('x', 'X %'), number('y', 'Y %'), number('width', 'Width %'), number('height', 'Height %'))
  return grid
}

export function renderInspector(): void {
  ui.inspectorBody.replaceChildren()
  const slide = currentSlide()
  const element = currentElement()
  if (!state.project || !slide) {
    ui.inspectorTitle.textContent = 'No selection'
    const message = html('p')
    message.className = 'muted'
    message.textContent = 'Open or create a deck to edit its properties.'
    ui.inspectorBody.append(message)
    return
  }
  if (!element) {
    ui.inspectorTitle.textContent = slide.title
    ui.inspectorBody.append(
      section(
        'Document',
        field('Deck title', state.project.title, (title) => localApply([{ kind: 'document.update', patch: { title } }], 'rename deck')),
        selectField('Typeface', state.project.theme.fontFamily, ['sans', 'serif', 'mono'] as const, (fontFamily) =>
          localApply([{ kind: 'document.update', patch: { theme: { fontFamily } } }], 'change typeface')),
        field('Deck background', state.project.theme.backgroundColor, (backgroundColor) =>
          localApply([{ kind: 'document.update', patch: { theme: { backgroundColor } } }], 'change deck background'), { type: 'color' }),
        field('Text color', state.project.theme.textColor, (textColor) =>
          localApply([{ kind: 'document.update', patch: { theme: { textColor } } }], 'change text color'), { type: 'color' }),
        field('Accent color', state.project.theme.accentColor, (accentColor) =>
          localApply([{ kind: 'document.update', patch: { theme: { accentColor } } }], 'change accent'), { type: 'color' })
      ),
      section(
        'Slide',
        field('Slide title', slide.title, (title) =>
          localApply([{ kind: 'slide.update', slideId: slide.id, patch: { title } }], 'rename slide')),
        field('Background', slide.backgroundColor ?? state.project.theme.backgroundColor, (backgroundColor) =>
          localApply([{ kind: 'slide.update', slideId: slide.id, patch: { backgroundColor } }], 'change slide background'), { type: 'color' })
      ),
      layerSection(slide)
    )
    return
  }

  ui.inspectorTitle.textContent = `${element.type} · ${element.id}`
  ui.inspectorBody.append(layerSection(slide))
  const common = section(
    'Layout',
    geometryFields(element),
    field('Rotation', String(element.rotation), (value) =>
      upsertElement({ ...element, rotation: clamp(Number(value), -180, 180) }, 'rotate element'),
    { type: 'number', min: '-180', max: '180', step: '1' }),
    field('Opacity', String(element.opacity), (value) =>
      upsertElement({ ...element, opacity: clamp(Number(value), 0, 1) }, 'change opacity'),
    { type: 'number', min: '0', max: '1', step: '0.05' })
  )
  ui.inspectorBody.append(common)

  if (element.type === 'text') {
    ui.inspectorBody.append(section(
      'Text',
      field('Content', element.text, (text) => upsertElement({ ...element, text }, 'edit text'), { multiline: true }),
      field('Font size', String(element.fontSize), (value) =>
        upsertElement({ ...element, fontSize: clamp(Number(value), 8, 240) }, 'change font size'),
      { type: 'number', min: '8', max: '240', step: '1' }),
      selectField('Weight', String(element.fontWeight), ['400', '500', '600', '700'] as const, (weight) =>
        upsertElement({ ...element, fontWeight: Number(weight) as 400 | 500 | 600 | 700 }, 'change weight')),
      field('Color', element.color, (color) => upsertElement({ ...element, color }, 'change text color'), { type: 'color' }),
      selectField('Align', element.align, ['left', 'center', 'right'] as const, (align) =>
        upsertElement({ ...element, align }, 'change text align')),
      selectField('Vertical', element.verticalAlign, ['top', 'middle', 'bottom'] as const, (verticalAlign) =>
        upsertElement({ ...element, verticalAlign }, 'change vertical align'))
    ))
  } else if (element.type === 'shape') {
    ui.inspectorBody.append(section(
      'Shape',
      selectField('Kind', element.shape, ['rectangle', 'ellipse', 'line'] as const, (shape) =>
        upsertElement({ ...element, shape }, 'change shape')),
      field('Fill', element.fillColor, (fillColor) => upsertElement({ ...element, fillColor }, 'change fill'), { type: 'color' }),
      field('Stroke', element.strokeColor, (strokeColor) => upsertElement({ ...element, strokeColor }, 'change stroke'), { type: 'color' }),
      field('Stroke width', String(element.strokeWidth), (value) =>
        upsertElement({ ...element, strokeWidth: clamp(Number(value), 0, 32) }, 'change stroke width'),
      { type: 'number', min: '0', max: '32', step: '1' }),
      field('Corner radius', String(element.cornerRadius), (value) =>
        upsertElement({ ...element, cornerRadius: clamp(Number(value), 0, 100) }, 'change corner radius'),
      { type: 'number', min: '0', max: '100', step: '1' })
    ))
  } else {
    ui.inspectorBody.append(section(
      'Image',
      field('Workspace path', element.src, (src) => {
        try {
          upsertElement({ ...element, src: assertImagePath(src) }, 'change image')
        } catch (error) {
          setSaveStatus(errorMessage(error), 'error')
        }
      }),
      field('Alt text', element.alt, (alt) => upsertElement({ ...element, alt }, 'change alt text')),
      selectField('Fit', element.fit, ['contain', 'cover'] as const, (fit) =>
        upsertElement({ ...element, fit }, 'change image fit'))
    ))
  }

  ui.inspectorBody.append(cssEditorSection(element))

  const remove = html('button')
  remove.type = 'button'
  remove.className = 'button button-danger'
  remove.textContent = 'Delete element'
  remove.disabled = state.conflicted
  remove.addEventListener('click', deleteSelectedElement)
  ui.inspectorBody.append(remove)
}
