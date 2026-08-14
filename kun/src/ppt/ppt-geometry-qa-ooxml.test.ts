import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { afterEach, describe, expect, it } from 'vitest'
import * as yazl from 'yazl'
import {
  auditPptGeometryParts,
  auditPptxGeometry,
  parsePptxGeometryParts,
  readPptxGeometryParts,
  type PptxGeometryParts
} from './ppt-geometry-qa.js'

const WIDTH = 12_192_000
const HEIGHT = 6_858_000
const roots: string[] = []
const namespaces = [
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
].join(' ')

function transform(x: number, y: number, width: number, height: number, rotation = 0): string {
  return `<a:xfrm${rotation ? ` rot="${rotation * 60000}"` : ''}><a:off x="${x}" y="${y}"/><a:ext cx="${width}" cy="${height}"/></a:xfrm>`
}

function shape(input: {
  id: string
  name?: string
  x: number
  y: number
  width: number
  height: number
  text?: string
  fontSize?: number
  hidden?: boolean
  fill?: boolean
}): string {
  const text = input.text === undefined ? '' : [
    '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r>',
    `<a:rPr${input.fontSize ? ` sz="${input.fontSize * 100}"` : ''}/>`,
    `<a:t>${input.text}</a:t>`,
    '</a:r></a:p></p:txBody>'
  ].join('')
  return [
    '<p:sp>',
    `<p:nvSpPr><p:cNvPr id="${input.id}" name="${input.name ?? input.id}"${input.hidden ? ' hidden="1"' : ''}/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`,
    `<p:spPr>${transform(input.x, input.y, input.width, input.height)}${input.fill ? '<a:solidFill><a:srgbClr val="335577"/></a:solidFill>' : '<a:noFill/>'}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>`,
    text,
    '</p:sp>'
  ].join('')
}

function picture(id: string, relationshipId: string, crop = ''): string {
  return [
    '<p:pic>',
    `<p:nvPicPr><p:cNvPr id="${id}" name="photo-${id}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>`,
    `<p:blipFill><a:blip r:embed="${relationshipId}"/>${crop}<a:stretch><a:fillRect/></a:stretch></p:blipFill>`,
    `<p:spPr>${transform(1_000_000, 1_000_000, 2_000_000, 2_000_000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>`,
    '</p:pic>'
  ].join('')
}

function group(child: string): string {
  return [
    '<p:grpSp>',
    '<p:nvGrpSpPr><p:cNvPr id="20" name="group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>',
    '<p:grpSpPr><a:xfrm><a:off x="100000" y="200000"/><a:ext cx="400000" cy="200000"/><a:chOff x="0" y="0"/><a:chExt cx="200000" cy="100000"/></a:xfrm></p:grpSpPr>',
    child,
    '</p:grpSp>'
  ].join('')
}

function tableFrame(): string {
  const cell = (text: string, size: number) => [
    '<a:tc>',
    `<a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="${size * 100}"/><a:t>${text}</a:t></a:r></a:p></a:txBody>`,
    '<a:tcPr marL="10000" marR="10000" marT="10000" marB="10000"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:tcPr>',
    '</a:tc>'
  ].join('')
  return [
    '<p:graphicFrame>',
    '<p:nvGraphicFramePr><p:cNvPr id="30" name="metrics-table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>',
    `<p:xfrm><a:off x="1000000" y="1000000"/><a:ext cx="4000000" cy="2000000"/></p:xfrm>`,
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">',
    '<a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="2000000"/><a:gridCol w="2000000"/></a:tblGrid>',
    `<a:tr h="2000000">${cell('Tiny', 7)}${cell('Normal', 12)}</a:tr>`,
    '</a:tbl></a:graphicData></a:graphic>',
    '</p:graphicFrame>'
  ].join('')
}

function slideXml(contents: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><p:sld ${namespaces}><p:cSld><p:spTree>${contents}</p:spTree></p:cSld></p:sld>`
}

function relationships(entries: Array<{ id: string; target: string; external?: boolean }>): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    ...entries.map((entry) => `<Relationship Id="${entry.id}" Type="image" Target="${entry.target}"${entry.external ? ' TargetMode="External"' : ''}/>`),
    '</Relationships>'
  ].join('')
}

function presentation(order: string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<p:presentation ${namespaces}><p:sldIdLst>`,
    ...order.map((id, index) => `<p:sldId id="${256 + index}" r:id="${id}"/>`),
    `</p:sldIdLst><p:sldSz cx="${WIDTH}" cy="${HEIGHT}"/></p:presentation>`
  ].join('')
}

function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer)
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

function parts(): PptxGeometryParts {
  const grouped = group(shape({
    id: '3',
    x: 10_000,
    y: 10_000,
    width: 50_000,
    height: 20_000,
    text: 'Grouped',
    fontSize: 12
  }))
  return {
    presentationXml: presentation(['rIdSecond', 'rIdFirst']),
    presentationRelationshipsXml: relationships([
      { id: 'rIdFirst', target: 'slides/slide1.xml' },
      { id: 'rIdSecond', target: 'slides/slide2.xml' }
    ]),
    slides: [
      {
        path: 'ppt/slides/slide1.xml',
        xml: slideXml(grouped + shape({
          id: '4', x: 0, y: 0, width: 1_000_000, height: 1_000_000
        }))
      },
      {
        path: 'ppt/slides/slide2.xml',
        xml: slideXml(
          picture('5', 'rIdImage', '<a:srcRect l="25000" r="25000"/>') +
          picture('6', 'rIdExternal')
        ),
        relationshipsXml: relationships([
          { id: 'rIdImage', target: '../media/image1.png' },
          { id: 'rIdExternal', target: 'https://example.com/image.png', external: true }
        ])
      }
    ],
    media: new Map([['ppt/media/image1.png', png(200, 100)]])
  }
}

