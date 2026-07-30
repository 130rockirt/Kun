import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { useDesignWorkspaceStore } from '../../design/design-workspace-store'
import {
  DesignAIRail,
  deriveDesignThreadTitleFromBlocks,
  designThreadTitleLooksDefault
} from './DesignAIRail'
import { DesignTargetToggle } from './DesignTargetToggle'

type DesignAIRailProps = ComponentProps<typeof DesignAIRail>

function props(overrides: Partial<DesignAIRailProps> = {}): DesignAIRailProps {
  return {
    input: '',
    setInput: () => {},
    mode: 'agent',
    setMode: () => {},
    busy: false,
    runtimeConnection: 'ready',
    activeThreadId: null,
    blocks: [],
    liveReasoning: '',
    liveAssistant: '',
    composerModel: 'deepseek-chat',
    composerPickList: ['deepseek-chat'],
    composerReasoningEffort: 'auto',
    setComposerModel: () => {},
    setComposerReasoningEffort: () => {},
    queuedMessages: [],
    removeQueuedMessage: () => {},
    guideQueuedMessage: () => {},
    onSend: () => {},
    onInterrupt: () => {},
    onRetryConnection: () => {},
    onOpenSettings: () => {},
    onNewConversation: () => {},
    designThreads: [],
    onSwitchThread: () => {},
    onCollapse: () => {},
    ...overrides
  }
}

beforeEach(() => {
  useDesignWorkspaceStore.setState({
    workspaceRoot: '/tmp/kun-design',
    artifacts: [],
    activeArtifactId: null,
    designContext: { designTarget: 'web' },
    pagesRun: null,
    multiPageMode: false
  })
})

describe('DesignAIRail target toggle', () => {
  it('offers guidance for queued plain-text messages', () => {
    const html = renderToStaticMarkup(createElement(DesignAIRail, props({
      busy: true,
      activeThreadId: 'thread-current-document',
      queuedMessages: [{ id: 'q-guide', text: 'use a smaller title' }],
      designThreads: [{
        id: 'thread-current-document',
        title: 'Settings',
        workspace: '/tmp/kun-design',
        model: 'deepseek-chat',
        mode: 'agent',
        updatedAt: '2026-07-03T00:00:00.000Z'
      }]
    })))

    expect(html).toContain('aria-label="Guide"')
  })

  it('derives visible drawing titles from the first design request', () => {
    expect(designThreadTitleLooksDefault('Design Assistant', '设计助手')).toBe(true)
    expect(designThreadTitleLooksDefault('设计助手', '设计助手')).toBe(true)
    expect(designThreadTitleLooksDefault('Kun mobile settings')).toBe(false)
    expect(deriveDesignThreadTitleFromBlocks([
      {
        kind: 'user',
        id: 'u1',
        text: '帮我设计一个 Kun 移动端设置页。需要深色主题和账号设置。'
      }
    ])).toBe('帮我设计一个 Kun 移动端设置页')
  })

  it('shows a derived drawing title instead of the default assistant title', () => {
    const html = renderToStaticMarkup(createElement(DesignAIRail, props({
      activeThreadId: 'thread-current-document',
      blocks: [
        {
          kind: 'user',
          id: 'u1',
          text: '帮我设计一个 Kun 线程列表页面。包含搜索、会话分组和底部导航。'
        }
      ],
      designThreads: [{
        id: 'thread-current-document',
        title: 'Design Assistant',
        workspace: '/tmp/kun-design',
        model: 'deepseek-chat',
        mode: 'agent',
        updatedAt: '2026-07-03T00:00:00.000Z'
      }]
    })))

    expect(html).toContain('帮我设计一个 Kun 线程列表页面')
    expect(html).not.toContain('>Design Assistant</span>')
  })

  it('does not render blocks from a thread outside the active design document', () => {
    const html = renderToStaticMarkup(
      createElement(DesignAIRail, props({
        activeThreadId: 'thread-old-document',
        blocks: [
          { kind: 'user', id: 'u1', text: 'old document request' },
          { kind: 'assistant', id: 'a1', text: 'old document answer' }
        ],
        liveReasoning: 'old live reasoning',
        liveAssistant: 'old live answer',
        designThreads: []
      }))
    )

    expect(html).not.toContain('old document request')
    expect(html).not.toContain('old document answer')
    expect(html).not.toContain('old live reasoning')
    expect(html).not.toContain('old live answer')
    expect(html).toContain('Describe the UI you want to design. The assistant will generate it for you.')
  })

  it('shows the design target toggle with Web selected by default', () => {
    const html = renderToStaticMarkup(createElement(DesignAIRail, props()))

    expect(html).toContain('Choose whether the design agent defaults to web pages or mobile app screens')
    expect(html).toContain('aria-label="Web: Default 1280 x 800 web frame"')
    expect(html).toContain('aria-label="App: Default 390 x 844 app frame"')
    expect(html).toContain('Agent context')
    expect(html).toContain('aria-label="Agent context: Web - Default 1280 x 800 web frame"')
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>[\s\S]*?Web<\/button>/)
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*>[\s\S]*?App<\/button>/)
    expect(html).toContain('dark:bg-[#343c4a]')
    expect(html).toContain('dark:ring-white/15')
    expect(html).not.toContain('dark:bg-white/14')
  })

  it('reflects the selected App target and locks switching while busy', () => {
    const html = renderToStaticMarkup(
      createElement(DesignTargetToggle, {
        designTarget: 'app',
        disabled: true,
        disabledReason: 'Design target switching is locked while the design agent is working',
        onChange: () => {}
      })
    )

    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*disabled=""[^>]*>[\s\S]*?Web<\/button>/)
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*disabled=""[^>]*>[\s\S]*?App<\/button>/)
    expect(html).toContain('aria-label="Design target switching is locked while the design agent is working"')
    expect(html).toContain(
      'aria-label="App: Default 390 x 844 app frame. Design target switching is locked while the design agent is working"'
    )
    expect(html).toContain(
      'title="Default 390 x 844 app frame. Design target switching is locked while the design agent is working"'
    )
  })

  it('explains why the rail target switch is disabled while the agent is busy', () => {
    const html = renderToStaticMarkup(createElement(DesignAIRail, props({
      activeThreadId: 'thread-current-document',
      busy: true,
      designThreads: [{
        id: 'thread-current-document',
        title: 'Design Assistant',
        workspace: '/tmp/kun-design',
        model: 'deepseek-chat',
        mode: 'agent',
        updatedAt: '2026-07-03T00:00:00.000Z'
      }]
    })))

    expect(html).toContain('Design target switching is locked while the design agent is working')
    expect(html).toContain(
      'aria-label="Web: Default 1280 x 800 web frame. Design target switching is locked while the design agent is working"'
    )
  })
})
