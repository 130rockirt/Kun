import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CapabilityRegistry } from './capability-registry.js'
import { LocalToolHost } from './local-tool-host.js'
import {
  PPT_TO_BOARD_PROVIDER_ID,
  PPT_TO_BOARD_TOOL_NAME,
  buildPptBoardLocalTools
} from './ppt-board-tool.js'

const baseContext = {
  threadId: 'thr_main',
  turnId: 'turn_main',
  workspace: '/workspace',
  agentSurface: 'code' as const,
  clientSurface: 'gui' as const,
  approvalPolicy: 'auto' as const,
  approvalReviewer: 'user' as const,
  awaitApproval: async () => 'allow' as const,
  abortSignal: new AbortController().signal
}

const DECK_PPTD = `version: v2
title: 测试演示
size: [960, 540]
theme:
  colors:
    primary: "#FF6900"
    white: "#FFFFFF"
pages:
- pages/cover.page
- pages/body.page
`

const COVER_PAGE = `pageType: cover
background:
  type: solid
  color: "#000000"
elements:
- elementId: title
  elementType: text
  bounds: [60, 150, 660, 130]
  content:
    fontSize: 42
    color: "$white"
    text: "封面标题"
- elementId: accent
  elementType: shape
  bounds: [60, 86, 56, 3]
  shapeName: rect
  fill: {type: solid, color: "$primary"}
- elementId: cover-img
  elementType: image
  bounds: [60, 300, 300, 180]
  src: "media/cover.jpg"
`

const BODY_PAGE = `pageType: content
elements:
- elementId: heading
  elementType: text
  bounds: [60, 40, 400, 40]
  content:
    fontSize: 24
    text: "正文标题"
- elementId: cell
  elementType: shape
  bounds: [60, 100, 200, 120]
  shapeName: roundRect
  fill: {type: solid, color: "$primary"}
`

async function writeFixture(workspace: string): Promise<void> {
  await mkdir(join(workspace, 'deck', 'pages'), { recursive: true })
  await writeFile(join(workspace, 'deck', 'deck.pptd'), DECK_PPTD, 'utf8')
  await writeFile(join(workspace, 'deck', 'pages', 'cover.page'), COVER_PAGE, 'utf8')
  await writeFile(join(workspace, 'deck', 'pages', 'body.page'), BODY_PAGE, 'utf8')
}

describe('ppt_to_board tool', () => {
  let dir: string
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('advertises only in guiDesignCanvas contexts', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ppt-board-tool-'))
    const host = new LocalToolHost({
      registry: new CapabilityRegistry([
        {
          id: PPT_TO_BOARD_PROVIDER_ID,
          kind: 'gui',
          enabled: true,
          available: true,
          tools: buildPptBoardLocalTools()
        }
      ])
    })
    expect(await host.listTools({ ...baseContext, guiDesignCanvas: true })).toHaveLength(1)
    const tools = await host.listTools({ ...baseContext, guiDesignCanvas: true })
    expect(tools[0]?.name).toBe(PPT_TO_BOARD_TOOL_NAME)
    expect(await host.listTools(baseContext)).toEqual([])
    expect(await host.listTools({ ...baseContext, guiDesignCanvas: false })).toEqual([])
  })

  it('converts a deck into screens and shapes', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ppt-board-tool-'))
    await writeFixture(dir)
    const tool = buildPptBoardLocalTools()[0]
    const result = await tool.execute(
      { pptdPath: 'deck/deck.pptd' },
      { ...baseContext, workspace: dir, guiDesignCanvas: true }
    )
    expect(result.isError).toBeFalsy()
    const output = result.output as {
      ops: Array<Record<string, unknown>>
      boardTitle: string
      pageCount: number
      more: boolean
    }
    expect(output.pageCount).toBe(2)
    expect(output.boardTitle).toContain('测试演示')
    expect(output.more).toBe(false)
    const screens = output.ops.filter((op) => op.op === 'add-screen')
    expect(screens).toHaveLength(2)
    // Grid layout: second page sits to the right of the first (960 + 80 gap).
    expect(screens[0]).toMatchObject({ x: 0, y: 0, width: 960, height: 540 })
    expect(screens[1]).toMatchObject({ x: 1040, y: 0 })
    const texts = output.ops.filter((op) => op.op === 'add' && (op.shape as { type?: string }).type === 'text')
    expect(texts.some((op) => (op.shape as { textContent?: string }).textContent === '封面标题')).toBe(true)
    expect(texts.some((op) => (op.shape as { textContent?: string }).textContent === '正文标题')).toBe(true)
    // Theme token resolved on the accent rect.
    const rects = output.ops.filter((op) => op.op === 'add' && (op.shape as { type?: string }).type === 'rect')
    expect(rects.some((op) =>
      (op.shape as { fills?: Array<{ color: string }> }).fills?.[0]?.color === '#FF6900')).toBe(true)
  })

  it('batches large decks and returns the more flag', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ppt-board-tool-'))
    await writeFixture(dir)
    // 120 text elements on the body page push total ops past 100, so
    // batch 0 returns 100 ops with more=true and a second batch finishes.
    const manyBody = Array.from({ length: 120 }, (_, i) => [
      `- elementId: extra-${i}`,
      '  elementType: text',
      `  bounds: [${60 + i}, 200, 200, 20]`,
      '  content:',
      '    fontSize: 12',
      `    text: "额外 ${i}"`
    ].join('\n')).join('\n')
    await writeFile(join(dir, 'deck', 'pages', 'body.page'), `${BODY_PAGE}\n${manyBody}`, 'utf8')
    const tool = buildPptBoardLocalTools()[0]
    const first = await tool.execute(
      { pptdPath: 'deck/deck.pptd', batch: 0 },
      { ...baseContext, workspace: dir, guiDesignCanvas: true }
    )
    const firstOut = first.output as { ops: unknown[]; more: boolean; batch: number; batchCount: number }
    expect(firstOut.more).toBe(true)
    expect(firstOut.batch).toBe(0)
    expect(firstOut.ops.length).toBeLessThanOrEqual(100)
    const last = await tool.execute(
      { pptdPath: 'deck/deck.pptd', batch: firstOut.batchCount - 1 },
      { ...baseContext, workspace: dir, guiDesignCanvas: true }
    )
    const lastOut = last.output as { more: boolean; ops: unknown[] }
    expect(lastOut.more).toBe(false)
    expect(lastOut.ops.length).toBeGreaterThan(0)
  })

  it('returns a readable error for a missing deck', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ppt-board-tool-'))
    const tool = buildPptBoardLocalTools()[0]
    const result = await tool.execute(
      { pptdPath: 'deck/nope.pptd' },
      { ...baseContext, workspace: dir, guiDesignCanvas: true }
    )
    expect(result.isError).toBe(true)
    expect((result.output as { error: string }).error).toContain('无法读取')
  })

  it('rejects a missing pptdPath argument', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ppt-board-tool-'))
    const tool = buildPptBoardLocalTools()[0]
    const result = await tool.execute({}, { ...baseContext, workspace: dir, guiDesignCanvas: true })
    expect(result.isError).toBe(true)
    expect((result.output as { error: string }).error).toBe('pptdPath is required')
  })
})
