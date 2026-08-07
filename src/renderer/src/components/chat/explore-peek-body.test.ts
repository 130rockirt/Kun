import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExplorePeekBody } from './explore-peek-body'

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, fallback?: string | { defaultValue?: string }) =>
      (typeof fallback === 'string' ? fallback : fallback?.defaultValue) ?? key
  })
}))

describe('ExplorePeekBody', () => {
  let renderer: ReactTestRenderer | undefined

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(async () => {
    if (renderer) await act(async () => renderer?.unmount())
    renderer = undefined
  })

  it('keeps the full summary visible even when step rows are present', async () => {
    const summary = [
      '已找到完整链路。结论如下:',
      '## 1) 设置定义',
      '- 默认应开启失败重试'
    ].join('\n')

    await act(async () => {
      renderer = create(createElement(ExplorePeekBody, {
        loading: false,
        error: null,
        summary,
        steps: [
          { id: 't1', kind: 'tool', label: 'grep retry', status: 'success' },
          { id: 't2', kind: 'tool', label: 'read settings', status: 'success' }
        ]
      }))
    })

    const summaryNode = renderer!.root.findByProps({ 'data-testid': 'explore-peek-summary' })
    const stepsNode = renderer!.root.findByProps({ 'data-testid': 'explore-peek-steps' })
    expect(instanceText(summaryNode)).toContain('已找到完整链路')
    expect(instanceText(summaryNode)).toContain('默认应开启失败重试')
    expect(instanceText(stepsNode)).toContain('grep retry')
    expect(instanceText(stepsNode)).toContain('read settings')
  })
})

function instanceText(instance: ReactTestInstance): string {
  return instance.children
    .map((child) => typeof child === 'string' ? child : instanceText(child))
    .join('')
}
