import { posix } from 'node:path'
import { DOMParser, type Document, type Element, type Node } from '@xmldom/xmldom'
import { detectPptImageDimensions, type PptGeometryImageDimensions } from './ppt-geometry-qa-image.js'

export const EMUS_PER_POINT = 12_700

export type PptGeometrySize = { width: number; height: number }
export type PptGeometryRect = { x: number; y: number; width: number; height: number }
export type PptGeometryCrop = { left: number; top: number; right: number; bottom: number }
export type PptGeometryShapeKind = 'shape' | 'picture' | 'graphic' | 'connector'

export type PptGeometryTextRun = {
  text: string
  fontSizePt?: number
  visible: boolean
}

export type PptGeometryTextParagraph = {
  runs: PptGeometryTextRun[]
  lineSpacing?: { kind: 'percent' | 'points'; value: number }
  spaceBeforePt: number
  spaceAfterPt: number
}

export type PptGeometryText = {
  paragraphs: PptGeometryTextParagraph[]
  autoFit: boolean
  wrap: boolean
  insets: { left: number; top: number; right: number; bottom: number }
}

export type PptGeometryImage = {
  relationshipId?: string
  target?: string
  crop: PptGeometryCrop
  dimensions?: PptGeometryImageDimensions
  unreadableReason?: 'external' | 'missing-relationship' | 'missing-media' | 'unsupported-media'
}

export type PptGeometryShape = {
  id: string
  name?: string
  kind: PptGeometryShapeKind
  graphicKind?: 'chart' | 'table' | 'diagram' | 'other'
  zIndex: number
  rect: PptGeometryRect
  rotationDegrees: number
  groupId?: string
  visible: boolean
  opaque: boolean
  decoration: boolean
  informational: boolean
  footer: boolean
  text?: PptGeometryText
  image?: PptGeometryImage
}

export type PptGeometrySlide = {
  path: string
  index: number
  shapes: PptGeometryShape[]
}

export type PptGeometryDocument = {
  size: PptGeometrySize
  slides: PptGeometrySlide[]
}

export type PptxGeometryParts = {
  packageBytes?: number
  contentTypesXml?: string
  presentationXml: string
  presentationRelationshipsXml?: string
  slides: Array<{ path: string; xml: string; relationshipsXml?: string }>
  media?: ReadonlyMap<string, Uint8Array>
}

type Relationship = { target?: string; external: boolean }
type CoordinateMap = { scaleX: number; scaleY: number; translateX: number; translateY: number }

export function parsePptxGeometryParts(parts: PptxGeometryParts): PptGeometryDocument {
  const presentation = parseOfficeXml(parts.presentationXml, 'ppt/presentation.xml')
  const size = presentationSize(presentation)
  const media = parts.media ?? new Map<string, Uint8Array>()
  const orderedSlides = orderSlideParts(parts, presentation)
  return {
    size,
    slides: orderedSlides.map((slide, index) => parseSlide(slide, index, size, media))
  }
}

function slideRelationshipsPath(slidePath: string): string {
  return posix.join(posix.dirname(slidePath), '_rels', `${posix.basename(slidePath)}.rels`)
}

function orderSlideParts(parts: PptxGeometryParts, presentation: Document): PptxGeometryParts['slides'] {
  const byPath = new Map(parts.slides.map((slide) => [normalizePartPath(slide.path), slide]))
  if (!parts.presentationRelationshipsXml) return [...parts.slides].sort(numericSlideOrder)
  const relationships = parseRelationships(
    parts.presentationRelationshipsXml,
    'ppt/presentation.xml',
    'ppt/_rels/presentation.xml.rels'
  )
  const ordered: PptxGeometryParts['slides'] = []
  for (const element of elements(documentRoot(presentation))) {
    if (elementName(element) !== 'sldid') continue
    const relationshipId = element.getAttribute('r:id')?.trim() ||
      attributeByNamespace(element, 'id', 'relationships')
    const relationship = relationships.get(relationshipId ?? '')
    if (!relationship?.target) continue
    const slide = byPath.get(relationship.target)
    if (slide && !ordered.includes(slide)) ordered.push(slide)
  }
  const remainder = parts.slides.filter((slide) => !ordered.includes(slide)).sort(numericSlideOrder)
  return [...ordered, ...remainder]
}

