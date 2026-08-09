import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolBlock } from '../../agent/types'
import { parseDelegateDetail, SubagentCallCard, SubagentGroup } from './SubagentCallCard'

const selectThread = vi.fn(async () => undefined)

vi.mock('../../store/chat-store', () => ({
  useChatStore: (selector: (state: { selectThread: typeof selectThread }) => unknown) =>
    selector({ selectThread })
}))

vi.mock('react-i18next', () => {
  const labels: Record<string, string> = {
    subagentAgentLabel: 'Agent',
    subagentModelLabel: 'Model',
    subagentNotRecorded: 'Not recorded',
    subagentDefaultName: 'Subagent',
    subagentStatusQueued: 'Queued',
    subagentStatusRunning: 'Running',
    subagentStatusDone: 'Done',
    subagentStatusFailed: 'Failed',
    subagentStatusAwaiting: 'Awaiting approval',
    subagentOpenSession: 'Open sub-session',
    subagentOpenSessionShort: 'Open',
    subagentGeneratedBadge: 'Generated',
    exploreKindBadge: 'Explore',
    exploreTaskDefaultTitle: 'Explore task',
    exploreViewProcess: 'View explore process',
    exploreViewProcessShort: 'Open',
    exploreViewProcessSteps: 'View explore process · {{count}} steps',
    exploreExpandConclusion: 'Show conclusion',
    explorePeekPreview: 'Preview',
    subagentSwarmTitle: '{{count}} subagents',
    subagentSwarmRunning: '{{count}} running',
    subagentSwarmQueued: '{{count}} queued',
    subagentSwarmDone: '{{count}} done',
    'subagentsPanel.role.explore.name': 'Repository Explorer',
    'subagentsPanel.role.general.name': 'General Agent'
  }
  return {
    initReactI18next: { type: '3rdParty', init: () => undefined },
    useTranslation: () => ({
      t: (key: string, fallback?: string | { defaultValue?: string; count?: number }) => {
        if (typeof fallback === 'object' && fallback && 'count' in fallback && key === 'exploreViewProcessSteps') {
          return `View explore process · ${fallback.count} steps`
        }
        return labels[key] ?? (typeof fallback === 'string' ? fallback : fallback?.defaultValue) ?? key
      }
    })
  }
})

describe('parseDelegateDetail', () => {
  it('reads the generated role name from the direct generated-agent result', () => {
    expect(parseDelegateDetail(JSON.stringify({
      profile: 'generated:ipc-investigator:12345678',
      profileName: 'IPC Investigator',
      model: 'gpt-5.6-sol',
      generatedAgent: { name: 'IPC Investigator' }
    }))).toMatchObject({
      generated: true,
      generatedAgentName: 'IPC Investigator',
      profileName: 'IPC Investigator',
      model: 'gpt-5.6-sol'
    })
  })

  it('falls back to the generated role snapshot embedded in routing metadata', () => {
    expect(parseDelegateDetail(JSON.stringify({
      profile: 'generated:browser-qa:12345678',
      routing: {
        selectedKind: 'generated',
        agent: { name: 'Browser QA Specialist' }
      }
    }))).toMatchObject({
      generated: true,
      generatedAgentName: 'Browser QA Specialist'
    })
  })

  it('reads explore_agent title and query from the tool payload', () => {
    expect(parseDelegateDetail(JSON.stringify({
      childId: 'child_explore',
      status: 'running',
      title: 'Voice transcription flow',
      query: 'Find how speech transcription is wired',
      profile: 'explore'
    }))).toMatchObject({
      childId: 'child_explore',
      status: 'running',
      title: 'Voice transcription flow',
      query: 'Find how speech transcription is wired',
      profile: 'explore'
    })
  })
})

