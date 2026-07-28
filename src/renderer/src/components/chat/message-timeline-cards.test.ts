import { createElement, createRef } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolBlock } from '../../agent/types'
import i18n from '../../i18n'
import { PlanBuildActions } from '../plan/PlanBuildActions'
import { ReviewPlanCard, TurnChangeSummary } from './message-timeline-cards'

function change(index: number): ToolBlock {
  const path = `src/file-${index}.ts`
  return {
    kind: 'tool',
    id: `change-${index}`,
    summary: `Edit ${path}`,
    status: 'success',
    toolKind: 'file_change',
    filePath: path,
    detail: [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      '@@ -1 +1 @@',
      `-old ${index}`,
      `+new ${index}`
    ].join('\n')
  }
}

function nodeText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(nodeText).join('')
  return ''
}

function buttonWithText(renderer: ReactTestRenderer, text: string): ReactTestInstance {
  const button = renderer.root
    .findAllByType('button')
    .find((candidate) => nodeText(candidate.props.children).includes(text))
  if (!button) throw new Error(`Missing button: ${text}`)
  return button
}

describe('TurnChangeSummary', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('previews three files, reveals the rest, and keeps change actions on the turn card', async () => {
    const onOpenChanges = vi.fn()
    const onReviewChanges = vi.fn()
    let renderer: ReactTestRenderer

    await act(async () => {
      renderer = create(
        createElement(TurnChangeSummary, {
          changes: [1, 2, 3, 4, 5].map(change),
          viewportRef: createRef<HTMLDivElement>(),
          onOpenChanges,
          onReviewChanges
        })
      )
    })

    expect(renderer!.root.findAllByProps({ 'data-turn-change-summary': true })).toHaveLength(1)
    expect(renderer!.root.findAllByProps({ 'data-turn-change-file': true })).toHaveLength(3)
    expect(JSON.stringify(renderer!.toJSON())).toContain('Edited 5 files')
    expect(JSON.stringify(renderer!.toJSON())).toContain('src/file-3.ts')
    expect(JSON.stringify(renderer!.toJSON())).not.toContain('src/file-4.ts')

    await act(async () => {
      buttonWithText(renderer!, 'Preview').props.onClick()
      buttonWithText(renderer!, 'Review').props.onClick()
      buttonWithText(renderer!, 'Show 2 more files').props.onClick()
    })

    expect(onOpenChanges).toHaveBeenCalledTimes(1)
    expect(onReviewChanges).toHaveBeenCalledTimes(1)
    expect(renderer!.root.findAllByProps({ 'data-turn-change-file': true })).toHaveLength(5)
    expect(buttonWithText(renderer!, 'Show fewer files')).toBeTruthy()

    act(() => renderer!.unmount())
  })
})

describe('plan build actions', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('renders responsive Direct and Graph actions and reports the selected orchestration', async () => {
    const onBuild = vi.fn()
    let renderer: ReactTestRenderer

    await act(async () => {
      renderer = create(createElement(ReviewPlanCard, {
        title: 'Checkout plan',
        relativePath: '.kunsdd/plan/checkout.md',
        busy: false,
        graphEnabled: true,
        onOpen: vi.fn(),
        onBuild
      }))
    })

    const card = renderer!.root.findByProps({ 'data-review-plan-card': true })
    const actions = renderer!.root.findByProps({ 'data-plan-build-actions-variant': 'card' })
    expect(card.props.className).toContain('flex-wrap')
    expect(actions.props.className).toContain('flex-wrap')

    const direct = renderer!.root.findByProps({ 'data-plan-build-orchestration': 'direct' })
    const graph = renderer!.root.findByProps({ 'data-plan-build-orchestration': 'graph' })
    expect(direct.props.disabled).toBe(false)
    expect(graph.props.disabled).toBe(false)
    expect(direct.props['aria-label']).toBe('Direct build')
    expect(graph.props['aria-label']).toBe('Graph build')

    await act(async () => {
      direct.props.onClick()
      graph.props.onClick()
    })
    expect(onBuild.mock.calls).toEqual([['direct'], ['graph']])

    act(() => renderer!.unmount())
  })

  it('keeps Graph discoverable but disabled when Graph Mode is unavailable', async () => {
    let renderer: ReactTestRenderer

    await act(async () => {
      renderer = create(createElement(PlanBuildActions, {
        disabled: false,
        graphEnabled: false,
        variant: 'panel',
        onBuild: vi.fn()
      }))
    })

    const actions = renderer!.root.findByProps({ 'data-plan-build-actions-variant': 'panel' })
    const direct = renderer!.root.findByProps({ 'data-plan-build-orchestration': 'direct' })
    const graph = renderer!.root.findByProps({ 'data-plan-build-orchestration': 'graph' })
    expect(actions.props.className).toContain('grid-cols-2')
    expect(direct.props.disabled).toBe(false)
    expect(graph.props.disabled).toBe(true)
    expect(graph.props.title).toBe('Enable experimental Graph Mode in Settings → AI assistant')
    expect(graph.props['aria-label']).toContain('Enable experimental Graph Mode')

    act(() => renderer!.unmount())
  })
})