function numericSlideOrder(left: { path: string }, right: { path: string }): number {
  const leftIndex = Number(left.path.match(/slide(\d+)\.xml$/)?.[1] ?? Number.MAX_SAFE_INTEGER)
  const rightIndex = Number(right.path.match(/slide(\d+)\.xml$/)?.[1] ?? Number.MAX_SAFE_INTEGER)
  return leftIndex - rightIndex || left.path.localeCompare(right.path)
}

function parseSlide(
  part: PptxGeometryParts['slides'][number],
  index: number,
  size: PptGeometrySize,
  media: ReadonlyMap<string, Uint8Array>
): PptGeometrySlide {
  const document = parseOfficeXml(part.xml, part.path)
  const root = documentRoot(document)
  const shapeTree = elements(root).find((element) => elementName(element) === 'sptree')
  const relationships = part.relationshipsXml
    ? parseRelationships(part.relationshipsXml, part.path, slideRelationshipsPath(part.path))
    : new Map<string, Relationship>()
  if (!shapeTree) return { path: part.path, index, shapes: [] }
  const shapes: PptGeometryShape[] = []
  const order = { value: 0 }
  const identity: CoordinateMap = { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 }
  for (const child of childElements(shapeTree)) {
    collectShape(child, identity, undefined, relationships, media, size, shapes, order)
  }
  return { path: part.path, index, shapes }
}

function collectShape(
  element: Element,
  parentMap: CoordinateMap,
  groupId: string | undefined,
  relationships: ReadonlyMap<string, Relationship>,
  media: ReadonlyMap<string, Uint8Array>,
  slideSize: PptGeometrySize,
  output: PptGeometryShape[],
  order: { value: number }
): void {
  const name = elementName(element)
  if (name === 'grpsp') {
    const fallback = `group-${order.value + 1}`
    const identity = nonVisualIdentity(element, fallback)
    const map = groupCoordinateMap(element, parentMap)
    const rootGroupId = groupId ?? identity.id
    for (const child of childElements(element)) {
      collectShape(child, map, rootGroupId, relationships, media, slideSize, output, order)
    }
    return
  }
  const kind = shapeKind(name)
  if (!kind) return
  const localRect = elementLocalRect(element, kind)
  if (!localRect) return
  const identity = nonVisualIdentity(element, `${kind}-${order.value + 1}`)
  const rect = mapRect(localRect, parentMap)
  const currentGraphicKind = kind === 'graphic' ? graphicKind(element) : undefined
  const text = kind === 'shape' || kind === 'connector' ? parseText(element) : undefined
  const visible = !elementHidden(element) && !pictureIsTransparent(element, kind)
  const opaque = visible && elementHasOpaquePaint(element, kind)
  const painted = elementHasVisiblePaint(element, kind)
  const image = kind === 'picture' ? parsePicture(element, relationships, media) : undefined
  const rotationDegrees = elementRotation(element, kind)
  const decoration = isDecoration(identity.name, kind, rect, slideSize, text)
  const effectiveGroupId = groupId ?? (currentGraphicKind === 'table' ? `table:${identity.id}` : undefined)
  const informational = visible && !decoration && kind !== 'connector' &&
    (kind === 'picture' || kind === 'graphic' || painted || visibleText(text).length > 0)
  const footer = isFooter(element, identity.name, rect, slideSize, text)
  output.push({
    id: identity.id,
    ...(identity.name ? { name: identity.name } : {}),
    kind,
    ...(currentGraphicKind ? { graphicKind: currentGraphicKind } : {}),
    zIndex: order.value,
    rect,
    rotationDegrees,
    ...(effectiveGroupId ? { groupId: effectiveGroupId } : {}),
    visible,
    opaque,
    decoration,
    informational,
    footer,
    ...(text ? { text } : {}),
    ...(image ? { image } : {})
  })
  order.value += 1
  if (currentGraphicKind === 'table') {
    collectTableCells(element, identity.id, rect, effectiveGroupId, output, order)
  }
}

