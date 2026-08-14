import {
  EMUS_PER_POINT,
  type PptGeometryDocument,
  type PptGeometryRect,
  type PptGeometryShape,
  type PptGeometrySize,
  type PptGeometryText,
  type PptGeometryTextParagraph
} from './ppt-geometry-qa-ooxml.js'
import {
  createPptGeometryQaReport,
  type PptGeometryQaIssueDraft,
  type PptGeometryQaNormalizedRect,
  type PptGeometryQaReportV1
} from './ppt-geometry-qa-report.js'

const OUT_OF_BOUNDS_TOLERANCE = EMUS_PER_POINT
const OVERLAP_WARNING_RATIO = 0.03
const OVERLAP_ERROR_RATIO = 0.1
const ASPECT_WARNING_RATIO = 0.03
const ASPECT_ERROR_RATIO = 0.1
const OVERFLOW_ERROR_RATIO = 1.15
const MINIMUM_FONT_PT = 8
const MAX_OVERLAP_SHAPES_PER_SLIDE = 512
const MAX_OVERLAP_ISSUES_PER_SLIDE = 2_000
const MAX_REPORT_ISSUES = 20_000

export type PptGeometryQaOptions = {
  attempt?: number
  captionSizePt?: number
  pageMarginPt?: number
  coverSlideIndexes?: ReadonlyArray<number>
}

export function auditPptGeometryDocument(
  document: PptGeometryDocument,
  options: PptGeometryQaOptions = {}
): PptGeometryQaReportV1 {
  if (document.slides.length === 0) throw new Error('geometry audit requires at least one slide')
  if (document.size.width <= 0 || document.size.height <= 0) throw new Error('geometry audit requires a valid slide size')
  const captionSizePt = options.captionSizePt ?? 10
  const pageMarginPt = options.pageMarginPt ?? 0
  const coverSlides = new Set(options.coverSlideIndexes ?? [0])
  const issues: PptGeometryQaIssueDraft[] = []
  for (const slide of document.slides) {
    issues.push(
      ...auditBounds(slide.index, slide.shapes, document.size),
      ...auditText(slide.index, slide.shapes, document.size, captionSizePt),
      ...auditOverlaps(slide.index, slide.shapes, document.size),
      ...auditFooter(slide.index, slide.shapes, document.size, pageMarginPt, coverSlides.has(slide.index)),
      ...auditImages(slide.index, slide.shapes, document.size)
    )
  }
  const boundedIssues = issues.length > MAX_REPORT_ISSUES
    ? [
        ...issues.slice(0, MAX_REPORT_ISSUES - 1),
        {
          rule: 'objects.overlap' as const,
          severity: 'error' as const,
          slideIndex: 0,
          shapeId: '__deck__',
          rect: { x: 0, y: 0, width: 1, height: 1 },
          message: `Geometry QA produced more than ${MAX_REPORT_ISSUES} findings and was truncated.`,
          repairHint: 'Reduce deck complexity and export again so every geometry finding can be reported.'
        }
      ]
    : issues
  return createPptGeometryQaReport({
    attempt: options.attempt,
    slideCount: document.slides.length,
    issues: boundedIssues
  })
}

function auditBounds(
  slideIndex: number,
  shapes: ReadonlyArray<PptGeometryShape>,
  size: PptGeometrySize
): PptGeometryQaIssueDraft[] {
  return informationalShapes(shapes).flatMap((shape) => {
    const rect = visualRect(shape)
    const outside = Math.max(
      0,
      -rect.x,
      -rect.y,
      rect.x + rect.width - size.width,
      rect.y + rect.height - size.height
    )
    if (outside <= OUT_OF_BOUNDS_TOLERANCE) return []
    return [issue({
      rule: 'bounds.out_of_slide',
      severity: 'error',
      slideIndex,
      shape,
      rect,
      size,
      message: `Shape ${shape.id} extends ${formatPoints(outside)} outside the slide.`,
      repairHint: 'Move or resize the informational object so its bounds remain inside the slide.'
    })]
  })
}