describe('SubagentCallCard route metadata', () => {
  let renderer: ReactTestRenderer | undefined

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(async () => {
    if (renderer) await act(async () => renderer?.unmount())
    renderer = undefined
  })

  it('keeps the task title separate from the recorded built-in agent and model', async () => {
    await act(async () => {
      renderer = create(createElement(SubagentCallCard, {
        block: childBlock({
          childLabel: 'Greeting Agent 1',
          childProfile: 'general',
          childProfileName: 'General Agent',
          childModel: 'gpt-5.6-sol'
        }, {
          summary: 'Hello! How can I help?',
          model: 'older-result-model'
        })
      }))
    })

    const metadata = renderer!.root.findByProps({ 'data-testid': 'subagent-route-metadata' })
    expect(metadata.props['data-agent-id']).toBe('general')
    expect(metadata.props['data-model']).toBe('gpt-5.6-sol')
    expect(instanceText(metadata)).toContain('General Agent (general)')
    expect(instanceText(renderer!.root)).toContain('Greeting Agent 1')
    expect(instanceText(renderer!.root)).toContain('Hello! How can I help?')
  })

  it('renders generated identity and model from a replayed tool result', async () => {
    await act(async () => {
      renderer = create(createElement(SubagentCallCard, {
        block: childBlock(undefined, {
          profile: 'generated:ipc-investigator:12345678',
          profileName: 'IPC Investigator',
          model: 'gpt-5.6-terra',
          summary: 'IPC path verified.'
        })
      }))
    })

    const metadata = renderer!.root.findByProps({ 'data-testid': 'subagent-route-metadata' })
    expect(metadata.props['data-agent-id']).toBe('generated:ipc-investigator:12345678')
    expect(metadata.props['data-model']).toBe('gpt-5.6-terra')
    expect(instanceText(metadata)).toContain('IPC Investigator (generated:ipc-investigator:12345678)')
  })

  it('restores a persisted PPT agent result and opens its child session', async () => {
    selectThread.mockClear()
    await act(async () => {
      renderer = create(createElement(SubagentCallCard, {
        block: {
          kind: 'tool',
          id: 'tool_ppt_history',
          createdAt: '2026-08-07T00:00:00.000Z',
          summary: 'ppt_agent',
          status: 'success',
          toolKind: 'tool_call',
          detail: JSON.stringify({
            childId: 'child_ppt_history',
            status: 'completed',
            title: 'Product launch deck',
            summary: 'Created the PPT deck and exported it.',
            profile: 'ppt',
            profileName: 'PPT Master',
            model: 'deepseek-v4-pro',
            toolInvocations: 4
          }),
          meta: { toolName: 'ppt_agent' }
        }
      }))
    })

    const metadata = renderer!.root.findByProps({ 'data-testid': 'subagent-route-metadata' })
    expect(metadata.props['data-agent-id']).toBe('ppt')
    expect(metadata.props['data-model']).toBe('deepseek-v4-pro')
    expect(instanceText(renderer!.root)).toContain('Product launch deck')
    expect(instanceText(renderer!.root)).toContain('Done')

    const open = renderer!.root.findByProps({ 'data-testid': 'explore-open-process-button' })
    await act(async () => {
      open.props.onClick({ stopPropagation() {} })
    })
    expect(selectThread).toHaveBeenCalledWith('child_ppt_history')
  })

  it('labels missing legacy identity and omits an empty model instead of showing Not recorded', async () => {
    await act(async () => {
      renderer = create(createElement(SubagentCallCard, {
        block: childBlock(undefined, { summary: 'Legacy result.' })
      }))
    })

    const metadata = renderer!.root.findByProps({ 'data-testid': 'subagent-route-metadata' })
    expect(metadata.props['data-agent-id']).toBe('')
    expect(metadata.props['data-model']).toBe('')
    expect(instanceText(metadata)).toContain('Not recorded')
    expect(instanceText(metadata)).not.toContain('Model')
  })

  it('shows independently comparable route metadata for every grouped child row', async () => {
    await act(async () => {
      renderer = create(createElement(SubagentGroup, {
        blocks: [
          childBlock({
            childId: 'child_general',
            childLabel: 'Greeting Agent 1',
            childProfile: 'general',
            childProfileName: 'General Agent',
            childModel: 'gpt-5.6-sol',
            childSeq: 1
          }, { summary: 'Hello.' }, 'tool_general'),
          childBlock({
            childId: 'child_explore',
            childLabel: 'Greeting Agent 2',
            childProfile: 'explore',
            childProfileName: 'Repository Explorer',
            childModel: 'gpt-5.6-terra',
            childSeq: 2
          }, { summary: 'Hi.' }, 'tool_explore')
        ]
      }))
    })

    const rows = renderer!.root.findAllByProps({ 'data-testid': 'subagent-route-metadata' })
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.props['data-agent-id'])).toEqual(['general', 'explore'])
    expect(rows.map((row) => row.props['data-model'])).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra'])
  })

  it('renders an all-explore cluster as independent full cards without a subagent swarm header', async () => {
    const onOpenChildThread = vi.fn()
    await act(async () => {
      renderer = create(createElement(SubagentGroup, {
        onOpenChildThread,
        blocks: [
          exploreChildBlock({
            id: 'tool_explore_a',
            childId: 'child_a',
            childSeq: 1,
            title: 'Packaging config',
            summary: 'Checked packaging scripts.'
          }),
          exploreChildBlock({
            id: 'tool_explore_b',
            childId: 'child_b',
            childSeq: 2,
            title: 'Release workflow',
            summary: 'Checked release.yml.'
          })
        ]
      }))
    })

    const text = instanceText(renderer!.root)
    expect(renderer!.root.findByProps({ 'data-testid': 'explore-independent-stack' })).toBeTruthy()
    expect(renderer!.root.findAllByProps({ 'data-testid': 'subagent-call-card' })).toHaveLength(2)
    expect(text).toContain('Packaging config')
    expect(text).toContain('Release workflow')
    expect(text).not.toContain('subagents')
    expect(text).not.toContain('{{count}} subagents')

    const openButtons = renderer!.root.findAllByProps({ 'data-testid': 'explore-open-process-button' })
    expect(openButtons.length).toBeGreaterThanOrEqual(1)
    await act(async () => {
      openButtons[0].props.onClick({ stopPropagation() {} })
    })
    expect(onOpenChildThread).toHaveBeenCalledWith('child_a')
  })

  it('prefers explore title and live activity on a running explore_agent card', async () => {
    await act(async () => {
      renderer = create(createElement(SubagentCallCard, {
        block: {
          kind: 'tool',
          id: 'tool_explore_live',
          createdAt: '2026-08-07T00:00:00.000Z',
          summary: 'explore_agent',
          status: 'running',
          toolKind: 'tool_call',
          detail: JSON.stringify({
            childId: 'child_voice',
            status: 'running',
            title: 'Voice transcription flow',
            query: 'Trace speech transcription',
            profile: 'explore'
          }),
          meta: {
            toolName: 'explore_agent',
            child: {
              parentThreadId: 'thread_parent',
              parentTurnId: 'turn_parent',
              childId: 'child_voice',
              childLabel: 'Voice transcription flow',
              childProfile: 'explore',
              childProfileName: 'Repository Explorer',
              childModel: 'deepseek-v4-flash',
              childStatus: 'running',
              childSeq: 1,
              activity: {
                phase: 'tool',
                label: 'Reading tool timeline UI',
                toolName: 'read',
                startedAt: '2026-08-07T00:00:00.000Z',
                updatedAt: '2026-08-07T00:00:02.000Z'
              }
            }
          }
        }
      }))
    })

    expect(instanceText(renderer!.root)).toContain('Explore')
    expect(instanceText(renderer!.root)).toContain('Voice transcription flow')
    expect(instanceText(renderer!.root)).toContain('Reading tool timeline UI · read')
    expect(instanceText(renderer!.root)).not.toContain('explore_agent')
    expect(instanceText(renderer!.root)).not.toContain('Not recorded')
    const card = renderer!.root.findByProps({ 'data-testid': 'subagent-call-card' })
    expect(card.props['data-activity-label']).toBe('Reading tool timeline UI · read')
    expect(card.props['data-explore']).toBe('true')
  })

  it('shows the full conclusion by default and opens the child only via the process button', async () => {
    selectThread.mockClear()
    const onOpenChildThread = vi.fn()
    const conclusion = [
      '已找到完整链路。结论如下:',
      '## 1) 设置定义',
      '- 类型定义: ProviderRetryConfig'
    ].join('\n')
    await act(async () => {
      renderer = create(createElement(SubagentCallCard, {
        onOpenChildThread,
        block: {
          kind: 'tool',
          id: 'tool_explore_done',
          createdAt: '2026-08-07T00:00:00.000Z',
          summary: 'explore_agent',
          status: 'success',
          toolKind: 'tool_call',
          detail: JSON.stringify({
            childId: 'child_tokens',
            status: 'completed',
            title: 'Token save label',
            summary: conclusion,
            profile: 'explore',
            profileName: 'Repository Explorer',
            model: 'deepseek-v4-flash',
            toolInvocations: 5
          }),
          meta: {
            toolName: 'explore_agent',
            child: {
              parentThreadId: 'thread_parent',
              parentTurnId: 'turn_parent',
              childId: 'child_tokens',
              childLabel: 'Token save label',
              childProfile: 'explore',
              childStatus: 'completed',
              childSeq: 1,
              toolInvocations: 5
            }
          }
        }
      }))
    })

    const card = renderer!.root.findByProps({ 'data-testid': 'subagent-call-card' })
    expect(card.props['data-conclusion-expanded']).toBe('true')
    expect(instanceText(renderer!.root)).toContain('已找到完整链路')
    expect(instanceText(renderer!.root)).toContain('ProviderRetryConfig')
    expect(instanceText(renderer!.root)).not.toContain('View explore process · 5 steps')

    const clickable = card.findAll((node) => node.props?.role === 'button')[0]
    await act(async () => {
      clickable.props.onClick()
    })
    expect(onOpenChildThread).not.toHaveBeenCalled()
    expect(
      renderer!.root.findByProps({ 'data-testid': 'subagent-call-card' }).props['data-conclusion-expanded']
    ).toBe('false')

    const openProcess = renderer!.root.findByProps({ 'data-testid': 'explore-open-process-button' })
    await act(async () => {
      openProcess.props.onClick({ stopPropagation() {} })
    })
    expect(onOpenChildThread).toHaveBeenCalledWith('child_tokens')
    expect(selectThread).not.toHaveBeenCalled()
  })

  it('never titles a completed explore card with the raw tool name', async () => {
    await act(async () => {
      renderer = create(createElement(SubagentCallCard, {
        block: {
          kind: 'tool',
          id: 'tool_explore_legacy',
          createdAt: '2026-08-07T00:00:00.000Z',
          summary: 'explore_agent',
          status: 'success',
          toolKind: 'tool_call',
          detail: JSON.stringify({
            childId: 'child_legacy',
            status: 'completed',
            summary: 'Located save-tokens rendering in FloatingComposer.tsx',
            toolInvocations: 5
          }),
          meta: { toolName: 'explore_agent' }
        }
      }))
    })

    const text = instanceText(renderer!.root)
    expect(text).toContain('Explore')
    expect(text).toContain('Located save-tokens rendering in FloatingComposer.tsx')
    expect(text).not.toMatch(/(^|[^a-z_])explore_agent([^a-z_]|$)/i)
    expect(text).toContain('Repository Explorer')
    expect(text).not.toContain('Not recorded')
  })

  it('shows Done when the tool result settled even if a stale child snapshot says running', async () => {
    await act(async () => {
      renderer = create(createElement(SubagentCallCard, {
        block: {
          kind: 'tool',
          id: 'tool_explore_stale',
          createdAt: '2026-08-07T00:00:00.000Z',
          summary: 'explore_agent',
          status: 'success',
          toolKind: 'tool_call',
          detail: JSON.stringify({
            childId: 'child_stale',
            status: 'completed',
            summary: 'Located the save-tokens wiring.',
            toolInvocations: 4
          }),
          meta: {
            toolName: 'explore_agent',
            child: {
              parentThreadId: 'thread_parent',
              parentTurnId: 'turn_parent',
              childId: 'child_stale',
              childProfile: 'explore',
              childProfileName: 'Repository Explorer',
              childStatus: 'running',
              childSeq: 1
            }
          }
        }
      }))
    })

    const text = instanceText(renderer!.root)
    expect(text).toContain('Done')
    expect(text).not.toContain('Running')
    expect(text).toContain('Located the save-tokens wiring.')
    const card = renderer!.root.findByProps({ 'data-testid': 'subagent-call-card' })
    expect(card.props['data-conclusion-expanded']).toBe('true')
    expect(card.props['data-activity-label']).toBe('')
  })

  it('shows Failed for a settled error result even when the child snapshot still says running', async () => {
    await act(async () => {
      renderer = create(createElement(SubagentCallCard, {
        block: {
          kind: 'tool',
          id: 'tool_delegate_stale_failed',
          createdAt: '2026-08-07T00:00:00.000Z',
          summary: 'delegate_task',
          status: 'error',
          toolKind: 'tool_call',
          detail: JSON.stringify({
            childId: 'child_failed_stale',
            status: 'failed',
            error: 'Child run failed after provider timeout.',
            toolInvocations: 2
          }),
          meta: {
            toolName: 'delegate_task',
            child: {
              parentThreadId: 'thread_parent',
              parentTurnId: 'turn_parent',
              childId: 'child_failed_stale',
              childProfile: 'general',
              childProfileName: 'General Agent',
              childStatus: 'running',
              childSeq: 1
            }
          }
        }
      }))
    })

    const text = instanceText(renderer!.root)
    expect(text).toContain('Failed')
    expect(text).not.toContain('Running')
    // Error body is collapsed by default on non-explore cards; the expand
    // affordance proves the terminal payload survived the stale snapshot.
    expect(text).toContain('Show conclusion')
    const card = renderer!.root.findByProps({ 'data-testid': 'subagent-call-card' })
    expect(card.props['data-activity-label']).toBe('')
  })
})