function collectTableCells(
  frame: Element,
  frameId: string,
  rect: PptGeometryRect,
  groupId: string | undefined,
  output: PptGeometryShape[],
  order: { value: number }
): void {
  const table = elements(frame).find((element) => elementName(element) === 'tbl')
  if (!table) return
  const columns = elements(table)
    .filter((element) => elementName(element) === 'gridcol')
    .map((element) => numberAttribute(element, 'w') ?? 0)
  const rows = childElements(table).filter((element) => elementName(element) === 'tr')
  const totalWidth = columns.reduce((sum, width) => sum + width, 0)
  const totalHeight = rows.reduce((sum, row) => sum + (numberAttribute(row, 'h') ?? 0), 0)
  if (totalWidth <= 0 || totalHeight <= 0) return
  let sourceY = 0
  rows.forEach((row, rowIndex) => {
    const rowHeight = numberAttribute(row, 'h') ?? 0
    let columnIndex = 0
    for (const cell of childElements(row).filter((element) => elementName(element) === 'tc')) {
      const properties = directChild(cell, 'tcpr')
      const span = Math.max(1, Math.trunc(numberAttribute(properties, 'gridSpan') ?? 1))
      const sourceX = columns.slice(0, columnIndex).reduce((sum, width) => sum + width, 0)
      const sourceWidth = columns.slice(columnIndex, columnIndex + span).reduce((sum, width) => sum + width, 0)
      const cellRect = {
        x: rect.x + rect.width * sourceX / totalWidth,
        y: rect.y + rect.height * sourceY / totalHeight,
        width: rect.width * sourceWidth / totalWidth,
        height: rect.height * rowHeight / totalHeight
      }
      const cellText = parseText(cell, properties ? {
        left: numberAttribute(properties, 'marL') ?? 91_440,
        top: numberAttribute(properties, 'marT') ?? 45_720,
        right: numberAttribute(properties, 'marR') ?? 91_440,
        bottom: numberAttribute(properties, 'marB') ?? 45_720
      } : undefined)
      const visible = !elementHidden(cell)
      const opaque = Boolean(properties && elements(properties).some((element) =>
        ['solidfill', 'gradfill', 'pattfill', 'blipfill'].includes(elementName(element)) && !hasTransparency(element)))
      output.push({
        id: `${frameId.slice(0, 220)}:cell-${rowIndex + 1}-${columnIndex + 1}`,
        kind: 'shape', zIndex: order.value, rect: cellRect, rotationDegrees: 0,
        ...(groupId ? { groupId } : {}),
        visible, opaque, decoration: false,
        informational: visible && (opaque || visibleText(cellText).length > 0),
        footer: false,
        ...(cellText ? { text: cellText } : {})
      })
      order.value += 1
      columnIndex += span
    }
    sourceY += rowHeight
  })
}

function shapeKind(name: string): PptGeometryShapeKind | undefined {
  if (name === 'sp') return 'shape'
  if (name === 'pic') return 'picture'
  if (name === 'graphicframe') return 'graphic'
  if (name === 'cxnsp') return 'connector'
  return undefined
}

function nonVisualIdentity(element: Element, fallback: string): { id: string; name?: string } {
  const properties = elements(element).find((candidate) => elementName(candidate) === 'cnvpr')
  const rawId = properties?.getAttribute('id')?.trim()
  const rawName = properties?.getAttribute('name')?.trim()
  return { id: (rawId || fallback).slice(0, 256), ...(rawName ? { name: rawName.slice(0, 256) } : {}) }
}

function groupCoordinateMap(element: Element, parent: CoordinateMap): CoordinateMap {
  const properties = directChild(element, 'grpsppr')
  const transform = properties ? firstDescendant(properties, 'xfrm') : undefined
  const offset = transform ? directChild(transform, 'off') : undefined
  const extent = transform ? directChild(transform, 'ext') : undefined
  const childOffset = transform ? directChild(transform, 'choff') : undefined
  const childExtent = transform ? directChild(transform, 'chext') : undefined
  const offX = numberAttribute(offset, 'x') ?? 0
  const offY = numberAttribute(offset, 'y') ?? 0
  const extX = numberAttribute(extent, 'cx')
  const extY = numberAttribute(extent, 'cy')
  const childX = numberAttribute(childOffset, 'x') ?? 0
  const childY = numberAttribute(childOffset, 'y') ?? 0
  const childWidth = numberAttribute(childExtent, 'cx')
  const childHeight = numberAttribute(childExtent, 'cy')
  if (!extX || !extY || !childWidth || !childHeight) return parent
  const scaleX = extX / childWidth
  const scaleY = extY / childHeight
  return {
    scaleX: parent.scaleX * scaleX,
    scaleY: parent.scaleY * scaleY,
    translateX: parent.translateX + parent.scaleX * (offX - childX * scaleX),
    translateY: parent.translateY + parent.scaleY * (offY - childY * scaleY)
  }
}

