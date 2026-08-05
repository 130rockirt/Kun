import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defaultClawSettings,
  defaultDesignSettings,
  defaultKeyboardShortcuts,
  defaultKunRuntimeSettings,
  defaultModelProviderSettings,
  defaultScheduleSettings,
  defaultWorkflowSettings,
  defaultWriteSettings,
  defaultTerminalSettings,
  type AppSettingsV1
} from '@shared/app-settings'
import { KunRuntimeProvider } from './kun-runtime'
import { getProvider, resetProviderCacheForTests } from './registry'
import { rendererRuntimeClient } from './runtime-client'
import type { ThreadEventSink } from './types'

const DEFAULT_EXECUTION_SETTINGS = {
  approvalPolicy: 'auto',
  sandboxMode: 'danger-full-access',
  approvalReviewer: 'user'
} as const

function settings(): AppSettingsV1 {
  return {
    version: 1,
    locale: 'en',
    theme: 'system',
    uiFontScale: 0.82,
    chatContentMaxWidthPx: 896,
    composerSendKey: 'enter',
    provider: defaultModelProviderSettings(),
    agents: {
      kun: defaultKunRuntimeSettings()
    },
    workspaceRoot: '/tmp/workspace',
    conversationWorkspaceRoot: '~/Documents/Kun',
    log: { enabled: false, retentionDays: 7 },
    checkpointCleanup: { createEnabled: false, enabled: false, intervalDays: 3 },
    notifications: { turnComplete: true },
    appBehavior: { openAtLogin: false, startMinimized: false, closeToTray: false },
    keyboardShortcuts: defaultKeyboardShortcuts(),
    write: defaultWriteSettings(),
    claw: defaultClawSettings(),
    schedule: defaultScheduleSettings(),
    workflow: defaultWorkflowSettings(),
    design: defaultDesignSettings(),
    terminal: defaultTerminalSettings(),
    guiUpdate: { channel: 'stable' },
    codePromptPrefix: '',
    disabledSkillIds: []
  }
}

function installDsGui(overrides: Partial<Window['kunGui']>): void {
  vi.stubGlobal('window', {
    kunGui: {
      getSettings: vi.fn(async () => settings()),
      runtimeRequest: vi.fn(async () => ({ ok: true, status: 200, body: '{}' })),
      resolveKunApproval: vi.fn(async () => ({
        confirmed: true,
        response: { ok: true, status: 200, body: '{}' }
      })),
      startSse: vi.fn(async (_threadId: string, _sinceSeq: number, streamId?: string) => ({
        streamId: streamId ?? 'stream-1'
      })),
      stopSse: vi.fn(async () => true),
      ackSse: vi.fn(async () => true),
      onSseEvent: vi.fn(() => () => undefined),
      onSseEnd: vi.fn(() => () => undefined),
      onSseError: vi.fn(() => () => undefined),
      ...overrides
    }
  })
}

afterEach(() => {
  rendererRuntimeClient.invalidateSettings()
  vi.unstubAllGlobals()
})