function childBlock(
  child: Record<string, unknown> | undefined,
  detail: Record<string, unknown>,
  id = 'tool_delegate'
): ToolBlock {
  const childId = typeof child?.childId === 'string' ? child.childId : `child_${id}`
  return {
    kind: 'tool',
    id,
    createdAt: '2026-07-22T00:00:00.000Z',
    summary: typeof child?.childLabel === 'string' ? child.childLabel : 'Greeting Agent',
    status: 'success',
    toolKind: 'tool_call',
    detail: JSON.stringify({
      childId,
      status: 'completed',
      durationMs: 1_000,
      ...detail
    }),
    meta: {
      toolName: 'delegate_task',
      ...(child ? {
        child: {
          parentThreadId: 'thread_parent',
          parentTurnId: 'turn_parent',
          childId,
          childStatus: 'completed',
          childSeq: 1,
          ...child
        }
      } : {})
    }
  }
}

function exploreChildBlock(input: {
  id: string
  childId: string
  childSeq: number
  title: string
  summary: string
}): ToolBlock {
  return {
    kind: 'tool',
    id: input.id,
    createdAt: '2026-08-07T00:00:00.000Z',
    summary: 'explore_agent',
    status: 'success',
    toolKind: 'tool_call',
    detail: JSON.stringify({
      childId: input.childId,
      status: 'completed',
      title: input.title,
      summary: input.summary,
      profile: 'explore',
      profileName: 'Repository Explorer',
      toolInvocations: 3
    }),
    meta: {
      toolName: 'explore_agent',
      child: {
        parentThreadId: 'thread_parent',
        parentTurnId: 'turn_parent',
        childId: input.childId,
        childLabel: input.title,
        childProfile: 'explore',
        childProfileName: 'Repository Explorer',
        childModel: 'deepseek-v4-flash',
        childStatus: 'completed',
        childSeq: input.childSeq
      }
    }
  }
}

function instanceText(instance: ReactTestInstance): string {
  return instance.children
    .map((child) => typeof child === 'string' ? child : instanceText(child))
    .join('')
}
