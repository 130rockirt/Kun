import JSZip from 'jszip'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertRenderablePptxPreviewModel,
  preparePptxPreviewPackage
} from './workspace-pptx-preview-compat'

describe('PPTX browser preview compatibility', () => {
  let dom: JSDOM

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body></body></html>')
    vi.stubGlobal('window', dom.window)
  })

  afterEach(() => {
    dom.window.close()
    vi.unstubAllGlobals()
  })

  it('repairs singleton theme line styles and removes missing declared parts in memory', async () => {
    const source = await pptxFixture({ singletonLineStyle: true, includeMissingOverride: true })
    const repaired = await preparePptxPreviewPackage(source)

    expect(repaired).not.toBe(source)
    const archive = await JSZip.loadAsync(repaired)
    const contentTypes = await archive.file('[Content_Types].xml')!.async('string')
    const theme = await archive.file('ppt/theme/theme1.xml')!.async('string')
    expect(contentTypes).not.toContain('slideMaster2.xml')
    expect(xmlElements(theme, 'lnStyleLst')[0]?.children).toHaveLength(3)
  })

  it('returns the original buffer when the package needs no compatibility repair', async () => {
    const source = await pptxFixture({ singletonLineStyle: false, includeMissingOverride: false })
    await expect(preparePptxPreviewPackage(source)).resolves.toBe(source)
  })

  it('preserves the original renderer failure path for invalid ZIP input', async () => {
    const source = new Uint8Array([1, 2, 3]).buffer
    await expect(preparePptxPreviewPackage(source)).resolves.toBe(source)
  })

  it('fills absent backgrounds but rejects incomplete slide inheritance', () => {
    const master = {}
    const layout = { slideMaster: master }
    const model = { slides: [{ slideLayout: layout }] }
    assertRenderablePptxPreviewModel(model)
    expect(model.slides[0]).toMatchObject({ background: { type: 'none' } })
    expect(layout).toMatchObject({ background: { type: 'none' } })
    expect(master).toMatchObject({ background: { type: 'none' } })

    expect(() => assertRenderablePptxPreviewModel({ slides: [{}] }))
      .toThrow('incomplete slide layout or master data')
  })
})

async function pptxFixture({
  singletonLineStyle,
  includeMissingOverride
}: {
  singletonLineStyle: boolean
  includeMissingOverride: boolean
}): Promise<ArrayBuffer> {
  const archive = new JSZip()
  const missingOverride = includeMissingOverride
    ? '<Override PartName="/ppt/slideMasters/slideMaster2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>'
    : ''
  archive.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
      <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
      ${missingOverride}
    </Types>`)
  const line = '<a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'
  archive.file('ppt/theme/theme1.xml', `<?xml version="1.0" encoding="UTF-8"?>
    <a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <a:themeElements><a:fmtScheme><a:lnStyleLst>${
        singletonLineStyle ? line : `${line}${line}${line}`
      }</a:lnStyleLst></a:fmtScheme></a:themeElements>
    </a:theme>`)
  archive.file('ppt/slideMasters/slideMaster1.xml', '<p:sldMaster xmlns:p="urn:p"/>')
  return archive.generateAsync({ type: 'arraybuffer' })
}

function xmlElements(source: string, localName: string): Element[] {
  const document = new window.DOMParser().parseFromString(source, 'application/xml')
  return Array.from(document.getElementsByTagName('*')).filter((element) => (
    element.localName === localName
  ))
}
