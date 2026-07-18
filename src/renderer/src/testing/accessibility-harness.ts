import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5'

type ElementNode = DefaultTreeAdapterTypes.Element
type MarkupNode = DefaultTreeAdapterTypes.Node

export type AccessibilityIssue = {
  rule:
    | 'aria-labelledby-reference'
    | 'dialog-semantics'
    | 'duplicate-id'
    | 'form-label'
    | 'interactive-name'
    | 'interactive-semantics'
  element: string
  message: string
}

/**
 * Audits server-rendered component markup using an HTML parser. The checks are
 * intentionally small and deterministic so component tests can use this as a
 * fast guard without pretending to replace browser/assistive-technology tests.
 */
export function auditStaticMarkup(markup: string): AccessibilityIssue[] {
  const root = parseFragment(markup)
  const elements = collectElements(root)
  const issues: AccessibilityIssue[] = []
  const ids = collectIds(elements, issues)
  const labelsByControlId = collectLabels(elements)

  for (const element of elements) {
    if (isHidden(element)) continue

    const labelledBy = getAttribute(element, 'aria-labelledby')
    if (labelledBy !== undefined) {
      const references = splitIdReferences(labelledBy)
      const missing = references.length === 0
        ? ['(empty)']
        : references.filter((id) => !ids.has(id))
      if (missing.length > 0) {
        issues.push({
          rule: 'aria-labelledby-reference',
          element: describeElement(element),
          message: `aria-labelledby references missing id${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`
        })
      }
    }

    auditInteractiveElement(element, ids, issues)
    auditFormControl(element, ids, labelsByControlId, issues)
    auditDialog(element, ids, issues)
  }

  return issues
}

function collectElements(root: MarkupNode): ElementNode[] {
  const elements: ElementNode[] = []

  const visit = (node: MarkupNode): void => {
    if (isElement(node)) elements.push(node)
    for (const child of nodeChildren(node)) visit(child)
  }

  visit(root)
  return elements
}

function collectIds(
  elements: ElementNode[],
  issues: AccessibilityIssue[]
): Map<string, ElementNode> {
  const ids = new Map<string, ElementNode>()
  for (const element of elements) {
    const id = getAttribute(element, 'id')?.trim()
    if (!id) continue
    if (ids.has(id)) {
      issues.push({
        rule: 'duplicate-id',
        element: describeElement(element),
        message: `duplicate id: ${id}`
      })
      continue
    }
    ids.set(id, element)
  }
  return ids
}

function collectLabels(elements: ElementNode[]): Map<string, ElementNode[]> {
  const labels = new Map<string, ElementNode[]>()
  for (const element of elements) {
    if (element.tagName !== 'label') continue
    const controlId = getAttribute(element, 'for')?.trim()
    if (!controlId) continue
    const entries = labels.get(controlId) ?? []
    entries.push(element)
    labels.set(controlId, entries)
  }
  return labels
}

function auditInteractiveElement(
  element: ElementNode,
  ids: Map<string, ElementNode>,
  issues: AccessibilityIssue[]
): void {
  const role = getAttribute(element, 'role')?.toLowerCase()
  const isRoleButton = role === 'button'
  const requiresName = isRoleButton || element.tagName === 'button' || isNamedInteractiveInput(element) ||
    (element.tagName === 'a' && getAttribute(element, 'href') !== undefined)

  if (requiresName && accessibleName(element, ids).length === 0) {
    issues.push({
      rule: 'interactive-name',
      element: describeElement(element),
      message: 'interactive element must have visible text, aria-label, or valid aria-labelledby text'
    })
  }

  if (isRoleButton && !isNativelyKeyboardFocusable(element) && getAttribute(element, 'tabindex') !== '0') {
    issues.push({
      rule: 'interactive-semantics',
      element: describeElement(element),
      message: 'non-native role="button" must be included in the keyboard tab order with tabindex="0"'
    })
  }

  const tabIndex = getAttribute(element, 'tabindex')
  if (
    tabIndex !== undefined &&
    Number.isInteger(Number(tabIndex)) &&
    Number(tabIndex) >= 0 &&
    !role &&
    !isNativelyKeyboardFocusable(element)
  ) {
    issues.push({
      rule: 'interactive-semantics',
      element: describeElement(element),
      message: 'focusable non-native element must declare an appropriate interactive role'
    })
  }
}

function auditFormControl(
  element: ElementNode,
  ids: Map<string, ElementNode>,
  labelsByControlId: Map<string, ElementNode[]>,
  issues: AccessibilityIssue[]
): void {
  if (!isLabelledFormControl(element)) return
  const id = getAttribute(element, 'id')?.trim()
  const associatedLabel = id
    ? labelsByControlId.get(id)?.some((label) => accessibleName(label, ids).length > 0) ?? false
    : false
  const wrappingLabel = findAncestor(element, 'label')
  const hasWrappingLabel = wrappingLabel !== undefined && accessibleName(wrappingLabel, ids).length > 0

  if (!associatedLabel && !hasWrappingLabel && accessibleName(element, ids).length === 0) {
    issues.push({
      rule: 'form-label',
      element: describeElement(element),
      message: 'form control must have an aria label or a text-bearing associated label element'
    })
  }
}

