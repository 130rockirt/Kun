import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolBlock } from '../../agent/types'
import { SubagentCallCard, SubagentGroup } from './SubagentCallCard'

const selectThread = vi.fn(async () => undefined)
const sendMessage = vi.fn(async () => true)

vi.mock('../../store/chat-store', () => ({
  useChatStore: (selector: (state: {
    selectThread: typeof selectThread
    sendMessage: typeof sendMessage
    busy: boolean
  }) => unknown) => selector({ selectThread, sendMessage, busy: false })
}))

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, fallback?: string | { defaultValue?: string }) => {
      const labels: Record<string, string> = {
        subagentStatusQueued: 'Queued',
        subagentStatusRunning: 'Running',
        subagentStatusDone: 'Done',
        subagentStatusStopped: 'Stopped',
        subagentStatusFailed: 'Failed',
        subagentStatusAwaiting: 'Awaiting approval',
        exploreKindBadge: 'Explore',
        exploreTaskDefaultTitle: 'Explore task',
        exploreViewProcess: 'View explore process',
        exploreViewProcessShort: 'Open',
        exploreExpandConclusion: 'Show conclusion',
        'subagentsPanel.role.explore.name': 'Repository Explorer'
      }
      return labels[key] ?? (typeof fallback === 'string' ? fallback : fallback?.defaultValue) ?? key
    }
  })
}))

describe('Fast Context evidence card', () => {
  let renderer: ReactTestRenderer | undefined

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(async () => {
    if (renderer) await act(async () => renderer?.unmount())
    renderer = undefined
  })

  it('renders one openable child with a bounded evidence pack', async () => {
    const onOpenChildThread = vi.fn()
    await act(async () => {
      renderer = create(createElement(SubagentCallCard, {
        block: fastContextBlock('completed'),
        onOpenChildThread
      }))
    })

    expect(renderer!.root.findAllByProps({ 'data-testid': 'subagent-call-card' })).toHaveLength(1)
    expect(instanceText(renderer!.root)).toContain('Fast Context retrieval')
    expect(instanceText(renderer!.root)).toContain('Done')
    expect(instanceText(renderer!.root.findByProps({ 'data-testid': 'fast-context-evidence-summary' })))
      .toContain('Evidence · 2 evidence')

    const card = renderer!.root.findByProps({ 'data-testid': 'subagent-call-card' })
    const toggle = card.findAll((node) => node.props?.role === 'button')[0]
    await act(async () => toggle.props.onClick())
    expect(instanceText(renderer!.root.findByProps({ 'data-testid': 'fast-context-evidence-detail' })))
      .toContain('SubagentCallCard.tsx:42-44')
    expect(instanceText(renderer!.root)).toContain('The card handles child navigation.')

    await act(async () => {
      renderer!.root.findByProps({ 'data-testid': 'explore-open-process-button' })
        .props.onClick({ stopPropagation() {} })
    })
    expect(onOpenChildThread).toHaveBeenCalledWith('child_fast_context')
  })

  it('labels an in-flight pack as retrieval without expanding legacy children', async () => {
    await act(async () => {
      renderer = create(createElement(SubagentGroup, { blocks: [fastContextBlock('running')] }))
    })
    expect(instanceText(renderer!.root.findByProps({ 'data-testid': 'fast-context-evidence-summary' })))
      .toContain('Retrieving · 2 evidence')
    expect(renderer!.root.findAllByProps({ 'data-testid': 'subagent-call-card' })).toHaveLength(1)
  })
})

function fastContextBlock(status: 'running' | 'completed'): ToolBlock {
  return {
    kind: 'tool',
    id: 'tool_fast_context',
    turnId: 'turn_parent',
    createdAt: '2026-08-13T00:00:00.000Z',
    summary: 'fast_context',
    status: status === 'completed' ? 'success' : 'running',
    toolKind: 'tool_call',
    detail: JSON.stringify({
      status,
      label: 'Fast Context retrieval',
      child: {
        childId: 'child_fast_context',
        status,
        profile: 'explore',
        profileName: 'Repository Explorer',
        model: 'gpt-5.6-mini'
      },
      evidencePack: {
        version: 1,
        tasks: [{
          index: 0,
          title: 'Renderer card',
          query: 'Trace SubagentCallCard',
          evidence: [
            {
              path: 'src/renderer/src/components/chat/SubagentCallCard.tsx',
              ranges: [[42, 44]],
              reason: 'Imports the card dependencies'
            },
            {
              path: 'src/renderer/src/components/chat/SubagentCallCard.tsx',
              ranges: [[56, 70]],
              excerpt: 'export function SubagentCallCard'
            }
          ],
          conclusion: 'The card handles child navigation.',
          uncertainties: []
        }],
        uncertainties: []
      }
    }),
    meta: { toolName: 'fast_context' }
  }
}

function instanceText(instance: ReactTestInstance): string {
  return instance.children.map((child) => typeof child === 'string' ? child : instanceText(child)).join('')
}
