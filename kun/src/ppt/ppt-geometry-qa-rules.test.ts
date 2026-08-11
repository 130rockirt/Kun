import { describe, expect, it } from 'vitest'
import {
  auditParsedPptGeometry,
  type PptGeometryDocument,
  type PptGeometryRect,
  type PptGeometryShape,
  type PptGeometryText
} from './ppt-geometry-qa.js'

const WIDTH = 1_000_000
const HEIGHT = 600_000

function text(
  content: string,
  fontSizePt: number | undefined,
  options: { autoFit?: boolean; visible?: boolean; insets?: number } = {}
): PptGeometryText {
  const inset = options.insets ?? 0
  return {
    paragraphs: [{
      runs: [{
        text: content,
        ...(fontSizePt === undefined ? {} : { fontSizePt }),
        visible: options.visible ?? true
      }],
      spaceBeforePt: 0,
      spaceAfterPt: 0
    }],
    autoFit: options.autoFit ?? false,
    wrap: true,
    insets: { left: inset, top: inset, right: inset, bottom: inset }
  }
}

function shape(
  id: string,
  rect: PptGeometryRect,
  overrides: Partial<PptGeometryShape> = {}
): PptGeometryShape {
  return {
    id,
    name: id,
    kind: 'shape',
    zIndex: 0,
    rect,
    rotationDegrees: 0,
    visible: true,
    opaque: false,
    decoration: false,
    informational: true,
    footer: false,
    ...overrides
  }
}

function document(...slides: PptGeometryShape[][]): PptGeometryDocument {
  return {
    size: { width: WIDTH, height: HEIGHT },
    slides: slides.map((shapes, index) => ({ path: `ppt/slides/slide${index + 1}.xml`, index, shapes }))
  }
}

function issuesFor(report: ReturnType<typeof auditParsedPptGeometry>, rule: string) {
  return report.issues.filter((issue) => issue.rule === rule)
}

