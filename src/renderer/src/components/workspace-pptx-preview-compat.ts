import JSZip from 'jszip'

const CONTENT_TYPES_PATH = '[Content_Types].xml'
const MIN_LINE_STYLE_COUNT = 3

type PptxBackgroundOwner = {
  background?: unknown
  slideMaster?: PptxBackgroundOwner
}

type PptxSlide = PptxBackgroundOwner & {
  slideLayout?: PptxBackgroundOwner
}

type PptxPreviewModel = {
  slides?: unknown
}

/**
 * Build an in-memory-only PPTX copy for parser edge cases in pptx-preview 1.0.7.
 * The workspace file is never changed.
 */
export async function preparePptxPreviewPackage(source: ArrayBuffer): Promise<ArrayBuffer> {
  try {
    const archive = await JSZip.loadAsync(source)
    const removedMissingParts = await removeMissingContentTypeOverrides(archive)
    const normalizedThemes = await normalizeSingletonThemeLineStyles(archive)
    if (!removedMissingParts && !normalizedThemes) return source
    return archive.generateAsync({
      type: 'arraybuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 1 }
    })
  } catch {
    // Keep the renderer's original error path for corrupt or non-ZIP input.
    return source
  }
}

/** Validate inheritance before pptx-preview reads slideLayout.background. */
export function assertRenderablePptxPreviewModel(value: unknown): asserts value is PptxPreviewModel {
  if (!isRecord(value) || !Array.isArray(value.slides) || value.slides.length === 0) {
    throw new Error('This PowerPoint presentation has no readable slide data.')
  }
  for (const candidate of value.slides) {
    if (!isRecord(candidate)) throw incompleteInheritanceError()
    const slide = candidate as PptxSlide
    if (!isRecord(slide.slideLayout) || !isRecord(slide.slideLayout.slideMaster)) {
      throw incompleteInheritanceError()
    }
    ensureBackground(slide)
    ensureBackground(slide.slideLayout)
    ensureBackground(slide.slideLayout.slideMaster)
  }
}

async function removeMissingContentTypeOverrides(archive: JSZip): Promise<boolean> {
  const entry = archive.file(CONTENT_TYPES_PATH)
  if (!entry) return false
  const document = parseXml(await entry.async('string'))
  if (!document) return false
  let changed = false
  for (const element of elementsWithLocalName(document, 'Override')) {
    const partName = element.getAttribute('PartName')
    if (!partName) continue
    const paths = packagePartPaths(partName)
    if (paths.some((path) => Boolean(archive.file(path)))) continue
    element.remove()
    changed = true
  }
  if (changed) archive.file(CONTENT_TYPES_PATH, serializeXml(document))
  return changed
}

async function normalizeSingletonThemeLineStyles(archive: JSZip): Promise<boolean> {
  let changed = false
  const themePaths = Object.keys(archive.files).filter((path) => (
    /^ppt\/theme\/[^/]+\.xml$/i.test(path) && !archive.files[path]?.dir
  ))
  for (const path of themePaths) {
    const entry = archive.file(path)
    if (!entry) continue
    const document = parseXml(await entry.async('string'))
    if (!document) continue
    let themeChanged = false
    for (const list of elementsWithLocalName(document, 'lnStyleLst')) {
      const lines = childElementsWithLocalName(list, 'ln')
      if (lines.length !== 1) continue
      while (childElementsWithLocalName(list, 'ln').length < MIN_LINE_STYLE_COUNT) {
        list.appendChild(lines[0]!.cloneNode(true))
      }
      themeChanged = true
    }
    if (!themeChanged) continue
    archive.file(path, serializeXml(document))
    changed = true
  }
  return changed
}

function packagePartPaths(partName: string): string[] {
  const raw = partName.replace(/^\/+/, '')
  try {
    const decoded = decodeURIComponent(raw)
    return decoded === raw ? [raw] : [raw, decoded]
  } catch {
    return [raw]
  }
}

function parseXml(source: string): XMLDocument | null {
  if (typeof window === 'undefined') return null
  const document = new window.DOMParser().parseFromString(source, 'application/xml')
  return elementsWithLocalName(document, 'parsererror').length > 0 ? null : document
}

function serializeXml(document: XMLDocument): string {
  return new window.XMLSerializer().serializeToString(document)
}

function elementsWithLocalName(root: Document | Element, name: string): Element[] {
  return Array.from(root.getElementsByTagName('*')).filter((element) => element.localName === name)
}

function childElementsWithLocalName(root: Element, name: string): Element[] {
  return Array.from(root.childNodes).filter((node): node is Element => (
    node.nodeType === node.ELEMENT_NODE && (node as Element).localName === name
  ))
}

function ensureBackground(owner: PptxBackgroundOwner): void {
  if (!isRecord(owner.background)) owner.background = { type: 'none' }
}

function incompleteInheritanceError(): Error {
  return new Error('This PowerPoint presentation has incomplete slide layout or master data.')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
