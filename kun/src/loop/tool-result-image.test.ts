import { afterEach, describe, expect, it } from 'vitest'
import type { TurnItem } from '../contracts/items.js'
import {
  capToolResultImages,
  clearTransientBrowserUseOutputsForTest,
  extractToolResultImages,
  isModelVisibleImageOutput,
  prepareBrowserUseToolResultForPersistence,
  rehydrateGeneratedImagesForForward,
  rehydrateTransientBrowserUseOutputsForForward,
  toolResultTextWithoutImages,
  type ToolResultImage
} from './tool-result-image.js'

function toolResult(id: string, output: unknown): Extract<TurnItem, { kind: 'tool_result' }> {
  return {
    id,
    turnId: 't1',
    threadId: 'th1',
    role: 'tool',
    status: 'completed',
    createdAt: '2026-01-01T00:00:00.000Z',
    kind: 'tool_result',
    toolName: 'computer_use',
    callId: id,
    toolKind: 'command_execution',
    output,
    isError: false
  }
}

const screenshot = (data: string) => ({
  kind: 'computer_screenshot',
  action: 'screenshot',
  screen: { width: 1280, height: 800 },
  images: [{ mime_type: 'image/png', data_base64: data, width: 1280, height: 800 }]
})

function genImageResult(id: string, isError = false): Extract<TurnItem, { kind: 'tool_result' }> {
  return {
    ...toolResult(id, {
      files: [{ relativePath: `.deepseekgui-images/${id}.png`, absolutePath: `/tmp/${id}.png` }],
      attachments: [{ id: `att_${id}` }],
      endpoint: 'generations'
    }),
    toolName: 'generate_image',
    isError
  }
}

const fakeResolve = async (): Promise<ToolResultImage> => ({
  mimeType: 'image/png',
  dataBase64: 'ZZZ',
  width: 24,
  height: 24
})

afterEach(() => {
  clearTransientBrowserUseOutputsForTest()
})

describe('rehydrateGeneratedImagesForForward', () => {
  it('augments the most recent generate_image into a model-visible image (copy only)', async () => {
    const history: TurnItem[] = [genImageResult('a')]
    const before = JSON.parse(JSON.stringify(history))
    const out = await rehydrateGeneratedImagesForForward(history, fakeResolve, 1)
    expect(out[0].kind).toBe('tool_result')
    if (out[0].kind === 'tool_result') {
      expect(isModelVisibleImageOutput(out[0].output)).toBe(true)
      expect((out[0].output as { data_base64?: string }).data_base64).toBe('ZZZ')
      // the original generate_image output is also preserved (files/attachments still there)
      expect((out[0].output as { files?: unknown }).files).toBeDefined()
    }
    // The input history is NEVER mutated — the persisted log stays base64-free.
    expect(history).toEqual(before)
  })

  it('forwards only the most recent N, leaving older generated images base64-free', async () => {
    const history: TurnItem[] = [genImageResult('older'), genImageResult('newer')]
    const out = await rehydrateGeneratedImagesForForward(history, fakeResolve, 1)
    const older = out[0]
    const newer = out[1]
    expect(newer.kind === 'tool_result' && isModelVisibleImageOutput(newer.output)).toBe(true)
    expect(older.kind === 'tool_result' && isModelVisibleImageOutput(older.output)).toBe(false)
  })

  it('skips error results and non-generate_image tools (returns history unchanged)', async () => {
    const history: TurnItem[] = [genImageResult('failed', true), toolResult('read1', { text: 'hi' })]
    const out = await rehydrateGeneratedImagesForForward(history, fakeResolve, 2)
    expect(out).toBe(history)
  })

  it('degrades to a no-op when the resolver throws (scope miss / missing file)', async () => {
    const history: TurnItem[] = [genImageResult('a')]
    const out = await rehydrateGeneratedImagesForForward(history, async () => {
      throw new Error('not authorized')
    }, 1)
    expect(out).toBe(history)
  })
})

describe('extractToolResultImages', () => {
  it('reads the read-tool single-image shape', () => {
    const images = extractToolResultImages({ kind: 'image', mime_type: 'image/png', data_base64: 'AAA', width: 10, height: 20 })
    expect(images).toEqual([{ mimeType: 'image/png', dataBase64: 'AAA', width: 10, height: 20 }])
  })

  it('reads the computer_use images-array shape', () => {
    expect(extractToolResultImages(screenshot('BBB'))).toEqual([
      { mimeType: 'image/png', dataBase64: 'BBB', width: 1280, height: 800 }
    ])
  })

  it('forwards bounded browser_use screenshots as model-visible images', () => {
    expect(extractToolResultImages({
      kind: 'browser_screenshot',
      code: 'screenshot',
      images: [{ mime_type: 'image/png', data_base64: 'BROWSER' }]
    })).toEqual([
      { mimeType: 'image/png', dataBase64: 'BROWSER' }
    ])
  })

  it('ignores non-image kinds and base64 from other tools', () => {
    expect(extractToolResultImages({ kind: 'generated', data_base64: 'CCC', mime_type: 'image/png' })).toEqual([])
    expect(extractToolResultImages({ note: 'hi' })).toEqual([])
    expect(isModelVisibleImageOutput({ kind: 'image', note: 'omitted' })).toBe(false)
  })
})

