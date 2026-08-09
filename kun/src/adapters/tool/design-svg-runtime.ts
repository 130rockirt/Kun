import { createHash, randomBytes } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { DOMParser, XMLSerializer, type Attr, type Document, type Element, type Node } from '@xmldom/xmldom'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { resolveWorkspacePath } from './builtin-tool-utils.js'
import { assertCanWritePath } from './sandbox-policy.js'
import {
  ALLOWED_SVG_TAGS as ALLOWED_TAGS,
  SAFE_SVG_ANIMATION_ATTRIBUTES as SAFE_ANIMATION_ATTRIBUTES,
  SVG_NS,
  MAX_SVG_ELEMENTS,
  assertSvgSourceSize,
  safeSvgAttribute as safeAttribute,
  safeSvgId as safeId,
  svgElementName as elementName,
  svgElements as elements,
  svgNodes as nodes,
  svgRoot as rootOf,
  validateSvgDocument as validateDocument,
  type SvgDiagnostic
} from './design-svg-validation.js'

export const DESIGN_SVG_EDIT_MAX_BATCH_OPS = 50
export const DESIGN_SVG_EDIT_MAX_ELEMENTS = MAX_SVG_ELEMENTS
export const DESIGN_SVG_EDIT_MAX_ELEMENT_DEPTH = 32
export const DESIGN_SVG_EDIT_MAX_ARGUMENT_BYTES = 1 * 1024 * 1024
export const DESIGN_SVG_EDIT_MAX_STRUCTURED_NODES = 20_000
const MAX_HANDLE_DEPTH = 64
// Keep inspect results below LocalToolHost's large-output offload threshold so
// structural handles remain directly available to the model. Larger documents
// are traversed with offset pagination.
export const MAX_INSPECT_ELEMENTS = 20
const MAX_INSPECT_ATTRIBUTES = 8
const MAX_INSPECT_ATTRIBUTE_NAME = 128
const MAX_INSPECT_ATTRIBUTE_VALUE = 256
const MAX_RETURNED_DIAGNOSTICS = 100

const CANONICAL_TAGS: Record<string, string> = {
  textpath: 'textPath',
  lineargradient: 'linearGradient',
  radialgradient: 'radialGradient',
  clippath: 'clipPath',
  animatetransform: 'animateTransform',
  animatemotion: 'animateMotion',
  feblend: 'feBlend',
  fecolormatrix: 'feColorMatrix',
  fecomponenttransfer: 'feComponentTransfer',
  fecomposite: 'feComposite',
  feconvolvematrix: 'feConvolveMatrix',
  fediffuselighting: 'feDiffuseLighting',
  fedisplacementmap: 'feDisplacementMap',
  fedistantlight: 'feDistantLight',
  fedropshadow: 'feDropShadow',
  feflood: 'feFlood',
  fefunca: 'feFuncA',
  fefuncb: 'feFuncB',
  fefuncg: 'feFuncG',
  fefuncr: 'feFuncR',
  fegaussianblur: 'feGaussianBlur',
  feimage: 'feImage',
  femerge: 'feMerge',
  femergenode: 'feMergeNode',
  femorphology: 'feMorphology',
  feoffset: 'feOffset',
  fepointlight: 'fePointLight',
  fespecularlighting: 'feSpecularLighting',
  fespotlight: 'feSpotLight',
  fetile: 'feTile',
  feturbulence: 'feTurbulence'
}

type SvgElementSpec = {
  tag: string
  id?: string
  attributes?: Record<string, unknown>
  text?: string
  children?: SvgElementSpec[]
}

export function advertised(context: ToolHostContext): boolean {
  return context.guiDesignMode === true && context.guiDesignArtifact?.kind === 'svg'
}

function elementChildren(parent: Node): Element[] {
  return nodes(parent.childNodes).filter((node): node is Element => node.nodeType === 1)
}

/**
 * Version-local structural handle for elements that do not yet have an id.
 * Indices count element children only, so formatting whitespace does not make
 * handles drift. Handles must always come from a fresh inspect result.
 */