function auditText(
  slideIndex: number,
  shapes: ReadonlyArray<PptGeometryShape>,
  size: PptGeometrySize,
  captionSizePt: number
): PptGeometryQaIssueDraft[] {
  const issues: PptGeometryQaIssueDraft[] = []
  for (const shape of informationalShapes(shapes)) {
    const runs = visibleRuns(shape.text)
    if (shape.kind === 'graphic' && shape.graphicKind !== 'table' && runs.length === 0) {
      for (const rule of ['text.minimum_font_size', 'text.overflow'] as const) {
        issues.push(issue({
          rule,
          severity: 'unchecked',
          slideIndex,
          shape,
          rect: shape.rect,
          size,
          message: `${shape.graphicKind ?? 'Graphic'} ${shape.id} stores text metrics outside the slide XML.`,
          repairHint: 'Inspect chart or diagram labels in PowerPoint, or convert important labels to explicit slide text.'
        }))
      }
      continue
    }
    if (runs.length === 0) continue
    const explicitSizes = runs.flatMap((run) => run.fontSizePt === undefined ? [] : [run.fontSizePt])
    const hasUnknownSize = runs.some((run) => run.fontSizePt === undefined && run.text.trim().length > 0)
    if (hasUnknownSize) {
      issues.push(issue({
        rule: 'text.minimum_font_size',
        severity: 'unchecked',
        slideIndex,
        shape,
        rect: shape.rect,
        size,
        message: `Shape ${shape.id} uses inherited font sizes that cannot be verified.`,
        repairHint: 'Apply explicit font sizes to visible text before export.'
      }))
    }
    if (explicitSizes.length > 0) {
      const minimum = Math.min(...explicitSizes)
      if (minimum < MINIMUM_FONT_PT) {
        issues.push(issue({
          rule: 'text.minimum_font_size',
          severity: 'error',
          slideIndex,
          shape,
          rect: shape.rect,
          size,
          message: `Shape ${shape.id} contains visible ${formatNumber(minimum)}pt text below the 8pt minimum.`,
          repairHint: 'Increase every visible run to at least 8pt.'
        }))
      } else if (minimum < captionSizePt) {
        issues.push(issue({
          rule: 'text.minimum_font_size',
          severity: 'warning',
          slideIndex,
          shape,
          rect: shape.rect,
          size,
          message: `Shape ${shape.id} contains ${formatNumber(minimum)}pt text below the ${formatNumber(captionSizePt)}pt caption size.`,
          repairHint: `Increase the text to the governed caption size of ${formatNumber(captionSizePt)}pt or larger.`
        }))
      }
    }
    if (shape.text?.autoFit) continue
    if (hasUnknownSize) {
      issues.push(issue({
        rule: 'text.overflow',
        severity: 'unchecked',
        slideIndex,
        shape,
        rect: shape.rect,
        size,
        message: `Shape ${shape.id} has inherited text metrics, so overflow cannot be estimated reliably.`,
        repairHint: 'Apply explicit run font sizes or enable PowerPoint autofit.'
      }))
      continue
    }
    const estimate = estimateTextHeight(shape.text, shape.rect)
    if (!estimate) continue
    const ratio = estimate.heightPt / estimate.availableHeightPt
    if (ratio <= 1) continue
    const severity = ratio > OVERFLOW_ERROR_RATIO ? 'error' : 'warning'
    issues.push(issue({
      rule: 'text.overflow',
      severity,
      slideIndex,
      shape,
      rect: shape.rect,
      size,
      message: `Shape ${shape.id} needs about ${formatNumber(estimate.heightPt)}pt of text height but has ${formatNumber(estimate.availableHeightPt)}pt.`,
      repairHint: severity === 'error'
        ? 'Enlarge the text box, shorten the copy, reduce explicit spacing, or enable autofit.'
        : 'Review the marginal fit in PowerPoint and enlarge the text box if text clips.'
    }))
  }
  return issues
}

