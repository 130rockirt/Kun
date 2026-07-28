import { createElement } from 'react'
import { act, create as createRenderer, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LlmDebugRequestBrowser,
  paginateLlmDebugRounds,
  sortLlmDebugRoundsNewestFirst,
  type LlmDebugRound
} from './settings-section-llm-debug'

const labels: Record<string, string> = {
  llmDebugRecords: 'Request records',
  llmDebugRecordCount: '{{count}} total · {{pageSize}} per page',
  llmDebugNewestFirst: 'Newest first',
  llmDebugStatusCompleted: 'Completed',
  llmDebugStatusToolCalls: 'Tool calls',
  llmDebugStatusError: 'Error',
  llmDebugEndpoint: 'Endpoint',
  llmDebugProvider: 'Provider',
  llmDebugStopReason: 'Stop reason',
  llmDebugDuration: 'Duration',
  llmDebugViewDetails: 'View full details',
  llmDebugDetails: 'Request details',
  llmDebugOverview: 'Overview',
  llmDebugRequestBody: 'Request body',
  llmDebugRawResponse: 'Raw response',
  llmDebugModel: 'Model',
  llmDebugStatus: 'Status',
  llmDebugTime: 'Time',
  llmDebugRequestContext: 'Request context',
  llmDebugOutputSummary: 'Output summary',
  llmDebugSelectRequest: 'Select a request',
  llmDebugSelectRequestDesc: 'Choose a record.',
  llmDebugCopyJson: 'Copy JSON',
  llmDebugCopied: 'Copied',
  llmDebugPageRange: '{{start}}–{{end}} / {{count}}',
  llmDebugPagination: 'Request history pages',
  llmDebugPageNumber: 'Page {{page}}',
  previousPage: 'Previous page',
  nextPage: 'Next page',
  close: 'Close',
  done: 'Done'
}

function t(key: string, options?: Record<string, unknown>): string {
  const template = labels[key] ?? key
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name] ?? ''))
}

function round(id: number, overrides: Partial<LlmDebugRound> = {}): LlmDebugRound {
  return {
    id,
    threadId: `thread-${id}`,
    turnId: `turn-${id}`,
    provider: 'deepseek',
    model: 'gpt-5.6-sol',
    url: 'https://api.example.com/v1/chat/completions',
    startedAt: new Date(Date.UTC(2026, 6, 26, 19, 38, id)).toISOString(),
    finishedAt: new Date(Date.UTC(2026, 6, 26, 19, 38, id + 1)).toISOString(),
    durationMs: id * 100,
    requestBody: {
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: `request-${id}` }]
    },
    output: {
      text: `response-${id}`,
      reasoning: '',
      toolCalls: [],
      stopReason: 'stop'
    },
    ...overrides
  }
}

function visibleRoundIds(root: ReactTestInstance): number[] {
  return root.findAll((node) => node.props['data-llm-debug-round'] !== undefined)
    .map((node) => Number(node.props['data-llm-debug-round']))
}

function button(root: ReactTestInstance, ariaLabel: string): ReactTestInstance {
  return root.findAllByType('button').find((node) => node.props['aria-label'] === ariaLabel) as ReactTestInstance
}

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

afterEach(() => {
  if (originalNavigator) {
    Object.defineProperty(globalThis, 'navigator', originalNavigator)
  } else {
    Reflect.deleteProperty(globalThis, 'navigator')
  }
})

describe('LLM troubleshooting request browser', () => {
  it('sorts newest first and slices five records per page', () => {
    const unordered = [round(3), round(12), round(1), round(10), round(7), round(11), round(2)]
    const sorted = sortLlmDebugRoundsNewestFirst(unordered)

    expect(sorted.map((item) => item.id)).toEqual([12, 11, 10, 7, 3, 2, 1])
    expect(paginateLlmDebugRounds(sorted, 0).map((item) => item.id)).toEqual([12, 11, 10, 7, 3])
    expect(paginateLlmDebugRounds(sorted, 1).map((item) => item.id)).toEqual([2, 1])
  })

  it('keeps pagination, expansion, selection, and detail tabs coordinated', async () => {
    const rounds = Array.from({ length: 12 }, (_, index) => round(index + 1)).reverse()
    let renderer!: ReactTestRenderer

    await act(async () => {
      renderer = createRenderer(createElement(LlmDebugRequestBrowser, { rounds, t }))
    })

    expect(visibleRoundIds(renderer.root)).toEqual([12, 11, 10, 9, 8])
    expect(renderer.root.findByProps({ 'data-llm-debug-detail': 12 })).toBeTruthy()

    await act(async () => {
      button(renderer.root, 'Page 2').props.onClick()
    })

    expect(visibleRoundIds(renderer.root)).toEqual([7, 6, 5, 4, 3])
    expect(renderer.root.findByProps({ 'data-llm-debug-detail': 7 })).toBeTruthy()

    const roundSix = renderer.root.findByProps({ 'data-llm-debug-round': 6 })
    const rowToggle = roundSix.findAllByType('button').find((node) => node.props['aria-expanded'] !== undefined)
    await act(async () => {
      rowToggle?.props.onClick()
    })

    expect(roundSix.findByProps({ 'aria-expanded': true })).toBeTruthy()
    expect(renderer.root.findByProps({ 'data-llm-debug-detail': 6 })).toBeTruthy()

    const rawResponseTab = renderer.root.findAllByProps({ role: 'tab' })
      .find((node) => node.children.includes('Raw response'))
    await act(async () => {
      rawResponseTab?.props.onClick()
    })

    expect(renderer.root.findByProps({ 'aria-selected': true }).children).toContain('Raw response')
    expect(renderer.root.findAllByType('pre').some((node) => String(node.children.join('')).includes('response-6'))).toBe(true)

    await act(async () => renderer.unmount())
  })

  it('copies the selected request body from the request tab', async () => {
    let copied = ''
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        clipboard: {
          writeText: async (value: string) => {
            copied = value
          }
        }
      }
    })
    let renderer!: ReactTestRenderer

    await act(async () => {
      renderer = createRenderer(createElement(LlmDebugRequestBrowser, { rounds: [round(4)], t }))
    })
    await act(async () => {
      const copy = renderer.root.findAllByType('button')
        .find((node) => node.children.includes('Copy JSON'))
      await copy?.props.onClick()
    })

    expect(copied).toContain('request-4')
    expect(renderer.root.findAllByType('button').some((node) => node.children.includes('Copied'))).toBe(true)
    await act(async () => renderer.unmount())
  })
})
