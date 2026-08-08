import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  convertPptdToCanvas,
  PPT_TO_BOARD_BATCH_SIZE,
  sliceOpsForBatch,
  type PptBoardOp
} from './pptd-to-canvas.js'

const DECK = [
  'version: v2',
  'title: 测试 Deck',
  'size: [960, 540]',
  'theme:',
  '  colors:',
  '    primary: "#FF6900"',
  '    white: "#FFFFFF"',
  '  textStyles:',
  '    coverTitle:',
  '      fontSize: 42',
  '      color: "$white"',
  '      bold: true',
  'pages:',
  '  - pages/1_cover.page',
  '  - pages/2_body.page'
].join('\n')

const COVER_PAGE = [
  'pageType: cover',
  'title: 封面',
  'background:',
  '  type: solid',
  '  color: "#000000"',
  'elements:',
  '  - elementId: overlay',
  '    elementType: shape',
  '    bounds: [0, 0, 960, 540]',
  '    shapeName: rect',
  '    fill: {type: solid, color: "#000000F2"}',
  '  - elementId: cover-title',
  '    elementType: text',
  '    bounds: [60, 150, 660, 130]',
  '    content:',
  '      style: "$coverTitle"',
  '      align: [center, middle]',
  '      text: "小米 YU7"',
  '  - elementId: accent-line',
  '    elementType: shape',
  '    bounds: [60, 86, 56, 3]',
  '    shapeName: rect',
  '    fill: {type: solid, color: "$primary"}',
  '  - elementId: cover-bg',
  '    elementType: image',
  '    bounds: [0, 0, 960, 540]',
  '    src: "media/bg_cover.jpg"',
  '  - elementId: divider',
  '    elementType: line',
  '    bounds: [60, 300, 400, 2]',
  '    border: {style: solid, width: 2, color: "$primary"}'
].join('\n')

const BODY_PAGE = [
  'pageType: content',
  'title: 正文',
  'elements:',
  '  - elementId: body-text',
  '    elementType: text',
  '    bounds: [80, 120, 700, 200]',
  '    content:',
  '      fontSize: 15',
  '      color: "$primary"',
  '      lineHeight: 1.6',
  '      text: |',
  '        <p>Revenue <strong>82.5</strong></p>',
  '  - elementId: growth-chart',
  '    elementType: chart',
  '    bounds: [80, 340, 400, 160]',
  '    chartType: bar',
  '    title:',
  '      text: 增长趋势'
].join('\n')

async function makeDeck(extraOps?: (dir: string) => Promise<void>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pptd-to-canvas-'))
  await mkdir(join(dir, 'pages'))
  await mkdir(join(dir, 'media'))
  await writeFile(join(dir, 'deck.pptd'), DECK)
  await writeFile(join(dir, 'pages', '1_cover.page'), COVER_PAGE)
  await writeFile(join(dir, 'pages', '2_body.page'), BODY_PAGE)
  await writeFile(join(dir, 'media', 'bg_cover.jpg'), 'jpeg-placeholder')
  await extraOps?.(dir)
  return dir
}

function findOp(ops: PptBoardOp[], type: string): PptBoardOp | undefined {
  return ops.find((op) => (op.op === 'add' ? op.shape.type === type : false))
}