function auditOverlaps(
  slideIndex: number,
  shapes: ReadonlyArray<PptGeometryShape>,
  size: PptGeometrySize
): PptGeometryQaIssueDraft[] {
  const allCandidates = informationalShapes(shapes).filter((shape) => !shape.footer)
  const candidates = allCandidates.slice(0, MAX_OVERLAP_SHAPES_PER_SLIDE)
  const issues: PptGeometryQaIssueDraft[] = allCandidates.length > candidates.length && candidates[0]
    ? [issue({
        rule: 'objects.overlap',
        severity: 'unchecked',
        slideIndex,
        shape: candidates[0],
        rect: candidates[0].rect,
        size,
        message: `Overlap analysis was bounded to ${MAX_OVERLAP_SHAPES_PER_SLIDE} of ${allCandidates.length} informational shapes.`,
        repairHint: 'Reduce slide complexity or split the content across multiple slides for complete overlap analysis.'
      })]
    : []
  let overlapTruncated = false
  outer: for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      if (issues.length >= MAX_OVERLAP_ISSUES_PER_SLIDE - 1) {
        overlapTruncated = true
        break outer
      }
      const left = candidates[leftIndex]
      const right = candidates[rightIndex]
      if (left.groupId && left.groupId === right.groupId) continue
      const intersection = intersect(visualRect(left), visualRect(right))
      if (!intersection || isCarrierComposition(left, right, intersection)) continue
      const ratio = area(intersection) / Math.min(area(left.rect), area(right.rect))
      const later = left.zIndex < right.zIndex ? right : left
      const earlier = later === right ? left : right
      const opaqueTextOcclusion = later.opaque && visibleRuns(earlier.text).length > 0
      if (ratio < OVERLAP_WARNING_RATIO && !opaqueTextOcclusion) continue
      const severity = ratio > OVERLAP_ERROR_RATIO || opaqueTextOcclusion ? 'error' : 'warning'
      issues.push(issue({
        rule: 'objects.overlap',
        severity,
        slideIndex,
        shape: earlier,
        relatedShapeId: later.id,
        rect: intersection,
        size,
        message: opaqueTextOcclusion
          ? `Later opaque shape ${later.id} overlaps text in ${earlier.id}.`
          : `Shapes ${left.id} and ${right.id} overlap ${formatPercent(ratio)} of the smaller object.`,
        repairHint: 'Separate the informational objects or group an intentional composition explicitly.'
      }))
    }
  }
  if (overlapTruncated && candidates[0]) {
    issues.push(issue({
      rule: 'objects.overlap', severity: 'error', slideIndex, shape: candidates[0],
      rect: candidates[0].rect, size,
      message: `Overlap findings exceeded the per-slide limit of ${MAX_OVERLAP_ISSUES_PER_SLIDE}.`,
      repairHint: 'Split this slide into simpler layouts before export.'
    }))
  }
  return issues
}

function auditFooter(
  slideIndex: number,
  shapes: ReadonlyArray<PptGeometryShape>,
  size: PptGeometrySize,
  pageMarginPt: number,
  isCover: boolean
): PptGeometryQaIssueDraft[] {
  if (isCover) return []
  const zoneHeight = Math.max(size.height * 0.06, Math.max(0, pageMarginPt) * EMUS_PER_POINT)
  const zoneTop = size.height - Math.min(size.height, zoneHeight)
  const footers = shapes.filter((shape) => shape.visible && shape.footer)
  const bodies = informationalShapes(shapes).filter((shape) => !shape.footer)
  const issues: PptGeometryQaIssueDraft[] = []
  for (const body of bodies) {
    const bodyRect = visualRect(body)
    if (bodyRect.y + bodyRect.height <= zoneTop) continue
    issues.push(issue({
      rule: 'footer.safe_zone',
      severity: 'warning',
      slideIndex,
      shape: body,
      rect: intersect(bodyRect, { x: 0, y: zoneTop, width: size.width, height: zoneHeight }) ?? bodyRect,
      size,
      message: `Body shape ${body.id} enters the bottom ${formatPercent(zoneHeight / size.height)} footer safe zone.`,
      repairHint: 'Move body content above the footer safe zone or reduce its height.'
    }))
    for (const footer of footers) {
      const intersection = intersect(bodyRect, visualRect(footer))
      if (!intersection) continue
      issues.push(issue({
        rule: 'footer.safe_zone',
        severity: 'error',
        slideIndex,
        shape: body,
        relatedShapeId: footer.id,
        rect: intersection,
        size,
        message: `Body shape ${body.id} intersects footer ${footer.id}.`,
        repairHint: 'Separate body content from the footer, page number, source, or citation.'
      }))
    }
  }
  return issues
}

