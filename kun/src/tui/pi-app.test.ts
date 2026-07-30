import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import { providerCatalogEntries } from '@kun/provider-catalog'
import { ThreadSchema } from '../contracts/threads.js'
import { buildRuntimeCapabilityManifest } from '../contracts/capabilities.js'
import type { RuntimeEvent } from '../contracts/events.js'
import type { TurnItem } from '../contracts/items.js'
import type { ModelConnectionSnapshot } from '../contracts/model-connections.js'
import { emptyUsageSnapshot } from '../contracts/usage.js'
import { modelCapabilitiesForModel } from '../loop/model-context-profile.js'
import { TuiClientError, type KunTuiClient, type ThreadDetail, type TuiConnection } from './client.js'
import { TuiController } from './controller.js'
import { testTuiGraphRun } from './graph-mode.test-support.js'
import { parseTuiKeymapConfig } from './keymap.js'
import { sanitizeTerminalText } from './layout.js'
import type { TuiOptions } from './options.js'
import {
  parseSgrMouseEvent,
  GraphBoardDialog,
  imagePasteShortcutLabel,
  openBrowser,
  authenticationStrategy,
  PermissionDialog,
  PiTuiApplication,
  renderActivityRow,
  renderGraphProgressRow,
  renderKunComposerFrame,
  renderKunThinking,
  renderKunWelcome,
  renderKunWordmark,
  TranscriptComponent
} from './pi-app.js'
import { projectThreadSnapshot } from './state.js'
import type { TerminalInput, TerminalOutput } from './pi-terminal.js'

function detail(): ThreadDetail {
  return {
    ...ThreadSchema.parse({
      id: 'thr_pi', title: 'Narrow thread', workspace: '/tmp/project', model: 'model-a',
      mode: 'agent', status: 'idle', approvalPolicy: 'on-request', sandboxMode: 'workspace-write',
      createdAt: '2026-07-22T00:00:00.000Z', updatedAt: '2026-07-22T00:00:00.000Z', turns: []
    }),
    latestSeq: 0,
    pendingUserInputIds: []
  }
}

function testToolCall(input: {
  id: string
  turnId: string
  toolName: string
  createdAt: string
  status?: 'pending' | 'running' | 'completed' | 'failed' | 'aborted'
  toolKind?: 'tool_call' | 'command_execution' | 'file_change'
  arguments?: Record<string, unknown>
  finishedAt?: string
}): Extract<TurnItem, { kind: 'tool_call' }> {
  return {
    id: input.id,
    threadId: 'thr_pi',
    turnId: input.turnId,
    role: 'assistant',
    status: input.status ?? 'completed',
    createdAt: input.createdAt,
    ...(input.finishedAt ? { finishedAt: input.finishedAt } : {}),
    kind: 'tool_call',
    toolName: input.toolName,
    callId: input.id,
    toolKind: input.toolKind ?? 'tool_call',
    arguments: input.arguments ?? {}
  }
}

function testToolResult(input: {
  id: string
  turnId: string
  toolName: string
  createdAt: string
  output?: unknown
  isError?: boolean
  toolKind?: 'tool_call' | 'command_execution' | 'file_change'
  finishedAt?: string
}): Extract<TurnItem, { kind: 'tool_result' }> {
  return {
    id: `result_${input.id}`,
    threadId: 'thr_pi',
    turnId: input.turnId,
    role: 'tool',
    status: 'completed',
    createdAt: input.createdAt,
    ...(input.finishedAt ? { finishedAt: input.finishedAt } : {}),
    kind: 'tool_result',
    toolName: input.toolName,
    callId: input.id,
    toolKind: input.toolKind ?? 'tool_call',
    output: input.output ?? 'ok',
    isError: input.isError ?? false
  }
}

const runtime = {
  baseUrl: 'http://127.0.0.1:18899', runtimeToken: 'secret', discovered: true,
  runtimeInfo: {
    host: '127.0.0.1', port: 18899, dataDir: '/tmp/data', model: 'model-a',
    instanceId: 'runtime_pi', serviceVersion: '1', launchMode: 'shared',
    startedAt: '2026-07-22T00:00:00.000Z', pid: 123,
    capabilities: {}
  }
} as unknown as TuiConnection

const options: TuiOptions = {
  runtimeToken: 'secret', dataDir: '/tmp/data', workspace: '/tmp/project',
  continueLatest: true, noStart: false, help: false
}

function modelSnapshot(): ModelConnectionSnapshot {
  return {
    schemaVersion: 1,
    revision: 3,
    providers: [
      {
        id: 'deepseek', accountId: 'account:deepseek', name: 'DeepSeek', kind: 'http',
        authType: 'api-key', baseUrl: 'https://api.deepseek.com', endpointFormat: 'chat_completions',
        configured: true, models: ['deepseek-v4-pro'], selectedModel: 'deepseek-v4-pro'
      },
      {
        id: 'kimi-code', accountId: 'account:kimi-code', name: 'Kimi Code', kind: 'http',
        authType: 'subscription', baseUrl: 'https://api.kimi.com/coding/v1', endpointFormat: 'chat_completions',
        configured: true, models: ['kimi-k2.5', 'kimi-k2-thinking'], selectedModel: 'kimi-k2.5'
      }
    ],
    defaultProviderId: 'deepseek', defaultAccountId: 'account:deepseek', defaultModel: 'deepseek-v4-pro',
    proxy: { enabled: false, url: '' }, routePools: [], localModelGateway: { enabled: false }
  }
}

function renderAssistantMessage(text: string, width: number, running = false): string[] {
  const current = detail()
  const status = running ? 'running' as const : 'completed' as const
  current.status = running ? 'running' : 'idle'
  current.turns = [{
    id: 'turn_markdown',
    threadId: current.id,
    status,
    orchestration: 'direct',
    prompt: 'Show code',
    steering: [],
    createdAt: current.createdAt,
    startedAt: current.createdAt,
    ...(running ? {} : { finishedAt: current.createdAt }),
    items: [{
      id: 'answer_markdown',
      threadId: current.id,
      turnId: 'turn_markdown',
      role: 'assistant',
      status,
      createdAt: current.createdAt,
      ...(running ? {} : { finishedAt: current.createdAt }),
      kind: 'assistant_text',
      text
    }],
    attachmentIds: [],
    activeSkillIds: [],
    injectedMemoryIds: [],
    injectedMemorySummaries: [],
    injectedInstructionSources: []
  }]
  const transcript = new TranscriptComponent()
  transcript.update(projectThreadSnapshot(current), false, false)
  return transcript.render(width)
}

