
export const PRESENTATION_SCHEMA_VERSION = 1 as const

export const MAX_PRESENTATION_HTML_BYTES = 900_000
export const MAX_PRESENTATION_JSON_BYTES = 700_000
export const MAX_PRESENTATION_SLIDES = 64
export const MAX_ELEMENTS_PER_SLIDE = 128
export const MAX_PRESENTATION_ELEMENTS = 1_024
export const MAX_PRESENTATION_OPERATIONS = 128
export const MAX_OPERATION_RECEIPTS = 64

export type PresentationFontFamily = 'sans' | 'serif' | 'mono'
export type PresentationTextAlign = 'left' | 'center' | 'right'
export type PresentationVerticalAlign = 'top' | 'middle' | 'bottom'
export type PresentationShapeKind = 'rectangle' | 'ellipse' | 'line'
export type PresentationImageFit = 'contain' | 'cover'

export interface PresentationTheme {
  backgroundColor: string
  textColor: string
  accentColor: string
  fontFamily: PresentationFontFamily
}

export interface PresentationOperationReceipt {
  operationId: string
  digest: string
  resultingRevision: number
}

export interface PresentationElementBase {
  id: string
  x: number
  y: number
  width: number
  height: number
  rotation: number
  opacity: number
}

export interface PresentationTextElement extends PresentationElementBase {
  type: 'text'
  text: string
  fontSize: number
  fontWeight: 400 | 500 | 600 | 700
  fontFamily?: PresentationFontFamily
  color: string
  align: PresentationTextAlign
  verticalAlign: PresentationVerticalAlign
}

export interface PresentationShapeElement extends PresentationElementBase {
  type: 'shape'
  shape: PresentationShapeKind
  fillColor: string
  strokeColor: string
  strokeWidth: number
  cornerRadius: number
}

export interface PresentationImageElement extends PresentationElementBase {
  type: 'image'
  src: string
  alt: string
  fit: PresentationImageFit
}

export type PresentationElement =
  | PresentationTextElement
  | PresentationShapeElement
  | PresentationImageElement

export interface PresentationSlide {
  id: string
  title: string
  backgroundColor: string | null
  elements: PresentationElement[]
}

export interface PresentationProject {
  schemaVersion: typeof PRESENTATION_SCHEMA_VERSION
  id: string
  revision: number
  title: string
  theme: PresentationTheme
  slides: PresentationSlide[]
  operationReceipts: PresentationOperationReceipt[]
}

export type PresentationDocumentPatch = {
  title?: string
  theme?: Partial<PresentationTheme>
}

export type PresentationSlidePatch = {
  title?: string
  backgroundColor?: string | null
}

export type PresentationOperation =
  | { kind: 'document.update'; patch: PresentationDocumentPatch }
  | { kind: 'slide.insert'; slide: PresentationSlide; index?: number }
  | { kind: 'slide.update'; slideId: string; patch: PresentationSlidePatch }
  | { kind: 'slide.delete'; slideId: string }
  | { kind: 'slide.reorder'; slideId: string; index: number }
  | { kind: 'element.upsert'; slideId: string; element: PresentationElement; index?: number }
  | { kind: 'element.style'; slideId: string; elementId: string; css: string }
  | { kind: 'element.delete'; slideId: string; elementId: string }

export interface PresentationValidationIssue {
  [key: string]: string
  code: string
  path: string
  message: string
}

export interface PresentationValidationResult {
  ok: boolean
  errors: PresentationValidationIssue[]
  warnings: PresentationValidationIssue[]
  project?: PresentationProject
}

export interface ApplyPresentationOperationsResult {
  project: PresentationProject
  changedIds: string[]
  inverseOperations: PresentationOperation[]
  warnings: PresentationValidationIssue[]
}

export class PresentationParseError extends Error {
  readonly issues: PresentationValidationIssue[]

  constructor(message: string, issues: PresentationValidationIssue[] = []) {
    super(message)
    this.name = 'PresentationParseError'
    this.issues = issues
  }
}

export class PresentationOperationError extends Error {
  readonly operationIndex: number

  constructor(message: string, operationIndex: number) {
    super(message)
    this.name = 'PresentationOperationError'
    this.operationIndex = operationIndex
  }
}

const DEFAULT_THEME: PresentationTheme = {
  backgroundColor: '#111827',
  textColor: '#F9FAFB',
  accentColor: '#6366F1',
  fontFamily: 'sans'
}

export function createPresentationSlide(
  id: string,
  title = 'Untitled slide'
): PresentationSlide {
  return { id, title, backgroundColor: null, elements: [] }
}

export function createPresentationProject(
  input: string | { id: string; title?: string; firstSlideId?: string } = 'presentation-1'
): PresentationProject {
  const options = typeof input === 'string' ? { id: input } : input
  return {
    schemaVersion: PRESENTATION_SCHEMA_VERSION,
    id: options.id,
    revision: 1,
    title: options.title ?? 'Untitled presentation',
    theme: { ...DEFAULT_THEME },
    slides: [createPresentationSlide(options.firstSlideId ?? 'slide-1')],
    operationReceipts: []
  }
}

type TextElementOverrides = Partial<Omit<PresentationTextElement, 'id' | 'type'>>
type ShapeElementOverrides = Partial<Omit<PresentationShapeElement, 'id' | 'type'>>
type ImageElementOverrides = Partial<Omit<PresentationImageElement, 'id' | 'type' | 'src'>>

export function createTextElement(
  id: string,
  overrides: TextElementOverrides = {}
): PresentationTextElement {
  return {
    id,
    type: 'text',
    x: 10,
    y: 12,
    width: 80,
    height: 20,
    rotation: 0,
    opacity: 1,
    text: 'Text',
    fontSize: 48,
    fontWeight: 600,
    color: '#F9FAFB',
    align: 'left',
    verticalAlign: 'middle',
    ...overrides
  }
}

export function createShapeElement(
  id: string,
  overrides: ShapeElementOverrides = {}
): PresentationShapeElement {
  return {
    id,
    type: 'shape',
    x: 20,
    y: 30,
    width: 60,
    height: 30,
    rotation: 0,
    opacity: 1,
    shape: 'rectangle',
    fillColor: '#6366F1',
    strokeColor: '#6366F1',
    strokeWidth: 0,
    cornerRadius: 12,
    ...overrides
  }
}

export function createImageElement(
  id: string,
  src: string,
  overrides: ImageElementOverrides = {}
): PresentationImageElement {
  return {
    id,
    type: 'image',
    x: 20,
    y: 20,
    width: 60,
    height: 60,
    rotation: 0,
    opacity: 1,
    src,
    alt: '',
    fit: 'contain',
    ...overrides
  }
}