function elementLocalRect(element: Element, kind: PptGeometryShapeKind): PptGeometryRect | undefined {
  const properties = kind === 'graphic'
    ? element
    : directChild(element, kind === 'connector' || kind === 'shape' || kind === 'picture' ? 'sppr' : '')
  const transform = properties ? firstDescendant(properties, 'xfrm') : undefined
  const offset = transform ? directChild(transform, 'off') : undefined
  const extent = transform ? directChild(transform, 'ext') : undefined
  const x = numberAttribute(offset, 'x')
  const y = numberAttribute(offset, 'y')
  const width = numberAttribute(extent, 'cx')
  const height = numberAttribute(extent, 'cy')
  return x !== undefined && y !== undefined && width !== undefined && height !== undefined && width > 0 && height > 0
    ? { x, y, width, height }
    : undefined
}

function mapRect(rect: PptGeometryRect, map: CoordinateMap): PptGeometryRect {
  return {
    x: map.translateX + rect.x * map.scaleX,
    y: map.translateY + rect.y * map.scaleY,
    width: rect.width * Math.abs(map.scaleX),
    height: rect.height * Math.abs(map.scaleY)
  }
}

function elementRotation(element: Element, kind: PptGeometryShapeKind): number {
  const properties = kind === 'graphic' ? element : directChild(element, 'sppr')
  const raw = numberAttribute(properties ? firstDescendant(properties, 'xfrm') : undefined, 'rot') ?? 0
  return ((raw / 60_000) % 360 + 360) % 360
}

function parseText(
  element: Element,
  insets?: PptGeometryText['insets']
): PptGeometryText | undefined {
  const body = directChild(element, 'txbody')
  if (!body) return undefined
  const bodyProperties = directChild(body, 'bodypr')
  const paragraphs = childElements(body)
    .filter((child) => elementName(child) === 'p')
    .map(parseTextParagraph)
    .filter((paragraph) => paragraph.runs.some((run) => run.text.length > 0))
  if (paragraphs.length === 0) return undefined
  return {
    paragraphs,
    autoFit: Boolean(bodyProperties && elements(bodyProperties).some((candidate) =>
      ['normautofit', 'spautofit'].includes(elementName(candidate)))),
    wrap: bodyProperties?.getAttribute('wrap')?.toLowerCase() !== 'none',
    insets: insets ?? {
      left: numberAttribute(bodyProperties, 'lIns') ?? 91_440,
      top: numberAttribute(bodyProperties, 'tIns') ?? 45_720,
      right: numberAttribute(bodyProperties, 'rIns') ?? 91_440,
      bottom: numberAttribute(bodyProperties, 'bIns') ?? 45_720
    }
  }
}

function parseTextParagraph(paragraph: Element): PptGeometryTextParagraph {
  const paragraphProperties = directChild(paragraph, 'ppr')
  const endRunProperties = directChild(paragraph, 'endpararpr')
  const defaultRunProperties = paragraphProperties ? directChild(paragraphProperties, 'defrpr') : undefined
  const defaultSize = fontSize(defaultRunProperties)
  const runs: PptGeometryTextRun[] = []
  for (const child of childElements(paragraph)) {
    const name = elementName(child)
    if (name === 'br') {
      const properties = directChild(child, 'rpr')
      const size = fontSize(properties) ?? defaultSize
      runs.push({ text: '\n', ...(size ? { fontSizePt: size } : {}), visible: !hasZeroAlpha(properties) })
      continue
    }
    if (name !== 'r' && name !== 'fld') continue
    const text = firstDescendant(child, 't')?.textContent ?? ''
    const properties = directChild(child, 'rpr')
    const size = fontSize(properties) ?? defaultSize ?? fontSize(endRunProperties)
    runs.push({
      text,
      ...(size ? { fontSizePt: size } : {}),
      visible: !hasZeroAlpha(properties) && !hasZeroAlpha(defaultRunProperties) && !hasZeroAlpha(endRunProperties)
    })
  }
  return {
    runs,
    ...(paragraphProperties ? parseLineSpacing(paragraphProperties) : {}),
    spaceBeforePt: paragraphProperties ? parsePointSpacing(paragraphProperties, 'spcbef') : 0,
    spaceAfterPt: paragraphProperties ? parsePointSpacing(paragraphProperties, 'spcaft') : 0
  }
}

