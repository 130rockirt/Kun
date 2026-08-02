import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '../store/chat-store'
import { useDesignWorkspaceStore } from './design-workspace-store'
import { runDesignPages } from './design-pages-run'
import type { ChatBlock } from '../agent/types'
import type { DesignDocument } from './design-types'
import type { SendMessageOverrides } from '../store/chat-store-types'

const createdAt = '2026-06-28T00:00:00.000Z'

function pushRuntimeTurn(prompt: string, assistantBlocks: ChatBlock[]): void {
  const user: ChatBlock = {
    kind: 'user',
    id: `user_${Math.random().toString(36).slice(2)}`,
    text: prompt,
    createdAt
  }
  useChatStore.setState((state) => ({
    blocks: [...state.blocks, user],
    currentTurnId: `turn_${Math.random().toString(36).slice(2)}`,
    liveAssistant: ''
  }))
  setTimeout(() => {
    useChatStore.setState((state) => ({
      blocks: [...state.blocks, ...assistantBlocks],
      currentTurnId: null,
      liveAssistant: ''
    }))
  }, 0)
}

function pageLabels(prompt: string): string[] {
  return [...prompt.matchAll(/page:([a-zA-Z0-9_-]+)/g)]
    .map((match) => match[1])
    .filter((value, index, all) => value && all.indexOf(value) === index)
}