function auditDialog(
  element: ElementNode,
  ids: Map<string, ElementNode>,
  issues: AccessibilityIssue[]
): void {
  const role = getAttribute(element, 'role')?.toLowerCase()
  if (role !== 'dialog' && role !== 'alertdialog') return
  if (getAttribute(element, 'aria-modal') !== 'true' || accessibleName(element, ids).length === 0) {
    issues.push({
      rule: 'dialog-semantics',
      element: describeElement(element),
      message: 'modal dialog must declare aria-modal="true" and an accessible name'
    })
  }
}

function accessibleName(element: ElementNode, ids: Map<string, ElementNode>): string {
  const ariaLabel = getAttribute(element, 'aria-label')?.trim()
  if (ariaLabel) return ariaLabel

  const references = splitIdReferences(getAttribute(element, 'aria-labelledby') ?? '')
  if (references.length > 0 && references.every((id) => ids.has(id))) {
    const referencedText = references
      .map((id) => visibleText(ids.get(id)!))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (referencedText) return referencedText
  }

  if (element.tagName === 'input') {
    const type = (getAttribute(element, 'type') ?? 'text').toLowerCase()
    if (['button', 'submit', 'reset'].includes(type)) {
      const value = getAttribute(element, 'value')?.trim()
      if (value) return value
    }
    if (type === 'image') {
      const alt = getAttribute(element, 'alt')?.trim()
      if (alt) return alt
    }
  }

  const text = visibleText(element)
  if (text) return text
  return getAttribute(element, 'title')?.trim() ?? ''
}

function visibleText(node: MarkupNode): string {
  if (isTextNode(node)) return node.value
  if (isElement(node) && isHiddenSelf(node)) return ''
  return nodeChildren(node)
    .map((child) => visibleText(child))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isLabelledFormControl(element: ElementNode): boolean {
  if (element.tagName === 'select' || element.tagName === 'textarea') return true
  if (element.tagName !== 'input') return false
  return !['button', 'hidden', 'image', 'reset', 'submit'].includes(
    (getAttribute(element, 'type') ?? 'text').toLowerCase()
  )
}

function isNamedInteractiveInput(element: ElementNode): boolean {
  if (element.tagName !== 'input') return false
  return ['button', 'image', 'reset', 'submit'].includes(
    (getAttribute(element, 'type') ?? 'text').toLowerCase()
  )
}

function isNativelyKeyboardFocusable(element: ElementNode): boolean {
  if (['button', 'select', 'textarea'].includes(element.tagName)) return true
  if (element.tagName === 'a') return getAttribute(element, 'href') !== undefined
  if (element.tagName !== 'input') return false
  return (getAttribute(element, 'type') ?? 'text').toLowerCase() !== 'hidden'
}

function isHidden(element: ElementNode): boolean {
  let current: ElementNode | undefined = element
  while (current) {
    if (isHiddenSelf(current)) return true
    const parent: DefaultTreeAdapterTypes.ParentNode | null = current.parentNode
    current = parent && isElement(parent) ? parent : undefined
  }
  return false
}

function isHiddenSelf(element: ElementNode): boolean {
  return getAttribute(element, 'hidden') !== undefined ||
    getAttribute(element, 'aria-hidden')?.toLowerCase() === 'true' ||
    (element.tagName === 'input' && getAttribute(element, 'type')?.toLowerCase() === 'hidden')
}

function findAncestor(element: ElementNode, tagName: string): ElementNode | undefined {
  let parent = element.parentNode
  while (parent) {
    if (isElement(parent) && parent.tagName === tagName) return parent
    parent = 'parentNode' in parent ? parent.parentNode : null
  }
  return undefined
}

function getAttribute(element: ElementNode, name: string): string | undefined {
  return element.attrs.find((attribute) => attribute.name === name)?.value
}

function splitIdReferences(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean)
}

function describeElement(element: ElementNode): string {
  const id = getAttribute(element, 'id')?.trim()
  return `<${element.tagName}${id ? `#${id}` : ''}>`
}

function isElement(node: MarkupNode): node is ElementNode {
  return 'tagName' in node
}

function isTextNode(node: MarkupNode): node is DefaultTreeAdapterTypes.TextNode {
  return node.nodeName === '#text' && 'value' in node
}

function nodeChildren(node: MarkupNode): DefaultTreeAdapterTypes.ChildNode[] {
  if ('content' in node) return node.content.childNodes
  return 'childNodes' in node ? node.childNodes : []
}
