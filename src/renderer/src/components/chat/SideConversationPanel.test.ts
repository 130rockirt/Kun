import { createElement } from 'react'
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer
} from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { useChatStore } from '../../store/chat-store'
import type { SideConversation } from '../../store/chat-store-types'
import {
  activeSideConversationOrdinal,
  SideConversationPanel
} from './SideConversationPanel'
import { FloatingComposer } from './FloatingComposer'

const firstSide: SideConversation = {
  threadId: 'side-1',
  parentThreadId: 'main-1',
  title: 'Parent · side',
  createdAt: '2026-07-23T00:22:00.000Z',
  inheritedAt: '2026-07-23T00:22:00.000Z',
  blocks: [
    {
      kind: 'user',
      id: 'side-user',
      turnId: 'side-turn',
      text: 'What did I just ask?',
      modelLabel: 'gpt-5.6'
    },
    {
      kind: 'reasoning',
      id: 'side-reasoning',
      text: 'internal reasoning that stays in the process section'
    },
    {
      kind: 'assistant',
      id: 'side-assistant',
      turnId: 'side-turn',
      text: 'You asked for three subagents to greet you.'
    }
  ],
  liveReasoning: '',
  liveAssistant: '',
  lastSeq: 4,
  input: 'independent branch draft',
  model: 'gpt-5.6',
  providerId: 'codex',
  reasoningEffort: 'low',
  busy: false,
  turnId: null,
  userItemId: null,
  error: null
}

function textContent(node: ReactTestInstance): string {
  return node.children
    .map((child) => typeof child === 'string' ? child : textContent(child))
    .join('')
}

describe('SideConversationPanel', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
    ;(globalThis as { window?: unknown }).window = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      requestAnimationFrame: vi.fn(() => 1),
      cancelAnimationFrame: vi.fn(),
      setInterval,
      clearInterval,
      innerHeight: 900,
      innerWidth: 1400,
      kunGui: {
        platform: 'darwin',
        runtimeRequest: vi.fn(async () => ({ ok: true, status: 200, body: '{"shells":[]}' }))
      }
    }
    useChatStore.setState({
      activeThreadId: 'main-1',
      threads: [{
        id: 'main-1',
        title: 'Parent conversation',
        updatedAt: '2026-07-23T00:22:00.000Z',
        model: 'gpt-5.6',
        mode: 'agent',
        status: 'idle'
      }],
      workspaceRoot: '/workspace',
      runtimeConnection: 'ready',
      busy: false,
      composerModel: 'gpt-5.6',
      composerProviderId: 'codex',
      composerPickList: ['gpt-5.6'],
      composerModelGroups: [],
      composerReasoningEffort: 'low',
      sideConversations: { [firstSide.threadId]: firstSide },
      sidePanel: { open: true, activeSideId: firstSide.threadId }
    })
  })

  it('uses the shared main timeline and composer inside the docked branch workspace', () => {
    let renderer: ReactTestRenderer
    act(() => {
      renderer = create(createElement(SideConversationPanel, { variant: 'docked' }))
    })

    const root = renderer!.root
    const content = textContent(root)
    expect(root.findByProps({ 'aria-label': 'Switch branch conversation' }).props.title)
      .toContain('From “Parent conversation”')
    expect(root.findAllByProps({ 'data-testid': 'side-conversation-timeline' })).toHaveLength(1)
    expect(root.findAll((node) =>
      typeof node.props.className === 'string' && node.props.className.includes('ds-user-message-bubble')
    )).toHaveLength(1)
    expect(content).toContain('What did I just ask?')
    expect(content).toContain('You asked for three subagents to greet you.')
    expect(root.findAll((node) =>
      typeof node.props.className === 'string' && node.props.className.includes('ds-composer-shell')
    )).toHaveLength(1)
    expect(root.findByProps({ value: 'independent branch draft' })).toBeDefined()
    expect(content).not.toContain('Fork response')
    expect(root.findAllByProps({ 'aria-label': 'Edit & resend' })).toHaveLength(0)

    act(() => renderer!.unmount())
  })

  it('derives stable one-based branch ordinals for tab titles', () => {
    const secondSide = { ...firstSide, threadId: 'side-2' }
    expect(activeSideConversationOrdinal([firstSide, secondSide], 'side-1')).toBe(1)
    expect(activeSideConversationOrdinal([firstSide, secondSide], 'side-2')).toBe(2)
    expect(activeSideConversationOrdinal([firstSide, secondSide], null)).toBe(3)
  })

  it('keeps provider and model changes local to the active branch conversation', () => {
    let renderer: ReactTestRenderer
    act(() => {
      renderer = create(createElement(SideConversationPanel, { variant: 'docked' }))
    })

    const composer = renderer!.root.findByType(FloatingComposer)
    expect(composer.props.composerProviderId).toBe('codex')

    act(() => {
      composer.props.onComposerModelChange('composer-2.5', 'cursor-subscription')
    })

    expect(useChatStore.getState().sideConversations['side-1']).toMatchObject({
      model: 'composer-2.5',
      providerId: 'cursor-subscription'
    })
    expect(useChatStore.getState().composerModel).toBe('gpt-5.6')
    expect(useChatStore.getState().composerProviderId).toBe('codex')

    act(() => renderer!.unmount())
  })

  it('can return from a new-branch draft to the only existing branch', () => {
    useChatStore.setState({ sidePanel: { open: true, activeSideId: null } })
    let renderer: ReactTestRenderer
    act(() => {
      renderer = create(createElement(SideConversationPanel, { variant: 'docked' }))
    })

    const switcher = renderer!.root.findByProps({ 'aria-label': 'Switch branch conversation' })
    expect(switcher.props.disabled).toBe(false)
    act(() => switcher.props.onClick())

    const branchOption = renderer!.root.findAllByType('button').find((button) =>
      textContent(button).includes('Branch conversation 1')
    )
    expect(branchOption).toBeDefined()
    act(() => branchOption!.props.onClick())
    expect(useChatStore.getState().sidePanel.activeSideId).toBe('side-1')

    act(() => renderer!.unmount())
  })
})