function parseLineSpacing(properties: Element): { lineSpacing?: PptGeometryTextParagraph['lineSpacing'] } {
  const lineSpacing = directChild(properties, 'lnspc')
  const percent = lineSpacing ? firstDescendant(lineSpacing, 'spcpct') : undefined
  const points = lineSpacing ? firstDescendant(lineSpacing, 'spcpts') : undefined
  const percentValue = numberAttribute(percent, 'val')
  if (percentValue !== undefined && percentValue > 0) {
    return { lineSpacing: { kind: 'percent', value: percentValue / 100_000 } }
  }
  const pointValue = numberAttribute(points, 'val')
  return pointValue !== undefined && pointValue > 0
    ? { lineSpacing: { kind: 'points', value: pointValue / 100 } }
    : {}
}

function parsePointSpacing(properties: Element, name: string): number {
  const spacing = directChild(properties, name)
  const points = spacing ? firstDescendant(spacing, 'spcpts') : undefined
  const value = numberAttribute(points, 'val')
  return value !== undefined && value > 0 ? value / 100 : 0
}

function fontSize(properties: Element | undefined): number | undefined {
  const value = numberAttribute(properties, 'sz')
  return value !== undefined && value > 0 ? value / 100 : undefined
}

function parsePicture(
  element: Element,
  relationships: ReadonlyMap<string, Relationship>,
  media: ReadonlyMap<string, Uint8Array>
): PptGeometryImage {
  const blip = elements(element).find((candidate) => elementName(candidate) === 'blip')
  const relationshipId = blip ? attributeByLocalName(blip, 'embed') : undefined
  const relationship = relationshipId ? relationships.get(relationshipId) : undefined
  const cropElement = elements(element).find((candidate) => elementName(candidate) === 'srcrect')
  const crop = {
    left: percentCrop(cropElement, 'l'),
    top: percentCrop(cropElement, 't'),
    right: percentCrop(cropElement, 'r'),
    bottom: percentCrop(cropElement, 'b')
  }
  if (!relationshipId || !relationship) {
    return { ...(relationshipId ? { relationshipId } : {}), crop, unreadableReason: 'missing-relationship' }
  }
  if (relationship.external) return { relationshipId, crop, unreadableReason: 'external' }
  const target = relationship.target
  if (!target) return { relationshipId, crop, unreadableReason: 'missing-relationship' }
  const bytes = media.get(target)
  if (!bytes) return { relationshipId, target, crop, unreadableReason: 'missing-media' }
  const dimensions = detectPptImageDimensions(bytes, target)
  return {
    relationshipId,
    target,
    crop,
    ...(dimensions ? { dimensions } : { unreadableReason: 'unsupported-media' })
  }
}

function percentCrop(element: Element | undefined, attribute: string): number {
  const value = numberAttribute(element, attribute) ?? 0
  return Math.max(0, Math.min(1, value / 100_000))
}

function elementHasOpaquePaint(element: Element, kind: PptGeometryShapeKind): boolean {
  if (kind === 'picture') {
    const fill = elements(element).find((candidate) => elementName(candidate) === 'blipfill')
    return Boolean(fill && !hasTransparency(fill))
  }
  const properties = directChild(element, 'sppr')
  if (!properties || childElements(properties).some((candidate) => elementName(candidate) === 'nofill')) return false
  const fill = childElements(properties).find((candidate) =>
    ['solidfill', 'gradfill', 'pattfill', 'blipfill'].includes(elementName(candidate)))
  return Boolean(fill && !hasTransparency(fill))
}