describe('KunRuntimeProvider', () => {
  it('reports the kun id and Kun display name', () => {
    const provider = new KunRuntimeProvider()
    expect(provider.id).toBe('kun')
    expect(provider.displayName).toBe('Kun')
  })

  it('exposes the local HTTP/SSE capabilities', () => {
    const provider = new KunRuntimeProvider()
    const caps = provider.getCapabilities()
    expect(caps.stream).toBe(true)
    expect(caps.interrupt).toBe(true)
    expect(caps.approvals).toBe(true)
  })

  it('reports invalid runtime JSON responses with a stable error message', async () => {
    installDsGui({
      runtimeRequest: vi.fn(async () => ({
        ok: true,
        status: 200,
        body: '{not-json'
      }))
    })
    const provider = new KunRuntimeProvider()

    await expect(provider.listThreads()).rejects.toThrow(
      'runtime returned an invalid thread list response'
    )
  })

  it('does not impose a hidden limit when listing the full thread inventory', async () => {
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: JSON.stringify({ threads: [] })
    }))
    installDsGui({ runtimeRequest })
    const provider = new KunRuntimeProvider()

    await provider.listThreads({ includeArchived: true })

    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/threads?include_archived=true',
      'GET'
    )
  })

  it('preserves an explicit thread list limit for bounded callers', async () => {
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: JSON.stringify({ threads: [] })
    }))
    installDsGui({ runtimeRequest })
    const provider = new KunRuntimeProvider()

    await provider.listThreads({ limit: 25 })

    expect(runtimeRequest).toHaveBeenCalledWith('/v1/threads?limit=25', 'GET')
  })

  it('rejects thread creation before the runtime request when the workspace is missing', async () => {
    const runtimeRequest = vi.fn(async () => ({ ok: true, status: 200, body: '{}' }))
    const alertDialog = vi.fn(async () => undefined)
    installDsGui({
      runtimeRequest,
      workspaceDirectoryExists: vi.fn(async () => false),
      alertDialog
    })
    const provider = new KunRuntimeProvider()

    await expect(provider.createThread({ workspace: 'E:\\missing-project' }))
      .rejects.toThrow(/working directory/i)

    expect(runtimeRequest).not.toHaveBeenCalled()
    expect(alertDialog).not.toHaveBeenCalled()
  })

  it('does not fall back to stale GUI settings when the shared registry has no connected default', async () => {
    const runtimeRequest = vi.fn(async (path: string) => {
      expect(path).toBe('/v1/model-connections')
      return {
        ok: true,
        status: 200,
        body: JSON.stringify({
          schemaVersion: 1,
          revision: 3,
          providers: [],
          proxy: { enabled: false, url: '' },
          routePools: [],
          localModelGateway: { enabled: false }
        })
      }
    })
    installDsGui({
      runtimeRequest,
      workspaceDirectoryExists: vi.fn(async () => true)
    })

    await expect(new KunRuntimeProvider().createThread({ workspace: '/tmp/workspace' }))
      .rejects.toThrow(/connected model/i)
    expect(runtimeRequest).toHaveBeenCalledTimes(1)
  })

  it('creates a new GUI session from the live shared default rather than stale local settings', async () => {
    const runtimeRequest = vi.fn(async (path: string, method?: string, body?: string) => {
      if (path === '/v1/model-connections') {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            schemaVersion: 1,
            revision: 4,
            providers: [{
              id: 'codex',
              accountId: 'account:codex',
              configured: true,
              models: ['gpt-live']
            }],
            defaultProviderId: 'codex',
            defaultAccountId: 'account:codex',
            defaultModel: 'gpt-live'
          })
        }
      }
      expect(path).toBe('/v1/threads')
      expect(method).toBe('POST')
      expect(JSON.parse(body ?? '{}')).toMatchObject({
        providerId: 'codex',
        accountId: 'account:codex',
        model: 'gpt-live',
        agentSurface: 'design',
        modelRequestCaptureEnabled: false
      })
      return {
        ok: true,
        status: 201,
        body: JSON.stringify({
          id: 'thr_live',
          title: 'Live',
          agentSurface: 'design',
          workspace: '/tmp/workspace',
          model: 'gpt-live',
          providerId: 'codex',
          accountId: 'account:codex',
          mode: 'agent',
          status: 'idle',
          createdAt: 't0',
          updatedAt: 't0',
          turns: []
        })
      }
    })
    installDsGui({
      runtimeRequest,
      workspaceDirectoryExists: vi.fn(async () => true)
    })

    await expect(new KunRuntimeProvider().createThread({
      workspace: '/tmp/workspace',
      agentSurface: 'design'
    })).resolves.toMatchObject({ id: 'thr_live', model: 'gpt-live', agentSurface: 'design' })
  })

  it('starts MCP OAuth authorization through the authenticated runtime bridge', async () => {
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: JSON.stringify({ serverId: 'google_drive', status: 'authorized', authorized: true })
    }))
    installDsGui({ runtimeRequest })

    const result = await new KunRuntimeProvider().authorizeMcpOAuthCredentials('google_drive')

    expect(runtimeRequest).toHaveBeenCalledWith('/v1/mcp/oauth/google_drive', 'POST')
    expect(result).toEqual({ serverId: 'google_drive', status: 'authorized', authorized: true })
  })

  it('maps Kun thread items into chat blocks', async () => {
    installDsGui({
      runtimeRequest: vi.fn(async () => ({
        ok: true,
        status: 200,
        body: JSON.stringify({
          id: 'thr_1',
          title: 'Demo',
          workspace: '/tmp',
          model: 'deepseek-chat',
          mode: 'agent',
          status: 'idle',
          createdAt: 't0',
          updatedAt: 't1',
          latestSeq: 9,
          turns: [
            {
              id: 'turn_1',
              threadId: 'thr_1',
              status: 'completed',
              prompt: 'hi',
              createdAt: 't0',
              guiDesignCanvas: true,
              items: [
                {
                  id: 'item_user',
                  turnId: 'turn_1',
                  threadId: 'thr_1',
                  role: 'user',
                  status: 'completed',
                  createdAt: 't0',
                  kind: 'user_message',
                  text: 'hi'
                },
                {
                  id: 'item_answer',
                  turnId: 'turn_1',
                  threadId: 'thr_1',
                  role: 'assistant',
                  status: 'completed',
                  createdAt: 't1',
                  kind: 'assistant_text',
                  text: 'hello'
                }
              ]
            }
          ]
        })
      }))
    })
    const provider = new KunRuntimeProvider()
    const detail = await provider.getThreadDetail('thr_1')
    expect(detail.blocks.map((block) => block.kind)).toEqual(['user', 'assistant'])
    expect(detail.blocks[0]).toMatchObject({
      kind: 'user',
      meta: { guiDesignCanvas: true }
    })
    expect(detail.latestSeq).toBe(9)
    expect(detail.latestTurnId).toBe('turn_1')
    expect(detail.latestUserMessageId).toBe('item_user')
  })

  it.each([
    ['graph', 'graph', 'graph'],
    ['direct', 'direct', 'direct'],
    ['legacy missing', undefined, 'direct']
  ] as const)('normalizes %s latest-turn orchestration', async (_label, orchestration, expected) => {
    installDsGui({
      runtimeRequest: vi.fn(async () => ({
        ok: true,
        status: 200,
        body: JSON.stringify({
          id: 'thr_orchestration',
          title: 'Orchestration',
          workspace: '/tmp',
          model: 'deepseek-chat',
          mode: 'agent',
          status: 'running',
          createdAt: 't0',
          updatedAt: 't1',
          latestSeq: 1,
          turns: [{
            id: 'turn_orchestration',
            threadId: 'thr_orchestration',
            status: 'running',
            prompt: 'continue',
            createdAt: 't0',
            ...(orchestration ? { orchestration } : {}),
            items: []
          }]
        })
      }))
    })

    const detail = await new KunRuntimeProvider().getThreadDetail('thr_orchestration')

    expect(detail.latestTurnOrchestration).toBe(expected)
  })

  it('rehydrates persisted partial assistant output for a running turn', async () => {
    installDsGui({
      runtimeRequest: vi.fn(async () => ({
        ok: true,
        status: 200,
        body: JSON.stringify({
          id: 'thr_cursor',
          title: 'Cursor turn',
          workspace: '/tmp',
          model: 'grok-4.5',
          mode: 'agent',
          status: 'running',
          createdAt: 't0',
          updatedAt: 't1',
          latestSeq: 42,
          turns: [{
            id: 'turn_cursor',
            threadId: 'thr_cursor',
            status: 'running',
            prompt: 'review',
            createdAt: 't0',
            items: [{
              id: 'item_user',
              turnId: 'turn_cursor',
              threadId: 'thr_cursor',
              role: 'user',
              status: 'completed',
              createdAt: 't0',
              kind: 'user_message',
              text: 'review'
            }, {
              id: 'item_cursor_text',
              turnId: 'turn_cursor',
              threadId: 'thr_cursor',
              role: 'assistant',
              status: 'running',
              createdAt: 't1',
              kind: 'assistant_text',
              text: 'partial Cursor response'
            }]
          }]
        })
      }))
    })

    const detail = await new KunRuntimeProvider().getThreadDetail('thr_cursor')

    expect(detail.threadStatus).toBe('running')
    expect(detail.blocks).toContainEqual(expect.objectContaining({
      kind: 'assistant',
      id: 'item_cursor_text',
      text: 'partial Cursor response'
    }))
  })

  it('flags user_input blocks live only when the runtime gate still awaits them (#606)', async () => {
    const threadBody = (pendingUserInputIds: string[]): string =>
      JSON.stringify({
        id: 'thr_1',
        title: 'Demo',
        workspace: '/tmp',
        model: 'deepseek-chat',
        mode: 'agent',
        status: 'running',
        createdAt: 't0',
        updatedAt: 't1',
        latestSeq: 9,
        pendingUserInputIds,
        turns: [
          {
            id: 'turn_1',
            threadId: 'thr_1',
            status: 'running',
            prompt: 'hi',
            createdAt: 't0',
            items: [
              {
                id: 'item_input',
                turnId: 'turn_1',
                threadId: 'thr_1',
                role: 'assistant',
                status: 'pending',
                createdAt: 't1',
                kind: 'user_input',
                inputId: 'in_live',
                prompt: 'north or south?'
              }
            ]
          }
        ]
      })

    // Gate still awaiting in_live -> the rehydrated prompt stays answerable.
    installDsGui({
      runtimeRequest: vi.fn(async () => ({ ok: true, status: 200, body: threadBody(['in_live']) }))
    })
    const liveDetail = await new KunRuntimeProvider().getThreadDetail('thr_1')
    const liveBlock = liveDetail.blocks.find((block) => block.kind === 'user_input')
    expect(liveBlock).toMatchObject({ requestId: 'in_live', status: 'pending', live: true })

    // Gate empty (finished thread) -> the same pending item is NOT live.
    resetProviderCacheForTests()
    installDsGui({
      runtimeRequest: vi.fn(async () => ({ ok: true, status: 200, body: threadBody([]) }))
    })
    const staleDetail = await new KunRuntimeProvider().getThreadDetail('thr_1')
    const staleBlock = staleDetail.blocks.find((block) => block.kind === 'user_input')
    expect(staleBlock?.kind === 'user_input' && staleBlock.live).toBeFalsy()
  })

  it('expires a recovered approval when the runtime approval gate no longer awaits it', async () => {
    const threadBody = (pendingApprovalIds: string[]): string =>
      JSON.stringify({
        id: 'thr_approval',
        title: 'Demo',
        workspace: '/tmp',
        model: 'deepseek-chat',
        mode: 'agent',
        status: 'running',
        createdAt: 't0',
        updatedAt: 't1',
        latestSeq: 12,
        pendingApprovalIds,
        turns: [{
          id: 'turn_approval',
          threadId: 'thr_approval',
          status: 'running',
          prompt: 'run command',
          createdAt: 't0',
          items: [{
            id: 'item_approval',
            turnId: 'turn_approval',
            threadId: 'thr_approval',
            role: 'tool',
            status: 'pending',
            createdAt: 't1',
            kind: 'approval',
            approvalId: 'approval_live',
            toolName: 'bash',
            summary: 'Run tests'
          }]
        }]
      })

    installDsGui({
      runtimeRequest: vi.fn(async () => ({ ok: true, status: 200, body: threadBody(['approval_live']) }))
    })
    const liveDetail = await new KunRuntimeProvider().getThreadDetail('thr_approval')
    expect(liveDetail.blocks.find((block) => block.kind === 'approval'))
      .toMatchObject({ status: 'pending' })

    resetProviderCacheForTests()
    installDsGui({
      runtimeRequest: vi.fn(async () => ({ ok: true, status: 200, body: threadBody([]) }))
    })
    const staleDetail = await new KunRuntimeProvider().getThreadDetail('thr_approval')
    expect(staleDetail.blocks.find((block) => block.kind === 'approval'))
      .toMatchObject({ status: 'expired' })
  })

  it('coalesces tool_call and tool_result pairs into one tool block on thread load', async () => {
    installDsGui({
      runtimeRequest: vi.fn(async () => ({
        ok: true,
        status: 200,
        body: JSON.stringify({
          id: 'thr_1',
          title: 'Demo',
          workspace: '/tmp',
          model: 'deepseek-chat',
          mode: 'agent',
          status: 'idle',
          createdAt: 't0',
          updatedAt: 't1',
          latestSeq: 9,
          turns: [
            {
              id: 'turn_1',
              threadId: 'thr_1',
              status: 'completed',
              prompt: 'run echo',
              createdAt: 't0',
              items: [
                {
                  id: 'item_call',
                  turnId: 'turn_1',
                  threadId: 'thr_1',
                  role: 'tool',
                  status: 'pending',
                  createdAt: 't0',
                  kind: 'tool_call',
                  toolName: 'echo',
                  callId: 'call_1',
                  arguments: { text: 'hi' }
                },
                {
                  id: 'item_result',
                  turnId: 'turn_1',
                  threadId: 'thr_1',
                  role: 'tool',
                  status: 'completed',
                  createdAt: 't1',
                  kind: 'tool_result',
                  toolName: 'echo',
                  callId: 'call_1',
                  output: { echoed: 'hi' }
                }
              ]
            }
          ]
        })
      }))
    })
    const provider = new KunRuntimeProvider()
    const detail = await provider.getThreadDetail('thr_1')
    expect(detail.blocks).toHaveLength(1)
    expect(detail.blocks[0]).toMatchObject({
      kind: 'tool',
      id: 'tool_call_1',
      status: 'success'
    })
  })

  it('posts Kun turn requests and returns the deterministic user item id', async () => {
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 202,
      body: JSON.stringify({ threadId: 'thr_1', turnId: 'turn_abc', userMessageItemId: 'item_user_real' })
    }))
    installDsGui({ runtimeRequest })
    const provider = new KunRuntimeProvider()
    const result = await provider.sendUserMessage('thr_1', 'hello')
    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/threads/thr_1/turns',
      'POST',
      JSON.stringify({
        prompt: 'hello',
        clientSurface: 'gui',
        ...DEFAULT_EXECUTION_SETTINGS
      })
    )
    expect(result.userMessageItemId).toBe('item_user_real')
  })

  it('posts per-turn provider ids with Kun turn requests when provided', async () => {
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 202,
      body: JSON.stringify({ threadId: 'thr_1', turnId: 'turn_abc', userMessageItemId: 'item_user_real' })
    }))
    installDsGui({ runtimeRequest })
    const provider = new KunRuntimeProvider()
    await provider.sendUserMessage('thr_1', 'hello', {
      model: 'mimo-v2.5',
      providerId: 'xiaomi-token-plan'
    })
    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/threads/thr_1/turns',
      'POST',
      JSON.stringify({
        prompt: 'hello',
        clientSurface: 'gui',
        model: 'mimo-v2.5',
        providerId: 'xiaomi-token-plan',
        ...DEFAULT_EXECUTION_SETTINGS
      })
    )
  })

  it('uses the configured Plan-mode model and provider when the turn has no explicit override', async () => {
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 202,
      body: JSON.stringify({ threadId: 'thr_1', turnId: 'turn_plan', userMessageItemId: 'item_plan' })
    }))
    installDsGui({
      runtimeRequest,
      getSettings: vi.fn(async () => ({
        ...settings(),
        agents: {
          kun: {
            ...defaultKunRuntimeSettings(),
            planModel: 'reasoning-pro',
            planProviderId: 'provider-pro'
          }
        }
      }))
    })
    await new KunRuntimeProvider().sendUserMessage('thr_1', 'draft a plan', { mode: 'plan' })

    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/threads/thr_1/turns',
      'POST',
      JSON.stringify({
        prompt: 'draft a plan',
        clientSurface: 'gui',
        model: 'reasoning-pro',
        providerId: 'provider-pro',
        ...DEFAULT_EXECUTION_SETTINGS,
        mode: 'plan'
      })
    )
  })

  it('posts workspace checkpoint ids with Kun turn requests when provided', async () => {
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 202,
      body: JSON.stringify({ threadId: 'thr_1', turnId: 'turn_abc', userMessageItemId: 'item_user_real' })
    }))
    installDsGui({ runtimeRequest })
    const provider = new KunRuntimeProvider()
    await provider.sendUserMessage('thr_1', 'hello', { workspaceCheckpointId: 'gcp_1' })
    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/threads/thr_1/turns',
      'POST',
      JSON.stringify({
        prompt: 'hello',
        clientSurface: 'gui',
        ...DEFAULT_EXECUTION_SETTINGS,
        workspaceCheckpointId: 'gcp_1'
      })
    )
  })

  it('posts pending checkpoint request ids without claiming rollback is ready', async () => {
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 202,
      body: JSON.stringify({ threadId: 'thr_1', turnId: 'turn_abc', userMessageItemId: 'item_user_real' })
    }))
    installDsGui({ runtimeRequest })
    const provider = new KunRuntimeProvider()
    await provider.sendUserMessage('thr_1', 'hello', {
      workspaceCheckpointRequestId: 'gcp_pending_1'
    })
    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/threads/thr_1/turns',
      'POST',
      JSON.stringify({
        prompt: 'hello',
        clientSurface: 'gui',
        ...DEFAULT_EXECUTION_SETTINGS,
        workspaceCheckpointRequestId: 'gcp_pending_1'
      })
    )
  })

  it('posts bounded extension composer context with the next Kun turn', async () => {
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 202,
      body: JSON.stringify({ threadId: 'thr_1', turnId: 'turn_abc', userMessageItemId: 'item_user_real' })
    }))
    installDsGui({ runtimeRequest })
    const provider = new KunRuntimeProvider()
    const composerContext = {
      schemaVersion: 1 as const,
      id: 'video-selection',
      title: 'Interview selection',
      summary: 'Revision 4 with two selected clips',
      reference: { projectId: 'project-1', selectedItemIds: ['clip-1'] },
      revision: 4,
      generation: 7,
      attachmentId: `extension-context:${'a'.repeat(64)}`,
      provenance: {
        extensionId: 'acme.video-editor',
        extensionVersion: '1.1.0',
        viewContributionId: 'extension:acme.video-editor/editor',
        workspaceId: 'b'.repeat(64)
      }
    }
    await provider.sendUserMessage('thr_1', 'Use the selection', {
      composerContexts: [composerContext]
    })
    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/threads/thr_1/turns',
      'POST',
      JSON.stringify({
        prompt: 'Use the selection',
        clientSurface: 'gui',
        ...DEFAULT_EXECUTION_SETTINGS,
        composerContexts: [composerContext]
      })
    )
  })

  it('posts GUI design canvas turn metadata when provided', async () => {
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 202,
      body: JSON.stringify({ threadId: 'thr_1', turnId: 'turn_canvas', userMessageItemId: 'item_user_canvas' })
    }))
    installDsGui({ runtimeRequest })
    const provider = new KunRuntimeProvider()
    await provider.sendUserMessage('thr_1', 'design a screen', {
      guiDesignCanvas: true,
      guiDesignMode: true
    })
    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/threads/thr_1/turns',
      'POST',
      JSON.stringify({
        prompt: 'design a screen',
        clientSurface: 'gui',
        ...DEFAULT_EXECUTION_SETTINGS,
        guiDesignCanvas: true,
        guiDesignMode: true
      })
    )
  })

  it('posts the reserved SVG artifact context for structured SVG turns', async () => {
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 202,
      body: JSON.stringify({ threadId: 'thr_1', turnId: 'turn_svg', userMessageItemId: 'item_user_svg' })
    }))
    installDsGui({ runtimeRequest })
    const provider = new KunRuntimeProvider()
    await provider.sendUserMessage('thr_1', 'animate the mark', {
      guiDesignMode: true,
      guiDesignArtifact: {
        kind: 'svg',
        artifactId: 'motion',
        relativePath: '.kun-design/doc/motion/v2.svg'
      }
    })
    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/threads/thr_1/turns',
      'POST',
      JSON.stringify({
        prompt: 'animate the mark',
        clientSurface: 'gui',
        ...DEFAULT_EXECUTION_SETTINGS,
        guiDesignMode: true,
        guiDesignArtifact: {
          kind: 'svg',
          artifactId: 'motion',
          relativePath: '.kun-design/doc/motion/v2.svg'
        }
      })
    )
  })

  it('posts rewind requests to the runtime', async () => {
    const runtimeRequest = vi.fn(async () => ({ ok: true, status: 200, body: '{}' }))
    installDsGui({ runtimeRequest })
    const provider = new KunRuntimeProvider()
    await provider.rewindThread('thr_1', 'turn_1')
    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/threads/thr_1/rewind',
      'POST',
      JSON.stringify({ turnId: 'turn_1' })
    )
  })

  it('posts attachment ids with Kun turn requests when provided', async () => {
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 202,
      body: JSON.stringify({ threadId: 'thr_1', turnId: 'turn_img', userMessageItemId: 'item_user_img' })
    }))
    installDsGui({ runtimeRequest })
    const provider = new KunRuntimeProvider()

    await provider.sendUserMessage('thr_1', 'describe this', { attachmentIds: ['att_1'] })

    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/threads/thr_1/turns',
      'POST',
      JSON.stringify({
        prompt: 'describe this',
        clientSurface: 'gui',
        ...DEFAULT_EXECUTION_SETTINGS,
        attachmentIds: ['att_1']
      })
    )
  })

  it('posts file references with Kun turn requests when provided', async () => {
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 202,
      body: JSON.stringify({ threadId: 'thr_1', turnId: 'turn_files', userMessageItemId: 'item_user_files' })
    }))
    installDsGui({ runtimeRequest })
    const provider = new KunRuntimeProvider()

    await provider.sendUserMessage('thr_1', 'explain these files', {
      fileReferences: [
        {
          path: '/workspace/deepseek-gui/src/App.tsx',
          relativePath: 'src/App.tsx',
          name: 'App.tsx',
          kind: 'file'
        },
        {
          path: '/workspace/deepseek-gui/src',
          relativePath: 'src',
          name: 'src',
          kind: 'directory'
        }
      ]
    })

    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/threads/thr_1/turns',
      'POST',
      JSON.stringify({
        prompt: 'explain these files',
        clientSurface: 'gui',
        ...DEFAULT_EXECUTION_SETTINGS,
        fileReferences: [
          {
            path: '/workspace/deepseek-gui/src/App.tsx',
            relativePath: 'src/App.tsx',
            name: 'App.tsx',
            kind: 'file'
          },
          {
            path: '/workspace/deepseek-gui/src',
            relativePath: 'src',
            name: 'src',
            kind: 'directory'
          }
        ]
      })
    )
  })

  it('posts explicit reasoning effort with Kun turn requests', async () => {
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 202,
      body: JSON.stringify({ threadId: 'thr_1', turnId: 'turn_reason', userMessageItemId: 'item_user_reason' })
    }))
    installDsGui({ runtimeRequest })
    const provider = new KunRuntimeProvider()

    await provider.sendUserMessage('thr_1', 'think harder', {
      model: 'auto',
      reasoningEffort: 'max'
    })

    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/threads/thr_1/turns',
      'POST',
      JSON.stringify({
        prompt: 'think harder',
        clientSurface: 'gui',
        model: 'auto',
        ...DEFAULT_EXECUTION_SETTINGS,
        reasoningEffort: 'max'
      })
    )
  })

  it('posts the canonical priority service tier for Fast turns', async () => {
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 202,
      body: JSON.stringify({ threadId: 'thr_1', turnId: 'turn_fast', userMessageItemId: 'item_user_fast' })
    }))
    installDsGui({ runtimeRequest })

    await new KunRuntimeProvider().sendUserMessage('thr_1', 'move faster', {
      model: 'gpt-5.4',
      providerId: 'codex-2',
      serviceTier: 'priority'
    })

    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/threads/thr_1/turns',
      'POST',
      JSON.stringify({
        prompt: 'move faster',
        clientSurface: 'gui',
        model: 'gpt-5.4',
        providerId: 'codex-2',
        ...DEFAULT_EXECUTION_SETTINGS,
        serviceTier: 'priority'
      })
    )
  })

  it('posts GUI plan context with Kun plan turn requests', async () => {
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 202,
      body: JSON.stringify({ threadId: 'thr_1', turnId: 'turn_plan', userMessageItemId: 'item_user_plan' })
    }))
    installDsGui({ runtimeRequest })
    const provider = new KunRuntimeProvider()

    await provider.sendUserMessage('thr_1', 'refine the plan', {
      mode: 'plan',
      displayText: 'Generate implementation plan',
      guiPlan: {
        operation: 'refine',
        workspaceRoot: '/workspace/deepseek-gui',
        relativePath: '.kunsdd/plan/auth.md',
        planId: '/workspace/deepseek-gui:.kunsdd/plan/auth.md',
        sourceRequest: 'Add auth',
        title: 'auth'
      }
    })

    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/threads/thr_1/turns',
      'POST',
      JSON.stringify({
        prompt: 'refine the plan',
        clientSurface: 'gui',
        ...DEFAULT_EXECUTION_SETTINGS,
        displayText: 'Generate implementation plan',
        mode: 'plan',
        guiPlan: {
          operation: 'refine',
          workspaceRoot: '/workspace/deepseek-gui',
          relativePath: '.kunsdd/plan/auth.md',
          planId: '/workspace/deepseek-gui:.kunsdd/plan/auth.md',
          sourceRequest: 'Add auth',
          title: 'auth'
        }
      })
    )
  })

  it('posts interrupt requests with the discard option when requested', async () => {
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: '{}'
    }))
    installDsGui({ runtimeRequest })
    const provider = new KunRuntimeProvider()

    await provider.interruptTurn('thr_1', 'turn_1', { discard: true })

    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/threads/thr_1/turns/turn_1/interrupt',
      'POST',
      JSON.stringify({ discard: true })
    )
  })

  it('posts mid-turn guidance with its user-facing display text', async () => {
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: '{}'
    }))
    installDsGui({ runtimeRequest })
    const provider = new KunRuntimeProvider()

    await provider.steerUserMessage(
      'thr_1',
      'turn_1',
      'use the compact logo instead',
      { displayText: 'Use the compact logo instead' }
    )

    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/threads/thr_1/turns/turn_1/steer',
      'POST',
      JSON.stringify({
        text: 'use the compact logo instead',
        displayText: 'Use the compact logo instead'
      })
    )
  })

  it('loads runtime diagnostics and uploads image attachments through Kun endpoints', async () => {
    const runtimeRequest = vi.fn(async (path: string) => {
      if (path === '/v1/runtime/info') {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            host: '127.0.0.1',
            port: 17878,
            dataDir: '/tmp/kun',
            startedAt: '2024-01-01T00:00:00.000Z',
            capabilities: {
              contractVersion: 1,
              model: {
                id: 'deepseek-chat',
                inputModalities: ['text', 'image'],
                outputModalities: ['text'],
                supportsToolCalling: true,
                messageParts: ['text', 'image_url']
              },
              cli: {
                serve: { status: 'available', enabled: true, available: true },
                run: { status: 'available', enabled: true, available: true },
                chat: { status: 'available', enabled: true, available: true },
                exec: { status: 'available', enabled: true, available: true }
              },
              mcp: { status: 'disabled', enabled: false, available: false, configuredServers: 0, connectedServers: 0, toolCount: 0 },
              web: {
                status: 'available',
                enabled: true,
                available: true,
                fetch: { status: 'available', enabled: true, available: true },
                search: { status: 'disabled', enabled: false, available: false }
              },
              skills: { status: 'disabled', enabled: false, available: false, configuredRoots: 0, discoveredSkills: 0 },
              subagents: { status: 'disabled', enabled: false, available: false, maxParallel: 0, maxChildRuns: 0 },
              attachments: {
                status: 'available',
                enabled: true,
                available: true,
                maxImageBytes: 5242880,
                maxImageDimension: 4096,
                allowedMimeTypes: ['image/png'],
                textFallbackMaxBase64Bytes: 524288,
                textFallbackMaxImageDimension: 1280,
                textFallbackPreferredMimeType: 'image/webp'
              },
              memory: { status: 'disabled', enabled: false, available: false, scopes: ['user'], maxInjectedRecords: 8 }
            }
          })
        }
      }
      if (path === '/v1/runtime/tools') {
        return { ok: true, status: 200, body: JSON.stringify({ providers: [{ id: 'web' }] }) }
      }
      if (path === '/v1/skills') {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            skills: [{
              id: 'review',
              name: 'Review',
              description: 'Review changes'
            }]
          })
        }
      }
      if (path === '/v1/attachments') {
        return {
          ok: true,
          status: 201,
          body: JSON.stringify({
            attachment: {
              id: 'att_1',
              name: 'shot.png',
              mimeType: 'image/png',
              byteSize: 3,
              hash: 'hash',
              localFilePath: '/tmp/picked/shot.png',
              createdAt: 't0',
              updatedAt: 't0'
            }
          })
        }
      }
      if (path === '/v1/attachments/att_1/content?thread_id=thr_1') {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            attachment: {
              id: 'att_1',
              name: 'shot.png',
              mimeType: 'image/png',
              byteSize: 3,
              hash: 'hash',
              localFilePath: '/tmp/picked/shot.png',
              createdAt: 't0',
              updatedAt: 't0'
            },
            dataBase64: 'abc'
          })
        }
      }
      return { ok: true, status: 200, body: '{}' }
    })
    installDsGui({ runtimeRequest })
    const provider = new KunRuntimeProvider()

    await expect(provider.getRuntimeInfo()).resolves.toMatchObject({
      capabilities: { attachments: { available: true } }
    })
    await expect(provider.getToolDiagnostics()).resolves.toMatchObject({
      providers: [{ id: 'web' }]
    })
    await expect(provider.listSkills()).resolves.toEqual([
      expect.objectContaining({
        id: 'review',
        name: 'Review',
        description: 'Review changes'
      })
    ])
    await expect(provider.uploadAttachment({
      name: 'shot.png',
      mimeType: 'image/png',
      dataBase64: 'abc',
      localFilePath: '/tmp/picked/shot.png',
      textFallback: {
        dataBase64: 'xyz',
        mimeType: 'image/webp',
        byteSize: 2,
        width: 1,
        height: 1,
        wasCompressed: true
      },
      threadId: 'thr_1'
    })).resolves.toMatchObject({ id: 'att_1', name: 'shot.png', localFilePath: '/tmp/picked/shot.png' })
    await expect(provider.getAttachmentContent('att_1', { threadId: 'thr_1' })).resolves.toMatchObject({
      attachment: { id: 'att_1', mimeType: 'image/png' },
      dataBase64: 'abc'
    })
    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/attachments',
      'POST',
      JSON.stringify({
        name: 'shot.png',
        mimeType: 'image/png',
        dataBase64: 'abc',
        localFilePath: '/tmp/picked/shot.png',
        textFallback: {
          dataBase64: 'xyz',
          mimeType: 'image/webp',
          byteSize: 2,
          width: 1,
          height: 1,
          wasCompressed: true
        },
        threadId: 'thr_1'
      })
    )
    await expect(provider.uploadAttachment({
      name: 'spec.pdf',
      mimeType: 'application/pdf',
      dataBase64: 'JVBERi0=',
      documentText: 'PDF body',
      pageCount: 2,
      localFilePath: '/tmp/picked/spec.pdf',
      workspace: '/tmp/ws'
    })).resolves.toMatchObject({ id: 'att_1' })
    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/attachments',
      'POST',
      JSON.stringify({
        name: 'spec.pdf',
        mimeType: 'application/pdf',
        dataBase64: 'JVBERi0=',
        documentText: 'PDF body',
        pageCount: 2,
        localFilePath: '/tmp/picked/spec.pdf',
        workspace: '/tmp/ws'
      })
    )
  })

  it('routes image uploads through the dedicated desktop bridge when available', async () => {
    const runtimeRequest = vi.fn(async () => ({ ok: true, status: 200, body: '{}' }))
    const uploadRuntimeImageAttachment = vi.fn(async () => ({
      ok: true as const,
      attachment: {
        id: 'att_bridge',
        name: 'large.webp',
        kind: 'image' as const,
        mimeType: 'image/webp',
        byteSize: 1024,
        hash: 'hash',
        createdAt: 't0',
        updatedAt: 't0'
      },
      preview: { dataBase64: 'AQID', mimeType: 'image/webp', byteSize: 3 },
      compression: {
        sourceBytes: 8 * 1024 * 1024,
        outputBytes: 1024,
        fallbackBytes: 3,
        wasCompressed: true
      }
    }))
    installDsGui({ runtimeRequest, uploadRuntimeImageAttachment })
    const provider = new KunRuntimeProvider()

    await expect(provider.uploadAttachment({
      name: 'large.png',
      mimeType: 'image/png',
      dataBase64: 'unused',
      localFilePath: '/tmp/large.png',
      threadId: 'thr_1'
    })).resolves.toMatchObject({ id: 'att_bridge', mimeType: 'image/webp' })
    expect(uploadRuntimeImageAttachment).toHaveBeenCalledWith({
      source: { kind: 'localPath', path: '/tmp/large.png' },
      name: 'large.png',
      threadId: 'thr_1'
    })
    expect(runtimeRequest).not.toHaveBeenCalled()
  })

  it('lists, toggles, and deletes memory records through Kun endpoints', async () => {
    const memoryPatches: string[] = []
    const runtimeRequest = vi.fn(async (path: string, method?: string, body?: string) => {
      if (path === '/v1/memory?workspace=%2Ftmp%2Fworkspace&include_deleted=false') {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            memories: [{
              id: 'mem_1',
              content: 'Use pnpm',
              scope: 'workspace',
              workspace: '/tmp/workspace',
              tags: ['tooling'],
              confidence: 0.9,
              createdAt: 't0',
              updatedAt: 't0'
            }]
          })
        }
      }
      if (path === '/v1/memory/mem_1?workspace=%2Ftmp%2Fworkspace' && method === 'PATCH') {
        memoryPatches.push(body ?? '')
        const disabled = JSON.parse(body ?? '{}').disabled === true
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            memory: {
              id: 'mem_1',
              content: 'Use pnpm',
              scope: 'workspace',
              ...(disabled ? { disabledAt: 't1' } : {}),
              createdAt: 't0',
              updatedAt: disabled ? 't1' : 't2'
            }
          })
        }
      }
      if (path === '/v1/memory/mem_1?workspace=%2Ftmp%2Fworkspace' && method === 'DELETE') {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            memory: {
              id: 'mem_1',
              content: 'Use pnpm',
              scope: 'workspace',
              deletedAt: 't2',
              createdAt: 't0',
              updatedAt: 't2'
            }
          })
        }
      }
      return { ok: true, status: 200, body: '{}' }
    })
    installDsGui({ runtimeRequest })
    const provider = new KunRuntimeProvider()

    await expect(provider.listMemories({ workspace: '/tmp/workspace', includeDeleted: false })).resolves.toHaveLength(1)
    await expect(provider.updateMemory('mem_1', { disabled: true }, { workspace: '/tmp/workspace' })).resolves.toMatchObject({
      id: 'mem_1',
      disabledAt: 't1'
    })
    await expect(provider.updateMemory('mem_1', { disabled: false }, { workspace: '/tmp/workspace' })).resolves.toMatchObject({
      id: 'mem_1',
      updatedAt: 't2'
    })
    expect(memoryPatches).toEqual([
      JSON.stringify({ disabled: true }),
      JSON.stringify({ disabled: false })
    ])
    await expect(provider.deleteMemory('mem_1', { workspace: '/tmp/workspace' })).resolves.toMatchObject({
      id: 'mem_1',
      deletedAt: 't2'
    })
  })

  it('calls Kun fork and user-input compatibility endpoints', async () => {
    const runtimeRequest = vi.fn(async (path: string) => ({
      ok: true,
      status: 200,
      body: path.includes('/fork')
        ? JSON.stringify({
            id: 'thr_fork',
            title: 'Forked',
            workspace: '/tmp/workspace',
            model: 'deepseek-chat',
            mode: 'agent',
            status: 'idle',
            forkedFromThreadId: 'thr_parent',
            createdAt: 't0',
            updatedAt: 't1'
          })
        : '{}'
    }))
    installDsGui({ runtimeRequest })
    const provider = new KunRuntimeProvider()

    const forked = await provider.forkThread('thr_parent')
    await provider.forkThread('thr_parent', { turnId: 'turn_1' })
    await provider.submitUserInputResponse('input_1', [
      {
        id: 'choice',
        label: 'Yes, Maybe',
        value: 'Yes, Maybe',
        labels: ['Yes', 'Maybe'],
        values: ['Yes', 'Maybe']
      }
    ])
    await provider.cancelUserInput('input_2')

    expect(forked).toMatchObject({ id: 'thr_fork', forkedFromThreadId: 'thr_parent' })
    expect(runtimeRequest).toHaveBeenCalledWith('/v1/threads/thr_parent/fork', 'POST')
    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/threads/thr_parent/fork',
      'POST',
      JSON.stringify({ turnId: 'turn_1' })
    )
    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/user-inputs/input_1',
      'POST',
      JSON.stringify({
        answers: [
          {
            id: 'choice',
            label: 'Yes, Maybe',
            value: 'Yes, Maybe',
            labels: ['Yes', 'Maybe'],
            values: ['Yes', 'Maybe']
          }
        ]
      })
    )
    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/user-inputs/input_2',
      'POST',
      JSON.stringify({ cancelled: true })
    )
  })

  it('resumes a session through the Kun HTTP runtime', async () => {
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 201,
      body: JSON.stringify({ thread_id: 'thr_resumed', session_id: 'sess_1' })
    }))
    installDsGui({ runtimeRequest })
    const provider = new KunRuntimeProvider()

    const result = await provider.resumeSession('sess_1', { mode: 'plan' })

    expect(result).toEqual({ threadId: 'thr_resumed', sessionId: 'sess_1' })
    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/sessions/sess_1/resume-thread',
      'POST',
      JSON.stringify({
        workspace: '/tmp/workspace',
        model: defaultKunRuntimeSettings().model,
        mode: 'plan'
      })
    )
  })

  it('maps Kun SSE deltas into the thread event sink', async () => {
    let onData: ((payload: { streamId: string; events: unknown[] }) => void) | null = null
    const ac = new AbortController()
    const sink: ThreadEventSink = {
      onConnected: vi.fn(),
      onSeq: vi.fn(() => ac.abort()),
      onDeltas: vi.fn(),
      onUserMessage: vi.fn(),
      onTool: vi.fn(),
      onCompaction: vi.fn(),
      onApproval: vi.fn(),
      onUserInput: vi.fn(),
      onUserInputStatus: vi.fn(),
      onGoal: vi.fn(),
      onTodos: vi.fn(),
      onTurnComplete: vi.fn(),
      onError: vi.fn()
    }
    installDsGui({
      onSseEvent: vi.fn((handler) => {
        onData = handler
        return () => undefined
      }),
      startSse: vi.fn(async (_threadId, _sinceSeq, streamId) => {
        queueMicrotask(() => {
          onData?.({
            streamId: streamId ?? 'stream-1',
            events: [
              {
                kind: 'assistant_text_delta',
                seq: 3,
                item: {
                  id: 'item_text',
                  turnId: 'turn_1',
                  threadId: 'thr_1',
                  role: 'assistant',
                  status: 'running',
                  createdAt: 't1',
                  kind: 'assistant_text',
                  text: 'he'
                }
              }
            ]
          })
        })
        return { streamId: streamId ?? 'stream-1' }
      })
    })
    const provider = new KunRuntimeProvider()
    await provider.subscribeThreadEvents('thr_1', 2, sink, ac.signal)
    expect(sink.onConnected).toHaveBeenCalledTimes(1)
    expect(sink.onSeq).toHaveBeenCalledWith(3)
    expect(sink.onDeltas).toHaveBeenCalledWith([{
      text: 'he',
      kind: 'agent_message',
      seq: 3,
      threadId: 'thr_1',
      turnId: 'turn_1',
      itemId: 'item_text',
      createdAt: 't1'
    }])
  })

  it('gates stale non-delta events and their side effects at the subscription high-water mark', async () => {
    let onData: ((payload: { streamId: string; events: unknown[] }) => void) | null = null
    const ac = new AbortController()
    const sink: ThreadEventSink = {
      onSeq: vi.fn(() => ac.abort()),
      onDeltas: vi.fn(),
      onUserMessage: vi.fn(),
      onTool: vi.fn(),
      onCompaction: vi.fn(),
      onApproval: vi.fn(),
      onUserInput: vi.fn(),
      onUserInputStatus: vi.fn(),
      onGoal: vi.fn(),
      onTodos: vi.fn(),
      onThreadUpdated: vi.fn(),
      onTurnComplete: vi.fn(),
      onError: vi.fn(),
      onChildRuntimeEvent: vi.fn(),
      onGraphEvent: vi.fn()
    }
    installDsGui({
      onSseEvent: vi.fn((handler) => {
        onData = handler
        return () => undefined
      }),
      startSse: vi.fn(async (_threadId, _sinceSeq, streamId) => {
        queueMicrotask(() => {
          onData?.({
            streamId: streamId ?? 'stream-1',
            events: [
              {
                kind: 'item_updated',
                seq: 199,
                item: {
                  id: 'item_tool',
                  callId: 'call_1',
                  turnId: 'turn_1',
                  threadId: 'thr_1',
                  role: 'assistant',
                  status: 'running',
                  kind: 'tool_call',
                  toolName: 'read_file',
                  arguments: { path: 'old.txt' }
                }
              },
              { kind: 'approval_requested', seq: 200, approvalId: 'stale-approval' },
              { kind: 'graph_event', seq: 150, graph: { kind: 'stale-graph' } },
              {
                kind: 'turn_started',
                seq: 180,
                child: {
                  parentThreadId: 'thr_1',
                  parentTurnId: 'turn_1',
                  childId: 'child_1',
                  childStatus: 'running',
                  childSeq: 1
                }
              },
              {
                kind: 'item_completed',
                seq: 201,
                item: {
                  id: 'item_result',
                  callId: 'call_1',
                  turnId: 'turn_1',
                  threadId: 'thr_1',
                  role: 'tool',
                  status: 'completed',
                  kind: 'tool_result',
                  toolName: 'read_file',
                  output: 'fresh result'
                }
              },
              // A duplicate persisted identity in the same batch is ignored.
              {
                kind: 'item_updated',
                seq: 201,
                item: {
                  id: 'item_tool',
                  callId: 'call_1',
                  turnId: 'turn_1',
                  threadId: 'thr_1',
                  role: 'assistant',
                  status: 'running',
                  kind: 'tool_call',
                  toolName: 'read_file',
                  arguments: { path: 'old.txt' }
                }
              },
              // Legacy unsequenced events remain compatible but never move the cursor.
              { kind: 'thread_updated', threadId: 'thr_1', title: 'Legacy title' },
              { kind: 'turn_completed', seq: 202, threadId: 'thr_1', turnId: 'turn_1' }
            ]
          })
        })
        return { streamId: streamId ?? 'stream-1' }
      })
    })

    await new KunRuntimeProvider().subscribeThreadEvents('thr_1', 200, sink, ac.signal)

    expect(sink.onTool).toHaveBeenCalledTimes(1)
    expect(sink.onTool).toHaveBeenCalledWith(expect.objectContaining({
      itemId: 'tool_call_1',
      status: 'success'
    }))
    expect(sink.onApproval).not.toHaveBeenCalled()
    expect(sink.onGraphEvent).not.toHaveBeenCalled()
    expect(sink.onChildRuntimeEvent).not.toHaveBeenCalled()
    expect(sink.onThreadUpdated).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Legacy title'
    }))
    expect(sink.onTurnComplete).toHaveBeenCalledOnce()
    expect(sink.onSeq).toHaveBeenCalledOnce()
    expect(sink.onSeq).toHaveBeenCalledWith(202)
  })

  it('acknowledges a stale-only replay batch without moving the renderer cursor', async () => {
    let onData: ((payload: { streamId: string; events: unknown[]; batchId?: string }) => void) | null = null
    const ac = new AbortController()
    const ackSse = vi.fn(async (_streamId: string, batchId: string) => {
      if (batchId === 'fresh-batch') ac.abort()
      return true
    })
    const sink: ThreadEventSink = {
      onSeq: vi.fn(),
      onDeltas: vi.fn(),
      onUserMessage: vi.fn(),
      onTool: vi.fn(),
      onCompaction: vi.fn(),
      onApproval: vi.fn(),
      onUserInput: vi.fn(),
      onUserInputStatus: vi.fn(),
      onGoal: vi.fn(),
      onTodos: vi.fn(),
      onThreadUpdated: vi.fn(),
      onTurnComplete: vi.fn(),
      onError: vi.fn()
    }
    installDsGui({
      ackSse,
      onSseEvent: vi.fn((handler) => {
        onData = handler
        return () => undefined
      }),
      startSse: vi.fn(async (_threadId, _sinceSeq, streamId) => {
        queueMicrotask(() => {
          onData?.({
            streamId: streamId ?? 'stream-1',
            batchId: 'stale-batch',
            events: [{ kind: 'thread_updated', seq: 200, threadId: 'thr_1', title: 'stale' }]
          })
          onData?.({
            streamId: streamId ?? 'stream-1',
            batchId: 'fresh-batch',
            events: [{ kind: 'thread_updated', seq: 201, threadId: 'thr_1', title: 'fresh' }]
          })
        })
        return { streamId: streamId ?? 'stream-1' }
      })
    })

    await new KunRuntimeProvider().subscribeThreadEvents('thr_1', 200, sink, ac.signal)

    expect(ackSse).toHaveBeenNthCalledWith(1, expect.any(String), 'stale-batch')
    expect(ackSse).toHaveBeenNthCalledWith(2, expect.any(String), 'fresh-batch')
    expect(sink.onThreadUpdated).toHaveBeenCalledOnce()
    expect(sink.onThreadUpdated).toHaveBeenCalledWith(expect.objectContaining({ title: 'fresh' }))
    expect(sink.onSeq).toHaveBeenCalledOnce()
    expect(sink.onSeq).toHaveBeenCalledWith(201)
  })

  it('treats a stale heartbeat as liveness without replaying stale lifecycle state', async () => {
    let onData: ((payload: { streamId: string; events: unknown[]; batchId?: string }) => void) | null = null
    const ac = new AbortController()
    const ackSse = vi.fn(async () => {
      ac.abort()
      return true
    })
    const sink: ThreadEventSink = {
      onSeq: vi.fn(),
      onDeltas: vi.fn(),
      onUserMessage: vi.fn(),
      onTool: vi.fn(),
      onCompaction: vi.fn(),
      onApproval: vi.fn(),
      onUserInput: vi.fn(),
      onUserInputStatus: vi.fn(),
      onGoal: vi.fn(),
      onTodos: vi.fn(),
      onThreadUpdated: vi.fn(),
      onTurnComplete: vi.fn(),
      onError: vi.fn()
    }
    installDsGui({
      ackSse,
      onSseEvent: vi.fn((handler) => {
        onData = handler
        return () => undefined
      }),
      startSse: vi.fn(async (_threadId, _sinceSeq, streamId) => {
        queueMicrotask(() => onData?.({
          streamId: streamId ?? 'stream-1',
          batchId: 'heartbeat-batch',
          events: [
            { kind: 'thread_updated', seq: 200, threadId: 'thr_1', title: 'stale' },
            { kind: 'heartbeat', seq: 200, threadId: 'thr_1' }
          ]
        }))
        return { streamId: streamId ?? 'stream-1' }
      })
    })

    await new KunRuntimeProvider().subscribeThreadEvents('thr_1', 200, sink, ac.signal)

    expect(sink.onThreadUpdated).not.toHaveBeenCalled()
    expect(sink.onSeq).toHaveBeenCalledOnce()
    expect(sink.onSeq).toHaveBeenCalledWith(200)
    expect(ackSse).toHaveBeenCalledWith(expect.any(String), 'heartbeat-batch')
  })

  it('replays an unacknowledged batch after projection fails without losing its event', async () => {
    const replayedEvent = {
      kind: 'item_completed',
      seq: 201,
      item: {
        id: 'item_result',
        callId: 'call_retry',
        turnId: 'turn_1',
        threadId: 'thr_1',
        role: 'tool',
        status: 'completed',
        kind: 'tool_result',
        toolName: 'read_file',
        output: 'durable result'
      }
    }
    const firstAck = vi.fn(async () => true)
    const firstSeq = vi.fn()
    const firstError = vi.fn()
    let firstOnData: ((payload: { streamId: string; events: unknown[]; batchId?: string }) => void) | null = null
    installDsGui({
      ackSse: firstAck,
      onSseEvent: vi.fn((handler) => {
        firstOnData = handler
        return () => undefined
      }),
      startSse: vi.fn(async (_threadId, _sinceSeq, streamId) => {
        queueMicrotask(() => firstOnData?.({
          streamId: streamId ?? 'stream-1',
          batchId: 'failed-batch',
          events: [replayedEvent]
        }))
        return { streamId: streamId ?? 'stream-1' }
      })
    })
    const throwingSink: ThreadEventSink = {
      onSeq: firstSeq,
      onDeltas: vi.fn(),
      onUserMessage: vi.fn(),
      onTool: vi.fn(() => {
        throw new Error('projection failed')
      }),
      onCompaction: vi.fn(),
      onApproval: vi.fn(),
      onUserInput: vi.fn(),
      onUserInputStatus: vi.fn(),
      onGoal: vi.fn(),
      onTodos: vi.fn(),
      onTurnComplete: vi.fn(),
      onError: firstError
    }

    await new KunRuntimeProvider().subscribeThreadEvents(
      'thr_1',
      200,
      throwingSink,
      new AbortController().signal
    )

    expect(firstError).toHaveBeenCalledWith(expect.objectContaining({ message: 'projection failed' }))
    expect(firstSeq).not.toHaveBeenCalled()
    expect(firstAck).not.toHaveBeenCalled()

    // Recovery opens a new stream from the last committed renderer cursor.
    // The runtime replays the failed batch and it must project normally.
    const replayAbort = new AbortController()
    const replayTool = vi.fn()
    let replayOnData: ((payload: { streamId: string; events: unknown[] }) => void) | null = null
    installDsGui({
      onSseEvent: vi.fn((handler) => {
        replayOnData = handler
        return () => undefined
      }),
      startSse: vi.fn(async (_threadId, sinceSeq, streamId) => {
        expect(sinceSeq).toBe(200)
        queueMicrotask(() => replayOnData?.({
          streamId: streamId ?? 'stream-2',
          events: [replayedEvent]
        }))
        return { streamId: streamId ?? 'stream-2' }
      })
    })
    const replaySink: ThreadEventSink = {
      onSeq: vi.fn(() => replayAbort.abort()),
      onDeltas: vi.fn(),
      onUserMessage: vi.fn(),
      onTool: replayTool,
      onCompaction: vi.fn(),
      onApproval: vi.fn(),
      onUserInput: vi.fn(),
      onUserInputStatus: vi.fn(),
      onGoal: vi.fn(),
      onTodos: vi.fn(),
      onTurnComplete: vi.fn(),
      onError: vi.fn()
    }

    await new KunRuntimeProvider().subscribeThreadEvents('thr_1', 200, replaySink, replayAbort.signal)

    expect(replayTool).toHaveBeenCalledOnce()
    expect(replayTool).toHaveBeenCalledWith(expect.objectContaining({
      itemId: 'tool_call_retry',
      status: 'success'
    }))
    expect(replaySink.onSeq).toHaveBeenCalledWith(201)
  })

  it('preserves a fatal SSE status for stream recovery', async () => {
    let onSseError: ((payload: { streamId: string; message?: string; status?: number }) => void) | null = null
    const onError = vi.fn()
    const sink: ThreadEventSink = {
      onSeq: vi.fn(),
      onDeltas: vi.fn(),
      onUserMessage: vi.fn(),
      onTool: vi.fn(),
      onCompaction: vi.fn(),
      onApproval: vi.fn(),
      onUserInput: vi.fn(),
      onUserInputStatus: vi.fn(),
      onGoal: vi.fn(),
      onTodos: vi.fn(),
      onTurnComplete: vi.fn(),
      onError
    }
    installDsGui({
      onSseError: vi.fn((handler) => {
        onSseError = handler
        return () => undefined
      }),
      startSse: vi.fn(async (_threadId, _sinceSeq, streamId) => {
        queueMicrotask(() => onSseError?.({
          streamId: streamId ?? 'stream-1',
          message: 'stream route unavailable',
          status: 404
        }))
        return { streamId: streamId ?? 'stream-1' }
      })
    })

    await new KunRuntimeProvider().subscribeThreadEvents('thr_1', 0, sink, new AbortController().signal)

    const [error] = onError.mock.calls[0] ?? []
    expect(error).toMatchObject({
      name: 'KunSseSubscriptionError',
      message: 'stream route unavailable',
      status: 404
    })
  })

  it('advances the renderer cursor after dispatch and only then acknowledges the SSE batch', async () => {
    let onData: ((payload: { streamId: string; events: unknown[]; batchId?: string }) => void) | null = null
    let releaseAck: (() => void) | undefined
    const ackGate = new Promise<void>((resolve) => {
      releaseAck = resolve
    })
    const ackSse = vi.fn(async () => {
      await ackGate
      return true
    })
    const startSse = vi.fn(async (_threadId: string, _sinceSeq: number, streamId?: string) => {
      queueMicrotask(() => {
        onData?.({
          streamId: streamId ?? 'stream-1',
          batchId: 'batch_1',
          events: [{ kind: 'assistant_text_delta', seq: 4, item: {
            id: 'item_text', turnId: 'turn_1', threadId: 'thr_1', role: 'assistant',
            status: 'running', createdAt: 't1', kind: 'assistant_text', text: 'ack me'
          } }]
        })
      })
      return { streamId: streamId ?? 'stream-1' }
    })
    const ac = new AbortController()
    const sink: ThreadEventSink = {
      onSeq: vi.fn(),
      onDeltas: vi.fn(),
      onUserMessage: vi.fn(),
      onTool: vi.fn(),
      onCompaction: vi.fn(),
      onApproval: vi.fn(),
      onUserInput: vi.fn(),
      onUserInputStatus: vi.fn(),
      onGoal: vi.fn(),
      onTodos: vi.fn(),
      onTurnComplete: vi.fn(),
      onError: vi.fn()
    }
    installDsGui({
      ackSse,
      onSseEvent: vi.fn((handler) => {
        onData = handler
        return () => undefined
      }),
      startSse
    })
    const provider = new KunRuntimeProvider()
    const subscription = provider.subscribeThreadEvents('thr_1', 0, sink, ac.signal)

    await vi.waitFor(() => expect(sink.onDeltas).toHaveBeenCalledTimes(1))
    expect(ackSse).toHaveBeenCalledWith(expect.any(String), 'batch_1')
    expect(startSse).toHaveBeenCalledWith(
      'thr_1',
      0,
      expect.any(String),
      { acknowledgedBatches: true }
    )
    expect(sink.onSeq).toHaveBeenCalledWith(4)

    releaseAck?.()
    await Promise.resolve()
    ac.abort()
    await subscription
  })

  it('does not acknowledge or advance an SSE batch aborted during dispatch', async () => {
    let onData: ((payload: { streamId: string; events: unknown[]; batchId?: string }) => void) | null = null
    const ackSse = vi.fn(async () => true)
    const stopSse = vi.fn(async () => true)
    const ac = new AbortController()
    const sink: ThreadEventSink = {
      onSeq: vi.fn(),
      onDeltas: vi.fn(() => ac.abort()),
      onUserMessage: vi.fn(),
      onTool: vi.fn(),
      onCompaction: vi.fn(),
      onApproval: vi.fn(),
      onUserInput: vi.fn(),
      onUserInputStatus: vi.fn(),
      onGoal: vi.fn(),
      onTodos: vi.fn(),
      onTurnComplete: vi.fn(),
      onError: vi.fn()
    }
    installDsGui({
      ackSse,
      stopSse,
      onSseEvent: vi.fn((handler) => {
        onData = handler
        return () => undefined
      }),
      startSse: vi.fn(async (_threadId, _sinceSeq, streamId) => {
        queueMicrotask(() => {
          onData?.({
            streamId: streamId ?? 'stream-1',
            batchId: 'batch_abort',
            events: [{ kind: 'assistant_text_delta', seq: 5, item: {
              id: 'item_text', turnId: 'turn_1', threadId: 'thr_1', role: 'assistant',
              status: 'running', createdAt: 't1', kind: 'assistant_text', text: 'abort me'
            } }]
          })
        })
        return { streamId: streamId ?? 'stream-1' }
      })
    })
    const provider = new KunRuntimeProvider()

    await provider.subscribeThreadEvents('thr_1', 0, sink, ac.signal)

    expect(ackSse).not.toHaveBeenCalled()
    expect(sink.onSeq).not.toHaveBeenCalled()
    expect(stopSse).toHaveBeenCalled()
  })

  it('treats legacy approval requests without a reviewer as manual even when current settings are full access', async () => {
    let onData: ((payload: { streamId: string; events: unknown[] }) => void) | null = null
    const runtimeRequest = vi.fn(async () => ({ ok: true, status: 200, body: '{}' }))
    const resolveKunApproval = vi.fn(async () => ({
      confirmed: true as const,
      response: { ok: true, status: 200, body: '{}' }
    }))
    const ac = new AbortController()
    const sink: ThreadEventSink = {
      onSeq: vi.fn(),
      onDeltas: vi.fn(),
      onUserMessage: vi.fn(),
      onTool: vi.fn(),
      onCompaction: vi.fn(),
      onApproval: vi.fn(),
      onUserInput: vi.fn(),
      onUserInputStatus: vi.fn(),
      onGoal: vi.fn(),
      onTodos: vi.fn(),
      onTurnComplete: vi.fn(() => ac.abort()),
      onError: vi.fn()
    }
    installDsGui({
      runtimeRequest,
      resolveKunApproval,
      onSseEvent: vi.fn((handler) => {
        onData = handler
        return () => undefined
      }),
      startSse: vi.fn(async (_threadId, _sinceSeq, streamId) => {
        queueMicrotask(() => {
          onData?.({
            streamId: streamId ?? 'stream-1',
            events: [
              { kind: 'approval_requested', seq: 4, approvalId: 'appr_auto', summary: 'Need approval' },
              { kind: 'turn_completed', seq: 5 }
            ]
          })
        })
        return { streamId: streamId ?? 'stream-1' }
      })
    })
    const provider = new KunRuntimeProvider()
    await provider.subscribeThreadEvents('thr_1', 0, sink, ac.signal)
    expect(resolveKunApproval).not.toHaveBeenCalled()
    expect(sink.onApproval).toHaveBeenCalledWith({
      approvalId: 'appr_auto',
      summary: 'Need approval',
      turnId: undefined,
      createdAt: undefined,
      toolName: undefined
    })
  })

  it('keeps explicit agent-reviewed requests out of the manual approval surface', async () => {
    let onData: ((payload: { streamId: string; events: unknown[] }) => void) | null = null
    const runtimeRequest = vi.fn(async () => ({ ok: true, status: 200, body: '{}' }))
    const resolveKunApproval = vi.fn(async () => ({
      confirmed: true as const,
      response: { ok: true, status: 200, body: '{}' }
    }))
    const getSettings = vi.fn(async (): Promise<AppSettingsV1> => ({
      ...settings(),
      agents: { kun: { ...defaultKunRuntimeSettings(), approvalPolicy: 'on-request' } }
    }))
    const ac = new AbortController()
    const sink: ThreadEventSink = {
      onSeq: vi.fn(),
      onDeltas: vi.fn(),
      onUserMessage: vi.fn(),
      onTool: vi.fn(),
      onCompaction: vi.fn(),
      onApproval: vi.fn(),
      onUserInput: vi.fn(),
      onUserInputStatus: vi.fn(),
      onGoal: vi.fn(),
      onTodos: vi.fn(),
      onTurnComplete: vi.fn(() => ac.abort()),
      onError: vi.fn()
    }
    installDsGui({
      getSettings,
      runtimeRequest,
      resolveKunApproval,
      onSseEvent: vi.fn((handler) => {
        onData = handler
        return () => undefined
      }),
      startSse: vi.fn(async (_threadId, _sinceSeq, streamId) => {
        queueMicrotask(() => {
          onData?.({
            streamId: streamId ?? 'stream-1',
            events: [
              {
                kind: 'approval_requested',
                seq: 4,
                approvalId: 'appr_event_auto',
                approvalPolicy: 'auto',
                approvalReviewer: 'agent',
                summary: 'Need approval'
              },
              { kind: 'turn_completed', seq: 5 }
            ]
          })
        })
        return { streamId: streamId ?? 'stream-1' }
      })
    })
    const provider = new KunRuntimeProvider()
    await provider.subscribeThreadEvents('thr_1', 0, sink, ac.signal)
    expect(resolveKunApproval).not.toHaveBeenCalled()
    expect(getSettings).not.toHaveBeenCalled()
    expect(sink.onApproval).not.toHaveBeenCalled()
  })

  it('renders approval cards for suggest and untrusted policies', async () => {
    for (const policy of ['suggest', 'untrusted'] as const) {
      let onData: ((payload: { streamId: string; events: unknown[] }) => void) | null = null
      const runtimeRequest = vi.fn(async () => ({ ok: true, status: 200, body: '{}' }))
      const resolveKunApproval = vi.fn(async () => ({
        confirmed: true as const,
        response: { ok: true, status: 200, body: '{}' }
      }))
      const ac = new AbortController()
      const sink: ThreadEventSink = {
        onSeq: vi.fn(),
        onDeltas: vi.fn(),
        onUserMessage: vi.fn(),
        onTool: vi.fn(),
        onCompaction: vi.fn(),
        onApproval: vi.fn(),
        onUserInput: vi.fn(),
        onUserInputStatus: vi.fn(),
        onGoal: vi.fn(),
        onTodos: vi.fn(),
        onTurnComplete: vi.fn(() => ac.abort()),
        onError: vi.fn()
      }
      const policySettings: AppSettingsV1 = {
        ...settings(),
        agents: { kun: { ...defaultKunRuntimeSettings(), approvalPolicy: policy } }
      }
      installDsGui({
        getSettings: vi.fn(async () => policySettings),
        runtimeRequest,
        resolveKunApproval,
        onSseEvent: vi.fn((handler) => {
          onData = handler
          return () => undefined
        }),
        startSse: vi.fn(async (_threadId, _sinceSeq, streamId) => {
          queueMicrotask(() => {
            onData?.({
              streamId: streamId ?? 'stream-1',
              events: [
                {
                  kind: 'approval_requested',
                  seq: 6,
                  approvalId: `appr_${policy}`,
                  summary: `${policy} approval`
                },
                { kind: 'turn_completed', seq: 7 }
              ]
            })
          })
          return { streamId: streamId ?? 'stream-1' }
        })
      })
      const provider = new KunRuntimeProvider()
      await provider.subscribeThreadEvents('thr_1', 0, sink, ac.signal)
      expect(sink.onApproval).toHaveBeenCalledWith({
        approvalId: `appr_${policy}`,
        summary: `${policy} approval`,
        toolName: undefined
      })
      expect(resolveKunApproval).not.toHaveBeenCalled()
    }
  })
})

describe('registry', () => {
  it('returns a cached provider for the kun id', () => {
    resetProviderCacheForTests()
    const first = getProvider()
    const second = getProvider()
    expect(first).toBe(second)
  })

})