function handleOf(root: Element, element: Element): string {
  if (element === root) return '0'
  const segments: number[] = []
  let current: Element | null = element
  while (current && current !== root) {
    const parent = current.parentNode
    if (!parent || parent.nodeType !== 1) return ''
    const siblings = elementChildren(parent)
    const index = siblings.indexOf(current)
    if (index < 0) return ''
    segments.unshift(index)
    current = parent as Element
  }
  return current === root ? `0/${segments.join('/')}` : ''
}

function findByHandle(document: Document, value: unknown): Element | null {
  if (typeof value !== 'string') return null
  const handle = value.trim()
  if (!/^0(?:\/\d+)*$/.test(handle)) return null
  const segments = handle.split('/').slice(1)
  if (segments.length > MAX_HANDLE_DEPTH) return null
  let current = rootOf(document)
  for (const rawIndex of segments) {
    const index = Number(rawIndex)
    if (!Number.isSafeInteger(index)) return null
    const child = elementChildren(current)[index]
    if (!child) return null
    current = child
  }
  return current
}

function operationElement(
  document: Document,
  operation: Record<string, unknown>,
  role = 'element'
): Element {
  const rawId = typeof operation.id === 'string' ? operation.id.trim() : ''
  const rawHandle = typeof operation.handle === 'string' ? operation.handle.trim() : ''
  if (rawId && rawHandle) throw new Error(`SVG ${role} must use either id or handle, not both`)
  const element = rawId
    ? (safeId(rawId) ? findUniqueById(document, rawId, role) : null)
    : rawHandle
      ? findByHandle(document, rawHandle)
      : null
  if (!element || element === rootOf(document)) {
    const reference = rawId || rawHandle || '(missing reference)'
    throw new Error(`SVG ${role} not found or protected: ${reference}`)
  }
  return element
}

function operationParent(
  document: Document,
  operation: Record<string, unknown>,
  fallback?: Element
): Element {
  const rawId = typeof operation.parentId === 'string' ? operation.parentId.trim() : ''
  const rawHandle = typeof operation.parentHandle === 'string' ? operation.parentHandle.trim() : ''
  if (rawId && rawHandle) throw new Error('SVG parent must use either parentId or parentHandle, not both')
  const parent = rawId
    ? (safeId(rawId) ? findUniqueById(document, rawId, 'parent') : null)
    : rawHandle
      ? findByHandle(document, rawHandle)
      : fallback ?? null
  if (!parent) throw new Error(`SVG parent not found: ${rawId || rawHandle || '(missing reference)'}`)
  return parent
}

function isDescendantOf(candidate: Element, ancestor: Element): boolean {
  let current: Node | null = candidate
  while (current) {
    if (current === ancestor) return true
    current = current.parentNode
  }
  return false
}

function findById(document: Document, id: string): Element | null {
  return elements(rootOf(document)).find((element) => element.getAttribute('id') === id) ?? null
}

export function findUniqueById(document: Document, id: string, role = 'element'): Element | null {
  const matches = elements(rootOf(document)).filter((element) => element.getAttribute('id') === id)
  if (matches.length > 1) throw new Error(`SVG ${role} id is ambiguous; inspect and use a structural handle: ${id}`)
  return matches[0] ?? null
}

function parseSvg(source: string): { document: Document; errors: string[] } {
  const errors: string[] = []
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet\b/i.test(source)) {
    errors.push('DOCTYPE, ENTITY, and xml-stylesheet declarations are not allowed')
  }
  const parser = new DOMParser({
    onError: (level, message) => {
      if (level !== 'warning') errors.push(message)
    }
  })
  let document: Document
  try {
    document = parser.parseFromString(source, 'image/svg+xml')
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error))
  }
  if (elementName(rootOf(document)) !== 'svg') errors.push('root element must be <svg>')
  return { document, errors }
}