describe('Browser Use transient output redaction', () => {
  it('keeps screenshots out of persistence while forwarding them once in memory', () => {
    const original = {
      ...toolResult('browser-shot', {
        kind: 'browser_screenshot',
        images: [{ mime_type: 'image/png', data_base64: 'SECRET_SCREENSHOT' }]
      }),
      toolName: 'browser_use'
    }
    const persisted = prepareBrowserUseToolResultForPersistence(original)
    if (persisted.kind !== 'tool_result') throw new Error('expected tool result')
    expect(JSON.stringify(persisted.output)).not.toContain('SECRET_SCREENSHOT')
    expect(persisted.output).toMatchObject({ images_omitted: 1 })

    const forwarded = rehydrateTransientBrowserUseOutputsForForward([persisted])
    expect(JSON.stringify((forwarded[0] as { output: unknown }).output))
      .toContain('SECRET_SCREENSHOT')
    expect(rehydrateTransientBrowserUseOutputsForForward([persisted])).toBeInstanceOf(Array)
    expect(JSON.stringify(rehydrateTransientBrowserUseOutputsForForward([persisted])))
      .not.toContain('SECRET_SCREENSHOT')
  })

  it('removes all untrusted DOM content from the durable snapshot projection', () => {
    const original = {
      ...toolResult('browser-snapshot', {
        kind: 'browser_snapshot',
        snapshot: {
          nodes: [{
            ref: 'opaque-reference-1234',
            role: 'textbox',
            name: 'Search',
            value: 'private value'
          }]
        }
      }),
      toolName: 'browser_use'
    }
    const persisted = prepareBrowserUseToolResultForPersistence(original)
    if (persisted.kind !== 'tool_result') throw new Error('expected tool result')
    expect(JSON.stringify(persisted.output)).not.toContain('private value')
    expect(persisted.output).toMatchObject({
      snapshot: { title: '[redacted]', nodes: [], truncated: true },
      snapshot_nodes_omitted: 1
    })
  })
})

describe('toolResultTextWithoutImages', () => {
  it('drops base64/images but keeps metadata', () => {
    const text = toolResultTextWithoutImages(screenshot('HUGE'))
    expect(text).not.toContain('HUGE')
    expect(text).toContain('computer_screenshot')
    expect(text).toContain('1280')
  })
})

describe('capToolResultImages', () => {
  it('keeps only the most recent N image results inline', () => {
    const history: TurnItem[] = [
      toolResult('a', screenshot('IMG_A')),
      toolResult('b', screenshot('IMG_B')),
      toolResult('c', screenshot('IMG_C')),
      toolResult('d', screenshot('IMG_D'))
    ]
    const capped = capToolResultImages(history, 2)
    const kept = capped.filter((item) => item.kind === 'tool_result' && isModelVisibleImageOutput(item.output))
    expect(kept).toHaveLength(2)
    // The two oldest are evicted, the two newest retained.
    expect(isModelVisibleImageOutput((capped[0] as { output: unknown }).output)).toBe(false)
    expect(isModelVisibleImageOutput((capped[1] as { output: unknown }).output)).toBe(false)
    expect(extractToolResultImages((capped[3] as { output: unknown }).output)[0]?.dataBase64).toBe('IMG_D')
  })

  it('is a no-op when within the cap', () => {
    const history: TurnItem[] = [toolResult('a', screenshot('IMG_A'))]
    expect(capToolResultImages(history, 3)).toBe(history)
  })

  it('removes the top-level base64 field instead of forwarding a placeholder as an image', () => {
    const history: TurnItem[] = [
      toolResult('a', { kind: 'image', mime_type: 'image/png', data_base64: 'IMG_A' }),
      toolResult('b', { kind: 'image', mime_type: 'image/png', data_base64: 'IMG_B' })
    ]

    const capped = capToolResultImages(history, 1)

    expect(isModelVisibleImageOutput((capped[0] as { output: unknown }).output)).toBe(false)
    expect((capped[0] as { output: Record<string, unknown> }).output).not.toHaveProperty('data_base64')
    expect(isModelVisibleImageOutput((capped[1] as { output: unknown }).output)).toBe(true)
  })
})