describe('runDesignPages parallel fanout', () => {
  const writeWorkspaceFile = vi.fn(async (_payload: { path?: string }) => ({ ok: true as const }))

  beforeEach(() => {
    vi.stubGlobal('window', { kunGui: { writeWorkspaceFile } })
    writeWorkspaceFile.mockClear()
    useChatStore.setState({
      blocks: [],
      currentTurnId: null,
      liveAssistant: '',
      liveReasoning: ''
    })
    const doc: DesignDocument = {
      id: 'doc',
      title: 'Doc',
      createdAt,
      updatedAt: createdAt,
      order: 0,
      artifacts: [],
      activeArtifactId: null
    }
    useDesignWorkspaceStore.setState({
      workspaceRoot: '/workspace',
      documents: [doc],
      activeDocumentId: 'doc',
      artifacts: [],
      activeArtifactId: null,
      pagesRun: null,
      parallelPageStates: {},
      fileError: null
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('pre-creates all pages and sends one fanout turn for page generation', async () => {
    const onFirstSendSettled = vi.fn()
    const sendMessage = vi.fn(async (
      prompt: string,
      _mode?: string,
      _overrides?: SendMessageOverrides
    ) => {
      if (prompt.includes('PLAN a multi-page')) {
        pushRuntimeTurn(prompt, [
          {
            kind: 'assistant',
            id: 'assistant_plan',
            text: '```pages\n[{"title":"Landing","brief":"Landing page","userGoal":"Decide whether to join the IKUN community","dataExamples":["8,421 active members","June watch party","VIP tier $12"],"states":["loading featured posts","empty events"],"primaryAction":"Join community","linksTo":["Community"]},{"title":"Community","brief":"Community feed","userGoal":"Browse member stories and post an update","dataExamples":["Mina Chen","3 new replies","Shanghai fan club"],"states":["empty feed","posting disabled"],"primaryAction":"Post update","linksTo":["Landing"]}]\n```',
            createdAt
          }
        ])
        return true
      }
      const labels = pageLabels(prompt)
      pushRuntimeTurn(
        prompt,
        labels.map((artifactId, index) => ({
          kind: 'tool' as const,
          id: `tool_${artifactId}`,
          summary: 'delegate_task',
          status: 'success' as const,
          detail: JSON.stringify({
            label: `page:${artifactId}`,
            childId: `child_${index + 1}`,
            status: 'completed',
            summary: `Finished ${artifactId}`
          }),
          meta: { toolName: 'delegate_task' }
        }))
      )
      return true
    })

    await runDesignPages({
      brief: 'IKUN community',
      workspaceRoot: '/workspace',
      sendMessage,
      foundation: false,
      serviceTier: 'priority',
      expectedThreadId: 'thr_design',
      onFirstSendSettled
    })

    expect(onFirstSendSettled).toHaveBeenCalledTimes(1)
    expect(onFirstSendSettled).toHaveBeenCalledWith(true)
    expect(sendMessage).toHaveBeenCalledTimes(2)
    for (const call of sendMessage.mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({
        agentSurface: 'design',
        serviceTier: 'priority',
        expectedThreadId: 'thr_design'
      }))
    }
    const fanoutPrompt = String(sendMessage.mock.calls[1]?.[0] ?? '')
    expect(fanoutPrompt).toContain('fan out a multi-page design build')
    expect(fanoutPrompt).toContain('delegate_task')
    expect(fanoutPrompt).toContain('User goal for this page: Decide whether to join the IKUN community')
    expect(fanoutPrompt).toContain('Required realistic content/data to visibly include:')
    expect(fanoutPrompt).toContain('8,421 active members')
    expect(fanoutPrompt).toContain('Key UI states to represent or document in the screen:')
    expect(fanoutPrompt).toContain('loading featured posts')
    expect(fanoutPrompt).toContain('Primary prototype action for this page: Join community')
    expect(fanoutPrompt).toContain('Planned outgoing prototype links from this page:')
    expect(fanoutPrompt).toContain('Use these exact href values')
    expect(fanoutPrompt).toContain('Job 2: Community')
    expect(fanoutPrompt).toContain('Community feed')
    expect(fanoutPrompt).toMatch(/\\?"Community\\?" -> href `\.\.\/[a-z0-9_-]+\/v1\.html`/)
    expect(fanoutPrompt).toContain('prototype href: ../')
    expect(useDesignWorkspaceStore.getState().artifacts).toHaveLength(2)
    const artifacts = useDesignWorkspaceStore.getState().artifacts
    expect(new Set(artifacts.map((artifact) => artifact.direction?.id))).toHaveLength(1)
    expect(artifacts.every((artifact) => artifact.direction?.name === 'IKUN community')).toBe(true)
    expect(useDesignWorkspaceStore.getState().pagesRun).toBeNull()
    expect(Object.values(useDesignWorkspaceStore.getState().parallelPageStates)).toHaveLength(2)
    expect(Object.values(useDesignWorkspaceStore.getState().parallelPageStates).every((state) => state.status === 'done')).toBe(true)
    const htmlWrites = writeWorkspaceFile.mock.calls.filter((call) => {
      const payload = call[0] as { path?: string } | undefined
      return String(payload?.path ?? '').endsWith('/v1.html')
    })
    expect(htmlWrites).toHaveLength(2)
    const projectDesignMdWrite = writeWorkspaceFile.mock.calls.find((call) => {
      const payload = call[0] as { path?: string; content?: string } | undefined
      return payload?.path === '.kun-design/HANDOFF.md'
    })?.[0] as { content?: string } | undefined
    expect(projectDesignMdWrite?.content).toContain('# DESIGN.md: Doc')
    expect(projectDesignMdWrite?.content).toContain('IKUN community')
    expect(projectDesignMdWrite?.content).toContain('Join community')
    expect(projectDesignMdWrite?.content).toContain('../')
  })

  it('reports a rejected first runtime send exactly once and stops before creating pages', async () => {
    const onFirstSendSettled = vi.fn()
    const sendMessage = vi.fn(async () => false)

    await runDesignPages({
      brief: 'IKUN community',
      workspaceRoot: '/workspace',
      sendMessage,
      foundation: false,
      onFirstSendSettled
    })

    expect(onFirstSendSettled).toHaveBeenCalledTimes(1)
    expect(onFirstSendSettled).toHaveBeenCalledWith(false)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(useDesignWorkspaceStore.getState().artifacts).toEqual([])
    expect(useDesignWorkspaceStore.getState().fileError).toBe(
      'Could not start the multi-page planning turn.'
    )
  })

  it('pre-creates app-target page drafts with mobile preview proportions and prototype links', async () => {
    const sendMessage = vi.fn(async (prompt: string) => {
      if (prompt.includes('PLAN a multi-page')) {
        pushRuntimeTurn(prompt, [
          {
            kind: 'assistant',
            id: 'assistant_plan_app',
            text: '```pages\n[{"title":"Today","brief":"Mobile today screen with bottom tabs and a primary check-in action","primaryAction":"Check in","linksTo":["Stats"]},{"title":"Stats","brief":"Mobile stats screen with weekly trend and back navigation","primaryAction":"Review week","linksTo":["Today"]}]\n```',
            createdAt
          }
        ])
        return true
      }
      const labels = pageLabels(prompt)
      pushRuntimeTurn(
        prompt,
        labels.map((artifactId, index) => ({
          kind: 'tool' as const,
          id: `tool_app_${artifactId}`,
          summary: 'delegate_task',
          status: 'success' as const,
          detail: JSON.stringify({
            label: `page:${artifactId}`,
            childId: `child_app_${index + 1}`,
            status: 'completed',
            summary: `Finished ${artifactId}`
          }),
          meta: { toolName: 'delegate_task' }
        }))
      )
      return true
    })

    await runDesignPages({
      brief: 'Habit tracker app',
      workspaceRoot: '/workspace',
      sendMessage,
      foundation: false,
      designContext: { designTarget: 'app' }
    })

    const planPrompt = String(sendMessage.mock.calls[0]?.[0] ?? '')
    const fanoutPrompt = String(sendMessage.mock.calls[1]?.[0] ?? '')
    expect(planPrompt).toContain('multi-page mobile app prototype')
    expect(planPrompt).toContain('390x844 phone frame')
    expect(fanoutPrompt).toContain('Design target: App')
    expect(fanoutPrompt).toContain('390x844 phone portrait')

    const artifacts = useDesignWorkspaceStore.getState().artifacts
    expect(artifacts).toHaveLength(2)
    expect(artifacts.every((artifact) => artifact.node?.width === 300 && artifact.node.height === 640)).toBe(true)
    expect(artifacts.every((artifact) => artifact.prototypeLinks?.length === 1)).toBe(true)
    expect(artifacts.map((artifact) => artifact.prototypeLinks?.[0]?.href)).toEqual(
      expect.arrayContaining([expect.stringMatching(/\.\.\/.+\/v1\.html/)])
    )
  })
})
