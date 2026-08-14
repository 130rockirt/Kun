import { parse, serialize, type DefaultTreeAdapterTypes } from 'parse5'
import { MAX_RUNTIME_DOCUMENT_HTML_CHARS } from '../../shared/office-document'

type ElementNode = DefaultTreeAdapterTypes.Element
type MarkupNode = DefaultTreeAdapterTypes.Node

const REMOVED_ELEMENTS = new Set([
  'applet',
  'base',
  'embed',
  'form',
  'frame',
  'frameset',
  'iframe',
  'input',
  'link',
  'math',
  'meta',
  'object',
  'script',
  'select',
  'svg',
  'template',
  'textarea'
])

const RESOURCE_ATTRIBUTES = new Set([
  'action',
  'background',
  'cite',
  'data',
  'formaction',
  'href',
  'ping',
  'poster',
  'src',
  'srcset',
  'xlink:href'
])

const UNSAFE_CSS = /(?:@import\b|@font-face\b|url\s*\(|expression\s*\(|-moz-binding\b|behavior\s*:|filter\s*:|(?:https?|file|data|javascript)\s*:)/i
const CSS_ESCAPE = /\\(?:([\da-f]{1,6})(?:\r\n|[\t\n\f\r ])?|\r\n|[\n\r\f]|(.))/gi

/**
 * Makes OfficeCLI's HTML safe to insert into an isolated, scriptless iframe.
 * The parser is deliberately structural: regexes cannot reliably remove a
 * malformed tag or an event handler split across attributes.
 */
export function sanitizeOfficeDocumentHtml(rawHtml: string): string {
  if (rawHtml.length > MAX_RUNTIME_DOCUMENT_HTML_CHARS) {
    throw new Error(`Office document HTML exceeds the ${MAX_RUNTIME_DOCUMENT_HTML_CHARS} character preview limit.`)
  }
  const document = parse(rawHtml)
  sanitizeChildren(document)
  const sanitized = serialize(document)
  if (sanitized.length > MAX_RUNTIME_DOCUMENT_HTML_CHARS) {
    throw new Error(`Office document HTML exceeds the ${MAX_RUNTIME_DOCUMENT_HTML_CHARS} character preview limit.`)
  }
  return sanitized
}

/**
 * OfficeCLI renders every visible worksheet and its own script-driven tab
 * strip. The preview iframe deliberately runs without scripts, so expose the
 * tab labels to the host UI instead of re-enabling OfficeCLI's script.
 */
export function extractOfficeDocumentSheetNames(sanitizedHtml: string): string[] {
  const names = new Map<number, string>()
  visitNodes(parse(sanitizedHtml), (node) => {
    if (!isElement(node) || !hasClass(node, 'sheet-tab')) return
    const rawIndex = node.attrs.find((attribute) => attribute.name === 'data-sheet')?.value
    const index = rawIndex ? Number.parseInt(rawIndex, 10) : Number.NaN
    if (!Number.isSafeInteger(index) || index < 0 || names.has(index)) return
    const name = nodeText(node).replace(/\s+/g, ' ').trim()
    if (name) names.set(index, name)
  })
  return [...names.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, name]) => name)
}

/**
 * Applies a static, numeric-only worksheet selection after sanitization. This
 * preserves the iframe's no-script sandbox while retaining OfficeCLI's full
 * workbook rendering for the selected tab.
 */
export function selectOfficeDocumentSheet(sanitizedHtml: string, sheetIndex: number): string {
  if (!Number.isSafeInteger(sheetIndex) || sheetIndex < 0) return sanitizedHtml
  const style = `<style data-kun-office-sheet="${sheetIndex}">` +
    `.sheet-content{display:none!important}` +
    `.sheet-content[data-sheet="${sheetIndex}"]{display:block!important}` +
    `.sheet-tabs{display:none!important}</style>`
  const selected = /<\/head>/i.test(sanitizedHtml)
    ? sanitizedHtml.replace(/<\/head>/i, `${style}</head>`)
    : `${style}${sanitizedHtml}`
  return selected.length <= MAX_RUNTIME_DOCUMENT_HTML_CHARS ? selected : sanitizedHtml
}

