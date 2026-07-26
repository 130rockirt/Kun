import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import i18n from '../../i18n'
import { useChatStore } from '../../store/chat-store'
import { ConversationTurn } from './MessageTimeline'
import type { Turn } from './message-timeline-turns'

const turn: Turn = {
  user: {
    kind: 'user',
    id: 'side-user',
    turnId: 'side-turn',
    text: 'hello from a branch',
    modelLabel: 'gpt-5.6'
  },
  blocks: [{
    kind: 'assistant',
    id: 'side-assistant',
    turnId: 'side-turn',
    text: 'branch answer'
  }]
}

function renderTurn(allowMainThreadActions: boolean): string {
  return renderToStaticMarkup(createElement(ConversationTurn, {
    turn,
    isProcessing: false,
    liveReasoning: '',
    live: '',
    filePreviewWorkspaceRoot: '/workspace',
    viewportRef: { current: null },
    allowMainThreadActions
  }))
}

describe('ConversationTurn branch rendering', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
    useChatStore.setState({
      route: 'chat',
      busy: false,
      activeThreadGoal: null
    })
  })

  it('keeps main turn presentation while disabling main-thread mutation actions', () => {
    const branchHtml = renderTurn(false)

    expect(branchHtml).toContain('ds-user-message-bubble')
    expect(branchHtml).toContain('hello from a branch')
    expect(branchHtml).toContain('branch answer')
    expect(branchHtml).not.toContain('Fork response')
    expect(branchHtml).not.toContain('Edit &amp; resend')
  })

  it('retains fork and edit affordances for the main conversation', () => {
    const mainHtml = renderTurn(true)

    expect(mainHtml).toContain('Fork response')
    expect(mainHtml).toContain('Edit &amp; resend')
  })
})