describe('PiTuiApplication command overlays', () => {
  it('keeps browser authentication usable when a Linux desktop opener is unavailable', () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    const spawnFn = vi.fn(() => child)
    const url = 'https://auth.example.test/authorize?state=visible'

    expect(() => openBrowser(url, spawnFn as never, 'linux')).not.toThrow()
    expect(spawnFn).toHaveBeenCalledWith('xdg-open', [url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    expect(child.unref).toHaveBeenCalledOnce()
    expect(() => child.emit('error', new Error('spawn xdg-open ENOENT'))).not.toThrow()
  })

  it('decodes complete SGR mouse reports and rejects partial or invalid coordinates', () => {
    expect(parseSgrMouseEvent('\x1b[<0;12;7M')).toEqual({
      button: 0, x: 12, y: 7, pressed: true
    })
    expect(parseSgrMouseEvent('\x1b[<65;20;9M')).toEqual({
      button: 65, x: 20, y: 9, pressed: true
    })
    expect(parseSgrMouseEvent('\x1b[<0;12;7m')).toEqual({
      button: 0, x: 12, y: 7, pressed: false
    })
    expect(parseSgrMouseEvent('\x1b[<0;12;')).toBeUndefined()
    expect(parseSgrMouseEvent('\x1b[<0;0;7M')).toBeUndefined()
  })

  it('uses a text-only Kun wordmark at every width without overflowing', () => {
    const wide = renderKunWordmark(100, '1.2.3')
    const compact = renderKunWordmark(60, '1.2.3')
    const narrow = renderKunWordmark(36, '1.2.3')
    expect(wide).toHaveLength(1)
    expect(compact).toHaveLength(1)
    expect(narrow).toHaveLength(1)
    expect(wide.join('\n')).toContain('KUN')
    expect(compact.join('\n')).toContain('KUN')
    expect(narrow.join('\n')).toContain('KUN')
    expect([wide, compact, narrow].flat().join('\n')).not.toMatch(/[◒◆▄▆█◢◣]/u)
    expect(wide.every((line) => visibleWidth(line) <= 100)).toBe(true)
    expect(compact.every((line) => visibleWidth(line) <= 60)).toBe(true)
    expect(narrow.every((line) => visibleWidth(line) <= 36)).toBe(true)
  })

  it('renders the reduced welcome and sparse composer without overflowing wide, medium, or narrow terminals', () => {
    const controller = new TuiController({} as KunTuiClient, { ...options, continueLatest: false }, runtime)
    const widths = [120, 80, 42]
    for (const width of widths) {
      const welcome = renderKunWelcome(controller.state, controller, width, width === 42 ? 18 : 36)
      expect(welcome.every((line) => visibleWidth(line) <= width)).toBe(true)
      expect(welcome.join('\n')).toContain('Welcome to Kun')
      expect(welcome.join('\n')).toContain('/connect')
      expect(welcome.join('\n')).toContain('/sessions')
      expect(welcome.join('\n')).toContain('Type a task')
      expect(welcome.join('\n')).not.toContain('/model')
      expect(welcome.join('\n')).not.toContain('Ctrl+P')

      const rule = '─'.repeat(Math.max(8, width - 5))
      const composer = renderKunComposerFrame([rule, '', rule], controller.state, controller, width)
      expect(composer.every((line) => visibleWidth(line) <= width)).toBe(true)
      expect(composer[0]).toContain('┌')
      expect(composer).toContainEqual(expect.stringContaining('├'))
      expect(composer.at(-1)).toContain('└')
      expect(composer.join('\n')).toContain('model-a')
      expect(composer.join('\n')).not.toContain('Ctrl+C')
    }
    expect(renderKunWelcome(controller.state, controller, 120, 36).join('\n')).toContain('Version')
    expect(renderKunWelcome(controller.state, controller, 42, 18).join('\n')).toContain('Mode')
  })

  it('shows Graph as the next-turn mode and renders bounded durable progress above the composer', () => {
    const controller = new TuiController({} as KunTuiClient, options, runtime)
    const projection = projectThreadSnapshot(detail())
    const state = {
      ...controller.state,
      projection,
      composerOrchestration: 'graph' as const,
      graphRuns: [testTuiGraphRun({ threadId: projection.thread.id })]
    }

    const composer = sanitizeTerminalText(
      renderKunComposerFrame(['────', '', '────'], state, controller, 80).join('\n')
    )
    const progress = sanitizeTerminalText(renderGraphProgressRow(state, 80))

    expect(composer).toContain('graph')
    expect(progress).toContain('GRAPH')
    expect(progress).toContain('Test graph')
    expect(progress).toContain('agents')
    expect(progress).toContain('/graph status')
    expect(visibleWidth(progress)).toBeLessThanOrEqual(80)
    expect(renderGraphProgressRow(state, 36)).toContain('/graph status')
    expect(visibleWidth(renderGraphProgressRow(state, 36))).toBeLessThanOrEqual(36)
  })

  it('renders automatic review progress and terminal rationale without approval controls', () => {
    const projection = projectThreadSnapshot(detail())
    projection.approvalReviews = [{
      reviewId: 'review_1',
      approvalId: 'approval_1',
      turnId: 'turn_1',
      toolName: 'bash',
      summary: 'Run the test command',
      status: 'in-progress',
      startedAt: '2026-07-22T00:00:01.000Z'
    }]
    const transcript = new TranscriptComponent()
    transcript.update(projection, false, false)

    const progress = sanitizeTerminalText(transcript.render(80).join('\n'))
    expect(progress).toContain('Reviewing bash')
    expect(progress).toContain('Run the test command')
    expect(progress).not.toMatch(/\bAllow\b|\bDeny\b/u)

    projection.approvalReviews = [{
      ...projection.approvalReviews[0]!,
      status: 'denied',
      decision: 'deny',
      riskLevel: 'high',
      rationale: 'The command exceeds the requested workspace scope.',
      completedAt: '2026-07-22T00:00:02.000Z'
    }]
    transcript.update(projection, false, false)
    const terminal = sanitizeTerminalText(transcript.render(80).join('\n'))
    expect(terminal).toContain('Agent review denied')
    expect(terminal).toContain('risk high')
    expect(terminal).toContain('The command exceeds the requested workspace scope.')
    expect(terminal).not.toMatch(/\bAllow\b/u)
  })

  it('renders a responsive Graph board and drills into the selected worker', () => {
    const controller = new TuiController({} as KunTuiClient, options, runtime)
    const projection = projectThreadSnapshot(detail())
    projection.childRuns = [{
      childId: 'child_research',
      parentTurnId: 'turn_source',
      label: 'Research',
      prompt: 'Inspect the relevant code.',
      profile: 'profile_1',
      status: 'running',
      startedAt: '2026-07-26T00:00:00.000Z',
      updatedAt: '2026-07-26T00:00:04.000Z'
    }]
    const run = testTuiGraphRun({ threadId: projection.thread.id })
    const state = {
      ...controller.state,
      projection,
      graphRuns: [run],
      graphBoard: { runId: run.id }
    }
    const openWorker = vi.fn()
    const dialog = new GraphBoardDialog({
      tui: { requestRender: vi.fn() } as never,
      controller,
      state,
      runId: run.id,
      terminalRows: () => 36,
      close: vi.fn(),
      openWorker
    })

    const wide = sanitizeTerminalText(dialog.render(120).join('\n'))
    expect(wide).toContain('GRAPH · running')
    expect(wide).toContain('research ─control→ finish')
    expect(wide).toContain('Node research')
    expect(wide).toContain('Researcher (profile_1)')

    dialog.handleInput('\r')
    expect(openWorker).toHaveBeenCalledWith(run.id, 'research', 'child_research')

    dialog.handleInput('\x1b[B')
    const narrow = sanitizeTerminalText(dialog.render(72).join('\n'))
    expect(dialog.selectedNodeId()).toBe('finish')
    expect(narrow).toContain('Phase 1 · Implementation')
    expect(narrow).toContain('Waiting for research.')
    expect(narrow.split('\n').every((line) => visibleWidth(line) <= 72)).toBe(true)
  })

  it('keeps Graph inline until an opt-in click opens the board and mandatory input temporarily preempts it', async () => {
    const current = detail()
    const run = testTuiGraphRun({ threadId: current.id })
    const child: ThreadDetail = {
      ...detail(),
      id: 'child_research',
      title: 'Graph worker · Research',
      relation: 'side',
      parentThreadId: current.id,
      status: 'running'
    }
    let parentOnEvent: ((event: RuntimeEvent) => void) | undefined
    let childSubscriptionAborted = false
    const client = {
      graphAvailability: vi.fn(async () => ({ enabled: true })),
      listGraphRuns: vi.fn(async () => [run]),
      listThreads: vi.fn(async () => [current]),
      getThread: vi.fn(async (threadId: string) => threadId === child.id ? child : current),
      delegationDiagnostics: vi.fn(async (threadId: string) => ({
        enabled: true,
        active: threadId === current.id ? 1 : 0,
        aggregates: [],
        childRuns: threadId === current.id
          ? [{
              id: child.id,
              parentThreadId: current.id,
              parentTurnId: 'turn_source',
              label: 'Research',
              prompt: 'Inspect the relevant code.',
              profile: 'profile_1',
              status: 'running' as const,
              createdAt: current.createdAt,
              updatedAt: current.updatedAt
            }]
          : []
      })),
      subscribeThreadEvents: vi.fn(async (input: {
        threadId: string
        signal: AbortSignal
        onEvent: (event: RuntimeEvent) => void
        onConnection: (state: 'connecting' | 'connected') => void
      }) => {
        if (input.threadId === current.id) parentOnEvent = input.onEvent
        input.onConnection('connected')
        await new Promise<void>((resolve) =>
          input.signal.addEventListener('abort', () => {
            if (input.threadId === child.id) childSubscriptionAborted = true
            resolve()
          }, { once: true }))
      }),
      skills: vi.fn(async () => ({ enabled: true, roots: [], skills: [], validationErrors: [] }))
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options, runtime)
    await controller.start()

    const input = Object.assign(new EventEmitter(), {
      isRaw: false,
      setRawMode: vi.fn(),
      setEncoding: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn()
    }) as unknown as TerminalInput
    let outputText = ''
    const terminalRows = 32
    const output = Object.assign(new EventEmitter(), {
      columns: 110,
      rows: terminalRows,
      write: (chunk: string) => { outputText += chunk }
    }) as unknown as TerminalOutput
    const app = new PiTuiApplication(controller, input, output)
    const running = app.run()
    try {
      await waitFor(() => outputText.includes('/graph status'))
      expect(controller.state.graphBoard).toBeUndefined()
      expect(sanitizeTerminalText(outputText)).not.toContain('GRAPH · running')

      type(input, '/mouse on')
      await waitFor(() => outputText.includes('Mouse clicks enabled'))
      const internals = app as unknown as {
        root: { graphProgressAtTerminalRow: (row: number) => boolean }
      }
      const graphRow = Array.from(
        { length: terminalRows },
        (_, index) => index + 1
      ).find((row) => internals.root.graphProgressAtTerminalRow(row))
      expect(graphRow).toBeDefined()
      input.emit('data', `\x1b[<0;2;${graphRow}M`)

      await waitFor(() => controller.state.graphBoard?.runId === run.id)
      await waitFor(() => sanitizeTerminalText(outputText).includes('GRAPH · running'))

      const beforeWorker = outputText.length
      input.emit('data', '\r')
      await waitFor(() =>
        sanitizeTerminalText(outputText.slice(beforeWorker)).includes('live child session'))
      expect(client.getThread).toHaveBeenCalledWith(child.id)
      const beforeWorkerClose = outputText.length
      input.emit('data', '\x1b')
      await waitFor(() =>
        childSubscriptionAborted &&
        sanitizeTerminalText(outputText.slice(beforeWorkerClose)).includes('Node research'))
      expect(controller.state.graphBoard).toEqual({ runId: run.id })

      const eventBase = {
        timestamp: '2026-07-26T00:00:05.000Z',
        threadId: current.id,
        turnId: 'turn_gate'
      }
      const beforeApproval = outputText.length
      parentOnEvent?.({
        ...eventBase,
        kind: 'approval_requested',
        seq: 1,
        approvalId: 'approval_graph',
        toolName: 'bash',
        status: 'pending',
        summary: 'Run Graph validation'
      })
      await waitFor(() => sanitizeTerminalText(outputText.slice(beforeApproval)).includes('Approval required'))
      expect(controller.state.graphBoard).toEqual({ runId: run.id })

      const beforeResolve = outputText.length
      parentOnEvent?.({
        ...eventBase,
        kind: 'approval_resolved',
        seq: 2,
        approvalId: 'approval_graph',
        toolName: 'bash',
        status: 'allowed',
        summary: 'Run Graph validation'
      })
      await waitFor(() =>
        sanitizeTerminalText(outputText.slice(beforeResolve)).includes('GRAPH · running'))

      input.emit('data', '\x1b')
      await waitFor(() => controller.state.graphBoard === undefined)
    } finally {
      controller.requestQuit()
      await running
      await app.stop()
      await controller.stop()
    }
  })

  it('keeps a startup Graph requirement in the composer when Graph is unavailable', async () => {
    const client = {
      graphAvailability: vi.fn(async () => ({ enabled: false })),
      listThreads: vi.fn(async () => []),
      skills: vi.fn(async () => ({ enabled: true, roots: [], skills: [], validationErrors: [] })),
      startTurn: vi.fn()
    } as unknown as KunTuiClient
    const controller = new TuiController(
      client,
      { ...options, continueLatest: false },
      runtime
    )
    await controller.start()

    const input = Object.assign(new EventEmitter(), {
      isRaw: false,
      setRawMode: vi.fn(),
      setEncoding: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn()
    }) as unknown as TerminalInput
    let outputText = ''
    const output = Object.assign(new EventEmitter(), {
      columns: 90,
      rows: 28,
      write: (chunk: string) => { outputText += chunk }
    }) as unknown as TerminalOutput
    const app = new PiTuiApplication(controller, input, output)
    const running = app.run()
    try {
      await expect(app.submitStartupGraphPrompt('保留这个 Graph 草稿')).resolves.toBe(false)
      await waitFor(() => outputText.includes('保留这个 Graph 草稿'))
      expect(controller.state.composerOrchestration).toBe('direct')
      expect(client.startTurn).not.toHaveBeenCalled()
      expect(controller.state.notification?.message).toContain('disabled')
    } finally {
      controller.requestQuit()
      await running
      await app.stop()
      await controller.stop()
    }
  })

  it('renders Thinking collapsed by default and expands its muted content on request', () => {
    const item: Extract<TurnItem, { kind: 'assistant_reasoning' }> = {
      id: 'reason_visible',
      threadId: 'thr_pi',
      turnId: 'turn_reasoning',
      role: 'assistant',
      status: 'completed',
      createdAt: '2026-07-22T00:00:00.000Z',
      finishedAt: '2026-07-22T00:00:01.200Z',
      kind: 'assistant_reasoning',
      text: 'Inspect the provider capability before sending the request.'
    }
    const collapsed = renderKunThinking(item, 60, { expanded: false, running: false })
    expect(collapsed.join('\n')).toContain('Thinking')
    expect(collapsed.join('\n')).toContain('collapsed')
    expect(collapsed.join('\n')).toContain('/thinking expand')
    expect(collapsed.join('\n')).not.toContain('Inspect the provider capability')
    expect(collapsed.every((line) => visibleWidth(line) <= 60)).toBe(true)

    const expanded = renderKunThinking(item, 60, { expanded: true, running: false })
    expect(expanded.join('\n')).toContain('Thinking')
    expect(expanded.join('\n')).toContain('Inspect the provider capability')
    expect(expanded.join('\n')).toContain('│')
    expect(expanded.every((line) => visibleWidth(line) <= 60)).toBe(true)
  })

  it('keeps streamed Thinking and the late reply body inside one Kun turn group', () => {
    const current = detail()
    current.status = 'running'
    current.turns = [{
      id: 'turn_grouped',
      threadId: current.id,
      status: 'running',
      orchestration: 'direct',
      prompt: 'Say hello',
      steering: [],
      createdAt: current.createdAt,
      startedAt: current.createdAt,
      items: [
        {
          id: 'user_grouped',
          threadId: current.id,
          turnId: 'turn_grouped',
          role: 'user',
          status: 'completed',
          createdAt: current.createdAt,
          kind: 'user_message',
          text: 'Say hello'
        },
        {
          id: 'reason_grouped',
          threadId: current.id,
          turnId: 'turn_grouped',
          role: 'assistant',
          status: 'running',
          createdAt: current.createdAt,
          kind: 'assistant_reasoning',
          text: 'Prepare a concise greeting.'
        }
      ],
      attachmentIds: [],
      activeSkillIds: [],
      injectedMemoryIds: [],
      injectedMemorySummaries: [],
      injectedInstructionSources: []
    }]
    const transcript = new TranscriptComponent()
    transcript.update(projectThreadSnapshot(current), false, false)

    const reasoningOnly = transcript.render(80).join('\n')
    expect(reasoningOnly.indexOf('You')).toBeLessThan(reasoningOnly.indexOf('Kun'))
    expect(reasoningOnly.indexOf('Kun')).toBeLessThan(reasoningOnly.indexOf('Thinking'))
    expect(reasoningOnly.match(/Kun/g)).toHaveLength(1)

    current.turns[0]!.items.push({
      id: 'answer_grouped',
      threadId: current.id,
      turnId: 'turn_grouped',
      role: 'assistant',
      status: 'running',
      createdAt: current.createdAt,
      kind: 'assistant_text',
      text: 'Hello.'
    })
    transcript.update(projectThreadSnapshot(current), false, false)

    const withReply = transcript.render(80).join('\n')
    expect(withReply.indexOf('Kun')).toBeLessThan(withReply.indexOf('Thinking'))
    expect(withReply.indexOf('Thinking')).toBeLessThan(withReply.indexOf('Hello.'))
    expect(withReply.match(/Kun/g)).toHaveLength(1)
  })

  it('renders completed fenced code as labeled terminal blocks without source delimiters', () => {
    const rendered = renderAssistantMessage([
      'Tagged:',
      '```ts',
      'const answer = "<ok>"',
      '```',
      '',
      'Bare:',
      '```',
      '  keep indentation',
      '```',
      '',
      'Fallback:',
      '```made-up-language',
      'alpha < beta',
      '```'
    ].join('\n'), 54)
    const plain = sanitizeTerminalText(rendered.join('\n'))

    expect(plain).toContain('╭─ typescript')
    expect(plain).toContain('╭─ code')
    expect(plain).toContain('╭─ made-up-language')
    expect(plain).toContain('│ const answer = "<ok>"')
    expect(plain).toContain('│   keep indentation')
    expect(plain).toContain('│ alpha < beta')
    expect(plain).toContain('╰─')
    expect(plain).not.toMatch(/```|~~~/u)
    expect(rendered.every((line) => visibleWidth(line) <= 54)).toBe(true)
  })

  it('keeps an unterminated streamed code block styled and bounded at narrow widths', () => {
    const rendered = renderAssistantMessage([
      '```typescript',
      '  const message = "a deliberately long streamed code line that must wrap safely";'
    ].join('\n'), 32, true)
    const plain = sanitizeTerminalText(rendered.join('\n'))

    expect(plain).toContain('╭─ typescript')
    expect(plain).toContain('│   const message')
    expect(plain).toContain('▍')
    expect(plain).not.toContain('```')
    expect(rendered.every((line) => visibleWidth(line) <= 32)).toBe(true)
  })

  it('maps only a Thinking title row and toggles that reasoning item independently', () => {
    const current = detail()
    current.turns = [{
      id: 'turn_click',
      threadId: current.id,
      status: 'completed',
      orchestration: 'direct',
      prompt: 'Explain',
      steering: [],
      createdAt: current.createdAt,
      startedAt: current.createdAt,
      finishedAt: '2026-07-22T00:00:02.000Z',
      items: [
        {
          id: 'user_click',
          threadId: current.id,
          turnId: 'turn_click',
          role: 'user',
          status: 'completed',
          createdAt: current.createdAt,
          kind: 'user_message',
          text: 'Explain'
        },
        {
          id: 'reason_click',
          threadId: current.id,
          turnId: 'turn_click',
          role: 'assistant',
          status: 'completed',
          createdAt: current.createdAt,
          finishedAt: '2026-07-22T00:00:01.000Z',
          kind: 'assistant_reasoning',
          text: 'Inspect exactly one disclosure.'
        },
        {
          id: 'answer_click',
          threadId: current.id,
          turnId: 'turn_click',
          role: 'assistant',
          status: 'completed',
          createdAt: '2026-07-22T00:00:01.000Z',
          finishedAt: '2026-07-22T00:00:02.000Z',
          kind: 'assistant_text',
          text: 'Done.'
        }
      ],
      attachmentIds: [],
      activeSkillIds: [],
      injectedMemoryIds: [],
      injectedMemorySummaries: [],
      injectedInstructionSources: []
    }]
    const transcript = new TranscriptComponent()
    transcript.update(projectThreadSnapshot(current), false, false)
    const collapsed = transcript.render(90)
    const titleRow = collapsed.findIndex((line) => line.includes('Thinking'))

    expect(titleRow).toBeGreaterThanOrEqual(0)
    expect(transcript.reasoningAtRenderedRow(titleRow)).toBe('reason_click')
    expect(transcript.reasoningAtRenderedRow(titleRow + 1)).toBeUndefined()
    expect(transcript.toggleReasoningAtRenderedRow(titleRow)).toBe('reason_click')
    expect(transcript.render(90).join('\n')).toContain('Inspect exactly one disclosure.')

    expect(transcript.toggleReasoningAtRenderedRow(titleRow + 1)).toBeUndefined()
    expect(transcript.toggleReasoningAtRenderedRow(titleRow)).toBe('reason_click')
    expect(transcript.render(90).join('\n')).not.toContain('Inspect exactly one disclosure.')
  })

  it('renders persisted image attachments beneath their user message', () => {
    const current = detail()
    current.turns = [{
      id: 'turn_image',
      threadId: current.id,
      status: 'completed',
      orchestration: 'direct',
      prompt: 'What is this?',
      steering: [],
      createdAt: current.createdAt,
      startedAt: current.createdAt,
      finishedAt: current.createdAt,
      items: [{
        id: 'user_image',
        threadId: current.id,
        turnId: 'turn_image',
        role: 'user',
        status: 'completed',
        createdAt: current.createdAt,
        finishedAt: current.createdAt,
        kind: 'user_message',
        text: 'What is this?'
      }],
      attachmentIds: ['att_image'],
      activeSkillIds: [],
      injectedMemoryIds: [],
      injectedMemorySummaries: [],
      injectedInstructionSources: []
    }]
    const transcript = new TranscriptComponent()
    transcript.update(projectThreadSnapshot(current), false, false, false, {
      att_image: {
        id: 'att_image',
        name: 'clipboard.png',
        kind: 'image',
        mimeType: 'image/png',
        byteSize: 2048,
        hash: 'image-hash',
        width: 640,
        height: 480,
        threadIds: [current.id],
        workspaces: [current.workspace],
        createdAt: current.createdAt,
        updatedAt: current.createdAt
      }
    })

    const rendered = sanitizeTerminalText(transcript.render(90).join('\n'))
    expect(rendered).toContain('You  What is this?')
    expect(rendered).toContain('Image  clipboard.png · image/png · 2.0 KiB · 640×480')

    transcript.update(projectThreadSnapshot(current), false, false)
    expect(sanitizeTerminalText(transcript.render(90).join('\n'))).toContain('Attachment · attached')
  })

  it('advances Thinking only during the reasoning phase and freezes it when the reply starts', () => {
    vi.useFakeTimers()
    try {
      const startedAt = '2026-07-22T00:00:00.000Z'
      vi.setSystemTime(new Date('2026-07-22T00:00:03.000Z'))
      const current = detail()
      current.status = 'running'
      current.createdAt = startedAt
      current.updatedAt = startedAt
      current.turns = [{
        id: 'turn_timed',
        threadId: current.id,
        status: 'running',
        orchestration: 'direct',
        prompt: 'Think briefly',
        steering: [],
        createdAt: startedAt,
        startedAt,
        items: [{
          id: 'reason_timed',
          threadId: current.id,
          turnId: 'turn_timed',
          role: 'assistant',
          status: 'running',
          createdAt: startedAt,
          kind: 'assistant_reasoning',
          text: 'Working it out.'
        }],
        attachmentIds: [],
        activeSkillIds: [],
        injectedMemoryIds: [],
        injectedMemorySummaries: [],
        injectedInstructionSources: []
      }]
      const transcript = new TranscriptComponent()
      transcript.update(projectThreadSnapshot(current), false, false)

      expect(transcript.render(80).join('\n')).toContain('3.0s')
      vi.advanceTimersByTime(2_000)
      expect(transcript.render(80).join('\n')).toContain('5.0s')

      current.turns[0]!.items.push({
        id: 'answer_timed',
        threadId: current.id,
        turnId: 'turn_timed',
        role: 'assistant',
        status: 'running',
        createdAt: new Date().toISOString(),
        kind: 'assistant_text',
        text: 'Done.'
      })
      transcript.update(projectThreadSnapshot(current), false, false)
      const frozen = transcript.render(80).join('\n')
      expect(frozen).toContain('5.0s')

      current.status = 'idle'
      current.turns[0]!.status = 'completed'
      current.turns[0]!.finishedAt = '2026-07-22T00:00:06.000Z'
      current.turns[0]!.items[0]!.status = 'completed'
      current.turns[0]!.items[1]!.status = 'completed'
      transcript.update(projectThreadSnapshot(current), false, false)
      expect(transcript.render(80).join('\n')).toContain('5.0s')

      vi.advanceTimersByTime(10 * 60_000)
      expect(transcript.render(80).join('\n')).toContain('5.0s')
      expect(transcript.render(80).join('\n')).not.toContain('10m')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps immediate progress and reconnect feedback visible above stale notifications', () => {
    const controller = new TuiController({} as KunTuiClient, { ...options, continueLatest: false }, runtime)
    const submitting = renderActivityRow({
      ...controller.state,
      connection: 'connected',
      busy: true,
      busyLabel: 'Sending message',
      busyStartedAt: new Date().toISOString(),
      notification: { kind: 'info', message: 'Old model notice' }
    }, controller, 100, 0)
    expect(submitting).toContain('Sending message')
    expect(submitting).toContain('Old model notice')

    const current = detail()
    current.status = 'running'
    current.turns = [{
      id: 'turn_reconnect', threadId: current.id, status: 'running', orchestration: 'direct', prompt: 'Wait', steering: [],
      createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), items: [],
      attachmentIds: [], activeSkillIds: [], injectedMemoryIds: [], injectedMemorySummaries: [],
      injectedInstructionSources: []
    }]
    const reconnecting = renderActivityRow({
      ...controller.state,
      connection: 'reconnecting',
      projection: {
        thread: current,
        items: [],
        lastSeq: 1,
        runningTurnId: 'turn_reconnect',
        activity: {
          turnId: 'turn_reconnect',
          phase: 'responding',
          label: 'Responding',
          startedAt: current.turns[0]!.startedAt!,
          turnStartedAt: current.turns[0]!.startedAt!,
          updatedAt: current.turns[0]!.startedAt!
        },
        childRuns: [],
        approvalReviews: []
      }
    }, controller, 100, 3)
    expect(reconnecting).toContain('Reconnecting to live stream')
    expect(reconnecting).toContain('Reconnecting')
  })

  it('uses phase motion and a request-local context gauge without cumulative usage overflow', () => {
    const now = new Date().toISOString()
    const contextRuntime = {
      ...runtime,
      runtimeInfo: {
        ...runtime.runtimeInfo,
        capabilities: { model: { contextWindowTokens: 500_000 } }
      }
    } as unknown as TuiConnection
    const controller = new TuiController(
      {} as KunTuiClient,
      { ...options, continueLatest: false },
      contextRuntime
    )
    const current = detail()
    current.status = 'running'
    current.turns = [{
      id: 'turn_loading',
      threadId: current.id,
      status: 'running',
      orchestration: 'direct',
      prompt: 'Stream a response',
      steering: [],
      createdAt: now,
      startedAt: now,
      items: [],
      attachmentIds: [],
      activeSkillIds: [],
      injectedMemoryIds: [],
      injectedMemorySummaries: [],
      injectedInstructionSources: []
    }]
    const projection = projectThreadSnapshot(current)
    projection.usage = { ...emptyUsageSnapshot(), totalTokens: 750_000 }
    projection.contextSnapshot = {
      kind: 'context_snapshot',
      seq: 2,
      timestamp: now,
      threadId: current.id,
      turnId: 'turn_loading',
      model: current.model,
      stepIndex: 0,
      contextWindowTokens: 500_000,
      softThresholdTokens: 375_000,
      hardThresholdTokens: 425_000,
      estimatedInputTokens: 7_100,
      breakdown: {
        tools: 1_000,
        system: 1_000,
        skills: 100,
        messages: 5_000,
        other: 0
      },
      toolCount: 1,
      activeSkillIds: [],
      contextManagement: 'kun-managed',
      nativeHistory: 'none'
    }
    projection.activity = {
      turnId: 'turn_loading',
      phase: 'responding',
      label: 'Responding',
      startedAt: now,
      turnStartedAt: now,
      updatedAt: now
    }
    const state = { ...controller.state, connection: 'connected' as const, projection }
    const first = renderActivityRow(state, controller, 140, 0)
    const second = renderActivityRow(state, controller, 140, 1)
    const narrow = renderActivityRow(state, controller, 70, 0)
    const firstPlain = sanitizeTerminalText(first)
    const secondPlain = sanitizeTerminalText(second)
    const narrowPlain = sanitizeTerminalText(narrow)
    expect(firstPlain).toContain('▏')
    expect(secondPlain).toContain('▎')
    expect(firstPlain).not.toContain('Tip:')
    expect(secondPlain).not.toContain('Tip:')
    expect(firstPlain).toContain('7.1k / 500k · 1%')
    expect(narrowPlain).not.toContain('Tip:')
    expect(visibleWidth(first)).toBeLessThanOrEqual(140)
    expect(visibleWidth(second)).toBeLessThanOrEqual(140)
    expect(visibleWidth(narrow)).toBeLessThanOrEqual(70)
  })

  it('does not flash a redundant total timer when the first phase starts with the turn', () => {
    vi.useFakeTimers()
    try {
      const turnStartedAt = '2026-07-22T00:00:00.000Z'
      const phaseStartedAt = '2026-07-22T00:00:00.040Z'
      const controller = new TuiController(
        {} as KunTuiClient,
        { ...options, continueLatest: false },
        runtime
      )
      const current = detail()
      current.status = 'running'
      current.turns = [{
        id: 'turn_pre_send',
        threadId: current.id,
        status: 'running',
        orchestration: 'direct',
        prompt: 'Start the conversation',
        steering: [],
        createdAt: turnStartedAt,
        startedAt: turnStartedAt,
        items: [],
        attachmentIds: [],
        activeSkillIds: [],
        injectedMemoryIds: [],
        injectedMemorySummaries: [],
        injectedInstructionSources: []
      }]
      const projection = projectThreadSnapshot(current)
      projection.activity = {
        turnId: 'turn_pre_send',
        phase: 'starting',
        label: 'Pre-Send',
        startedAt: phaseStartedAt,
        turnStartedAt,
        updatedAt: phaseStartedAt
      }
      const state = { ...controller.state, connection: 'connected' as const, projection }

      const totalVisibility = [130, 160, 230, 260].map((elapsedMs, animationFrame) => {
        vi.setSystemTime(Date.parse(turnStartedAt) + elapsedMs)
        return sanitizeTerminalText(
          renderActivityRow(state, controller, 120, animationFrame)
        ).includes('· total ')
      })

      expect(totalVisibility).toEqual([false, false, false, false])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps total timing visible when the current phase started meaningfully later', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime('2026-07-22T00:04:28.000Z')
      const turnStartedAt = '2026-07-22T00:00:00.000Z'
      const phaseStartedAt = '2026-07-22T00:04:21.300Z'
      const controller = new TuiController(
        {} as KunTuiClient,
        { ...options, continueLatest: false },
        runtime
      )
      const current = detail()
      current.status = 'running'
      current.turns = [{
        id: 'turn_pre_send',
        threadId: current.id,
        status: 'running',
        orchestration: 'direct',
        prompt: 'Continue the conversation',
        steering: [],
        createdAt: turnStartedAt,
        startedAt: turnStartedAt,
        items: [],
        attachmentIds: [],
        activeSkillIds: [],
        injectedMemoryIds: [],
        injectedMemorySummaries: [],
        injectedInstructionSources: []
      }]
      const projection = projectThreadSnapshot(current)
      projection.activity = {
        turnId: 'turn_pre_send',
        phase: 'starting',
        label: 'Pre-Send',
        startedAt: phaseStartedAt,
        turnStartedAt,
        updatedAt: phaseStartedAt
      }

      const rendered = sanitizeTerminalText(renderActivityRow({
        ...controller.state,
        connection: 'connected',
        projection
      }, controller, 120, 0))

      expect(rendered).toContain('· 6.7s · total 4m 28s')
    } finally {
      vi.useRealTimers()
    }
  })

  it('omits context occupancy when no matching request snapshot exists', () => {
    const now = new Date().toISOString()
    const controller = new TuiController(
      {} as KunTuiClient,
      { ...options, continueLatest: false },
      runtime
    )
    const current = detail()
    current.status = 'running'
    current.turns = [{
      id: 'turn_loading',
      threadId: current.id,
      status: 'running',
      orchestration: 'direct',
      prompt: 'Stream a response',
      steering: [],
      createdAt: now,
      startedAt: now,
      items: [],
      attachmentIds: [],
      activeSkillIds: [],
      injectedMemoryIds: [],
      injectedMemorySummaries: [],
      injectedInstructionSources: []
    }]
    const projection = projectThreadSnapshot(current)
    projection.usage = { ...emptyUsageSnapshot(), totalTokens: 750_000 }
    projection.contextSnapshot = {
      kind: 'context_snapshot',
      seq: 2,
      timestamp: now,
      threadId: current.id,
      turnId: 'turn_loading',
      model: 'different-model',
      stepIndex: 0,
      contextWindowTokens: 500_000,
      softThresholdTokens: 375_000,
      hardThresholdTokens: 425_000,
      estimatedInputTokens: 400_000,
      breakdown: {
        tools: 0,
        system: 0,
        skills: 0,
        messages: 400_000,
        other: 0
      },
      toolCount: 0,
      activeSkillIds: []
    }
    projection.activity = {
      turnId: 'turn_loading',
      phase: 'responding',
      label: 'Responding',
      startedAt: now,
      turnStartedAt: now,
      updatedAt: now
    }

    const rendered = sanitizeTerminalText(renderActivityRow({
      ...controller.state,
      connection: 'connected',
      projection
    }, controller, 140, 0))

    expect(rendered).not.toContain('750k')
    expect(rendered).not.toContain('400k / 500k')
  })

  it('renders tool input and output as a compact semantic tree', () => {
    const current = detail()
    current.turns = [{
      id: 'turn_tools',
      threadId: current.id,
      status: 'completed',
      orchestration: 'direct',
      prompt: 'Inspect the file',
      steering: [],
      createdAt: current.createdAt,
      startedAt: current.createdAt,
      finishedAt: '2026-07-22T00:00:02.000Z',
      items: [
        {
          id: 'user_tools',
          threadId: current.id,
          turnId: 'turn_tools',
          role: 'user',
          status: 'completed',
          createdAt: current.createdAt,
          kind: 'user_message',
          text: 'Inspect the file'
        },
        {
          id: 'call_tools',
          threadId: current.id,
          turnId: 'turn_tools',
          role: 'assistant',
          status: 'completed',
          createdAt: current.createdAt,
          finishedAt: '2026-07-22T00:00:01.000Z',
          kind: 'tool_call',
          toolName: 'read_file',
          callId: 'call_tools',
          toolKind: 'tool_call',
          arguments: { path: '/tmp/project/README.md' }
        },
        {
          id: 'result_tools',
          threadId: current.id,
          turnId: 'turn_tools',
          role: 'tool',
          status: 'completed',
          createdAt: '2026-07-22T00:00:01.000Z',
          finishedAt: '2026-07-22T00:00:02.000Z',
          kind: 'tool_result',
          toolName: 'read_file',
          callId: 'call_tools',
          toolKind: 'tool_call',
          output: 'README contents',
          isError: false
        }
      ],
      attachmentIds: [],
      activeSkillIds: [],
      injectedMemoryIds: [],
      injectedMemorySummaries: [],
      injectedInstructionSources: []
    }]
    const transcript = new TranscriptComponent()
    const projection = projectThreadSnapshot(current)

    transcript.update(projection, false, false)
    const compact = transcript.render(80)
    const compactPlain = sanitizeTerminalText(compact.join('\n'))
    expect(compactPlain).toContain('● Read')
    expect(compactPlain).toContain('└')
    expect(compactPlain).toContain('README contents')
    expect(compact.every((line) => visibleWidth(line) <= 80)).toBe(true)

    transcript.update(projection, false, true)
    const expanded = transcript.render(80)
    const expandedPlain = sanitizeTerminalText(expanded.join('\n'))
    expect(expandedPlain).toContain('├ input')
    expect(expandedPlain).toContain('└ output')
    expect(expandedPlain).toContain('/tmp/project/README.md')
    expect(expanded.every((line) => visibleWidth(line) <= 80)).toBe(true)
  })

  it('merges exploration Thinking in source order and stops at execution boundaries', () => {
    const current = detail()
    const turnId = 'turn_exploration'
    const startedAt = '2026-07-22T00:00:00.000Z'
    const search = testToolCall({
      id: 'call_search',
      turnId,
      toolName: 'grep',
      createdAt: '2026-07-22T00:00:01.000Z',
      finishedAt: '2026-07-22T00:00:02.000Z',
      arguments: { pattern: 'modelCapabilities', path: 'loop.test.ts' }
    })
    const read = testToolCall({
      id: 'call_read',
      turnId,
      toolName: 'read',
      createdAt: '2026-07-22T00:00:03.000Z',
      finishedAt: '2026-07-22T00:00:04.000Z',
      arguments: { path: 'loop.test.ts' }
    })
    const edit = testToolCall({
      id: 'call_edit',
      turnId,
      toolName: 'edit',
      toolKind: 'file_change',
      createdAt: '2026-07-22T00:00:05.000Z',
      finishedAt: '2026-07-22T00:00:06.000Z',
      arguments: { path: 'src/app.ts' }
    })
    const run = testToolCall({
      id: 'call_run',
      turnId,
      toolName: 'bash',
      toolKind: 'command_execution',
      createdAt: '2026-07-22T00:00:07.000Z',
      finishedAt: '2026-07-22T00:00:08.000Z',
      arguments: { command: 'rg modelCapabilities' }
    })
    const singleRead = testToolCall({
      id: 'call_single_read',
      turnId,
      toolName: 'read_file',
      createdAt: '2026-07-22T00:00:09.000Z',
      finishedAt: '2026-07-22T00:00:10.000Z',
      arguments: { path: 'README.md' }
    })
    current.turns = [{
      id: turnId,
      threadId: current.id,
      status: 'completed',
      orchestration: 'direct',
      prompt: 'Explore and update',
      steering: [],
      createdAt: startedAt,
      startedAt,
      finishedAt: '2026-07-22T00:00:11.000Z',
      items: [
        {
          id: 'user_exploration',
          threadId: current.id,
          turnId,
          role: 'user',
          status: 'completed',
          createdAt: startedAt,
          kind: 'user_message',
          text: 'Explore and update'
        },
        {
          id: 'reasoning_before_search',
          threadId: current.id,
          turnId,
          role: 'assistant',
          status: 'completed',
          createdAt: '2026-07-22T00:00:01.000Z',
          kind: 'assistant_reasoning',
          text: 'Find the relevant tests.'
        },
        search,
        testToolResult({
          id: search.id,
          turnId,
          toolName: search.toolName,
          createdAt: '2026-07-22T00:00:02.000Z',
          finishedAt: '2026-07-22T00:00:02.000Z',
          output: 'loop.test.ts:319'
        }),
        {
          id: 'reasoning_between_tools',
          threadId: current.id,
          turnId,
          role: 'assistant',
          status: 'completed',
          createdAt: '2026-07-22T00:00:03.000Z',
          kind: 'assistant_reasoning',
          text: 'Read the matching test.'
        },
        read,
        testToolResult({
          id: read.id,
          turnId,
          toolName: read.toolName,
          createdAt: '2026-07-22T00:00:04.000Z',
          finishedAt: '2026-07-22T00:00:04.000Z',
          output: 'supportsToolCalling: true'
        }),
        edit,
        testToolResult({
          id: edit.id,
          turnId,
          toolName: edit.toolName,
          toolKind: edit.toolKind,
          createdAt: '2026-07-22T00:00:06.000Z',
          output: 'updated src/app.ts'
        }),
        run,
        testToolResult({
          id: run.id,
          turnId,
          toolName: run.toolName,
          toolKind: run.toolKind,
          createdAt: '2026-07-22T00:00:08.000Z',
          output: 'src/app.ts:1'
        }),
        {
          id: 'reasoning_after_execution',
          threadId: current.id,
          turnId,
          role: 'assistant',
          status: 'completed',
          createdAt: '2026-07-22T00:00:08.500Z',
          kind: 'assistant_reasoning',
          text: 'Check the final README separately.'
        },
        singleRead,
        testToolResult({
          id: singleRead.id,
          turnId,
          toolName: singleRead.toolName,
          createdAt: '2026-07-22T00:00:10.000Z',
          output: 'Kun'
        }),
        {
          id: 'answer_exploration',
          threadId: current.id,
          turnId,
          role: 'assistant',
          status: 'completed',
          createdAt: '2026-07-22T00:00:11.000Z',
          kind: 'assistant_text',
          text: 'Done.'
        }
      ],
      attachmentIds: [],
      activeSkillIds: [],
      injectedMemoryIds: [],
      injectedMemorySummaries: [],
      injectedInstructionSources: []
    }]

    const transcript = new TranscriptComponent()
    transcript.update(projectThreadSnapshot(current), false, false)
    const rendered = sanitizeTerminalText(transcript.render(96).join('\n'))

    expect(rendered.match(/Explored/g)).toHaveLength(1)
    expect(rendered).toContain('Explored · 2 actions · 3.0s')
    expect(rendered).toContain('Search modelCapabilities')
    expect(rendered).toContain('Read loop.test.ts')
    expect(rendered.match(/Thinking/g)).toHaveLength(1)
    expect(rendered.indexOf('Explored')).toBeLessThan(rendered.indexOf('Edit'))
    expect(rendered).toContain('Run · rg modelCapabilities')
    expect(rendered.indexOf('Run · rg modelCapabilities')).toBeLessThan(rendered.indexOf('Thinking'))
    expect(rendered.indexOf('Thinking')).toBeLessThan(rendered.indexOf('Read · README.md'))
    expect(rendered).toContain('Read · README.md')

    transcript.update(projectThreadSnapshot(current), true, false)
    const expanded = sanitizeTerminalText(transcript.render(96).join('\n'))
    expect(expanded.indexOf('Find the relevant tests.'))
      .toBeLessThan(expanded.indexOf('Search modelCapabilities'))
    expect(expanded.indexOf('Search modelCapabilities'))
      .toBeLessThan(expanded.indexOf('Read the matching test.'))
    expect(expanded.indexOf('Read the matching test.'))
      .toBeLessThan(expanded.indexOf('Read loop.test.ts'))
    expect(expanded.indexOf('Read loop.test.ts')).toBeLessThan(expanded.indexOf('Edit'))
    expect(expanded.indexOf('Run · rg modelCapabilities'))
      .toBeLessThan(expanded.indexOf('Check the final README separately.'))
    expect(expanded.indexOf('Check the final README separately.'))
      .toBeLessThan(expanded.indexOf('Read · README.md'))
  })

  it('shows live, failed, capped, expanded, and narrow exploration group states', () => {
    const current = detail()
    const turnId = 'turn_live_exploration'
    const startedAt = new Date().toISOString()
    const items: TurnItem[] = [{
      id: 'user_live_exploration',
      threadId: current.id,
      turnId,
      role: 'user',
      status: 'completed',
      createdAt: startedAt,
      kind: 'user_message',
      text: 'Inspect many files'
    }]
    for (let index = 0; index < 14; index += 1) {
      const createdAt = new Date(Date.parse(startedAt) + (index + 1) * 1_000).toISOString()
      const call = testToolCall({
        id: `call_search_${index}`,
        turnId,
        toolName: index % 2 === 0 ? 'grep' : 'read_file',
        createdAt,
        status: index === 13 ? 'running' : 'completed',
        ...(index === 13 ? {} : { finishedAt: createdAt }),
        arguments: index % 2 === 0
          ? { pattern: `needle-${index}`, path: `src/file-${index}.ts` }
          : { path: `src/file-${index}.ts` }
      })
      items.push(call)
      if (index !== 13) {
        items.push(testToolResult({
          id: call.id,
          turnId,
          toolName: call.toolName,
          createdAt,
          finishedAt: createdAt,
          output: `result-${index}`,
          isError: index === 2
        }))
      }
    }
    current.status = 'running'
    current.turns = [{
      id: turnId,
      threadId: current.id,
      status: 'running',
      orchestration: 'direct',
      prompt: 'Inspect many files',
      steering: [],
      createdAt: startedAt,
      startedAt,
      items,
      attachmentIds: [],
      activeSkillIds: [],
      injectedMemoryIds: [],
      injectedMemorySummaries: [],
      injectedInstructionSources: []
    }]

    const transcript = new TranscriptComponent()
    const projection = projectThreadSnapshot(current)
    transcript.update(projection, false, false)
    const compactLines = transcript.render(52, 1)
    const compact = sanitizeTerminalText(compactLines.join('\n'))

    expect(compact).toContain('Exploring · 14 actions · 1 failed')
    expect(compact).toContain('… +2 more')
    expect(compact).not.toContain('input ·')
    expect(compactLines.every((line) => visibleWidth(line) <= 52)).toBe(true)

    transcript.update(projection, false, true)
    const expandedLines = transcript.render(52, 2)
    const expanded = sanitizeTerminalText(expandedLines.join('\n'))
    expect(expanded).not.toContain('+2 more')
    expect(expanded).toContain('src/file-13.ts')
    expect(expanded).toContain('input ·')
    expect(expanded).toContain('output ·')
    expect(expandedLines.every((line) => visibleWidth(line) <= 52)).toBe(true)
  })

  it('renders a guided welcome layout and turns the focused composer into the first conversation', async () => {
    let current: ThreadDetail | undefined
    let resolveStart!: (value: { turnId: string }) => void
    const startTurn = vi.fn(() => new Promise<{ turnId: string }>((resolve) => {
      resolveStart = resolve
    }))
    const client = {
      listThreads: vi.fn(async () => current ? [current] : []),
      createThread: vi.fn(async (input: { title: string }) => {
        current = { ...detail(), title: input.title }
        return current
      }),
      getThread: vi.fn(async () => current!),
      subscribeThreadEvents: vi.fn(async (input: {
        signal: AbortSignal
        onConnection: (state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected') => void
      }) => {
        input.onConnection('connected')
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      skills: vi.fn(async () => ({ enabled: true, roots: [], skills: [], validationErrors: [] })),
      modelConnections: vi.fn(async () => modelSnapshot()),
      startTurn
    } as unknown as KunTuiClient
    const controller = new TuiController(client, { ...options, continueLatest: false }, runtime)
    await controller.start()

    const input = Object.assign(new EventEmitter(), {
      isRaw: false,
      setRawMode: vi.fn(),
      setEncoding: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn()
    }) as unknown as TerminalInput
    let outputText = ''
    const outputEvents = new EventEmitter()
    const output = Object.assign(outputEvents, {
      columns: 100,
      rows: 32,
      write: (chunk: string) => { outputText += chunk }
    }) as unknown as TerminalOutput
    const app = new PiTuiApplication(controller, input, output)
    const running = app.run()
    try {
      await waitFor(() => outputText.includes('Welcome to Kun'))
      expect(outputText).toContain('A focused terminal agent')
      expect(outputText).toContain('Workspace')
      expect(outputText).toContain('Model')
      expect(outputText).toContain('Mode')
      expect(outputText).toContain('Version')
      expect(outputText).toContain('/connect')
      expect(outputText).toContain('add or manage a provider')
      expect(outputText).not.toContain('/model')
      expect(outputText).toContain('Ctrl+P')
      expect(outputText).toContain('KUN')
      expect(outputText).not.toContain('◒ KUN')
      expect(outputText).not.toContain('●    ●')
      expect(outputText).not.toContain('Welcome ─')
      expect(outputText).not.toContain('No threads found')

      const beforeResize = outputText.length
      Object.assign(output, { columns: 42, rows: 18 })
      outputEvents.emit('resize')
      await waitFor(() => outputText.length > beforeResize)
      const narrowOutput = outputText.slice(beforeResize)
      expect(narrowOutput).toContain('Welcome to Kun')
      expect(narrowOutput).toContain('/connect')
      expect(narrowOutput).toContain('Ctrl+P')

      input.emit('data', '\x10') // Ctrl+P
      await waitFor(() => outputText.includes('Commands') && outputText.includes('Switch session'))
      input.emit('data', '\x03') // Ctrl+C closes the command palette like Escape

      for (const character of 'preserved draft') input.emit('data', character)
      await waitFor(() => outputText.includes('preserved draft'))
      const beforeDraftRoute = outputText.length
      input.emit('data', '\x18m') // A real PTY may coalesce Ctrl+X M.
      await waitFor(() => outputText.slice(beforeDraftRoute).includes('Kimi Code'))
      const modelFrame = outputText.slice(beforeDraftRoute)
      expect(modelFrame).toContain('Models')
      expect(modelFrame).toContain('DeepSeek')
      expect(modelFrame).toContain('Kimi Code')
      expect(modelFrame).not.toContain('preserved draft')
      expect(modelFrame).not.toContain('Welcome to Kun')
      expect(modelFrame).not.toContain('add provider')
      expect(modelFrame).not.toContain(' Prompt')
      expect(modelFrame).not.toContain('\x1b[3J')
      expect(modelFrame).not.toContain('\x1b[?1049h')
      const beforeModelResize = outputText.length
      Object.assign(output, { columns: 80, rows: 24 })
      outputEvents.emit('resize')
      await waitFor(() => outputText.slice(beforeModelResize).includes('Kimi Code'))
      const resizedModelFrame = outputText.slice(beforeModelResize)
      expect(resizedModelFrame).not.toContain('Welcome to Kun')
      expect(resizedModelFrame).not.toContain(' Prompt')
      const beforeReturn = outputText.length
      input.emit('data', '\x03') // Ctrl+C closes the exclusive model route
      await waitFor(() => outputText.slice(beforeReturn).includes('preserved draft'))
      input.emit('data', '\x03') // Clear the restored draft before the next route.

      const beforeConnect = outputText.length
      type(input, '/connect')
      await waitFor(() => sanitizeTerminalText(outputText.slice(beforeConnect)).includes('KUN / Connect'))
      const connectFrame = outputText.slice(beforeConnect)
      expect(connectFrame).toContain('Add a provider')
      expect(connectFrame).toContain('DeepSeek')
      expect(connectFrame).toContain('Kimi Code')
      expect(connectFrame).not.toContain('Subscription')
      expect(connectFrame).not.toContain('Welcome to Kun')
      expect(connectFrame).not.toContain('add provider')
      expect(connectFrame).not.toContain(' Prompt')
      const beforeCatalog = outputText.length
      input.emit('data', '\r')
      await waitFor(() => outputText.slice(beforeCatalog).includes('Custom provider'))
      const catalogFrame = outputText.slice(beforeCatalog)
      expect(catalogFrame).toContain('Add provider')
      expect(catalogFrame).toContain('Subscription')
      expect(catalogFrame).toContain('API')
      const beforeCatalogBack = outputText.length
      input.emit('data', '\x03') // Ctrl+C returns from the catalog to configured connections.
      await waitFor(() =>
        sanitizeTerminalText(outputText.slice(beforeCatalogBack)).includes('KUN / Connect') &&
        outputText.slice(beforeCatalogBack).includes('Connections')
      )
      input.emit('data', '\x03') // A second Ctrl+C closes /connect without exiting the TUI.
      await new Promise((resolve) => setTimeout(resolve, 20))
      for (const character of 'route restored') input.emit('data', character)
      await waitFor(() => outputText.includes('route restored'))
      input.emit('data', '\x03')

      for (const character of 'discard me') input.emit('data', character)
      input.emit('data', '\x03') // Ctrl+C clears non-empty composer
      input.emit('data', '\r')
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(startTurn).not.toHaveBeenCalled()

      input.emit('data', '\x18') // Ctrl+X Leader
      input.emit('data', 'l')
      await waitFor(() => controller.state.view === 'threads' && outputText.includes('Sessions'))
      input.emit('data', '\x03') // Ctrl+C returns from the session picker
      await waitFor(() => controller.state.view === 'chat')

      type(input, 'Explain this repository')
      await waitFor(() => startTurn.mock.calls.length === 1)
      await waitFor(() => outputText.includes('Sending message'))
      expect(controller.state).toMatchObject({
        busy: true,
        busyLabel: 'Sending message'
      })
      expect(client.createThread).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Explain this repository', workspace: '/tmp/project'
      }))
      expect(startTurn).toHaveBeenCalledWith('thr_pi', expect.objectContaining({
        prompt: 'Explain this repository'
      }))
      resolveStart({ turnId: 'turn_welcome' })
      await waitFor(() => controller.state.projection?.runningTurnId === 'turn_welcome')
      expect(controller.state.projection?.thread.id).toBe('thr_pi')

      const beforeConversationModels = outputText.length
      input.emit('data', '\x18')
      input.emit('data', 'm')
      await waitFor(() => outputText.slice(beforeConversationModels).includes('Kimi Code'))
      const conversationModelFrame = outputText.slice(beforeConversationModels)
      expect(conversationModelFrame).not.toContain('Explain this repository')
      expect(conversationModelFrame).not.toContain(' Prompt')
      input.emit('data', '\x1b')
    } finally {
      controller.requestQuit()
      await running
      await app.stop()
      await controller.stop()
    }
  })

  it('uses ArrowUp and ArrowDown to browse submitted composer input history', async () => {
    const current = detail()
    const startTurn = vi.fn(async () => ({ turnId: 'turn_history' }))
    const listThreads = vi.fn(async () => [current])
    const client = {
      listThreads,
      getThread: vi.fn(async () => current),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      skills: vi.fn(async () => ({ enabled: true, roots: [], skills: [], validationErrors: [] })),
      modelConnections: vi.fn(async () => modelSnapshot()),
      startTurn
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options, runtime)
    await controller.start()

    const input = Object.assign(new EventEmitter(), {
      isRaw: false,
      setRawMode: vi.fn(),
      setEncoding: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn()
    }) as unknown as TerminalInput
    let outputText = ''
    const output = Object.assign(new EventEmitter(), {
      columns: 92,
      rows: 28,
      write: (chunk: string) => { outputText += chunk }
    }) as unknown as TerminalOutput
    const app = new PiTuiApplication(controller, input, output)
    const root = (app as unknown as {
      root: {
        editor: { getText: () => string }
        render: (width: number) => string[]
      }
    }).root
    const running = app.run()
    try {
      type(input as unknown as EventEmitter, 'previous prompt')
      await waitFor(() => startTurn.mock.calls.length === 1)

      const listCallsBeforeHistory = listThreads.mock.calls.length
      input.emit('data', '\x1b[A')
      await waitFor(() => root.editor.getText() === 'previous prompt')
      expect(sanitizeTerminalText(root.render(92).join('\n'))).toContain('previous prompt')
      expect(listThreads).toHaveBeenCalledTimes(listCallsBeforeHistory)
      expect(controller.state.notification?.message ?? '').not.toContain('No parent session')

      input.emit('data', '\x1b[B')
      await waitFor(() => root.editor.getText() === '')
      for (const character of 'next prompt') input.emit('data', character)
      await waitFor(() => root.editor.getText() === 'next prompt')
    } finally {
      controller.requestQuit()
      await running
      await app.stop()
      await controller.stop()
    }
  })

  it('restores the exact composer draft when @file preparation fails', async () => {
    const current = detail()
    const startTurn = vi.fn(async () => ({ turnId: 'turn_file_mention' }))
    const client = {
      listThreads: vi.fn(async () => [current]),
      getThread: vi.fn(async () => current),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      skills: vi.fn(async () => ({ enabled: true, roots: [], skills: [], validationErrors: [] })),
      modelConnections: vi.fn(async () => modelSnapshot()),
      startTurn
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options, runtime)
    await controller.start()
    const prepare = vi.spyOn(controller, 'prepareFileMentions')
      .mockImplementationOnce(async () => {
        controller.notify('Could not attach @missing.ts: file was not found.', 'error')
        return false
      })
      .mockResolvedValueOnce(true)
    const input = Object.assign(new EventEmitter(), {
      isRaw: false,
      setRawMode: vi.fn(),
      setEncoding: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn()
    }) as unknown as TerminalInput
    const output = Object.assign(new EventEmitter(), {
      columns: 92,
      rows: 28,
      write: vi.fn()
    }) as unknown as TerminalOutput
    const app = new PiTuiApplication(controller, input, output)
    const root = (app as unknown as {
      root: { editor: { getText: () => string } }
    }).root
    const running = app.run()
    const original = 'Inspect @missing.ts'
    try {
      type(input as unknown as EventEmitter, original)
      await waitFor(() => prepare.mock.calls.length === 1)
      await waitFor(() => root.editor.getText() === original)
      expect(startTurn).not.toHaveBeenCalled()

      for (const character of ' after fixing') input.emit('data', character)
      input.emit('data', '\r')
      await waitFor(() => startTurn.mock.calls.length === 1)
      expect(prepare).toHaveBeenNthCalledWith(2, `${original} after fixing`)
      expect(startTurn).toHaveBeenCalledWith(current.id, expect.objectContaining({
        prompt: `${original} after fixing`
      }))
    } finally {
      controller.requestQuit()
      await running
      await app.stop()
      await controller.stop()
    }
  })

  it('intercepts complete and split bracketed path pastes while preserving ordinary pasted text', async () => {
    const current = detail()
    const startTurn = vi.fn(async () => ({ turnId: 'turn_after_paste' }))
    const client = {
      listThreads: vi.fn(async () => [current]),
      getThread: vi.fn(async () => current),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      skills: vi.fn(async () => ({ enabled: true, roots: [], skills: [], validationErrors: [] })),
      modelConnections: vi.fn(async () => modelSnapshot()),
      startTurn
    } as unknown as KunTuiClient
    const attachmentRuntime = {
      ...runtime,
      runtimeInfo: {
        ...runtime.runtimeInfo,
        capabilities: buildRuntimeCapabilityManifest({
          model: modelCapabilitiesForModel('model-a')
        })
      }
    } as TuiConnection
    const controller = new TuiController(client, options, attachmentRuntime)
    await controller.start()
    const attachPastedPaths = vi.spyOn(controller, 'attachPastedPaths')
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    const input = Object.assign(new EventEmitter(), {
      isRaw: false,
      setRawMode: vi.fn(),
      setEncoding: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn()
    }) as unknown as TerminalInput
    let outputText = ''
    const output = Object.assign(new EventEmitter(), {
      columns: 92,
      rows: 28,
      write: (chunk: string) => { outputText += chunk }
    }) as unknown as TerminalOutput
    const app = new PiTuiApplication(controller, input, output)
    const running = app.run()
    try {
      input.emit('data', "\x1b[200~'/tmp/screen")
      input.emit('data', " shot.png'\x1b[201~")
      await waitFor(() => attachPastedPaths.mock.calls.length === 1)
      expect(attachPastedPaths).toHaveBeenNthCalledWith(1, "'/tmp/screen shot.png'")

      input.emit('data', '\x1b[200~ordinary pasted text\x1b[201~')
      await waitFor(() => attachPastedPaths.mock.calls.length === 2)
      await waitFor(() => outputText.includes('ordinary pasted text'))
      expect(attachPastedPaths).toHaveBeenNthCalledWith(2, 'ordinary pasted text')

      const validate = vi.spyOn(controller, 'validatePendingAttachmentsForCurrentModel')
        .mockImplementationOnce(() => {
          controller.notify('custom/text-only does not support image input; attachment remains queued.', 'error')
          return false
        })
        .mockReturnValue(true)
      input.emit('data', '\r')
      await waitFor(() => validate.mock.calls.length === 1)
      expect(controller.state.notification?.message).toContain('does not support image input')

      for (const character of ' suffix') input.emit('data', character)
      input.emit('data', '\r')
      await waitFor(() => startTurn.mock.calls.length === 1)
      expect(startTurn).toHaveBeenCalledWith(current.id, expect.objectContaining({
        prompt: 'ordinary pasted text suffix'
      }))
    } finally {
      controller.requestQuit()
      await running
      await app.stop()
      await controller.stop()
    }
  })

  it('reads a system clipboard image on forwarded paste keys, empty bracketed paste, Leader V, and /paste', async () => {
    const current = detail()
    const client = {
      listThreads: vi.fn(async () => [current]),
      getThread: vi.fn(async () => current),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      skills: vi.fn(async () => ({ enabled: true, roots: [], skills: [], validationErrors: [] })),
      modelConnections: vi.fn(async () => modelSnapshot())
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options, runtime)
    await controller.start()
    const image = {
      bytes: Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0, 0, 0, 0, 0x49, 0x48, 0x44, 0x52
      ]),
      mimeType: 'image/png' as const,
      source: 'macos' as const
    }
    const clipboardImageReader = vi.fn(async () => image)
    const attachClipboardImage = vi.spyOn(controller, 'attachClipboardImage').mockResolvedValue(true)
    const input = Object.assign(new EventEmitter(), {
      isRaw: false,
      setRawMode: vi.fn(),
      setEncoding: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn()
    }) as unknown as TerminalInput
    const output = Object.assign(new EventEmitter(), {
      columns: 92,
      rows: 28,
      write: vi.fn()
    }) as unknown as TerminalOutput
    const app = new PiTuiApplication(
      controller,
      input,
      output,
      parseTuiKeymapConfig({}).keymap,
      clipboardImageReader
    )
    const running = app.run()
    try {
      input.emit('data', '\x16')
      await waitFor(() => attachClipboardImage.mock.calls.length === 1)
      expect(clipboardImageReader).toHaveBeenCalledTimes(1)
      expect(attachClipboardImage).toHaveBeenNthCalledWith(1, image)

      input.emit('data', '\x1bv')
      await waitFor(() => attachClipboardImage.mock.calls.length === 2)
      expect(clipboardImageReader).toHaveBeenCalledTimes(2)
      expect(attachClipboardImage).toHaveBeenNthCalledWith(2, image)

      input.emit('data', '\x1b[118;9u')
      await waitFor(() => attachClipboardImage.mock.calls.length === 3)
      expect(clipboardImageReader).toHaveBeenCalledTimes(3)
      expect(attachClipboardImage).toHaveBeenNthCalledWith(3, image)

      input.emit('data', '\x1b[200~\x1b[201~')
      await waitFor(() => attachClipboardImage.mock.calls.length === 4)
      expect(clipboardImageReader).toHaveBeenCalledTimes(4)
      expect(attachClipboardImage).toHaveBeenNthCalledWith(4, image)

      input.emit('data', '\x18')
      input.emit('data', 'v')
      await waitFor(() => attachClipboardImage.mock.calls.length === 5)
      expect(clipboardImageReader).toHaveBeenCalledTimes(5)
      expect(attachClipboardImage).toHaveBeenNthCalledWith(5, image)

      type(input as unknown as EventEmitter, '/paste')
      await waitFor(() => attachClipboardImage.mock.calls.length === 6)
      expect(clipboardImageReader).toHaveBeenCalledTimes(6)
      expect(attachClipboardImage).toHaveBeenNthCalledWith(6, image)
    } finally {
      controller.requestQuit()
      await running
      await app.stop()
      await controller.stop()
    }
  })

  it('advertises the platform-native screenshot paste key with a reliable fallback', () => {
    expect(imagePasteShortcutLabel('darwin')).toBe('⌘V / Ctrl+X V')
    expect(imagePasteShortcutLabel('win32')).toBe('Ctrl+V / Alt+V')
    expect(imagePasteShortcutLabel('linux')).toBe('Ctrl+V / Ctrl+X V')
  })

  it('renders pending attachment chips and removes them only from an empty text editor', async () => {
    const current = detail()
    let attachmentNumber = 0
    const uploadAttachment = vi.fn(async (input: { name: string; mimeType?: string }) => {
      attachmentNumber += 1
      return {
        attachment: {
          id: `attachment_${attachmentNumber}`,
          name: input.name,
          kind: 'image' as const,
          mimeType: input.mimeType ?? 'image/png',
          byteSize: 2048 * attachmentNumber,
          hash: `hash-${attachmentNumber}`,
          threadIds: [current.id],
          workspaces: [current.workspace],
          createdAt: current.createdAt,
          updatedAt: current.updatedAt
        }
      }
    })
    const client = {
      listThreads: vi.fn(async () => [current]),
      getThread: vi.fn(async () => current),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      skills: vi.fn(async () => ({ enabled: true, roots: [], skills: [], validationErrors: [] })),
      modelConnections: vi.fn(async () => modelSnapshot()),
      setLocalCapabilityEnabled: vi.fn(async () => ({ id: 'attachments' as const, enabled: true })),
      uploadAttachment
    } as unknown as KunTuiClient
    const attachmentRuntime = {
      ...runtime,
      runtimeInfo: {
        ...runtime.runtimeInfo,
        capabilities: buildRuntimeCapabilityManifest({
          model: modelCapabilitiesForModel('model-a')
        })
      }
    } as TuiConnection
    const controller = new TuiController(client, options, attachmentRuntime)
    await controller.start()
    const image = {
      bytes: Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0, 0, 0, 0, 0x49, 0x48, 0x44, 0x52
      ]),
      mimeType: 'image/png' as const,
      source: 'macos' as const
    }
    expect(await controller.attachClipboardImage(image)).toBe(true)
    expect(await controller.attachClipboardImage(image)).toBe(true)
    expect(controller.state.pendingAttachments).toHaveLength(2)
    const input = Object.assign(new EventEmitter(), {
      isRaw: false,
      setRawMode: vi.fn(),
      setEncoding: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn()
    }) as unknown as TerminalInput
    let outputText = ''
    const output = Object.assign(new EventEmitter(), {
      columns: 100,
      rows: 30,
      write: (chunk: string) => { outputText += chunk }
    }) as unknown as TerminalOutput
    const app = new PiTuiApplication(controller, input, output)
    const running = app.run()
    try {
      const rule = '─'.repeat(95)
      const composer = sanitizeTerminalText(
        renderKunComposerFrame([rule, '', rule], controller.state, controller, 100).join('\n')
      )
      expect(composer).toContain('Attachment 1/2 [Image]')
      expect(composer).toContain('Attachment 2/2 [Image]')
      expect(composer).toContain('Backspace/Del remove')

      input.emit('data', 'x')
      input.emit('data', '\x7f')
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(controller.state.pendingAttachments.map((attachment) => attachment.id)).toEqual([
        'attachment_1',
        'attachment_2'
      ])

      input.emit('data', '\x7f')
      await waitFor(() => controller.state.pendingAttachments.length === 1)
      expect(controller.state.pendingAttachments[0]?.id).toBe('attachment_1')
      expect(controller.state.notification?.message).toContain('Removed clipboard-')

      input.emit('data', '\x1b[3~')
      await waitFor(() => controller.state.pendingAttachments.length === 0)
      expect(controller.state.quitRequested).toBe(false)

      await controller.attachClipboardImage(image)
      const previousWindowsTerminalSession = process.env.WT_SESSION
      process.env.WT_SESSION = 'kun-tui-test'
      try {
        input.emit('data', '\x08')
        await waitFor(() => controller.state.pendingAttachments.length === 0)
      } finally {
        if (previousWindowsTerminalSession === undefined) delete process.env.WT_SESSION
        else process.env.WT_SESSION = previousWindowsTerminalSession
      }
      expect(controller.state.quitRequested).toBe(false)

      await controller.attachClipboardImage(image)
      input.emit('data', '\x03')
      await waitFor(() => controller.state.pendingAttachments.length === 0)
      expect(controller.state.notification?.message).toBe('Pending attachments cleared.')
      expect(controller.state.quitRequested).toBe(false)
    } finally {
      controller.requestQuit()
      await running
      await app.stop()
      await controller.stop()
    }
  })

  it('renders assistant fragments before the turn completes and keeps the final text intact', async () => {
    const current = detail()
    current.status = 'running'
    current.turns = [{
      id: 'turn_stream', threadId: current.id, status: 'running', orchestration: 'direct', prompt: 'Say hello', steering: [],
      createdAt: current.createdAt, startedAt: current.createdAt, items: [], attachmentIds: [], activeSkillIds: [],
      injectedMemoryIds: [], injectedMemorySummaries: [], injectedInstructionSources: []
    }]
    let onEvent: ((event: RuntimeEvent) => void) | undefined
    const client = {
      listThreads: vi.fn(async () => [current]),
      getThread: vi.fn(async () => current),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal; onEvent: (event: RuntimeEvent) => void }) => {
        onEvent = input.onEvent
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      skills: vi.fn(async () => ({ enabled: true, roots: [], skills: [], validationErrors: [] }))
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options, runtime)
    await controller.start()
    const input = Object.assign(new EventEmitter(), {
      isRaw: false, setRawMode: vi.fn(), setEncoding: vi.fn(), resume: vi.fn(), pause: vi.fn()
    }) as unknown as TerminalInput
    let outputText = ''
    const output = Object.assign(new EventEmitter(), {
      columns: 80, rows: 24, write: (chunk: string) => { outputText += chunk }
    }) as unknown as TerminalOutput
    const app = new PiTuiApplication(controller, input, output)
    const running = app.run()
    const base = {
      timestamp: '2026-07-22T00:00:01.000Z', threadId: current.id, turnId: 'turn_stream', itemId: 'item_stream'
    }
    try {
      await waitFor(() => sanitizeTerminalText(outputText).includes('History'))
      expect(outputText).not.toContain('\x1b[?1000h\x1b[?1006h')
      onEvent?.({
        ...base, kind: 'assistant_text_delta', seq: 1,
        item: {
          id: 'item_stream', threadId: current.id, turnId: 'turn_stream', role: 'assistant',
          status: 'running', createdAt: base.timestamp, kind: 'assistant_text', text: 'Hel'
        }
      })
      await waitFor(() => outputText.includes('Hel'))
      expect(outputText).toContain('▍')
      expect(outputText).toContain('Responding')
      expect(controller.state.projection?.items.find((item) => item.id === 'item_stream')).toMatchObject({ text: 'Hel' })

      onEvent?.({
        ...base, kind: 'assistant_text_delta', seq: 2,
        item: {
          id: 'item_stream', threadId: current.id, turnId: 'turn_stream', role: 'assistant',
          status: 'running', createdAt: base.timestamp, kind: 'assistant_text', text: 'lo'
        }
      })
      await waitFor(() => outputText.includes('Hello'))
      expect(controller.state.projection?.runningTurnId).toBe('turn_stream')

      onEvent?.({
        ...base, kind: 'assistant_reasoning_delta', seq: 3, itemId: 'reason_stream',
        item: {
          id: 'reason_stream', threadId: current.id, turnId: 'turn_stream', role: 'assistant',
          status: 'running', createdAt: base.timestamp, kind: 'assistant_reasoning', text: 'private thought'
        }
      })
      await waitFor(() => controller.state.projection?.items.some((item) => item.id === 'reason_stream') ?? false)
      await waitFor(() => outputText.includes('Thinking'))
      await waitFor(() => outputText.includes('/thinking expand'))
      expect(outputText).not.toContain('private thought')

      const beforePointerMode = outputText.length
      input.emit('data', '\x18')
      input.emit('data', 'p')
      await waitFor(() => outputText.slice(beforePointerMode).includes('Mouse clicks enabled'))
      expect(outputText.slice(beforePointerMode)).toContain('\x1b[?1000h\x1b[?1006h')

      const beforeMouseExpand = outputText.length
      for (let row = 1; row <= output.rows!; row += 1) {
        input.emit('data', `\x1b[<0;8;${row}M`)
      }
      await waitFor(() => outputText.slice(beforeMouseExpand).includes('private thought'))

      const beforeMouseCollapse = outputText.length
      for (let row = 1; row <= output.rows!; row += 1) {
        input.emit('data', `\x1b[<0;8;${row}M`)
      }
      await waitFor(() => outputText.slice(beforeMouseCollapse).includes('collapsed'))
      expect(outputText.slice(beforeMouseCollapse)).not.toContain('private thought')

      const beforeTextSelection = outputText.length
      input.emit('data', '\x18')
      input.emit('data', 'p')
      await waitFor(() => outputText.slice(beforeTextSelection).includes('Text selection mode'))
      expect(outputText.slice(beforeTextSelection)).toContain('\x1b[?1000l\x1b[?1006l')
      expect(controller.state.projection?.runningTurnId).toBe('turn_stream')

      const beforeClicksRestored = outputText.length
      input.emit('data', '\x18')
      input.emit('data', 'p')
      await waitFor(() => outputText.slice(beforeClicksRestored).includes('Mouse clicks enabled'))
      expect(outputText.slice(beforeClicksRestored)).toContain('\x1b[?1000h\x1b[?1006h')

      const beforeExpand = outputText.length
      type(input, '/thinking')
      await waitFor(() => outputText.slice(beforeExpand).includes('Thinking is expanded'))
      await waitFor(() => outputText.slice(beforeExpand).includes('private thought'))

      const beforeCollapse = outputText.length
      type(input, '/thinking')
      await waitFor(() => outputText.slice(beforeCollapse).includes('Thinking is collapsed'))
      onEvent?.({
        ...base, kind: 'assistant_reasoning_delta', seq: 4, itemId: 'reason_stream',
        item: {
          id: 'reason_stream', threadId: current.id, turnId: 'turn_stream', role: 'assistant',
          status: 'running', createdAt: base.timestamp, kind: 'assistant_reasoning',
          text: ' and this stays folded'
        }
      })
      await waitFor(() => controller.state.projection?.items.some((item) =>
        item.id === 'reason_stream' && item.kind === 'assistant_reasoning' &&
        item.text.includes('this stays folded')
      ) ?? false)
      expect(outputText.slice(beforeCollapse)).not.toContain('this stays folded')

      const beforeShow = outputText.length
      type(input, '/thinking')
      await waitFor(() => outputText.slice(beforeShow).includes('this stays folded'))

      onEvent?.({
        ...base, kind: 'item_completed', seq: 5,
        item: {
          id: 'item_stream', threadId: current.id, turnId: 'turn_stream', role: 'assistant',
          status: 'completed', createdAt: base.timestamp, kind: 'assistant_text', text: 'Hello'
        }
      })
      onEvent?.({
        kind: 'turn_completed', seq: 6, timestamp: base.timestamp, threadId: current.id,
        turnId: 'turn_stream', status: 'completed'
      })
      await waitFor(() => controller.state.projection?.runningTurnId === undefined)
      expect(controller.state.projection?.items.find((item) => item.id === 'item_stream')).toMatchObject({ text: 'Hello' })
    } finally {
      controller.requestQuit()
      await running
      await app.stop()
      await controller.stop()
    }
  })

  it('renders persistent actionable model failures instead of an empty Ready conversation', async () => {
    const current = detail()
    current.status = 'running'
    current.turns = [{
      id: 'turn_auth', threadId: current.id, status: 'running', orchestration: 'direct', prompt: 'Hello', steering: [],
      createdAt: current.createdAt, startedAt: current.createdAt,
      items: [{
        id: 'user_auth', threadId: current.id, turnId: 'turn_auth', role: 'user', status: 'completed',
        createdAt: current.createdAt, kind: 'user_message', text: 'Hello'
      }], attachmentIds: [], activeSkillIds: [], injectedMemoryIds: [], injectedMemorySummaries: [],
      injectedInstructionSources: []
    }]
    let onEvent: ((event: RuntimeEvent) => void) | undefined
    const client = {
      listThreads: vi.fn(async () => [current]), getThread: vi.fn(async () => current),
      delegationDiagnostics: vi.fn(async () => ({ enabled: true, active: 0, childRuns: [], aggregates: [] })),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal; onEvent: (event: RuntimeEvent) => void }) => {
        onEvent = input.onEvent
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      skills: vi.fn(async () => ({ enabled: true, roots: [], skills: [], validationErrors: [] }))
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options, runtime)
    await controller.start()
    const input = Object.assign(new EventEmitter(), {
      isRaw: false, setRawMode: vi.fn(), setEncoding: vi.fn(), resume: vi.fn(), pause: vi.fn()
    }) as unknown as TerminalInput
    let outputText = ''
    const output = Object.assign(new EventEmitter(), {
      columns: 92, rows: 26, write: (chunk: string) => { outputText += chunk }
    }) as unknown as TerminalOutput
    const app = new PiTuiApplication(controller, input, output)
    const running = app.run()
    try {
      const base = { timestamp: '2026-07-23T01:27:22.000Z', threadId: current.id, turnId: 'turn_auth' }
      onEvent?.({
        ...base, kind: 'error', seq: 1, code: 'http_401', severity: 'error',
        message: 'model request failed with status 401: invalid or expired credentials; no auth context'
      })
      onEvent?.({
        ...base, kind: 'turn_failed', seq: 2, status: 'failed', code: 'http_401',
        message: 'model request failed with status 401: invalid or expired credentials; no auth context'
      })
      await waitFor(() => outputText.includes('Model connection failed'))
      expect(outputText).toContain('Run /connect')
      expect(outputText).toContain('/model')
      expect(outputText).toContain('HTTP 401')
      expect(outputText).not.toContain('no auth context')
      expect(controller.state.projection?.runningTurnId).toBeUndefined()
      expect(controller.state.projection?.items).toContainEqual(expect.objectContaining({ kind: 'error', code: 'http_401' }))
    } finally {
      controller.requestQuit()
      await running
      await app.stop()
      await controller.stop()
    }
  })

  it('renders paired tools and nested subagents while keeping the parent turn live', async () => {
    const current = detail()
    current.status = 'running'
    current.turns = [{
      id: 'turn_parent', threadId: current.id, status: 'running', orchestration: 'direct', prompt: 'Investigate', steering: [],
      createdAt: current.createdAt, startedAt: current.createdAt,
      items: [{
        id: 'call_delegate', threadId: current.id, turnId: 'turn_parent', role: 'assistant', status: 'running',
        createdAt: current.createdAt, kind: 'tool_call', toolName: 'delegate_task', callId: 'call_1',
        toolKind: 'tool_call', arguments: { label: 'Inspect streaming', prompt: 'Find the TUI event bug' },
        summary: 'Inspect streaming'
      }], attachmentIds: [], activeSkillIds: [], injectedMemoryIds: [], injectedMemorySummaries: [],
      injectedInstructionSources: []
    }]
    let onEvent: ((event: RuntimeEvent) => void) | undefined
    const client = {
      listThreads: vi.fn(async () => [current]), getThread: vi.fn(async () => current),
      delegationDiagnostics: vi.fn(async () => ({
        enabled: true, active: 1, aggregates: [], childRuns: [{
          id: 'child_1', parentThreadId: current.id, parentTurnId: 'turn_parent',
          label: 'Inspect streaming', prompt: 'Find the TUI event bug', profile: 'researcher',
          status: 'running', createdAt: current.createdAt, updatedAt: current.createdAt
        }]
      })),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal; onEvent: (event: RuntimeEvent) => void }) => {
        onEvent = input.onEvent
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      skills: vi.fn(async () => ({ enabled: true, roots: [], skills: [], validationErrors: [] }))
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options, runtime)
    await controller.start()
    const input = Object.assign(new EventEmitter(), {
      isRaw: false, setRawMode: vi.fn(), setEncoding: vi.fn(), resume: vi.fn(), pause: vi.fn()
    }) as unknown as TerminalInput
    let outputText = ''
    const output = Object.assign(new EventEmitter(), {
      columns: 100, rows: 28, write: (chunk: string) => { outputText += chunk }
    }) as unknown as TerminalOutput
    const app = new PiTuiApplication(controller, input, output)
    const running = app.run()
    try {
      await waitFor(() => outputText.includes('Subagent · Inspect streaming'))
      expect(outputText).toContain('Delegate')
      expect(outputText).toContain('Working independently')
      const before = outputText.length
      onEvent?.({
        kind: 'turn_completed', seq: 1, timestamp: '2026-07-22T00:00:01.250Z',
        threadId: current.id, turnId: 'turn_parent', status: 'completed', text: 'Found the projection bug',
        child: {
          parentThreadId: current.id, parentTurnId: 'turn_parent', childId: 'child_1',
          childLabel: 'Inspect streaming', childStatus: 'completed', childSeq: 2,
          childProfile: 'researcher', toolInvocations: 3, durationMs: 1250
        }
      })
      await waitFor(() => outputText.slice(before).includes('3 tools'))
      expect(outputText.slice(before)).toContain('Found the projection bug')
      expect(controller.state.projection?.runningTurnId).toBe('turn_parent')
      const beforeResult = outputText.length
      onEvent?.({
        kind: 'item_created', seq: 2, timestamp: '2026-07-22T00:00:01.300Z',
        threadId: current.id, turnId: 'turn_parent', itemId: 'result_delegate',
        item: {
          id: 'result_delegate', threadId: current.id, turnId: 'turn_parent', role: 'tool', status: 'completed',
          createdAt: '2026-07-22T00:00:01.300Z', finishedAt: '2026-07-22T00:00:01.300Z',
          kind: 'tool_result', toolName: 'delegate_task', callId: 'call_1', toolKind: 'tool_call',
          output: { childId: 'child_1', summary: 'Subagent result received' }, isError: false
        }
      })
      await waitFor(() => outputText.slice(beforeResult).includes('Subagent result received'))
      expect(controller.state.projection?.items.filter((item) => item.kind === 'tool_result')).toHaveLength(1)
    } finally {
      controller.requestQuit()
      await running
      await app.stop()
      await controller.stop()
    }
  })

  it('groups parallel subagents with Kimi-style status and expands them with Ctrl+O state', () => {
    const projection = projectThreadSnapshot(detail())
    projection.childRuns = [
      {
        childId: 'child_research',
        parentTurnId: 'turn_parallel',
        childSeq: 1,
        label: 'Inspect runtime',
        prompt: 'Inspect the runtime event flow in detail',
        profile: 'researcher',
        profileName: 'Researcher',
        status: 'running',
        toolInvocations: 2,
        totalTokens: 2048,
        activity: {
          phase: 'tool',
          label: 'Searching the workspace',
          toolName: 'search',
          startedAt: '2026-07-22T00:00:01.000Z',
          updatedAt: '2026-07-22T00:00:01.000Z'
        },
        startedAt: '2026-07-22T00:00:00.000Z',
        updatedAt: '2026-07-22T00:00:01.000Z'
      },
      {
        childId: 'child_tests',
        parentTurnId: 'turn_parallel',
        childSeq: 2,
        label: 'Run tests',
        prompt: 'Run the focused regression tests',
        profile: 'tester',
        profileName: 'Test Engineer',
        status: 'queued',
        startedAt: '2026-07-22T00:00:00.000Z',
        updatedAt: '2026-07-22T00:00:00.000Z'
      }
    ]
    const transcript = new TranscriptComponent()
    transcript.update(projection, false, false)
    const compact = transcript.render(100, 1)
    const compactText = sanitizeTerminalText(compact.join('\n'))
    expect(compactText).toContain('Running 2 agents')
    expect(compactText).toContain('1 running')
    expect(compactText).toContain('1 waiting')
    expect(compactText).toContain('2 tools')
    expect(compactText).toContain('2.0k tok')
    expect(compactText).toContain('Searching the workspace')
    expect(compactText).toContain('Ctrl+O expand')
    expect(compactText).not.toContain('Inspect the runtime event flow in detail')
    const researcherRow = compact.findIndex((line) => sanitizeTerminalText(line).includes('Researcher'))
    expect(transcript.childAtRenderedRow(researcherRow)?.childId).toBe('child_research')

    transcript.update(projection, false, true)
    const expandedText = sanitizeTerminalText(transcript.render(100, 2).join('\n'))
    expect(expandedText).toContain('Inspect the runtime event flow in detail')
    expect(expandedText).toContain('Ctrl+O collapse')
  })

  it('opens a delegated child as a live controllable transcript and returns to the parent', async () => {
    const parent = detail()
    parent.title = 'Parent investigation'
    parent.turns = [{
      id: 'turn_parent', threadId: parent.id, status: 'running', orchestration: 'direct', prompt: 'Delegate this', steering: [],
      createdAt: parent.createdAt, startedAt: parent.createdAt,
      items: [{
        id: 'user_parent', threadId: parent.id, turnId: 'turn_parent', role: 'user', status: 'completed',
        createdAt: parent.createdAt, kind: 'user_message', text: 'Delegate this'
      }], attachmentIds: [], activeSkillIds: [], injectedMemoryIds: [], injectedMemorySummaries: [],
      injectedInstructionSources: []
    }]
    const child: ThreadDetail = {
      ...detail(),
      id: 'child_1',
      title: 'Subagent · Inspect streaming',
      relation: 'side',
      parentThreadId: parent.id,
      status: 'running',
      turns: [{
        id: 'turn_child', threadId: 'child_1', status: 'running', orchestration: 'direct', prompt: 'Find the event bug', steering: [],
        createdAt: parent.createdAt, startedAt: parent.createdAt,
        items: [{
          id: 'reason_child', threadId: 'child_1', turnId: 'turn_child', role: 'assistant', status: 'running',
          createdAt: parent.createdAt, kind: 'assistant_reasoning', text: 'private child reasoning'
        }], attachmentIds: [], activeSkillIds: [], injectedMemoryIds: [], injectedMemorySummaries: [],
        injectedInstructionSources: []
      }]
    }
    const childRun = {
      id: child.id, parentThreadId: parent.id, parentTurnId: 'turn_parent',
      label: 'Inspect streaming', prompt: 'Find the event bug', profile: 'researcher', model: 'model-a',
      status: 'running' as const, createdAt: parent.createdAt, updatedAt: parent.updatedAt
    }
    let childOnEvent: ((event: RuntimeEvent) => void) | undefined
    let childSubscriptionAborted = false
    const client = {
      listThreads: vi.fn(async () => [parent]),
      getThread: vi.fn(async (id: string) => id === child.id ? child : parent),
      delegationDiagnostics: vi.fn(async (threadId: string) => ({
        enabled: true,
        active: threadId === parent.id ? 1 : 0,
        childRuns: threadId === parent.id ? [childRun] : [],
        aggregates: []
      })),
      subscribeThreadEvents: vi.fn(async (request: {
        threadId: string
        signal: AbortSignal
        onConnection?: (state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected') => void
        onEvent: (event: RuntimeEvent) => void
      }) => {
        request.onConnection?.('connected')
        if (request.threadId === child.id) childOnEvent = request.onEvent
        await new Promise<void>((resolve) => request.signal.addEventListener('abort', () => {
          if (request.threadId === child.id) childSubscriptionAborted = true
          resolve()
        }, { once: true }))
      }),
      skills: vi.fn(async () => ({ enabled: true, roots: [], skills: [], validationErrors: [] }))
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options, runtime)
    await controller.start()
    const input = Object.assign(new EventEmitter(), {
      isRaw: false, setRawMode: vi.fn(), setEncoding: vi.fn(), resume: vi.fn(), pause: vi.fn()
    }) as unknown as TerminalInput
    let outputText = ''
    const output = Object.assign(new EventEmitter(), {
      columns: 96, rows: 30, write: (chunk: string) => { outputText += chunk }
    }) as unknown as TerminalOutput
    const app = new PiTuiApplication(controller, input, output)
    const running = app.run()
    try {
      expect(outputText).not.toContain('\x1b[?1000h\x1b[?1006h')
      input.emit('data', '\x18')
      input.emit('data', 'p')
      await waitFor(() => outputText.includes('Mouse clicks enabled'))
      type(input, '/subagents')
      await waitFor(() => outputText.includes('Subagents') && outputText.includes('Inspect streaming'))
      expect(sanitizeTerminalText(outputText)).toContain('Enter open transcript')
      expect(outputText).toContain('\x1b[?1000h\x1b[?1006h')

      const beforeRouteClose = outputText.length
      input.emit('data', '\x03')
      await waitFor(() => outputText.slice(beforeRouteClose).includes('Parent investigation'))
      const beforeOpen = outputText.length
      for (let row = 1; row <= output.rows!; row += 1) {
        input.emit('data', `\x1b[<0;8;${row}M`)
      }
      await waitFor(() => outputText.slice(beforeOpen).includes('child session') && Boolean(childOnEvent))
      const childFrame = outputText.slice(beforeOpen)
      expect(childFrame).toContain('Find the event bug')
      expect(childFrame).toContain('Thinking')
      expect(childFrame).toContain('collapsed')
      expect(childFrame).not.toContain('private child reasoning')
      expect(childFrame.indexOf('Kun')).toBeLessThan(childFrame.indexOf('Thinking'))
      expect(client.getThread).toHaveBeenCalledWith('child_1')

      const beforeChildMouseExpand = outputText.length
      for (let row = 1; row <= output.rows!; row += 1) {
        input.emit('data', `\x1b[<0;8;${row}M`)
      }
      await waitFor(() => outputText.slice(beforeChildMouseExpand).includes('private child reasoning'))

      const beforeChildMouseCollapse = outputText.length
      for (let row = 1; row <= output.rows!; row += 1) {
        input.emit('data', `\x1b[<0;8;${row}M`)
      }
      await waitFor(() => outputText.slice(beforeChildMouseCollapse).includes('collapsed'))
      expect(outputText.slice(beforeChildMouseCollapse)).not.toContain('private child reasoning')

      childOnEvent?.({
        kind: 'assistant_text_delta',
        seq: 1,
        timestamp: '2026-07-22T00:00:01.000Z',
        threadId: child.id,
        turnId: 'turn_child',
        itemId: 'answer_child',
        item: {
          id: 'answer_child', threadId: child.id, turnId: 'turn_child', role: 'assistant',
          status: 'running', createdAt: parent.createdAt, kind: 'assistant_text', text: 'Hel'
        }
      })
      await waitFor(() => outputText.includes('Hel'))

      const beforeExpand = outputText.length
      input.emit('data', 't')
      await waitFor(() => outputText.slice(beforeExpand).includes('private child reasoning'))

      const beforeParent = outputText.length
      input.emit('data', '\x03')
      await waitFor(() =>
        childSubscriptionAborted &&
        controller.state.projection?.thread.id === parent.id
      )
      expect(controller.state.projection?.thread.id).toBe(parent.id)
      expect(outputText).toContain('Parent investigation')
      expect(outputText).toContain('Delegate this')
      expect(outputText.length).toBeGreaterThan(beforeParent)

      childSubscriptionAborted = false
      childOnEvent = undefined
      const beforePopup = outputText.length
      for (let row = 1; row <= output.rows!; row += 1) {
        input.emit('data', `\x1b[<0;8;${row}M`)
      }
      await waitFor(() =>
        sanitizeTerminalText(outputText.slice(beforePopup)).includes('Esc close') &&
        Boolean(childOnEvent)
      )
      const popupFrame = outputText.slice(beforePopup)
      expect(popupFrame).toContain('Subagent · Inspect streaming')
      expect(popupFrame).toContain('live child session')
      expect(popupFrame).toContain('Thinking')
      expect(popupFrame).toContain('collapsed')
      expect(popupFrame.indexOf('Kun')).toBeLessThan(popupFrame.indexOf('Thinking'))
      expect(outputText).toContain('\x1b[?1000h\x1b[?1006h')

      const beforePopupThinking = outputText.length
      for (let row = 1; row <= output.rows!; row += 1) {
        input.emit('data', `\x1b[<0;8;${row}M`)
      }
      await waitFor(() => outputText.slice(beforePopupThinking).includes('private child reasoning'))

      const popupOnEvent = childOnEvent as ((event: RuntimeEvent) => void) | undefined
      expect(popupOnEvent).toBeTypeOf('function')
      popupOnEvent!({
        kind: 'assistant_text_delta',
        seq: 2,
        timestamp: '2026-07-22T00:00:02.000Z',
        threadId: child.id,
        turnId: 'turn_child',
        itemId: 'answer_child',
        item: {
          id: 'answer_child', threadId: child.id, turnId: 'turn_child', role: 'assistant',
          status: 'running', createdAt: parent.createdAt, kind: 'assistant_text', text: 'Popup live'
        }
      })
      await waitFor(() => outputText.slice(beforePopup).includes('Popup live'))

      // Wheel input belongs to the popup and must never leak into the parent
      // composer. Ctrl+C closes only the popup and restores the parent.
      input.emit('data', '\x1b[<65;20;12M')
      input.emit('data', '\x03')
      await waitFor(() => childSubscriptionAborted)
      expect(controller.state.projection?.thread.id).toBe(parent.id)
      expect(outputText).toContain('\x1b[?1000h\x1b[?1006h')
      const beforeRestoredComposer = outputText.length
      type(input, '/status')
      await waitFor(() => outputText.slice(beforeRestoredComposer).includes('Permissions'))
      input.emit('data', '\x03')
    } finally {
      controller.requestQuit()
      await running
      await app.stop()
      await controller.stop()
    }
    expect(outputText).toContain('\x1b[?1000l\x1b[?1006l')
    expect(outputText).not.toContain('\x1b[?1049h')
    expect(outputText).not.toContain('\x1b[?1049l')
  })

  it('maps the three GUI-aligned permission modes and removes raw Advanced editing', async () => {
    const presetSave = vi.fn(async () => true)
    const closePreset = vi.fn()
    const presetDialog = new PermissionDialog(
      { setPermissions: presetSave } as unknown as TuiController,
      'on-request',
      'workspace-write',
      'user',
      closePreset
    )
    const presetFrame = sanitizeTerminalText(presetDialog.render(100).join('\n'))
    for (const label of [
      'Ask for approval',
      'Approve for me',
      'Full access'
    ]) {
      expect(presetFrame).toContain(label)
    }
    expect(presetFrame).not.toContain('Approval policy')
    expect(presetFrame).not.toContain('Advanced')

    presetDialog.handleInput('\x1b[B')
    presetDialog.handleInput('\r')
    await waitFor(() => presetSave.mock.calls.length === 1)
    expect(presetSave).toHaveBeenCalledWith('on-request', 'workspace-write', 'agent')
    expect(closePreset).toHaveBeenCalledOnce()

    // Rendering a custom legacy pair projects it conservatively without
    // writing. An explicit save canonicalizes all three authority fields.
    const customSave = vi.fn(async () => true)
    const customDialog = new PermissionDialog(
      { setPermissions: customSave } as unknown as TuiController,
      'never',
      'read-only',
      'user',
      vi.fn()
    )
    const projectedAskRow = customDialog.render(100)
      .map((line) => sanitizeTerminalText(line))
      .find((line) => line.includes('Ask for approval'))
    expect(projectedAskRow).toContain('│ Ask for approval')
    expect(customSave).not.toHaveBeenCalled()
    customDialog.handleInput('a')
    expect(sanitizeTerminalText(customDialog.render(100).join('\n'))).not.toContain('Advanced')
    customDialog.handleInput('\r')
    await waitFor(() => customSave.mock.calls.length === 1)
    expect(customSave).toHaveBeenCalledWith('on-request', 'workspace-write', 'user')

    const cancelSave = vi.fn(async () => true)
    const cancelClose = vi.fn()
    const cancelDialog = new PermissionDialog(
      { setPermissions: cancelSave } as unknown as TuiController,
      'suggest',
      'external-sandbox',
      'user',
      cancelClose
    )
    cancelDialog.handleInput('\x1b')
    expect(cancelClose).toHaveBeenCalledOnce()
    expect(cancelSave).not.toHaveBeenCalled()
  })

  it('requires a second explicit confirmation only when elevating to Full access', async () => {
    const restrictedSave = vi.fn(async () => true)
    const restrictedClose = vi.fn()
    const restrictedDialog = new PermissionDialog(
      { setPermissions: restrictedSave } as unknown as TuiController,
      'on-request',
      'workspace-write',
      'user',
      restrictedClose
    )
    restrictedDialog.handleInput('\x1b[B')
    restrictedDialog.handleInput('\x1b[B')
    restrictedDialog.handleInput('\r')

    expect(restrictedSave).not.toHaveBeenCalled()
    const confirmation = sanitizeTerminalText(restrictedDialog.render(100).join('\n'))
    expect(confirmation).toContain('Enable Full access?')
    expect(confirmation).toContain('access any file on this computer')
    expect(confirmation).toContain('execute host commands')
    expect(confirmation).toContain('network-capable tools')

    restrictedDialog.handleInput('\x1b')
    expect(restrictedSave).not.toHaveBeenCalled()
    expect(restrictedClose).not.toHaveBeenCalled()
    expect(sanitizeTerminalText(restrictedDialog.render(100).join('\n')))
      .toContain('Tool permission mode')

    restrictedDialog.handleInput('\r')
    expect(restrictedSave).not.toHaveBeenCalled()
    restrictedDialog.handleInput('\r')
    await waitFor(() => restrictedSave.mock.calls.length === 1)
    expect(restrictedSave).toHaveBeenCalledWith('auto', 'danger-full-access', 'user')
    expect(restrictedClose).toHaveBeenCalledOnce()

    const alreadyFullSave = vi.fn(async () => true)
    const alreadyFullDialog = new PermissionDialog(
      { setPermissions: alreadyFullSave } as unknown as TuiController,
      'auto',
      'danger-full-access',
      'user',
      vi.fn()
    )
    alreadyFullDialog.handleInput('\r')
    await waitFor(() => alreadyFullSave.mock.calls.length === 1)
    expect(alreadyFullSave).toHaveBeenCalledWith('auto', 'danger-full-access', 'user')

    const lowerAuthoritySave = vi.fn(async () => true)
    const lowerAuthorityDialog = new PermissionDialog(
      { setPermissions: lowerAuthoritySave } as unknown as TuiController,
      'auto',
      'danger-full-access',
      'user',
      vi.fn()
    )
    lowerAuthorityDialog.handleInput('\x1b[A')
    lowerAuthorityDialog.handleInput('\r')
    await waitFor(() => lowerAuthoritySave.mock.calls.length === 1)
    expect(lowerAuthoritySave).toHaveBeenCalledWith(
      'on-request',
      'workspace-write',
      'agent'
    )
  })

  it('renders GUI-aligned permission presets in a narrow inline terminal and restores focus', async () => {
    let current = detail()
    const updateThread = vi.fn(async (_id: string, patch: Partial<ThreadDetail>) => {
      current = { ...current, ...patch }
      return current
    })
    const client = {
      listThreads: vi.fn(async () => [current]),
      getThread: vi.fn(async () => current),
      subscribeThreadEvents: vi.fn(async (input: {
        signal: AbortSignal
        onConnection: (state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected') => void
      }) => {
        input.onConnection('connected')
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      skills: vi.fn(async () => ({ enabled: true, roots: [], skills: [], validationErrors: [] })),
      updateThread
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options, runtime)
    await controller.start()

    const input = Object.assign(new EventEmitter(), {
      isRaw: false,
      setRawMode: vi.fn(),
      setEncoding: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn()
    }) as unknown as TerminalInput
    let outputText = ''
    const output = Object.assign(new EventEmitter(), {
      columns: 38,
      rows: 16,
      write: (chunk: string) => { outputText += chunk }
    }) as unknown as TerminalOutput
    const app = new PiTuiApplication(controller, input, output)
    const running = app.run()
    try {
      type(input, '/status')
      await waitFor(() => outputText.includes('Status'))
      expect(outputText).not.toContain('Mode: agent')
      const beforeStatusScroll = outputText.length
      input.emit('data', '\x1b[B')
      await waitFor(() => /Mode\s+agent/u.test(sanitizeTerminalText(outputText.slice(beforeStatusScroll))))
      input.emit('data', '\x1b')
      const beforePermission = outputText.length
      type(input, '/permission')
      await waitFor(() => outputText.slice(beforePermission).includes('Full access'))
      const narrowPresetFrame = sanitizeTerminalText(outputText.slice(beforePermission))
      expect(narrowPresetFrame).toContain('Tool permission mode')
      expect(narrowPresetFrame).toContain('Ask for approval')
      expect(narrowPresetFrame).toContain('Approve for me')
      expect(narrowPresetFrame).toContain('Full access')
      expect(narrowPresetFrame).not.toContain('adva')
      expect(narrowPresetFrame).not.toContain('Approval policy')
      input.emit('data', '\r')
      await waitFor(() => updateThread.mock.calls.length > 0)

      expect(outputText).not.toContain('\x1b[?1049h')
      expect(updateThread).toHaveBeenCalledWith('thr_pi', {
        approvalPolicy: 'on-request',
        sandboxMode: 'workspace-write',
        approvalReviewer: 'user'
      })
    } finally {
      controller.requestQuit()
      await running
      await app.stop()
      await controller.stop()
    }
    expect(input.setRawMode).toHaveBeenLastCalledWith(false)
    expect(outputText).not.toContain('\x1b[?1049l')
  })

  it('keeps every major keyboard dialog operable and restores the composer on a narrow terminal', async () => {
    const current = detail()
    current.providerId = 'deepseek'
    current.accountId = 'account:deepseek'
    current.model = 'deepseek-v4-pro'
    const startTurn = vi.fn(async () => ({ turnId: 'turn_focus' }))
    const catalog: ModelConnectionSnapshot = {
      ...modelSnapshot(),
      providers: modelSnapshot().providers.map((provider) => provider.id === 'deepseek'
        ? {
            ...provider,
            modelCapabilities: {
              'deepseek-v4-pro': {
                id: 'deepseek-v4-pro', inputModalities: ['text'], outputModalities: ['text'],
                supportsToolCalling: true, messageParts: ['text'],
                reasoning: {
                  supportedEfforts: ['low', 'high'], defaultEffort: 'low',
                  requestProtocol: 'deepseek-chat-completions'
                }
              }
            }
          }
        : provider)
    }
    const client = {
      listThreads: vi.fn(async () => [current]),
      getThread: vi.fn(async () => current),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      skills: vi.fn(async () => ({
        enabled: true, roots: ['/tmp/project/.agents/skills'], validationErrors: [],
        skills: [{ id: 'review', name: 'Review', description: 'Review changes', version: '1',
          root: '/tmp/project/.agents/skills/review', source: 'project', legacy: false, allowedTools: [] }]
      })),
      modelConnections: vi.fn(async () => catalog),
      startTurn
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options, runtime)
    await controller.start()
    controller.applyModelSelection(catalog, false)

    const input = Object.assign(new EventEmitter(), {
      isRaw: false, setRawMode: vi.fn(), setEncoding: vi.fn(), resume: vi.fn(), pause: vi.fn()
    }) as unknown as TerminalInput
    let outputText = ''
    const output = Object.assign(new EventEmitter(), {
      columns: 44, rows: 18, write: (chunk: string) => { outputText += chunk }
    }) as unknown as TerminalOutput
    const app = new PiTuiApplication(controller, input, output)
    const running = app.run()
    const openSlashAndCancel = async (command: string, expected: string) => {
      const before = outputText.length
      type(input, command)
      await waitFor(() => sanitizeTerminalText(outputText.slice(before)).includes(expected))
      input.emit('data', '\x03')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    try {
      await openSlashAndCancel('/help', 'KUN / Help')
      await openSlashAndCancel('/timeline', 'Timeline')
      await openSlashAndCancel('/skills', 'KUN / Skills')
      await openSlashAndCancel('/connect', 'KUN / Connect')
      await openSlashAndCancel('/variants', 'Reasoning effort')

      let before = outputText.length
      input.emit('data', '\x18')
      input.emit('data', 'a')
      await waitFor(() => sanitizeTerminalText(outputText.slice(before)).includes('KUN / Mode'))
      expect(sanitizeTerminalText(outputText.slice(before))).toContain('Goal')
      expect(sanitizeTerminalText(outputText.slice(before))).toContain('Keep pursuing')
      input.emit('data', '\x03')

      before = outputText.length
      input.emit('data', '\x10')
      await waitFor(() => outputText.slice(before).includes('Commands'))
      input.emit('data', '\x03')

      type(input, 'focus restored')
      await waitFor(() => startTurn.mock.calls.length === 1)
      expect(startTurn).toHaveBeenCalledWith('thr_pi', expect.objectContaining({ prompt: 'focus restored' }))
      expect(outputText).not.toContain('\x1b[?1049h')
    } finally {
      controller.requestQuit()
      await running
      await app.stop()
      await controller.stop()
    }
  })

  it('refreshes an open model route when another client changes the shared catalog', async () => {
    const current = detail()
    const initial = modelSnapshot()
    const client = {
      listThreads: vi.fn(async () => [current]),
      getThread: vi.fn(async () => current),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      skills: vi.fn(async () => ({ enabled: true, roots: [], skills: [], validationErrors: [] })),
      modelConnections: vi.fn(async () => initial)
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options, runtime)
    await controller.start()
    controller.applyModelSelection(initial, false)
    const input = Object.assign(new EventEmitter(), {
      isRaw: false, setRawMode: vi.fn(), setEncoding: vi.fn(), resume: vi.fn(), pause: vi.fn()
    }) as unknown as TerminalInput
    let outputText = ''
    const output = Object.assign(new EventEmitter(), {
      columns: 72, rows: 22, write: (chunk: string) => { outputText += chunk }
    }) as unknown as TerminalOutput
    const app = new PiTuiApplication(controller, input, output)
    const running = app.run()
    try {
      type(input, '/model')
      await waitFor(() => outputText.includes('Kimi Code'))
      const before = outputText.length
      const updated: ModelConnectionSnapshot = {
        ...initial,
        revision: initial.revision + 1,
        providers: [...initial.providers, {
          id: 'claude', accountId: 'account:claude', name: 'Claude', kind: 'http',
          authType: 'api-key', endpointFormat: 'messages', configured: true,
          models: ['claude-opus-4-6'], selectedModel: 'claude-opus-4-6'
        }]
      }
      controller.applyModelSelection(updated, false)
      await waitFor(() => outputText.slice(before).includes('Claude'))
      expect(outputText.slice(before)).toContain('claude-opus-4-6')
      input.emit('data', '\x1b')
    } finally {
      controller.requestQuit()
      await running
      await app.stop()
      await controller.stop()
    }
  })

  it('shows the complete shared GUI catalog and submits a masked Grok callback result', async () => {
    const current = detail()
    const initial = modelSnapshot()
    const grokProfile = {
      id: 'grok-subscription',
      accountId: 'account:grok-subscription',
      name: 'Grok 订阅',
      presetSource: 'grok-subscription',
      kind: 'http' as const,
      authType: 'oauth' as const,
      baseUrl: 'https://cli-chat-proxy.grok.com/v1',
      endpointFormat: 'responses' as const,
      configured: true,
      models: [
        'grok-4.5',
        'grok-4-1-fast-reasoning',
        'grok-4-1-fast-non-reasoning',
        'grok-code-fast-1'
      ],
      selectedModel: 'grok-4.5'
    }
    const connected: ModelConnectionSnapshot = {
      ...initial,
      revision: initial.revision + 1,
      providers: [...initial.providers, grokProfile],
      defaultProviderId: grokProfile.id,
      defaultAccountId: grokProfile.accountId,
      defaultModel: grokProfile.selectedModel
    }
    const startModelOAuth = vi.fn(async () => ({
      sessionId: 'oauth-grok-1',
      provider: 'grok' as const,
      status: 'pending' as const,
      expiresAt: '2026-07-23T12:00:00.000Z'
    }))
    const submitModelOAuth = vi.fn(async () => ({
      sessionId: 'oauth-grok-1',
      provider: 'grok' as const,
      status: 'connected' as const,
      expiresAt: '2026-07-23T12:00:00.000Z',
      snapshot: connected
    }))
    const client = {
      listThreads: vi.fn(async () => [current]),
      getThread: vi.fn(async () => current),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      skills: vi.fn(async () => ({ enabled: true, roots: [], skills: [], validationErrors: [] })),
      modelConnections: vi.fn(async () => initial),
      startModelOAuth,
      submitModelOAuth,
      modelOAuthStatus: vi.fn(async () => ({
        sessionId: 'oauth-grok-1',
        provider: 'grok' as const,
        status: 'pending' as const,
        expiresAt: '2026-07-23T12:00:00.000Z'
      })),
      cancelModelOAuth: vi.fn()
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options, runtime)
    await controller.start()
    controller.applyModelSelection(initial, false)
    const input = Object.assign(new EventEmitter(), {
      isRaw: false, setRawMode: vi.fn(), setEncoding: vi.fn(), resume: vi.fn(), pause: vi.fn()
    }) as unknown as TerminalInput
    let outputText = ''
    const output = Object.assign(new EventEmitter(), {
      columns: 92, rows: 28, write: (chunk: string) => { outputText += chunk }
    }) as unknown as TerminalOutput
    const app = new PiTuiApplication(controller, input, output)
    const running = app.run()
    const callback = 'http://127.0.0.1:45678/callback?code=browser-code-secret&state=state-1'
    try {
      type(input, '/connect')
      await waitFor(() => sanitizeTerminalText(outputText).includes('KUN / Connect'))
      input.emit('data', '\r')
      await waitFor(() =>
        outputText.includes('17 subscriptions') &&
        outputText.includes('10 APIs') &&
        outputText.includes('Google Antigravity 订阅') &&
        outputText.includes('Cursor 订阅')
      )
      type(input, 'grok')
      await waitFor(() => outputText.includes('Grok 订阅'))
      input.emit('data', '\r')
      await waitFor(() => outputText.includes('Paste the authorization code or complete callback URL'))

      input.emit('data', `\x1b[200~${callback}\x1b[201~`)
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(outputText).toContain('•')
      expect(outputText).not.toContain('browser-code-secret')
      input.emit('data', '\r')

      await waitFor(() => submitModelOAuth.mock.calls.length === 1)
      expect(startModelOAuth).toHaveBeenCalledWith({
        expectedRevision: initial.revision,
        provider: 'grok',
        model: 'grok-4.5',
        select: true
      })
      expect(submitModelOAuth).toHaveBeenCalledWith('oauth-grok-1', callback)
      await waitFor(() => controller.state.modelConnections?.defaultProviderId === 'grok-subscription')
      expect(outputText).not.toContain('browser-code-secret')
    } finally {
      controller.requestQuit()
      await running
      await app.stop()
      await controller.stop()
    }
  })

  it('authenticates and selects a new Gemini CLI subscription through the official CLI handoff', async () => {
    const current = detail()
    const initial = modelSnapshot()
    const geminiProfile = {
      id: 'gemini-cli-subscription',
      accountId: 'account:gemini-cli-subscription',
      name: 'Gemini CLI 订阅（API）',
      presetSource: 'gemini-cli-subscription',
      kind: 'gemini-cli-api' as const,
      authType: 'subscription' as const,
      endpointFormat: 'custom_endpoint' as const,
      configured: true,
      models: ['gemini-3.1-pro-preview', 'gemini-3-flash-preview'],
      selectedModel: 'gemini-3.1-pro-preview'
    }
    const connected: ModelConnectionSnapshot = {
      ...initial,
      revision: initial.revision + 1,
      providers: [...initial.providers, geminiProfile],
      defaultProviderId: geminiProfile.id,
      defaultAccountId: geminiProfile.accountId,
      defaultModel: geminiProfile.selectedModel
    }
    const completeModelCliAuth = vi.fn(async () => connected)
    const authenticateOfficialProvider = vi.fn(async () => undefined)
    const client = {
      listThreads: vi.fn(async () => [current]),
      getThread: vi.fn(async () => current),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      skills: vi.fn(async () => ({ enabled: true, roots: [], skills: [], validationErrors: [] })),
      modelConnections: vi.fn(async () => initial),
      completeModelCliAuth
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options, runtime)
    await controller.start()
    controller.applyModelSelection(initial, false)
    const input = Object.assign(new EventEmitter(), {
      isRaw: false, setRawMode: vi.fn(), setEncoding: vi.fn(), resume: vi.fn(), pause: vi.fn()
    }) as unknown as TerminalInput
    let outputText = ''
    const output = Object.assign(new EventEmitter(), {
      columns: 92, rows: 28, write: (chunk: string) => { outputText += chunk }
    }) as unknown as TerminalOutput
    const app = new PiTuiApplication(
      controller,
      input,
      output,
      undefined,
      async () => null,
      authenticateOfficialProvider
    )
    const running = app.run()
    try {
      type(input, '/connect')
      await waitFor(() => sanitizeTerminalText(outputText).includes('KUN / Connect'))
      input.emit('data', '\r')
      await waitFor(() => outputText.includes('Add provider'))
      type(input, 'gemini-cli-subscription')

      await waitFor(() => completeModelCliAuth.mock.calls.length === 1)
      expect(authenticateOfficialProvider).toHaveBeenCalledWith('gemini-cli')
      expect(completeModelCliAuth).toHaveBeenCalledWith({
        expectedRevision: initial.revision,
        provider: 'gemini-cli',
        model: 'gemini-3.1-pro-preview',
        select: true
      })
      await waitFor(() =>
        controller.state.modelConnections?.defaultProviderId === 'gemini-cli-subscription'
      )
    } finally {
      controller.requestQuit()
      await running
      await app.stop()
      await controller.stop()
    }
  })

  it('keeps the existing default when Gemini CLI reconnect is cancelled', async () => {
    const current = detail()
    const initialBase = modelSnapshot()
    const initial: ModelConnectionSnapshot = {
      ...initialBase,
      providers: [...initialBase.providers, {
        id: 'gemini-cli-subscription',
        accountId: 'account:gemini-cli-subscription',
        name: 'Gemini CLI 订阅（API）',
        presetSource: 'gemini-cli-subscription',
        kind: 'gemini-cli-api',
        authType: 'subscription',
        endpointFormat: 'custom_endpoint',
        configured: true,
        models: ['gemini-3.1-pro-preview'],
        selectedModel: 'gemini-3.1-pro-preview'
      }]
    }
    const completeModelCliAuth = vi.fn()
    const authenticateOfficialProvider = vi.fn(async () => {
      throw new Error('Google login cancelled')
    })
    const client = {
      listThreads: vi.fn(async () => [current]),
      getThread: vi.fn(async () => current),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      skills: vi.fn(async () => ({ enabled: true, roots: [], skills: [], validationErrors: [] })),
      modelConnections: vi.fn(async () => initial),
      completeModelCliAuth
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options, runtime)
    await controller.start()
    controller.applyModelSelection(initial, false)
    const input = Object.assign(new EventEmitter(), {
      isRaw: false, setRawMode: vi.fn(), setEncoding: vi.fn(), resume: vi.fn(), pause: vi.fn()
    }) as unknown as TerminalInput
    let outputText = ''
    const output = Object.assign(new EventEmitter(), {
      columns: 92, rows: 28, write: (chunk: string) => { outputText += chunk }
    }) as unknown as TerminalOutput
    const app = new PiTuiApplication(
      controller,
      input,
      output,
      undefined,
      async () => null,
      authenticateOfficialProvider
    )
    const running = app.run()
    try {
      type(input, '/connect')
      await waitFor(() => sanitizeTerminalText(outputText).includes('KUN / Connect'))
      input.emit('data', '\x1b[F')
      input.emit('data', '\r')
      await waitFor(() => outputText.includes('Sign in again / reconnect'))
      input.emit('data', '\x1b[B')
      input.emit('data', '\r')

      await waitFor(() => outputText.includes('Google login cancelled'))
      expect(authenticateOfficialProvider).toHaveBeenCalledWith('gemini-cli')
      expect(completeModelCliAuth).not.toHaveBeenCalled()
      expect(controller.state.modelConnections?.defaultProviderId).toBe('deepseek')
      expect(controller.state.modelConnections?.defaultModel).toBe('deepseek-v4-pro')
    } finally {
      controller.requestQuit()
      await running
      await app.stop()
      await controller.stop()
    }
  })

  it('maps every shared catalog authentication flow to an implemented TUI strategy', () => {
    const strategies = new Map(
      providerCatalogEntries().map((entry) => [
        entry.authFlow,
        authenticationStrategy(entry.authFlow)
      ])
    )

    expect(strategies).toEqual(new Map([
      ['api-key', 'secret'],
      ['chatgpt-oauth', 'runtime'],
      ['grok-oauth', 'runtime'],
      ['claude-subscription', 'runtime'],
      ['gemini-subscription', 'official-cli'],
      ['gemini-cli-subscription', 'official-cli'],
      ['cursor-api-key', 'secret']
    ]))
  })

  it('creates a custom provider from the explicit /connect entry and publishes it to /model', async () => {
    const current = detail()
    const initial = modelSnapshot()
    const connected: ModelConnectionSnapshot = {
      ...initial,
      revision: initial.revision + 1,
      providers: [...initial.providers, {
        id: 'acme-proxy',
        accountId: 'account:acme-proxy',
        name: 'Acme Proxy',
        kind: 'http',
        authType: 'api-key',
        baseUrl: 'https://models.acme.test/v1',
        endpointFormat: 'responses',
        configured: true,
        models: ['acme-fast', 'acme-reasoning'],
        selectedModel: 'acme-fast'
      }],
      defaultProviderId: 'acme-proxy',
      defaultAccountId: 'account:acme-proxy',
      defaultModel: 'acme-fast'
    }
    const connectModel = vi.fn(async () => connected)
    const client = {
      listThreads: vi.fn(async () => [current]),
      getThread: vi.fn(async () => current),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      skills: vi.fn(async () => ({ enabled: true, roots: [], skills: [], validationErrors: [] })),
      modelConnections: vi.fn(async () => initial),
      connectModel
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options, runtime)
    await controller.start()
    controller.applyModelSelection(initial, false)
    const input = Object.assign(new EventEmitter(), {
      isRaw: false, setRawMode: vi.fn(), setEncoding: vi.fn(), resume: vi.fn(), pause: vi.fn()
    }) as unknown as TerminalInput
    let outputText = ''
    const output = Object.assign(new EventEmitter(), {
      columns: 88, rows: 26, write: (chunk: string) => { outputText += chunk }
    }) as unknown as TerminalOutput
    const app = new PiTuiApplication(controller, input, output)
    const running = app.run()
    const replaceField = (value: string): void => {
      input.emit('data', '\x15')
      type(input, value)
    }
    try {
      type(input, '/connect')
      await waitFor(() => outputText.includes('Add a provider'))
      input.emit('data', '\r')
      await waitFor(() => outputText.includes('Custom provider'))
      input.emit('data', '\r')
      await waitFor(() => outputText.includes('Provider ID'))

      replaceField('acme proxy')
      await waitFor(() => outputText.includes('Provider name'))
      replaceField('Acme Proxy')
      await waitFor(() => outputText.includes('Base URL'))
      replaceField('https://models.acme.test/v1')
      await waitFor(() => outputText.includes('Endpoint format'))
      input.emit('data', '\x1b[C') // responses
      input.emit('data', '\r')
      await waitFor(() => outputText.includes('API key / token plan key'))
      type(input, 'top-secret-provider-key')
      await waitFor(() => outputText.includes('Models (comma separated)'))
      type(input, 'acme-fast, acme-reasoning')

      await waitFor(() => connectModel.mock.calls.length === 1)
      expect(connectModel).toHaveBeenCalledWith({
        expectedRevision: initial.revision,
        id: 'acme-proxy',
        name: 'Acme Proxy',
        kind: 'http',
        authType: 'api-key',
        baseUrl: 'https://models.acme.test/v1',
        endpointFormat: 'responses',
        credential: 'top-secret-provider-key',
        models: ['acme-fast', 'acme-reasoning'],
        selectedModel: 'acme-fast',
        probe: true,
        select: true
      })
      await waitFor(() => controller.state.modelConnections?.defaultProviderId === 'acme-proxy')
      expect(outputText).not.toContain('top-secret-provider-key')

      const beforeModels = outputText.length
      type(input, '/model')
      await waitFor(() => outputText.slice(beforeModels).includes('Acme Proxy'))
      const modelFrame = outputText.slice(beforeModels)
      expect(modelFrame).toContain('acme-fast')
      expect(modelFrame).toContain('acme-reasoning')
      expect(modelFrame).toContain('current')
    } finally {
      controller.requestQuit()
      await running
      await app.stop()
      await controller.stop()
    }
  })

  it('keeps a failed custom probe in the wizard and requires explicit confirmation to save supplied models', async () => {
    const current = detail()
    const initial = modelSnapshot()
    const connected: ModelConnectionSnapshot = {
      ...initial,
      revision: initial.revision + 1,
      providers: [...initial.providers, {
        id: 'offline-proxy',
        accountId: 'account:offline-proxy',
        name: 'Offline Proxy',
        kind: 'http',
        authType: 'api-key',
        baseUrl: 'https://offline.example.test/v1',
        endpointFormat: 'chat_completions',
        configured: true,
        models: ['offline-model'],
        selectedModel: 'offline-model'
      }],
      defaultProviderId: 'offline-proxy',
      defaultAccountId: 'account:offline-proxy',
      defaultModel: 'offline-model'
    }
    const connectModel = vi.fn()
      .mockRejectedValueOnce(new Error('provider probe failed with HTTP 404'))
      .mockResolvedValueOnce(connected)
    const client = {
      listThreads: vi.fn(async () => [current]),
      getThread: vi.fn(async () => current),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      skills: vi.fn(async () => ({ enabled: true, roots: [], skills: [], validationErrors: [] })),
      modelConnections: vi.fn(async () => initial),
      connectModel
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options, runtime)
    await controller.start()
    controller.applyModelSelection(initial, false)
    const input = Object.assign(new EventEmitter(), {
      isRaw: false, setRawMode: vi.fn(), setEncoding: vi.fn(), resume: vi.fn(), pause: vi.fn()
    }) as unknown as TerminalInput
    let outputText = ''
    const output = Object.assign(new EventEmitter(), {
      columns: 84, rows: 24, write: (chunk: string) => { outputText += chunk }
    }) as unknown as TerminalOutput
    const app = new PiTuiApplication(controller, input, output)
    const running = app.run()
    const replaceField = (value: string): void => {
      input.emit('data', '\x15')
      type(input, value)
    }
    try {
      type(input, '/connect')
      await waitFor(() => sanitizeTerminalText(outputText).includes('KUN / Connect'))
      input.emit('data', '\r')
      await waitFor(() => outputText.includes('Custom provider'))
      input.emit('data', '\r')
      await waitFor(() => outputText.includes('Provider ID'))
      replaceField('offline-proxy')
      replaceField('Offline Proxy')
      replaceField('https://offline.example.test/v1')
      input.emit('data', '\r') // keep chat_completions
      type(input, 'offline-secret')
      type(input, 'offline-model')

      await waitFor(() => outputText.includes('Probe failed'))
      expect(connectModel).toHaveBeenCalledTimes(1)
      expect(connectModel.mock.calls[0]?.[0]).toMatchObject({ probe: true })
      expect(controller.state.modelConnections?.providers.some((profile) => profile.id === 'offline-proxy')).toBe(false)
      expect(outputText).not.toContain('offline-secret')

      input.emit('data', '\x13') // Ctrl+S explicitly accepts the supplied catalog.
      await waitFor(() => connectModel.mock.calls.length === 2)
      expect(connectModel.mock.calls[1]?.[0]).toMatchObject({
        id: 'offline-proxy',
        credential: 'offline-secret',
        models: ['offline-model'],
        probe: false
      })
      await waitFor(() => controller.state.modelConnections?.defaultProviderId === 'offline-proxy')
      expect(outputText).not.toContain('offline-secret')
    } finally {
      controller.requestQuit()
      await running
      await app.stop()
      await controller.stop()
    }
  })

  it('refreshes the custom-provider wizard on a concurrent connection revision conflict', async () => {
    const current = detail()
    const initial = modelSnapshot()
    const latest: ModelConnectionSnapshot = {
      ...initial,
      revision: initial.revision + 1,
      providers: [...initial.providers, {
        id: 'external-provider',
        accountId: 'account:external-provider',
        name: 'External Provider',
        kind: 'http',
        authType: 'api-key',
        baseUrl: 'https://external.example.test/v1',
        endpointFormat: 'chat_completions',
        configured: true,
        models: ['external-model'],
        selectedModel: 'external-model'
      }]
    }
    const modelConnections = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(latest)
    const connectModel = vi.fn(async () => {
      throw new TuiClientError(
        'model connection registry revision changed',
        409,
        'revision_conflict',
        '/v1/model-connections'
      )
    })
    const client = {
      listThreads: vi.fn(async () => [current]),
      getThread: vi.fn(async () => current),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      skills: vi.fn(async () => ({ enabled: true, roots: [], skills: [], validationErrors: [] })),
      modelConnections,
      connectModel
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options, runtime)
    await controller.start()
    controller.applyModelSelection(initial, false)
    const input = Object.assign(new EventEmitter(), {
      isRaw: false, setRawMode: vi.fn(), setEncoding: vi.fn(), resume: vi.fn(), pause: vi.fn()
    }) as unknown as TerminalInput
    let outputText = ''
    const output = Object.assign(new EventEmitter(), {
      columns: 88, rows: 26, write: (chunk: string) => { outputText += chunk }
    }) as unknown as TerminalOutput
    const app = new PiTuiApplication(controller, input, output)
    const running = app.run()
    const replaceField = (value: string): void => {
      input.emit('data', '\x15')
      type(input, value)
    }
    try {
      type(input, '/connect')
      await waitFor(() => sanitizeTerminalText(outputText).includes('KUN / Connect'))
      input.emit('data', '\r')
      input.emit('data', '\r')
      await waitFor(() => outputText.includes('Provider ID'))
      replaceField('conflicting-provider')
      replaceField('Conflicting Provider')
      replaceField('https://conflict.example.test/v1')
      input.emit('data', '\r')
      type(input, 'conflict-secret')
      type(input, 'conflict-model')

      await waitFor(() => outputText.includes('Connections changed in another client'))
      expect(modelConnections).toHaveBeenCalledTimes(2)
      expect(controller.state.modelConnections?.revision).toBe(latest.revision)
      expect(controller.state.modelConnections?.providers.some((profile) => profile.id === 'external-provider')).toBe(true)
      expect(outputText).not.toContain('External Provider')
      expect(outputText).not.toContain('conflict-secret')
      expect(connectModel).toHaveBeenCalledTimes(1)
    } finally {
      controller.requestQuit()
      await running
      await app.stop()
      await controller.stop()
    }
  })

  it('shows unconfigured GUI catalogs in /model but requires /connect before selection', async () => {
    const current = detail()
    const catalog: ModelConnectionSnapshot = {
      ...modelSnapshot(),
      providers: [...modelSnapshot().providers, {
        id: 'zenmux', accountId: 'account:zenmux', name: 'ZenMux', kind: 'http',
        authType: 'api-key', baseUrl: 'https://zenmux.ai/api/v1',
        endpointFormat: 'chat_completions', configured: false,
        models: ['future-model'], selectedModel: 'future-model'
      }]
    }
    const selectModel = vi.fn()
    const client = {
      listThreads: vi.fn(async () => [current]),
      getThread: vi.fn(async () => current),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      skills: vi.fn(async () => ({ enabled: true, roots: [], skills: [], validationErrors: [] })),
      modelConnections: vi.fn(async () => catalog),
      selectModel
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options, runtime)
    await controller.start()
    controller.applyModelSelection(catalog, false)
    const input = Object.assign(new EventEmitter(), {
      isRaw: false, setRawMode: vi.fn(), setEncoding: vi.fn(), resume: vi.fn(), pause: vi.fn()
    }) as unknown as TerminalInput
    let outputText = ''
    const output = Object.assign(new EventEmitter(), {
      columns: 80, rows: 24, write: (chunk: string) => { outputText += chunk }
    }) as unknown as TerminalOutput
    const app = new PiTuiApplication(controller, input, output)
    const running = app.run()
    try {
      type(input, '/model')
      await waitFor(() => outputText.includes('ZenMux') && outputText.includes('future-model'))
      const before = outputText.length
      for (const character of 'zenmux') input.emit('data', character)
      input.emit('data', '\r')
      await waitFor(() => outputText.slice(before).includes('Run /connect'))
      expect(selectModel).not.toHaveBeenCalled()
    } finally {
      controller.requestQuit()
      await running
      await app.stop()
      await controller.stop()
    }
  })

  it('applies configured semantic keys inside session and model selectors', async () => {
    let current = detail()
    const updateThread = vi.fn(async (_id: string, patch: Partial<ThreadDetail>) => {
      current = { ...current, ...patch }
      return current
    })
    const catalog = modelSnapshot()
    const client = {
      listThreads: vi.fn(async () => [current]),
      getThread: vi.fn(async () => current),
      updateThread,
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      skills: vi.fn(async () => ({ enabled: true, roots: [], skills: [], validationErrors: [] })),
      modelConnections: vi.fn(async () => catalog)
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options, runtime)
    await controller.start()
    controller.applyModelSelection(catalog, false)
    const input = Object.assign(new EventEmitter(), {
      isRaw: false, setRawMode: vi.fn(), setEncoding: vi.fn(), resume: vi.fn(), pause: vi.fn()
    }) as unknown as TerminalInput
    let outputText = ''
    const output = Object.assign(new EventEmitter(), {
      columns: 72, rows: 22, write: (chunk: string) => { outputText += chunk }
    }) as unknown as TerminalOutput
    const keymap = parseTuiKeymapConfig({ keybinds: {
      session_pin: 'f3', session_delete: 'none',
      model_provider_list: 'f4', model_favorite_toggle: 'none'
    } }).keymap
    const app = new PiTuiApplication(controller, input, output, keymap)
    const running = app.run()
    try {
      input.emit('data', '\x18')
      input.emit('data', 'l')
      await waitFor(() => outputText.includes('Sessions'))
      input.emit('data', '\x1bOR') // F3
      await waitFor(() => updateThread.mock.calls.length === 1)
      expect(updateThread).toHaveBeenCalledWith('thr_pi', { pinned: true })
      input.emit('data', '\x1b')

      type(input, '/model')
      await waitFor(() => outputText.includes('Kimi Code'))
      const before = outputText.length
      input.emit('data', '\x1bOS') // F4
      await waitFor(() => outputText.slice(before).includes('Providers & accounts'))
      expect(sanitizeTerminalText(outputText.slice(before))).toContain('F4 all models')
      input.emit('data', '\x1b')
    } finally {
      controller.requestQuit()
      await running
      await app.stop()
      await controller.stop()
    }
  })

  it('resolves approval and structured user-input dialogs and returns focus to the composer', async () => {
    const current = detail()
    let onEvent: ((event: RuntimeEvent) => void) | undefined
    const decideApproval = vi.fn(async () => ({ approvalId: 'approval_pi', status: 'allowed' }))
    const resolveUserInput = vi.fn(async () => ({ inputId: 'input_pi', status: 'submitted' }))
    const startTurn = vi.fn(async () => ({ turnId: 'turn_after_dialogs' }))
    const client = {
      listThreads: vi.fn(async () => [current]),
      getThread: vi.fn(async () => current),
      subscribeThreadEvents: vi.fn(async (input: {
        signal: AbortSignal
        onEvent: (event: RuntimeEvent) => void
      }) => {
        onEvent = input.onEvent
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      skills: vi.fn(async () => ({ enabled: true, roots: [], skills: [], validationErrors: [] })),
      decideApproval,
      resolveUserInput,
      startTurn
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options, runtime)
    await controller.start()

    const input = Object.assign(new EventEmitter(), {
      isRaw: false, setRawMode: vi.fn(), setEncoding: vi.fn(), resume: vi.fn(), pause: vi.fn()
    }) as unknown as TerminalInput
    let outputText = ''
    const output = Object.assign(new EventEmitter(), {
      columns: 48, rows: 18, write: (chunk: string) => { outputText += chunk }
    }) as unknown as TerminalOutput
    const app = new PiTuiApplication(controller, input, output)
    const running = app.run()
    const eventBase = {
      timestamp: '2026-07-22T00:03:00.000Z', threadId: current.id, turnId: 'turn_gate'
    }
    try {
      onEvent?.({
        ...eventBase, kind: 'approval_requested', seq: 1, approvalId: 'approval_pi',
        toolName: 'bash', status: 'pending', summary: 'Run the focused tests'
      })
      await waitFor(() => outputText.includes('Approval required') && outputText.includes('Run the focused tests'))
      input.emit('data', 'y')
      await waitFor(() => decideApproval.mock.calls.length === 1)
      expect(decideApproval).toHaveBeenCalledWith('approval_pi', 'allow')
      onEvent?.({
        ...eventBase, kind: 'approval_resolved', seq: 2, approvalId: 'approval_pi',
        toolName: 'bash', status: 'allowed', summary: 'Run the focused tests'
      })
      await waitFor(() => controller.state.projection?.pendingApproval === undefined)

      const beforeInput = outputText.length
      onEvent?.({
        ...eventBase, kind: 'user_input_requested', seq: 3, inputId: 'input_pi', status: 'pending',
        prompt: 'Choose a release channel',
        questions: [{
          id: 'channel', header: 'Release channel', question: 'Where should Kun publish?',
          options: [
            { label: 'Preview', description: 'Internal testers' },
            { label: 'Stable', description: 'All users' }
          ]
        }]
      })
      await waitFor(() => outputText.slice(beforeInput).includes('Release channel'))
      input.emit('data', '\x0e') // Ctrl+N selects the next option inside the modal.
      input.emit('data', '\r')
      await waitFor(() => resolveUserInput.mock.calls.length === 1)
      expect(resolveUserInput).toHaveBeenCalledWith('input_pi', [{
        id: 'channel', label: 'Stable', value: 'Stable'
      }])
      onEvent?.({
        ...eventBase, kind: 'user_input_resolved', seq: 4, inputId: 'input_pi', status: 'submitted',
        answers: [{ id: 'channel', label: 'Stable', value: 'Stable' }]
      })
      await waitFor(() => controller.state.projection?.pendingUserInput === undefined)

      type(input, 'composer focus restored')
      await waitFor(() => startTurn.mock.calls.length === 1)
      expect(startTurn).toHaveBeenCalledWith('thr_pi', expect.objectContaining({ prompt: 'composer focus restored' }))
    } finally {
      controller.requestQuit()
      await running
      await app.stop()
      await controller.stop()
    }
  })

  it('opens the current draft with Ctrl+G, restores terminal ownership, and keeps the edited result', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kun-pi-editor-'))
    const script = join(directory, 'editor.mjs')
    await writeFile(script, "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], 'edited draft\\n')\n")
    vi.stubEnv('EDITOR', `"${process.execPath}" "${script}"`)

    const current = detail()
    const startTurn = vi.fn(async () => ({ turnId: 'turn_edited' }))
    const client = {
      listThreads: vi.fn(async () => [current]),
      getThread: vi.fn(async () => current),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      skills: vi.fn(async () => ({ enabled: true, roots: [], skills: [], validationErrors: [] })),
      startTurn
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options, runtime)
    await controller.start()

    const rawModes: boolean[] = []
    const input = Object.assign(new EventEmitter(), {
      isRaw: false,
      setRawMode: vi.fn((mode: boolean) => { rawModes.push(mode) }),
      setEncoding: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn()
    }) as unknown as TerminalInput
    let outputText = ''
    const output = Object.assign(new EventEmitter(), {
      columns: 60,
      rows: 20,
      write: (chunk: string) => { outputText += chunk }
    }) as unknown as TerminalOutput
    const app = new PiTuiApplication(controller, input, output)
    const running = app.run()
    try {
      for (const character of 'seed') input.emit('data', character)
      input.emit('data', '\x07')
      await waitFor(() => outputText.includes('edited draft'))
      expect(rawModes).toEqual(expect.arrayContaining([true, false]))
      const releasedAt = rawModes.indexOf(false)
      expect(rawModes.slice(releasedAt + 1)).toContain(true)

      input.emit('data', '\r')
      await waitFor(() => startTurn.mock.calls.length === 1)
      expect(startTurn).toHaveBeenCalledWith('thr_pi', expect.objectContaining({ prompt: 'edited draft' }))
    } finally {
      controller.requestQuit()
      await running
      await app.stop()
      await controller.stop()
      vi.unstubAllEnvs()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('requires a matching second Ctrl+C or Ctrl+D to exit and disarms on other input', async () => {
    const current = detail()
    const client = {
      listThreads: vi.fn(async () => [current]),
      getThread: vi.fn(async () => current),
      subscribeThreadEvents: vi.fn(async (input: {
        signal: AbortSignal
        onConnection: (state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected') => void
      }) => {
        input.onConnection('connected')
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      skills: vi.fn(async () => ({ enabled: true, roots: [], skills: [], validationErrors: [] }))
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options, runtime)
    await controller.start()
    const input = Object.assign(new EventEmitter(), {
      isRaw: false, setRawMode: vi.fn(), setEncoding: vi.fn(), resume: vi.fn(), pause: vi.fn()
    }) as unknown as TerminalInput
    let outputText = ''
    const output = Object.assign(new EventEmitter(), {
      columns: 72, rows: 22, write: (chunk: string) => { outputText += chunk }
    }) as unknown as TerminalOutput
    const app = new PiTuiApplication(controller, input, output)
    const running = app.run()
    try {
      input.emit('data', '\x03')
      await waitFor(() => outputText.includes('Press Ctrl+C again to exit'))
      expect(controller.state.quitRequested).toBe(false)

      input.emit('data', 'x')
      input.emit('data', '\x03') // Non-empty Ctrl+C clears the draft.
      expect(controller.state.quitRequested).toBe(false)

      input.emit('data', '\x04')
      await waitFor(() => outputText.includes('Press Ctrl+D again to exit'))
      expect(controller.state.quitRequested).toBe(false)
      input.emit('data', '\x04')
      await running
      expect(controller.state.quitRequested).toBe(true)
    } finally {
      controller.requestQuit()
      await app.stop()
      await controller.stop()
    }
  })

  it('uses consecutive idle Escape for safe undo and Ctrl+O for tool details', async () => {
    const current = detail()
    const client = {
      listThreads: vi.fn(async () => [current]),
      getThread: vi.fn(async () => current),
      subscribeThreadEvents: vi.fn(async (input: {
        signal: AbortSignal
        onConnection: (state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected') => void
      }) => {
        input.onConnection('connected')
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      skills: vi.fn(async () => ({ enabled: true, roots: [], skills: [], validationErrors: [] }))
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options, runtime)
    await controller.start()
    const undo = vi.spyOn(controller, 'undoLastTurn').mockResolvedValue()
    const input = Object.assign(new EventEmitter(), {
      isRaw: false, setRawMode: vi.fn(), setEncoding: vi.fn(), resume: vi.fn(), pause: vi.fn()
    }) as unknown as TerminalInput
    let outputText = ''
    const output = Object.assign(new EventEmitter(), {
      columns: 72, rows: 22, write: (chunk: string) => { outputText += chunk }
    }) as unknown as TerminalOutput
    const app = new PiTuiApplication(controller, input, output)
    const running = app.run()
    try {
      input.emit('data', '\x1b')
      await waitFor(() => outputText.includes('Press Esc again to undo the last turn'))
      expect(undo).not.toHaveBeenCalled()
      input.emit('data', '\x1b')
      await waitFor(() => undo.mock.calls.length === 1)

      input.emit('data', '\x0f')
      await waitFor(() => outputText.includes('Tool details expanded'))
    } finally {
      controller.requestQuit()
      await running
      await app.stop()
      await controller.stop()
    }
  })

  it('uses contextual Ctrl+B to background the latest foreground subagent', async () => {
    const current = detail()
    const childRun = {
      id: 'child_foreground',
      parentThreadId: current.id,
      parentTurnId: 'turn_parent',
      label: 'Inspect runtime',
      prompt: 'Inspect the runtime',
      profile: 'researcher',
      status: 'running' as const,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      createdAt: current.createdAt,
      startedAt: current.createdAt,
      updatedAt: current.updatedAt
    }
    const detachDelegation = vi.fn(async () => ({ childId: childRun.id, detached: true }))
    const client = {
      listThreads: vi.fn(async () => [current]),
      getThread: vi.fn(async () => current),
      delegationDiagnostics: vi.fn(async () => ({
        enabled: true,
        active: 1,
        childRuns: [childRun],
        aggregates: []
      })),
      detachDelegation,
      subscribeThreadEvents: vi.fn(async (input: {
        signal: AbortSignal
        onConnection: (state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected') => void
      }) => {
        input.onConnection('connected')
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      skills: vi.fn(async () => ({ enabled: true, roots: [], skills: [], validationErrors: [] }))
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options, runtime)
    await controller.start()
    const input = Object.assign(new EventEmitter(), {
      isRaw: false, setRawMode: vi.fn(), setEncoding: vi.fn(), resume: vi.fn(), pause: vi.fn()
    }) as unknown as TerminalInput
    let outputText = ''
    const output = Object.assign(new EventEmitter(), {
      columns: 88, rows: 24, write: (chunk: string) => { outputText += chunk }
    }) as unknown as TerminalOutput
    const app = new PiTuiApplication(controller, input, output)
    const running = app.run()
    try {
      input.emit('data', '\x02')
      await waitFor(() => detachDelegation.mock.calls.length === 1)
      expect(detachDelegation).toHaveBeenCalledWith(childRun.id)
      await waitFor(() => controller.state.notification?.message.includes('continuing in the background') === true)
    } finally {
      controller.requestQuit()
      await running
      await app.stop()
      await controller.stop()
    }
  })

  it('sends a non-empty Ctrl+S draft through the running-turn steering queue', async () => {
    const current = detail()
    current.status = 'running'
    current.turns = [{
      id: 'turn_running',
      threadId: current.id,
      status: 'running',
      orchestration: 'direct',
      prompt: 'initial task',
      steering: [],
      createdAt: current.createdAt,
      startedAt: current.createdAt,
      attachmentIds: [],
      activeSkillIds: [],
      injectedMemoryIds: [],
      injectedMemorySummaries: [],
      injectedInstructionSources: [],
      items: []
    }]
    const steerTurn = vi.fn(async () => undefined)
    const client = {
      listThreads: vi.fn(async () => [current]),
      getThread: vi.fn(async () => current),
      steerTurn,
      subscribeThreadEvents: vi.fn(async (input: {
        signal: AbortSignal
        onConnection: (state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected') => void
      }) => {
        input.onConnection('connected')
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      skills: vi.fn(async () => ({ enabled: true, roots: [], skills: [], validationErrors: [] }))
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options, runtime)
    await controller.start()
    const input = Object.assign(new EventEmitter(), {
      isRaw: false, setRawMode: vi.fn(), setEncoding: vi.fn(), resume: vi.fn(), pause: vi.fn()
    }) as unknown as TerminalInput
    const output = Object.assign(new EventEmitter(), {
      columns: 80, rows: 24, write: vi.fn()
    }) as unknown as TerminalOutput
    const app = new PiTuiApplication(controller, input, output)
    const running = app.run()
    try {
      for (const character of 'focus on the failing test') input.emit('data', character)
      input.emit('data', '\x13')
      await waitFor(() => steerTurn.mock.calls.length === 1)
      expect(steerTurn).toHaveBeenCalledWith('thr_pi', 'turn_running', 'focus on the failing test')
    } finally {
      controller.requestQuit()
      await running
      await app.stop()
      await controller.stop()
    }
  })

  it('treats empty Ctrl+C like Escape while a turn is running', async () => {
    const current = detail()
    current.status = 'running'
    current.turns = [{
      id: 'turn_running',
      threadId: current.id,
      status: 'running',
      orchestration: 'direct',
      prompt: 'initial task',
      steering: [],
      createdAt: current.createdAt,
      startedAt: current.createdAt,
      attachmentIds: [],
      activeSkillIds: [],
      injectedMemoryIds: [],
      injectedMemorySummaries: [],
      injectedInstructionSources: [],
      items: []
    }]
    const interruptTurn = vi.fn(async () => undefined)
    const client = {
      listThreads: vi.fn(async () => [current]),
      getThread: vi.fn(async () => current),
      interruptTurn,
      subscribeThreadEvents: vi.fn(async (input: {
        signal: AbortSignal
        onConnection: (state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected') => void
      }) => {
        input.onConnection('connected')
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      skills: vi.fn(async () => ({ enabled: true, roots: [], skills: [], validationErrors: [] }))
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options, runtime)
    await controller.start()
    const input = Object.assign(new EventEmitter(), {
      isRaw: false, setRawMode: vi.fn(), setEncoding: vi.fn(), resume: vi.fn(), pause: vi.fn()
    }) as unknown as TerminalInput
    const output = Object.assign(new EventEmitter(), {
      columns: 80, rows: 24, write: vi.fn()
    }) as unknown as TerminalOutput
    const app = new PiTuiApplication(controller, input, output)
    const running = app.run()
    try {
      input.emit('data', '\x03')
      await waitFor(() => interruptTurn.mock.calls.length === 1)
      expect(interruptTurn).toHaveBeenCalledWith('thr_pi', 'turn_running')
      expect(controller.state.quitRequested).toBe(false)
    } finally {
      controller.requestQuit()
      await running
      await app.stop()
      await controller.stop()
    }
  })

  it('opens a selected live timeline turn and exports the authoritative transcript', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kun-pi-export-'))
    const exportPath = join(directory, 'thread.md')
    const current = detail()
    current.turns = [{
      id: 'turn_live', threadId: current.id, status: 'completed', orchestration: 'direct', prompt: 'inspect live state', steering: [],
      createdAt: current.createdAt, finishedAt: current.updatedAt, attachmentIds: [], activeSkillIds: [],
      injectedMemoryIds: [], injectedMemorySummaries: [], injectedInstructionSources: [],
      items: [{
        id: 'item_user', turnId: 'turn_live', threadId: current.id, role: 'user', status: 'completed',
        createdAt: current.createdAt, kind: 'user_message', text: 'inspect live state'
      }, {
        id: 'item_assistant', turnId: 'turn_live', threadId: current.id, role: 'assistant', status: 'completed',
        createdAt: current.createdAt, kind: 'assistant_text', text: 'live answer'
      }]
    }]
    const client = {
      listThreads: vi.fn(async () => [current]),
      getThread: vi.fn(async () => current),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      skills: vi.fn(async () => ({ enabled: true, roots: [], skills: [], validationErrors: [] }))
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options, runtime)
    await controller.start()

    const input = Object.assign(new EventEmitter(), {
      isRaw: false, setRawMode: vi.fn(), setEncoding: vi.fn(), resume: vi.fn(), pause: vi.fn()
    }) as unknown as TerminalInput
    let outputText = ''
    const output = Object.assign(new EventEmitter(), {
      columns: 60, rows: 20, write: (chunk: string) => { outputText += chunk }
    }) as unknown as TerminalOutput
    const app = new PiTuiApplication(controller, input, output)
    const running = app.run()
    try {
      type(input, '/jump 1')
      await waitFor(() => outputText.includes('Timeline') && outputText.includes('inspect live state'))
      input.emit('data', '\x1b')

      type(input, `/export ${exportPath}`)
      await vi.waitFor(async () => {
        expect(await readFile(exportPath, 'utf8')).toContain('live answer')
      })
    } finally {
      controller.requestQuit()
      await running
      await app.stop()
      await controller.stop()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

function type(input: EventEmitter, text: string): void {
  for (const character of text) input.emit('data', character)
  input.emit('data', '\r')
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for TUI output')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