describe('pptd-to-canvas', () => {
  it('emits add-screen ops in a 2-column grid with fixed gaps', async () => {
    const dir = await makeDeck()
    try {
      const result = await convertPptdToCanvas(join(dir, 'deck.pptd'))
      expect(result.pageCount).toBe(2)
      expect(result.boardTitle).toContain('测试 Deck')
      const screens = result.ops.filter((op) => op.op === 'add-screen')
      expect(screens).toHaveLength(2)
      expect(screens[0]).toMatchObject({ x: 0, y: 0, width: 960, height: 540 })
      expect(screens[1]).toMatchObject({ x: 1040, y: 0, width: 960, height: 540 })
      expect(screens[0].name).toContain('封面')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('resolves theme tokens and 8-digit alpha colors', async () => {
    const dir = await makeDeck()
    try {
      const result = await convertPptdToCanvas(join(dir, 'deck.pptd'))
      const rects = result.ops.filter(
        (op) => op.op === 'add' && op.shape.type === 'rect'
      )
      // overlay: #000000F2 → #000000 + opacity 242/255
      const overlay = rects.find((op) => op.op === 'add' && op.shape.name === 'overlay')
      expect(overlay).toBeDefined()
      if (overlay?.op === 'add') {
        expect(overlay.shape.fills).toEqual([
          { type: 'solid', color: '#000000', opacity: Math.round((242 / 255) * 1000) / 1000 }
        ])
      }
      // accent-line: $primary → #FF6900
      const accent = rects.find((op) => op.op === 'add' && op.shape.name === 'accent-line')
      if (accent?.op === 'add') {
        expect(accent.shape.fills).toEqual([{ type: 'solid', color: '#FF6900', opacity: 1 }])
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('merges theme text style refs and maps alignment/bold', async () => {
    const dir = await makeDeck()
    try {
      const result = await convertPptdToCanvas(join(dir, 'deck.pptd'))
      const text = findOp(result.ops, 'text')
      expect(text).toBeDefined()
      if (text?.op === 'add') {
        expect(text.shape).toMatchObject({
          name: 'cover-title',
          textContent: '小米 YU7',
          fontSize: 42,
          fontWeight: 700,
          fontColor: '#FFFFFF',
          textAlign: 'center'
        })
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('strips rich text and resolves relative media paths to workspace paths', async () => {
    const dir = await makeDeck()
    try {
      const result = await convertPptdToCanvas(join(dir, 'deck.pptd'), {
        workspaceRoot: dir
      })
      const bodyText = result.ops.find(
        (op) => op.op === 'add' && op.shape.name === 'body-text'
      )
      if (bodyText?.op === 'add') {
        expect(bodyText.shape.textContent).toBe('Revenue 82.5')
      }
      const image = result.ops.find(
        (op) => op.op === 'add' && op.shape.name === 'cover-bg'
      )
      if (image?.op === 'add') {
        // media/bg_cover.jpg resolves to the workspace-relative path.
        expect(image.shape.imageUrl).toBe('media/bg_cover.jpg')
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('maps lines to point shapes and charts to editable placeholders', async () => {
    const dir = await makeDeck()
    try {
      const result = await convertPptdToCanvas(join(dir, 'deck.pptd'))
      const line = result.ops.find((op) => op.op === 'add' && op.shape.type === 'line')
      expect(line).toBeDefined()
      if (line?.op === 'add') {
        expect(line.shape.points).toEqual([
          { x: 60, y: 300 },
          { x: 460, y: 302 }
        ])
      }
      const chartTexts = result.ops.filter(
        (op) =>
          op.op === 'add' &&
          op.shape.type === 'text' &&
          (op.shape.textContent ?? '').includes('图表占位')
      )
      expect(chartTexts.length).toBeGreaterThan(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('converts tables into a rect + text grid', async () => {
    const dir = await makeDeck(async (d) => {
      await writeFile(
        join(d, 'pages', '2_body.page'),
        [
          'pageType: content',
          'elements:',
          '  - elementId: table1',
          '    elementType: table',
          '    bounds: [80, 120, 600, 200]',
          '    columnWidths: [0.5, 0.5]',
          '    rowHeights: [0.5, 0.5]',
          '    rows:',
          '      - - text: "指标"',
          '        - text: "数值"',
          '      - - text: "营收"',
          '        - text: "82.5"'
        ].join('\n')
      )
    })
    try {
      const result = await convertPptdToCanvas(join(dir, 'deck.pptd'))
      const texts = result.ops.filter(
        (op) => op.op === 'add' && op.shape.type === 'text'
      )
      const cellTexts = texts
        .map((op) => (op.op === 'add' ? op.shape.textContent : undefined))
        .filter((t): t is string => t !== undefined)
      expect(cellTexts).toEqual(expect.arrayContaining(['指标', '数值', '营收', '82.5']))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('slices converted ops into deterministic ≤100-op batches', async () => {
    const dir = await makeDeck()
    try {
      const result = await convertPptdToCanvas(join(dir, 'deck.pptd'))
      const ops = result.ops
      const first = sliceOpsForBatch(ops, 0)
      expect(first.ops.length).toBeLessThanOrEqual(PPT_TO_BOARD_BATCH_SIZE)
      expect(first.batchCount).toBe(1)
      expect(first.more).toBe(false)

      const many = Array.from({ length: 250 }, (_, i) => ({
        op: 'add' as const,
        shape: { type: 'rect' as const, x: i, y: 0, width: 10, height: 10 }
      }))
      const b0 = sliceOpsForBatch(many, 0)
      const b1 = sliceOpsForBatch(many, 1)
      const b2 = sliceOpsForBatch(many, 2)
      expect(b0.ops).toHaveLength(100)
      expect(b0.more).toBe(true)
      expect(b1.ops).toHaveLength(100)
      expect(b1.more).toBe(true)
      expect(b2.ops).toHaveLength(50)
      expect(b2.more).toBe(false)
      expect(b2.batchCount).toBe(3)
      expect(sliceOpsForBatch(many, 99).ops).toHaveLength(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns readable errors for missing files and invalid YAML', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pptd-to-canvas-err-'))
    try {
      await expect(
        convertPptdToCanvas(join(dir, 'nope.pptd'))
      ).rejects.toThrow(/无法读取/)
      await writeFile(join(dir, 'bad.pptd'), 'pages: [unclosed\n  : :')
      await expect(
        convertPptdToCanvas(join(dir, 'bad.pptd'))
      ).rejects.toThrow()
      await writeFile(join(dir, 'empty.pptd'), '---\n')
      await expect(
        convertPptdToCanvas(join(dir, 'empty.pptd'))
      ).rejects.toThrow(/不是有效的 YAML 映射/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