describe('PPT geometry QA rules', () => {
  it('reports informational objects beyond 1pt while exempting full-slide decoration', () => {
    const report = auditParsedPptGeometry(document([
      shape('outside', { x: -30_000, y: 100_000, width: 200_000, height: 100_000 }),
      shape('background', { x: -100_000, y: -100_000, width: 1_200_000, height: 800_000 }, {
        kind: 'picture',
        decoration: true,
        informational: false,
        image: { crop: { left: 0, top: 0, right: 0, bottom: 0 }, unreadableReason: 'missing-media' }
      })
    ]))

    const bounds = issuesFor(report, 'bounds.out_of_slide')
    expect(bounds).toHaveLength(1)
    expect(bounds[0]).toMatchObject({ severity: 'error', shapeId: 'outside' })
    expect(bounds[0].rect).toEqual({ x: 0, y: 0.166667, width: 0.17, height: 0.166667 })
  })

  it('uses the rotated visual bounds instead of only the unrotated transform extent', () => {
    const report = auditParsedPptGeometry(document([
      shape('rotated', { x: 0, y: 100_000, width: 200_000, height: 400_000 }, {
        rotationDegrees: 90
      })
    ]))
    expect(issuesFor(report, 'bounds.out_of_slide')).toEqual([
      expect.objectContaining({ shapeId: 'rotated', severity: 'error' })
    ])
  })

  it('blocks confident text overflow, warns on marginal fit, and does not guess inherited metrics', () => {
    const report = auditParsedPptGeometry(document([
      shape('confident', { x: 0, y: 0, width: 120_000, height: 220_000 }, {
        text: text('This explicit text wraps onto many lines', 20)
      }),
      shape('marginal', { x: 250_000, y: 0, width: 150_000, height: 310_000 }, {
        text: text('wrap wrap', 10)
      }),
      shape('inherited', { x: 500_000, y: 0, width: 300_000, height: 100_000 }, {
        text: text('Inherited size', undefined)
      }),
      shape('autofit', { x: 0, y: 350_000, width: 100_000, height: 20_000 }, {
        text: text('Long autofit text that would overflow', 20, { autoFit: true })
      })
    ]))

    expect(issuesFor(report, 'text.overflow')).toEqual(expect.arrayContaining([
      expect.objectContaining({ shapeId: 'confident', severity: 'error' }),
      expect.objectContaining({ shapeId: 'inherited', severity: 'unchecked' })
    ]))
    expect(issuesFor(report, 'text.overflow').some((issue) => issue.shapeId === 'autofit')).toBe(false)
  })

  it('uses overlap thresholds and exempts groups and text-on-carrier compositions', () => {
    const warning = auditParsedPptGeometry(document([
      shape('left', { x: 0, y: 0, width: 200_000, height: 200_000 }, { zIndex: 0 }),
      shape('right', { x: 190_000, y: 0, width: 200_000, height: 200_000 }, { zIndex: 1 })
    ]))
    expect(issuesFor(warning, 'objects.overlap')).toEqual([
      expect.objectContaining({ severity: 'warning', shapeId: 'left', relatedShapeId: 'right' })
    ])

    const error = auditParsedPptGeometry(document([
      shape('left', { x: 0, y: 0, width: 200_000, height: 200_000 }, { zIndex: 0, text: text('Label', 12) }),
      shape('right', { x: 150_000, y: 0, width: 200_000, height: 200_000 }, { zIndex: 1, opaque: true })
    ]))
    expect(issuesFor(error, 'objects.overlap')).toEqual([
      expect.objectContaining({ severity: 'error', shapeId: 'left', relatedShapeId: 'right' })
    ])

    const exempt = auditParsedPptGeometry(document([
      shape('group-a', { x: 0, y: 0, width: 200_000, height: 200_000 }, { groupId: 'g', zIndex: 0 }),
      shape('group-b', { x: 10_000, y: 10_000, width: 200_000, height: 200_000 }, { groupId: 'g', zIndex: 1 }),
      shape('carrier', { x: 400_000, y: 0, width: 300_000, height: 200_000 }, { opaque: true, zIndex: 2 }),
      shape('label', { x: 450_000, y: 50_000, width: 200_000, height: 100_000 }, {
        zIndex: 3,
        text: text('Text on carrier', 12)
      })
    ]))
    expect(issuesFor(exempt, 'objects.overlap')).toHaveLength(0)
  })

  it('warns when body enters the safe zone and errors on actual footer collision except on covers', () => {
    const body = shape('body', { x: 100_000, y: 555_000, width: 400_000, height: 40_000 })
    const footer = shape('footer', { x: 100_000, y: 570_000, width: 400_000, height: 20_000 }, {
      informational: false,
      footer: true
    })
    const report = auditParsedPptGeometry(document([], [body, footer]), {
      coverSlideIndexes: [0],
      pageMarginPt: 2
    })

    expect(issuesFor(report, 'footer.safe_zone')).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'warning', slideIndex: 1, shapeId: 'body' }),
      expect.objectContaining({ severity: 'error', slideIndex: 1, shapeId: 'body', relatedShapeId: 'footer' })
    ]))

    const cover = auditParsedPptGeometry(document([body, footer]))
    expect(issuesFor(cover, 'footer.safe_zone')).toHaveLength(0)
  })

  it('checks effective cropped image ratios and leaves unreadable media non-blocking', () => {
    const picture = (id: string, width: number, image: PptGeometryShape['image']): PptGeometryShape =>
      shape(id, { x: 0, y: 0, width, height: 100_000 }, {
        kind: 'picture',
        decoration: true,
        informational: false,
        image
      })
    const report = auditParsedPptGeometry(document(
      [picture('warning', 105_000, {
        crop: { left: 0, top: 0, right: 0, bottom: 0 },
        dimensions: { width: 100, height: 100 }
      })],
      [picture('error', 120_000, {
        crop: { left: 0, top: 0, right: 0, bottom: 0 },
        dimensions: { width: 100, height: 100 }
      })],
      [picture('cropped-fit', 100_000, {
        crop: { left: 0.25, top: 0, right: 0.25, bottom: 0 },
        dimensions: { width: 200, height: 100 }
      })],
      [{ ...picture('rotated-fit', 200_000, {
        crop: { left: 0, top: 0, right: 0, bottom: 0 },
        dimensions: { width: 200, height: 100 }
      }), rotationDegrees: 90 }],
      [picture('unknown', 100_000, {
        crop: { left: 0, top: 0, right: 0, bottom: 0 },
        unreadableReason: 'unsupported-media'
      })]
    ))

    expect(issuesFor(report, 'image.aspect_ratio')).toEqual(expect.arrayContaining([
      expect.objectContaining({ shapeId: 'warning', severity: 'warning' }),
      expect.objectContaining({ shapeId: 'error', severity: 'error' }),
      expect.objectContaining({ shapeId: 'unknown', severity: 'unchecked' })
    ]))
    expect(issuesFor(report, 'image.aspect_ratio').some((issue) => issue.shapeId === 'cropped-fit')).toBe(false)
    expect(issuesFor(report, 'image.aspect_ratio').some((issue) => issue.shapeId === 'rotated-fit')).toBe(false)
  })

  it('enforces the minimum and caption font sizes while ignoring invisible runs', () => {
    const report = auditParsedPptGeometry(document([
      shape('tiny', { x: 0, y: 0, width: 300_000, height: 200_000 }, {
        text: text('tiny', 7, { autoFit: true })
      }),
      shape('caption', { x: 350_000, y: 0, width: 300_000, height: 200_000 }, {
        text: text('caption', 9, { autoFit: true })
      }),
      shape('hidden', { x: 700_000, y: 0, width: 200_000, height: 200_000 }, {
        text: text('hidden', 4, { autoFit: true, visible: false })
      }),
      shape('mixed', { x: 0, y: 250_000, width: 300_000, height: 200_000 }, {
        text: {
          ...text('', 12, { autoFit: true }),
          paragraphs: [{
            runs: [
              { text: 'explicit', fontSizePt: 12, visible: true },
              { text: ' inherited', visible: true }
            ],
            spaceBeforePt: 0,
            spaceAfterPt: 0
          }]
        }
      })
    ]), { captionSizePt: 12 })

    expect(issuesFor(report, 'text.minimum_font_size')).toEqual([
      expect.objectContaining({ shapeId: 'caption', severity: 'warning' }),
      expect.objectContaining({ shapeId: 'mixed', severity: 'unchecked' }),
      expect.objectContaining({ shapeId: 'tiny', severity: 'error' })
    ])
  })

  it('records external chart text metrics as unchecked instead of guessing', () => {
    const report = auditParsedPptGeometry(document([
      shape('chart', { x: 100_000, y: 100_000, width: 600_000, height: 300_000 }, {
        kind: 'graphic',
        graphicKind: 'chart'
      })
    ]))
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: 'text.minimum_font_size', severity: 'unchecked', shapeId: 'chart' }),
      expect.objectContaining({ rule: 'text.overflow', severity: 'unchecked', shapeId: 'chart' })
    ]))
    expect(report.counts.errors).toBe(0)
  })
})