function auditImages(
  slideIndex: number,
  shapes: ReadonlyArray<PptGeometryShape>,
  size: PptGeometrySize
): PptGeometryQaIssueDraft[] {
  const issues: PptGeometryQaIssueDraft[] = []
  for (const shape of shapes) {
    if (!shape.visible || shape.kind !== 'picture' || !shape.image) continue
    const dimensions = shape.image.dimensions
    if (!dimensions) {
      issues.push(issue({
        rule: 'image.aspect_ratio',
        severity: 'unchecked',
        slideIndex,
        shape,
        rect: shape.rect,
        size,
        message: `Image ${shape.id} dimensions could not be read (${shape.image.unreadableReason ?? 'unknown media'}).`,
        repairHint: 'Use an embedded PNG, JPEG, GIF, BMP, WebP, or dimensioned SVG to enable aspect checking.'
      }))
      continue
    }
    const horizontal = 1 - shape.image.crop.left - shape.image.crop.right
    const vertical = 1 - shape.image.crop.top - shape.image.crop.bottom
    if (horizontal <= 0 || vertical <= 0) {
      issues.push(issue({
        rule: 'image.aspect_ratio',
        severity: 'unchecked',
        slideIndex,
        shape,
        rect: shape.rect,
        size,
        message: `Image ${shape.id} has invalid crop percentages.`,
        repairHint: 'Reset the image crop to leave a positive visible width and height.'
      }))
      continue
    }
    const effectiveRatio = (dimensions.width * horizontal) / (dimensions.height * vertical)
    const frameRatio = shape.rect.width / shape.rect.height
    const difference = Math.abs(frameRatio / effectiveRatio - 1)
    if (difference <= ASPECT_WARNING_RATIO) continue
    const severity = difference > ASPECT_ERROR_RATIO ? 'error' : 'warning'
    issues.push(issue({
      rule: 'image.aspect_ratio',
      severity,
      slideIndex,
      shape,
      rect: shape.rect,
      size,
      message: `Image ${shape.id} frame differs ${formatPercent(difference)} from its cropped media aspect ratio.`,
      repairHint: 'Resize the frame proportionally or adjust srcRect cropping without stretching the image.'
    }))
  }
  return issues
}

function informationalShapes(shapes: ReadonlyArray<PptGeometryShape>): PptGeometryShape[] {
  return shapes.filter((shape) => shape.informational)
}

function visibleRuns(text: PptGeometryText | undefined): Array<{ text: string; fontSizePt?: number }> {
  return text?.paragraphs.flatMap((paragraph) => paragraph.runs)
    .filter((run) => run.visible && run.text.replace(/\s/gu, '').length > 0) ?? []
}

function estimateTextHeight(
  text: PptGeometryText | undefined,
  rect: PptGeometryRect
): { heightPt: number; availableHeightPt: number } | undefined {
  if (!text) return undefined
  const availableWidthPt = (rect.width - text.insets.left - text.insets.right) / EMUS_PER_POINT
  const availableHeightPt = (rect.height - text.insets.top - text.insets.bottom) / EMUS_PER_POINT
  if (availableWidthPt <= 0 || availableHeightPt <= 0) {
    return { heightPt: Number.POSITIVE_INFINITY, availableHeightPt: Math.max(0.01, availableHeightPt) }
  }
  let heightPt = 0
  for (const paragraph of text.paragraphs) {
    const visible = paragraph.runs.filter((run) => run.visible && run.text.length > 0)
    if (visible.length === 0) continue
    heightPt += paragraph.spaceBeforePt
    heightPt += estimateParagraphHeight(paragraph, availableWidthPt, text.wrap)
    heightPt += paragraph.spaceAfterPt
  }
  return { heightPt, availableHeightPt }
}

function estimateParagraphHeight(paragraph: PptGeometryTextParagraph, widthPt: number, wrap: boolean): number {
  let lineWidth = 0
  let lineFont = 0
  let total = 0
  const flush = (): void => {
    const font = Math.max(lineFont, 1)
    total += paragraph.lineSpacing?.kind === 'points'
      ? paragraph.lineSpacing.value
      : font * (paragraph.lineSpacing?.kind === 'percent' ? paragraph.lineSpacing.value : 1.2)
    lineWidth = 0
    lineFont = 0
  }
  for (const run of paragraph.runs) {
    if (!run.visible || !run.fontSizePt) continue
    for (const character of run.text) {
      if (character === '\n') {
        flush()
        continue
      }
      const advance = characterAdvance(character, run.fontSizePt)
      if (wrap && lineWidth > 0 && lineWidth + advance > widthPt) flush()
      lineWidth += advance
      lineFont = Math.max(lineFont, run.fontSizePt)
    }
  }
  if (lineWidth > 0 || lineFont > 0 || total === 0) flush()
  return total
}