function elementHasVisiblePaint(element: Element, kind: PptGeometryShapeKind): boolean {
  if (kind === 'picture' || kind === 'graphic') return true
  const properties = directChild(element, 'sppr')
  const style = directChild(element, 'style')
  if (style && !hasZeroAlpha(style)) return true
  if (!properties) return false
  return elements(properties).some((candidate) => {
    const name = elementName(candidate)
    return ['solidfill', 'gradfill', 'pattfill', 'blipfill'].includes(name) && !hasZeroAlpha(candidate)
  }) || elements(properties).some((candidate) => {
    if (elementName(candidate) !== 'ln' || hasZeroAlpha(candidate)) return false
    return !elements(candidate).some((child) => elementName(child) === 'nofill')
  })
}

function pictureIsTransparent(element: Element, kind: PptGeometryShapeKind): boolean {
  if (kind !== 'picture') return false
  const fill = elements(element).find((candidate) => elementName(candidate) === 'blipfill')
  return Boolean(fill && hasZeroAlpha(fill))
}

function isDecoration(
  name: string | undefined,
  kind: PptGeometryShapeKind,
  rect: PptGeometryRect,
  size: PptGeometrySize,
  text: PptGeometryText | undefined
): boolean {
  const hasText = visibleText(text).length > 0
  const namedDecoration = /(?:background|backdrop|decor|ornament|accent|watermark)/i.test(name ?? '')
  const coverage = (rect.width * rect.height) / (size.width * size.height)
  return kind === 'connector' || (!hasText && (namedDecoration || coverage >= 0.9))
}

function isFooter(
  element: Element,
  name: string | undefined,
  rect: PptGeometryRect,
  size: PptGeometrySize,
  text: PptGeometryText | undefined
): boolean {
  const placeholder = elements(element).find((candidate) => elementName(candidate) === 'ph')
  const placeholderType = placeholder?.getAttribute('type')?.toLowerCase()
  if (placeholderType && ['ftr', 'sldnum', 'dt'].includes(placeholderType)) return true
  if (/(?:footer|footnote|slide.?number|page.?number|citation|source|页脚|页码|来源|引用|注释)/iu.test(name ?? '')) return true
  const content = visibleText(text).trim()
  if (!content || rect.y < size.height * 0.9) return false
  const sizes = text?.paragraphs.flatMap((paragraph) => paragraph.runs.flatMap((run) =>
    run.visible && run.fontSizePt ? [run.fontSizePt] : [])) ?? []
  return sizes.length > 0 && Math.max(...sizes) <= 14 &&
    /^(?:source|sources|note|来源|资料来源|注|备注|©|\d+\s*$)/iu.test(content)
}

function visibleText(text: PptGeometryText | undefined): string {
  return text?.paragraphs.flatMap((paragraph) => paragraph.runs)
    .filter((run) => run.visible)
    .map((run) => run.text)
    .join('') ?? ''
}

function graphicKind(element: Element): PptGeometryShape['graphicKind'] {
  const source = elements(element).map((candidate) => {
    const uri = candidate.getAttribute('uri') ?? ''
    return `${elementName(candidate)} ${uri}`.toLowerCase()
  }).join(' ')
  if (/chart/.test(source)) return 'chart'
  if (/(?:\btbl\b|table)/.test(source)) return 'table'
  if (/(?:diagram|datamodel|relids)/.test(source)) return 'diagram'
  return 'other'
}

function presentationSize(document: Document): PptGeometrySize {
  const size = elements(documentRoot(document)).find((element) => elementName(element) === 'sldsz')
  const width = numberAttribute(size, 'cx')
  const height = numberAttribute(size, 'cy')
  if (!width || !height || width <= 0 || height <= 0) {
    throw new Error('presentation slide size is missing or invalid')
  }
  return { width, height }
}

function parseRelationships(source: string, ownerPath: string, label: string): Map<string, Relationship> {
  const document = parseOfficeXml(source, label)
  const output = new Map<string, Relationship>()
  for (const element of elements(documentRoot(document))) {
    if (elementName(element) !== 'relationship') continue
    const id = element.getAttribute('Id')?.trim()
    const target = element.getAttribute('Target')?.trim()
    if (!id || !target) continue
    const external = element.getAttribute('TargetMode')?.trim().toLowerCase() === 'external'
    output.set(id, {
      external,
      ...(!external ? { target: resolveRelationshipTarget(ownerPath, target) } : {})
    })
  }
  return output
}