function attributesOf(element: Element): { attributes: Record<string, string>; truncated: boolean } {
  const output: Record<string, string> = {}
  let truncated = false
  let included = 0
  for (const attribute of nodes(element.attributes).filter((node): node is Attr => node.nodeType === 2)) {
    if (['id', 'xmlns'].includes(attribute.name)) continue
    if (included >= MAX_INSPECT_ATTRIBUTES || attribute.name.length > MAX_INSPECT_ATTRIBUTE_NAME) {
      truncated = true
      continue
    }
    output[attribute.name] = attribute.value.slice(0, MAX_INSPECT_ATTRIBUTE_VALUE)
    if (attribute.value.length > MAX_INSPECT_ATTRIBUTE_VALUE) truncated = true
    included += 1
  }
  return { attributes: output, truncated }
}

export function inspectDocument(
  document: Document,
  page: { offset?: number; limit?: number } = {}
) {
  const root = rootOf(document)
  const all = elements(root)
  const offset = page.offset ?? 0
  const limit = page.limit ?? MAX_INSPECT_ELEMENTS
  const end = Math.min(all.length, offset + limit)
  const animationTags = new Set(['animate', 'animatetransform', 'animatemotion', 'set'])
  return {
    viewBox: root.getAttribute('viewBox') ?? null,
    width: root.getAttribute('width') ?? null,
    height: root.getAttribute('height') ?? null,
    elementCount: all.length,
    animationCount: all.filter((element) => animationTags.has(elementName(element))).length,
    offset,
    limit,
    elements: all.slice(offset, end).map((element) => {
      const inspectedAttributes = attributesOf(element)
      return {
        tag: elementName(element),
        id: element.getAttribute('id') || null,
        handle: handleOf(root, element),
        parentId: element.parentNode?.nodeType === 1 ? (element.parentNode as Element).getAttribute('id') || null : null,
        attributes: inspectedAttributes.attributes,
        ...(inspectedAttributes.truncated ? { attributesTruncated: true } : {}),
        ...(element.childNodes.length === 1 && element.firstChild?.nodeType === 3
          ? { text: element.textContent?.slice(0, 200) ?? '' }
          : {})
      }
    }),
    truncated: offset > 0 || end < all.length,
    hasMore: end < all.length
  }
}