function characterAdvance(character: string, fontSizePt: number): number {
  if (/\s/u.test(character)) return fontSizePt * 0.33
  if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(character)) {
    return fontSizePt
  }
  if (/[ilI1|.,'`:;]/u.test(character)) return fontSizePt * 0.3
  if (/[MW@#%&]/u.test(character)) return fontSizePt * 0.85
  return fontSizePt * 0.55
}

function isCarrierComposition(
  left: PptGeometryShape,
  right: PptGeometryShape,
  intersection: PptGeometryRect
): boolean {
  const pairs = [[left, right], [right, left]] as const
  return pairs.some(([carrier, label]) =>
    carrier.kind === 'shape' && carrier.opaque && visibleRuns(carrier.text).length === 0 &&
    visibleRuns(label.text).length > 0 && carrier.zIndex < label.zIndex &&
    area(intersection) / area(label.rect) >= 0.9)
}

function visualRect(shape: PptGeometryShape): PptGeometryRect {
  const radians = shape.rotationDegrees * Math.PI / 180
  const sine = Math.abs(Math.sin(radians))
  const cosine = Math.abs(Math.cos(radians))
  if (sine < 0.000_001) return shape.rect
  const width = shape.rect.width * cosine + shape.rect.height * sine
  const height = shape.rect.width * sine + shape.rect.height * cosine
  return {
    x: shape.rect.x + (shape.rect.width - width) / 2,
    y: shape.rect.y + (shape.rect.height - height) / 2,
    width,
    height
  }
}

function issue(input: {
  rule: PptGeometryQaIssueDraft['rule']
  severity: PptGeometryQaIssueDraft['severity']
  slideIndex: number
  shape: PptGeometryShape
  relatedShapeId?: string
  rect: PptGeometryRect
  size: PptGeometrySize
  message: string
  repairHint: string
}): PptGeometryQaIssueDraft {
  return {
    rule: input.rule,
    severity: input.severity,
    slideIndex: input.slideIndex,
    shapeId: input.shape.id,
    ...(input.relatedShapeId ? { relatedShapeId: input.relatedShapeId } : {}),
    rect: normalizeRect(input.rect, input.size),
    message: input.message,
    repairHint: input.repairHint
  }
}

export function normalizePptGeometryRect(
  rect: PptGeometryRect,
  size: PptGeometrySize
): PptGeometryQaNormalizedRect {
  return normalizeRect(rect, size)
}

function normalizeRect(rect: PptGeometryRect, size: PptGeometrySize): PptGeometryQaNormalizedRect {
  const left = clamp(rect.x, 0, size.width)
  const top = clamp(rect.y, 0, size.height)
  const right = clamp(rect.x + rect.width, left, size.width)
  const bottom = clamp(rect.y + rect.height, top, size.height)
  const x = rounded(left / size.width)
  const y = rounded(top / size.height)
  return {
    x,
    y,
    width: rounded(Math.min(1 - x, (right - left) / size.width)),
    height: rounded(Math.min(1 - y, (bottom - top) / size.height))
  }
}

function intersect(left: PptGeometryRect, right: PptGeometryRect): PptGeometryRect | undefined {
  const x = Math.max(left.x, right.x)
  const y = Math.max(left.y, right.y)
  const farX = Math.min(left.x + left.width, right.x + right.width)
  const farY = Math.min(left.y + left.height, right.y + right.height)
  return farX > x && farY > y ? { x, y, width: farX - x, height: farY - y } : undefined
}

function area(rect: PptGeometryRect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height)
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function formatPoints(emus: number): string {
  return `${formatNumber(emus / EMUS_PER_POINT)}pt`
}

function formatPercent(value: number): string {
  return `${formatNumber(value * 100)}%`
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}