function resolveRelationshipTarget(ownerPath: string, target: string): string | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(target).replaceAll('\\', '/')
  } catch {
    return undefined
  }
  const path = decoded.startsWith('/')
    ? normalizePartPath(decoded.slice(1))
    : normalizePartPath(posix.join(posix.dirname(ownerPath), decoded))
  return path.startsWith('../') || path === '..' ? undefined : path
}

function normalizePartPath(path: string): string {
  return posix.normalize(path.replaceAll('\\', '/').replace(/^\/+/, ''))
}

function parseOfficeXml(source: string, label: string): Document {
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error(`${label} contains a forbidden XML declaration`)
  const errors: string[] = []
  const parser = new DOMParser({
    onError: (level, message) => {
      if (level !== 'warning') errors.push(message)
    }
  })
  const document = parser.parseFromString(source, 'application/xml')
  if (!document.documentElement || errors.length > 0) {
    throw new Error(`${label} is malformed XML${errors[0] ? `: ${errors[0]}` : ''}`)
  }
  return document
}

function documentRoot(document: Document): Element {
  if (!document.documentElement) throw new Error('Office XML document has no root element')
  return document.documentElement
}

function elements(root: Element): Element[] {
  const output = [root]
  const descendants = root.getElementsByTagName('*')
  for (let index = 0; index < descendants.length; index += 1) {
    const node = descendants.item(index)
    if (node?.nodeType === 1) output.push(node as Element)
  }
  return output
}

function childElements(element: Element): Element[] {
  const output: Element[] = []
  for (let index = 0; index < element.childNodes.length; index += 1) {
    const node = element.childNodes.item(index)
    if (node?.nodeType === 1) output.push(node as Element)
  }
  return output
}

function directChild(element: Element, name: string): Element | undefined {
  return childElements(element).find((child) => elementName(child) === name)
}

function firstDescendant(element: Element, name: string): Element | undefined {
  return elements(element).find((candidate) => candidate !== element && elementName(candidate) === name)
}

function elementName(element: Element): string {
  return (element.localName || element.tagName.split(':').pop() || element.tagName).toLowerCase()
}

function numberAttribute(element: Element | undefined, name: string): number | undefined {
  const raw = element?.getAttribute(name)
  if (raw === null || raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

function attributeByLocalName(element: Element, name: string): string | undefined {
  for (let index = 0; index < element.attributes.length; index += 1) {
    const attribute = element.attributes.item(index)
    const local = attribute?.localName || attribute?.name.split(':').pop()
    if (local === name && attribute?.value.trim()) return attribute.value.trim()
  }
  return undefined
}

function attributeByNamespace(element: Element, name: string, namespaceFragment: string): string | undefined {
  for (let index = 0; index < element.attributes.length; index += 1) {
    const attribute = element.attributes.item(index)
    if (attribute?.localName === name && attribute.namespaceURI?.includes(namespaceFragment) && attribute.value.trim()) {
      return attribute.value.trim()
    }
  }
  return undefined
}

function elementHidden(element: Element): boolean {
  return elements(element).some((candidate) => {
    const value = candidate.getAttribute('hidden')?.trim().toLowerCase()
    return value === '1' || value === 'true'
  })
}

function hasZeroAlpha(element: Element | undefined): boolean {
  return Boolean(element && elements(element).some((candidate) => {
    const name = elementName(candidate)
    const attribute = name === 'alpha' ? 'val' : 'amt'
    const value = ['alpha', 'alphamod', 'alphamodfix'].includes(name)
      ? numberAttribute(candidate, attribute)
      : undefined
    return value !== undefined && value <= 0
  }))
}

function hasTransparency(element: Element): boolean {
  return elements(element).some((candidate) => {
    const name = elementName(candidate)
    const attribute = name === 'alpha' ? 'val' : 'amt'
    const value = ['alpha', 'alphamod', 'alphamodfix'].includes(name)
      ? numberAttribute(candidate, attribute)
      : undefined
    return value !== undefined && value < 100_000
  })
}