function specFrom(
  value: unknown,
  depth = 0,
  state: { count: number } = { count: 0 }
): SvgElementSpec {
  if (depth >= DESIGN_SVG_EDIT_MAX_ELEMENT_DEPTH) {
    throw new Error(`SVG element nesting exceeds ${DESIGN_SVG_EDIT_MAX_ELEMENT_DEPTH} levels`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid SVG element spec')
  state.count += 1
  if (state.count > DESIGN_SVG_EDIT_MAX_ELEMENTS) {
    throw new Error(
      `SVG edit batch cannot add more than ${DESIGN_SVG_EDIT_MAX_ELEMENTS} elements; ` +
      'split the additions into smaller calls, then run design_svg_inspect again and use its new revision/handles'
    )
  }
  const record = value as Record<string, unknown>
  if (typeof record.tag !== 'string') throw new Error('SVG element spec requires tag')
  if (record.id !== undefined && typeof record.id !== 'string') throw new Error('SVG element id must be a string')
  if (record.text !== undefined && typeof record.text !== 'string') throw new Error('SVG element text must be a string')
  if (record.attributes !== undefined && (!record.attributes || typeof record.attributes !== 'object' || Array.isArray(record.attributes))) {
    throw new Error('SVG element attributes must be an object')
  }
  if (record.children !== undefined && !Array.isArray(record.children)) throw new Error('SVG element children must be an array')
  const children = Array.isArray(record.children)
    ? record.children.map((child) => specFrom(child, depth + 1, state))
    : []
  return {
    tag: record.tag,
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
    ...(record.attributes && typeof record.attributes === 'object' && !Array.isArray(record.attributes)
      ? { attributes: record.attributes as Record<string, unknown> }
      : {}),
    ...(typeof record.text === 'string' ? { text: record.text } : {}),
    ...(Array.isArray(record.children)
      ? { children }
      : {})
  }
}

type PreparedEditOperation = {
  operation: Record<string, unknown>
  element?: Element
  parent?: Element
  spec?: SvgElementSpec
}

export function prepareEditOperations(
  document: Document,
  operations: readonly Record<string, unknown>[]
): PreparedEditOperation[] {
  const addedElements = { count: 0 }
  return operations.map((operation) => {
    const op = typeof operation.op === 'string' ? operation.op : ''
    if (op === 'set-document') return { operation }
    if (op === 'add') {
      return {
        operation,
        spec: specFrom(operation.element, 0, addedElements),
        ...(typeof operation.parentHandle === 'string'
          ? { parent: operationParent(document, operation) }
          : {})
      }
    }
    return {
      operation,
      ...(typeof operation.handle === 'string'
        ? { element: operationElement(document, operation) }
        : {}),
      ...(op === 'reparent' && typeof operation.parentHandle === 'string'
        ? { parent: operationParent(document, operation) }
        : {})
    }
  })
}

function requireAttached(document: Document, element: Element, role: string): Element {
  const root = rootOf(document)
  if (element !== root && !isDescendantOf(element, root)) {
    throw new Error(`SVG ${role} is no longer attached after an earlier batch operation`)
  }
  return element
}

function createElement(document: Document, spec: SvgElementSpec): Element {
  const tag = spec.tag.trim().toLowerCase()
  if (!ALLOWED_TAGS.has(tag) || tag === 'svg') throw new Error(`unsupported SVG element: ${spec.tag}`)
  const element = document.createElementNS(SVG_NS, CANONICAL_TAGS[tag] ?? tag)
  if (spec.id !== undefined) {
    const id = safeId(spec.id)
    if (!id) throw new Error(`invalid SVG id: ${spec.id}`)
    if (findById(document, id)) throw new Error(`SVG id already exists: ${id}`)
    element.setAttribute('id', id)
  }
  for (const [name, rawValue] of Object.entries(spec.attributes ?? {})) {
    if (rawValue === undefined || rawValue === null) continue
    if (name.toLowerCase() === 'xmlns' || name.toLowerCase().startsWith('xmlns:')) {
      throw new Error('namespace declarations are only supported by set-document')
    }
    const value = String(rawValue)
    if (!safeAttribute(name, value)) throw new Error(`unsafe SVG attribute: ${name}`)
    element.setAttribute(name, value)
  }
  if (spec.text !== undefined) element.appendChild(document.createTextNode(spec.text))
  for (const child of spec.children ?? []) element.appendChild(createElement(document, child))
  return element
}

export function applyEditOperation(document: Document, prepared: PreparedEditOperation): string[] {
  const { operation } = prepared
  const op = typeof operation.op === 'string' ? operation.op : ''
  if (op === 'set-document') {
    const root = rootOf(document)
    const attrs = operation.attributes && typeof operation.attributes === 'object' && !Array.isArray(operation.attributes)
      ? operation.attributes as Record<string, unknown>
      : {}
    for (const [name, rawValue] of Object.entries(attrs)) {
      if (!['viewBox', 'width', 'height', 'preserveAspectRatio', 'role', 'aria-labelledby', 'xmlns'].includes(name)) {
        throw new Error(`unsupported document attribute: ${name}`)
      }
      if (rawValue === null || rawValue === undefined) {
        throw new Error(`document attribute ${name} cannot be null`)
      }
      const value = String(rawValue)
      if (name === 'xmlns' && value !== SVG_NS) throw new Error(`xmlns must be ${SVG_NS}`)
      if (!safeAttribute(name, value)) throw new Error(`unsafe SVG attribute: ${name}`)
      root.setAttribute(name, value)
    }
    return []
  }
  if (op === 'add') {
    const spec = prepared.spec ?? specFrom(operation.element)
    const parent = requireAttached(
      document,
      prepared.parent ?? operationParent(document, operation, findUniqueById(document, 'artwork', 'parent') ?? rootOf(document)),
      'parent'
    )
    const element = createElement(document, spec)
    parent.appendChild(element)
    const createdId = element.getAttribute('id') || undefined
    return createdId ? [createdId] : []
  }
  const element = requireAttached(document, prepared.element ?? operationElement(document, operation), 'element')
  const originalReference = element.getAttribute('id') || handleOf(rootOf(document), element)
  if (op === 'delete') {
    element.parentNode?.removeChild(element)
    return [originalReference]
  }
  if (op === 'update') {
    const attrs = operation.attributes && typeof operation.attributes === 'object' && !Array.isArray(operation.attributes)
      ? operation.attributes as Record<string, unknown>
      : {}
    for (const [name, rawValue] of Object.entries(attrs)) {
      if (name.toLowerCase() === 'xmlns' || name.toLowerCase().startsWith('xmlns:')) {
        throw new Error('namespace declarations are only supported by set-document')
      }
      if (rawValue === null) {
        element.removeAttribute(name)
        continue
      }
      const value = String(rawValue)
      if (!safeAttribute(name, value)) throw new Error(`unsafe SVG attribute: ${name}`)
      element.setAttribute(name, value)
    }
    if (Array.isArray(operation.removeAttributes)) {
      for (const name of operation.removeAttributes) {
        if (typeof name !== 'string' || !/^[A-Za-z_:][\w:.-]*$/.test(name)) {
          throw new Error(`invalid SVG attribute name: ${String(name)}`)
        }
        if (name.toLowerCase() === 'xmlns' || name.toLowerCase().startsWith('xmlns:')) {
          throw new Error('namespace declarations are only supported by set-document')
        }
        element.removeAttribute(name)
      }
    }
    if (typeof operation.text === 'string') element.textContent = operation.text
    return [element.getAttribute('id') || originalReference]
  }
  if (op === 'reparent') {
    const parent = requireAttached(document, prepared.parent ?? operationParent(document, operation), 'parent')
    if (parent === element || isDescendantOf(parent, element)) {
      throw new Error(`cannot reparent ${originalReference} into itself or its descendant`)
    }
    parent.appendChild(element)
    return [element.getAttribute('id') || handleOf(rootOf(document), element)]
  }
  if (op === 'reorder') {
    const parent = element.parentNode
    if (!parent) throw new Error(`element has no parent: ${originalReference}`)
    const position = operation.position
    if (position === 'front') parent.appendChild(element)
    else if (position === 'back') parent.insertBefore(element, parent.firstChild)
    else throw new Error('reorder position must be front or back')
    return [element.getAttribute('id') || handleOf(rootOf(document), element)]
  }
  throw new Error(`unsupported SVG edit op: ${op}`)
}

export function animationElement(document: Document, input: Record<string, unknown>): { target: Element; animation: Element; ids: string[] } {
  const targetId = safeId(input.targetId)
  if (!targetId) throw new Error('animation targetId is required')
    const target = findUniqueById(document, targetId, 'animation target')
  if (!target) throw new Error(`animation target not found: ${targetId}`)
  const requestedId = input.id
  const id = requestedId === undefined ? `anim_${randomBytes(4).toString('hex')}` : safeId(requestedId)
  if (!id) throw new Error(`invalid animation id: ${String(requestedId)}`)
  if (findById(document, id)) throw new Error(`animation id already exists: ${id}`)
  const kind = typeof input.kind === 'string' ? input.kind : 'attribute'
  const duration = input.durationMs === undefined ? 1000 : Number(input.durationMs)
  const delay = input.delayMs === undefined ? 0 : Number(input.delayMs)
  if (!Number.isFinite(duration) || duration < 1 || duration > 600_000) {
    throw new Error('durationMs must be between 1 and 600000')
  }
  if (!Number.isFinite(delay) || delay < 0 || delay > 600_000) {
    throw new Error('delayMs must be between 0 and 600000')
  }
  if (typeof input.iterations === 'number' && (!Number.isInteger(input.iterations) || input.iterations < 1 || input.iterations > 1000)) {
    throw new Error('iterations must be an integer between 1 and 1000 or infinite')
  }
  if (input.iterations !== undefined && typeof input.iterations !== 'number' && input.iterations !== 'infinite') {
    throw new Error('iterations must be an integer between 1 and 1000 or infinite')
  }
  const repeatCount = input.iterations === 'infinite'
    ? 'indefinite'
    : String(Math.max(1, typeof input.iterations === 'number' ? input.iterations : 1))
  let animation: Element
  if (kind === 'motion') {
    animation = document.createElementNS(SVG_NS, 'animateMotion')
    const path = typeof input.path === 'string' ? input.path.trim() : ''
    if (!path || path.length > 50_000) throw new Error('motion animation requires a path of at most 50000 characters')
    animation.setAttribute('path', path)
    animation.setAttribute('rotate', typeof input.rotate === 'string' ? input.rotate : 'auto')
  } else if (kind === 'transform') {
    animation = document.createElementNS(SVG_NS, 'animateTransform')
    const type = typeof input.transformType === 'string' ? input.transformType : ''
    if (!['translate', 'scale', 'rotate', 'skewX', 'skewY'].includes(type)) {
      throw new Error('transformType must be translate, scale, rotate, skewX, or skewY')
    }
    animation.setAttribute('attributeName', 'transform')
    animation.setAttribute('type', type)
  } else {
    animation = document.createElementNS(SVG_NS, 'animate')
    const attributeName = typeof input.attributeName === 'string' ? input.attributeName.trim().toLowerCase() : ''
    if (!SAFE_ANIMATION_ATTRIBUTES.has(attributeName)) throw new Error(`unsupported animation attribute: ${attributeName}`)
    animation.setAttribute('attributeName', attributeName)
  }
  animation.setAttribute('id', id)
  animation.setAttribute('dur', `${duration}ms`)
  if (delay > 0) animation.setAttribute('begin', `${delay}ms`)
  animation.setAttribute('repeatCount', repeatCount)
  animation.setAttribute('fill', input.fill === 'remove' ? 'remove' : 'freeze')
  if (kind !== 'motion') {
    const rawValues = Array.isArray(input.values) ? input.values : []
    if (rawValues.some((value) => typeof value !== 'string' && typeof value !== 'number')) {
      throw new Error('animation values must contain only strings or numbers')
    }
    const values = rawValues.map(String)
    if (values.length >= 2) {
      animation.setAttribute('values', values.join(';'))
    } else {
      if (input.from === undefined || input.to === undefined) {
        throw new Error('animation requires at least two values or both from and to')
      }
      if (
        (typeof input.from !== 'string' && typeof input.from !== 'number') ||
        (typeof input.to !== 'string' && typeof input.to !== 'number')
      ) {
        throw new Error('animation from and to must be strings or numbers')
      }
      animation.setAttribute('from', String(input.from))
      animation.setAttribute('to', String(input.to))
    }
    if (Array.isArray(input.keyTimes)) {
      const keyTimes = input.keyTimes.map(Number)
      const expected = values.length >= 2 ? values.length : 2
      if (
        keyTimes.length !== expected ||
        keyTimes.some((value, index) => !Number.isFinite(value) || value < 0 || value > 1 || (index > 0 && value < keyTimes[index - 1])) ||
        keyTimes[0] !== 0 ||
        keyTimes[keyTimes.length - 1] !== 1
      ) {
        throw new Error(`keyTimes must contain ${expected} ascending values from 0 to 1`)
      }
      animation.setAttribute('keyTimes', keyTimes.join(';'))
    }
    if (Array.isArray(input.keySplines)) {
      const segmentCount = (values.length >= 2 ? values.length : 2) - 1
      if (input.keySplines.length !== segmentCount) {
        throw new Error(`keySplines must contain ${segmentCount} cubic-bezier entries`)
      }
      const validSplines = input.keySplines.every((entry) => {
        if (typeof entry !== 'string') return false
        const splineValues = entry.trim().split(/[ ,]+/).map(Number)
        return splineValues.length === 4 && splineValues.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
      })
      if (!validSplines) throw new Error('each keySpline must contain four values from 0 to 1')
      animation.setAttribute('calcMode', 'spline')
      animation.setAttribute('keySplines', input.keySplines.map(String).join(';'))
    }
  } else if (
    input.from !== undefined ||
    input.to !== undefined ||
    input.values !== undefined ||
    input.keyTimes !== undefined ||
    input.keySplines !== undefined
  ) {
    throw new Error('motion animation uses path; value and spline fields are not supported')
  }
  target.appendChild(animation)
  return { target, animation, ids: [targetId, id] }
}

export async function svgFileContext(context: ToolHostContext, write: boolean) {
  const artifact = context.guiDesignArtifact
  if (context.guiDesignMode !== true || !artifact || artifact.kind !== 'svg') {
    throw new Error('SVG tools require an active Design-mode SVG artifact turn')
  }
  // GUI-reserved artifacts must stay inside the active workspace even when the
  // thread otherwise runs with danger-full-access. A planted .kun-design
  // directory symlink must never redirect this scoped tool to an external file.
  const resolved = await resolveWorkspacePath(artifact.relativePath, context, {
    enforceWorkspaceBoundary: true
  })
  if (!resolved.relativePath.startsWith('.kun-design/') || !/\/v\d+\.svg$/i.test(resolved.relativePath)) {
    throw new Error('SVG artifact path must be a versioned file under .kun-design')
  }
  if (write) assertCanWritePath(resolved.absolutePath, context)
  return { ...resolved, artifact }
}

export async function readSvg(context: ToolHostContext) {
  const file = await svgFileContext(context, false)
  const source = await readFile(file.absolutePath, 'utf8')
  assertSvgSourceSize(source)
  const parsed = parseSvg(source)
  return { ...file, source, ...parsed }
}

export async function atomicWrite(path: string, content: string, signal?: AbortSignal): Promise<void> {
  const temp = `${path}.kun-${process.pid}-${randomBytes(4).toString('hex')}.tmp`
  try {
    if (signal?.aborted) throw new Error('SVG write aborted before start')
    await writeFile(temp, content, 'utf8')
    if (signal?.aborted) throw new Error('SVG write aborted before atomic rename')
    await rename(temp, path)
  } finally {
    await unlink(temp).catch(() => undefined)
  }
}

export function revision(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

export function expectedRevision(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^[a-f0-9]{16}$/i.test(value.trim())) {
    throw new Error('expectedRevision must be the 16-character revision returned by design_svg_inspect')
  }
  return value.trim().toLowerCase()
}

export function assertExpectedRevision(source: string, expected: string | undefined): void {
  if (expected && revision(source) !== expected) {
    throw new Error('SVG revision conflict: inspect the current artifact and retry against its latest revision')
  }
}

export async function assertFileUnchanged(path: string, originalSource: string): Promise<void> {
  const latest = await readFile(path, 'utf8')
  if (revision(latest) !== revision(originalSource)) {
    throw new Error('SVG revision conflict: the artifact changed before write; inspect and retry')
  }
}

export function toolError(error: unknown) {
  return { output: { ok: false, error: error instanceof Error ? error.message : String(error) }, isError: true }
}

export function diagnosticEnvelope(diagnostics: readonly SvgDiagnostic[]) {
  return {
    diagnostics: diagnostics.slice(0, MAX_RETURNED_DIAGNOSTICS).map((diagnostic) => ({
      ...diagnostic,
      message: diagnostic.message.length > 1_000
        ? `${diagnostic.message.slice(0, 1_000)}...`
        : diagnostic.message,
      ...(diagnostic.elementId
        ? { elementId: diagnostic.elementId.slice(0, 128) }
        : {})
    })),
    diagnosticCount: diagnostics.length,
    diagnosticsTruncated: diagnostics.length > MAX_RETURNED_DIAGNOSTICS
  }
}

export function serializeValidatedSvg(document: Document) {
  const content = new XMLSerializer().serializeToString(document)
  assertSvgSourceSize(content)
  // Validate the exact bytes that will be written. Namespace declarations can
  // change the namespaceURI seen after a serialize/parse round trip, and only
  // the reparsed document represents what the renderer will consume.
  const reparsed = parseSvg(content)
  const diagnostics = validateDocument(reparsed.document, reparsed.errors)
  const errors = diagnostics.filter((item) => item.severity === 'error')
  if (errors.length) {
    const shown = errors.slice(0, 20).map((item) => item.message.slice(0, 1_000)).join(' ')
    throw new Error(`${shown}${errors.length > 20 ? ` (${errors.length - 20} more validation errors)` : ''}`)
  }
  return { content, diagnostics }
}