function sanitizeChildren(parent: MarkupNode): void {
  const children = nodeChildren(parent)
  const safeChildren = children.filter((child) => sanitizeNode(child))
  if ('childNodes' in parent) parent.childNodes = safeChildren
}

function sanitizeNode(node: MarkupNode): boolean {
  if (node.nodeName === '#comment') return false
  if (!isElement(node)) return true
  if (REMOVED_ELEMENTS.has(node.tagName.toLowerCase())) return false

  sanitizeAttributes(node)
  if (node.tagName.toLowerCase() === 'style') sanitizeStyleChildren(node)
  sanitizeChildren(node)
  return true
}

function sanitizeAttributes(element: ElementNode): void {
  element.attrs = element.attrs.flatMap((attribute) => {
    const name = attribute.name.toLowerCase()
    if (name.startsWith('on') || RESOURCE_ATTRIBUTES.has(name)) {
      return safeResourceAttribute(name, attribute.value, attribute)
    }
    if (name === 'style') {
      const value = sanitizeOfficeCss(attribute.value)
      return value ? [{ ...attribute, value }] : []
    }
    if (name === 'contenteditable' || name === 'draggable' || name === 'autofocus') return []
    return [attribute]
  })
}

function safeResourceAttribute(
  name: string,
  value: string,
  attribute: ElementNode['attrs'][number]
): ElementNode['attrs'] {
  if (name === 'src' && isSafeOfficeDocumentDataImage(value)) return [attribute]
  if (name === 'href' && value.trim().startsWith('#')) return [attribute]
  return []
}

export function isSafeOfficeDocumentDataImage(value: string): boolean {
  return /^data:image\/(?:avif|gif|jpe?g|png|webp);base64,[a-z0-9+/=\s]+$/i.test(value.trim())
}

function sanitizeStyleChildren(element: ElementNode): void {
  for (const child of element.childNodes) {
    if (child.nodeName === '#text' && 'value' in child) {
      child.value = sanitizeOfficeCss(child.value)
    }
  }
}

function sanitizeOfficeCss(value: string): string {
  const withoutComments = value.replace(/\/\*[\s\S]*?\*\//g, '')
  // CSS escape sequences can spell `url`, `@import`, or a remote protocol
  // without any literal dangerous token. Dropping the whole style is safer
  // than trying to remove an escaped declaration while preserving its syntax.
  if (UNSAFE_CSS.test(decodeCssEscapes(withoutComments))) return ''
  return withoutComments.trim()
}

function decodeCssEscapes(value: string): string {
  return value.replace(CSS_ESCAPE, (_match, hex: string | undefined, literal: string | undefined) => {
    if (hex) {
      const codePoint = Number.parseInt(hex, 16)
      return codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '\uFFFD'
    }
    return literal ?? ''
  })
}

function isElement(node: MarkupNode): node is ElementNode {
  return 'tagName' in node
}

function hasClass(node: ElementNode, className: string): boolean {
  return node.attrs.some((attribute) =>
    attribute.name === 'class' && attribute.value.split(/\s+/).includes(className)
  )
}

function nodeText(node: MarkupNode): string {
  if (node.nodeName === '#text' && 'value' in node) return node.value
  return nodeChildren(node).map((child) => nodeText(child)).join('')
}

function visitNodes(node: MarkupNode, visit: (node: MarkupNode) => void): void {
  visit(node)
  for (const child of nodeChildren(node)) visitNodes(child, visit)
}

function nodeChildren(node: MarkupNode): DefaultTreeAdapterTypes.ChildNode[] {
  if ('content' in node) return node.content.childNodes
  return 'childNodes' in node ? node.childNodes : []
}