async function pptxFixture(input: PptxGeometryParts): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kun-ppt-geometry-ooxml-'))
  roots.push(root)
  const path = join(root, 'deck.pptx')
  const zip = new yazl.ZipFile()
  zip.addBuffer(Buffer.from(input.presentationXml), 'ppt/presentation.xml')
  if (input.presentationRelationshipsXml) {
    zip.addBuffer(Buffer.from(input.presentationRelationshipsXml), 'ppt/_rels/presentation.xml.rels')
  }
  for (const slide of input.slides) {
    zip.addBuffer(Buffer.from(slide.xml), slide.path)
    if (slide.relationshipsXml) {
      const base = slide.path.split('/').pop()
      zip.addBuffer(Buffer.from(slide.relationshipsXml), `ppt/slides/_rels/${base}.rels`)
    }
  }
  for (const [mediaPath, bytes] of input.media ?? []) zip.addBuffer(Buffer.from(bytes), mediaPath)
  zip.end()
  await pipeline(zip.outputStream, createWriteStream(path))
  return path
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('PPT geometry OOXML parser', () => {
  it('honors presentation order and parses groups, relationships, crop, and media dimensions', () => {
    const parsed = parsePptxGeometryParts(parts())

    expect(parsed.size).toEqual({ width: WIDTH, height: HEIGHT })
    expect(parsed.slides.map((slide) => slide.path)).toEqual([
      'ppt/slides/slide2.xml',
      'ppt/slides/slide1.xml'
    ])
    expect(parsed.slides[0].shapes[0]).toMatchObject({
      id: '5',
      kind: 'picture',
      image: {
        target: 'ppt/media/image1.png',
        dimensions: { width: 200, height: 100 },
        crop: { left: 0.25, top: 0, right: 0.25, bottom: 0 }
      }
    })
    expect(parsed.slides[0].shapes[1].image).toMatchObject({ unreadableReason: 'external' })
    expect(parsed.slides[1].shapes[0]).toMatchObject({
      id: '3',
      groupId: '20',
      rect: { x: 120_000, y: 220_000, width: 100_000, height: 40_000 }
    })
    expect(parsed.slides[1].shapes[1]).toMatchObject({ id: '4', informational: false })
  })

  it('reads a PPTX package and exposes the same audit through the file facade', async () => {
    const input = parts()
    input.slides[0].xml = slideXml(shape({
      id: '9',
      x: -50_000,
      y: 500_000,
      width: 2_000_000,
      height: 500_000,
      text: 'Outside',
      fontSize: 18
    }))
    const path = await pptxFixture(input)

    const unpacked = await readPptxGeometryParts(path)
    expect(unpacked.slides).toHaveLength(2)
    expect(unpacked.media?.get('ppt/media/image1.png')).toBeDefined()

    const report = await auditPptxGeometry(path)
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: 'bounds.out_of_slide', severity: 'error', shapeId: '9' })
    ]))
  })

  it('projects inline table cells with explicit text metrics and cell geometry', () => {
    const input: PptxGeometryParts = {
      presentationXml: presentation(['rId1']),
      presentationRelationshipsXml: relationships([{ id: 'rId1', target: 'slides/slide1.xml' }]),
      slides: [{ path: 'ppt/slides/slide1.xml', xml: slideXml(tableFrame()) }]
    }
    const parsed = parsePptxGeometryParts(input)

    expect(parsed.slides[0].shapes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: '30', kind: 'graphic', graphicKind: 'table', groupId: 'table:30' }),
      expect.objectContaining({
        id: '30:cell-1-1',
        groupId: 'table:30',
        rect: { x: 1_000_000, y: 1_000_000, width: 2_000_000, height: 2_000_000 }
      }),
      expect.objectContaining({
        id: '30:cell-1-2',
        rect: { x: 3_000_000, y: 1_000_000, width: 2_000_000, height: 2_000_000 }
      })
    ]))
    expect(auditPptGeometryParts(input, { captionSizePt: 10 }).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rule: 'text.minimum_font_size',
        severity: 'error',
        shapeId: '30:cell-1-1'
      })
    ]))
  })

  it('rejects XML entity declarations before parsing', () => {
    expect(() => parsePptxGeometryParts({
      presentationXml: '<!DOCTYPE p [<!ENTITY x "bad">]><p:presentation/>',
      slides: [{ path: 'ppt/slides/slide1.xml', xml: '<p:sld/>' }]
    })).toThrow(/forbidden XML declaration/)
  })

  it('uses direct fill and paragraph defaults without treating unrelated descendants as shape paint', () => {
    const xml = slideXml([
      '<p:sp>',
      '<p:nvSpPr><p:cNvPr id="41" name="text-defaults"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>',
      `<p:spPr>${transform(0, 0, 2_000_000, 1_000_000)}<a:noFill/><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>`,
      '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="700"/></a:pPr>',
      '<a:r><a:t>Tiny</a:t></a:r></a:p></p:txBody>',
      '</p:sp>'
    ].join(''))
    const input: PptxGeometryParts = {
      presentationXml: presentation(['rId1']),
      presentationRelationshipsXml: relationships([{ id: 'rId1', target: 'slides/slide1.xml' }]),
      slides: [{ path: 'ppt/slides/slide1.xml', xml }]
    }

    const parsed = parsePptxGeometryParts(input)
    expect(parsed.slides[0].shapes[0]).toMatchObject({ id: '41', opaque: false })
    expect(auditPptGeometryParts(input).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rule: 'text.minimum_font_size', severity: 'error', shapeId: '41'
      })
    ]))
  })
})
