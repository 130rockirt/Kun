import { describe, expect, it, vi } from 'vitest'
import type { ThreadStore } from '../src/ports/thread-store.js'
import type { RuntimeEventRecorder } from '../src/services/runtime-event-recorder.js'
import {
  BACKGROUND_SHELL_UPDATE_CHECKPOINT_INTERVAL_MS,
  BackgroundShellRuntime,
  MAX_BACKGROUND_SHELL_SESSIONS
} from '../src/services/background-shell-runtime.js'
import type { TurnService } from '../src/services/turn-service.js'

describe('BackgroundShellRuntime', () => {
  it('coalesces high-frequency durable updates, flushes a trailing checkpoint, and keeps terminal immediate', async () => {
    vi.useFakeTimers()
    const recordEvent = vi.fn(async (_event: Record<string, unknown>) => undefined)
    const runtime = new BackgroundShellRuntime({
      events: { record: recordEvent } as unknown as RuntimeEventRecorder,
      threadStore: {} as ThreadStore,
      turns: {} as TurnService,
      nowIso: () => '2026-01-01T00:00:00.000Z'
    })
    const hooks = runtime.bashHooks()
    const running = {
      id: 'checkpoint1',
      threadId: 'thr_1',
      turnId: 'turn_1',
      command: 'generate-output',
      cwd: '/tmp',
      shell: 'bash',
      status: 'running' as const,
      startedAt: '2026-01-01T00:00:00.000Z',
      exitCode: null,
      output: '',
      detached: false
    }

    try {
      await hooks.onSessionStarted?.(running)
      for (let index = 0; index < 100; index += 1) {
        await hooks.onSessionUpdated?.({ ...running, output: `burst-one-${index}` })
      }

      expect(recordEvent.mock.calls.filter(([event]) => event.kind === 'bash_session_updated')).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(BACKGROUND_SHELL_UPDATE_CHECKPOINT_INTERVAL_MS)
      expect(recordEvent.mock.calls.filter(([event]) => event.kind === 'bash_session_updated')).toHaveLength(1)
      expect(recordEvent).toHaveBeenLastCalledWith(expect.objectContaining({
        kind: 'bash_session_updated',
        output: 'burst-one-99'
      }))

      for (let index = 0; index < 100; index += 1) {
        await hooks.onSessionUpdated?.({ ...running, output: `burst-two-${index}` })
      }
      await vi.advanceTimersByTimeAsync(BACKGROUND_SHELL_UPDATE_CHECKPOINT_INTERVAL_MS - 1)
      expect(recordEvent.mock.calls.filter(([event]) => event.kind === 'bash_session_updated')).toHaveLength(1)
      // Even though output is now silent, the trailing timer persists the
      // latest liveness/output checkpoint at the end of the throttle window.
      await vi.advanceTimersByTimeAsync(1)
      expect(recordEvent.mock.calls.filter(([event]) => event.kind === 'bash_session_updated')).toHaveLength(2)
      expect(recordEvent).toHaveBeenLastCalledWith(expect.objectContaining({
        kind: 'bash_session_updated',
        output: 'burst-two-99'
      }))

      await hooks.onSessionUpdated?.({ ...running, output: 'superseded-by-terminal' })
      await hooks.onSessionSettled?.({
        ...running,
        status: 'completed',
        finishedAt: '2026-01-01T00:00:12.000Z',
        exitCode: 0,
        output: 'final-output'
      })
      expect(recordEvent).toHaveBeenLastCalledWith(expect.objectContaining({
        kind: 'bash_session_completed',
        output: 'final-output'
      }))
      await vi.advanceTimersByTimeAsync(BACKGROUND_SHELL_UPDATE_CHECKPOINT_INTERVAL_MS)
      expect(recordEvent.mock.calls.filter(([event]) => event.kind === 'bash_session_updated')).toHaveLength(2)
      expect(recordEvent.mock.calls.filter(([event]) => event.kind === 'bash_session_completed')).toHaveLength(1)
    } finally {
      await runtime.shutdown()
      vi.useRealTimers()
    }
  })

  it('bounds settled sessions while retaining active shells', () => {
    const runtime = new BackgroundShellRuntime({
      events: { record: vi.fn(async () => undefined) } as unknown as RuntimeEventRecorder,
      threadStore: {} as ThreadStore,
      turns: {} as TurnService,
      nowIso: () => '2026-01-01T00:00:00.000Z'
    })
    for (let index = 0; index <= MAX_BACKGROUND_SHELL_SESSIONS; index += 1) {
      runtime.upsertSession({
        id: `settled_${index}`, threadId: 'thr_1', turnId: 'turn_1', command: 'true', cwd: '/tmp', shell: 'bash',
        status: 'completed', startedAt: '2026-01-01T00:00:00.000Z', exitCode: 0, output: '', detached: false
      })
    }
    runtime.upsertSession({
      id: 'running', threadId: 'thr_1', turnId: 'turn_1', command: 'sleep 1', cwd: '/tmp', shell: 'bash',
      status: 'running', startedAt: '2026-01-01T00:00:00.000Z', exitCode: null, output: '', detached: false
    })

    expect(runtime.listSessions()).toHaveLength(MAX_BACKGROUND_SHELL_SESSIONS + 1)
    expect(runtime.getSession('settled_0')).toBeNull()
    expect(runtime.getSession('running')).toMatchObject({ status: 'running' })
  })

  it('steers a running turn when a detached shell completes successfully', async () => {
    const steerTurn = vi.fn(async () => undefined)
    const startTurn = vi.fn(async () => ({ threadId: 'thr_1', turnId: 'turn_new', userMessageItemId: 'item_1' }))
    const runTurn = vi.fn(async () => undefined)
    const runtime = new BackgroundShellRuntime({
      events: { record: vi.fn(async () => undefined) } as unknown as RuntimeEventRecorder,
      threadStore: {
        get: vi.fn(async () => ({
          id: 'thr_1',
          status: 'running',
          turns: [{ id: 'turn_1', status: 'running' }]
        }))
      } as unknown as ThreadStore,
      turns: { steerTurn, startTurn } as unknown as TurnService,
      nowIso: () => '2026-01-01T00:00:00.000Z'
    })
    runtime.bindAgentLoop({ runTurn })
    await runtime.bashHooks().onSessionSettled?.({
      id: 'abcd1234',
      threadId: 'thr_1',
      turnId: 'turn_1',
      command: 'npm test',
      cwd: '/tmp',
      shell: 'bash',
      status: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:05.000Z',
      exitCode: 0,
      output: 'ok',
      detached: true
    })
    expect(steerTurn).toHaveBeenCalledWith({
      threadId: 'thr_1',
      turnId: 'turn_1',
      text: expect.stringContaining('<session_id>abcd1234</session_id>'),
      displayText: 'Background shell abcd1234 completed',
      messageSource: 'background_shell'
    })
    expect(startTurn).not.toHaveBeenCalled()
    expect(runTurn).not.toHaveBeenCalled()
  })

  it('starts a new turn with messageSource when the thread is idle', async () => {
    const steerTurn = vi.fn(async () => undefined)
    const startTurn = vi.fn(async () => ({ threadId: 'thr_1', turnId: 'turn_new', userMessageItemId: 'item_1' }))
    const runTurn = vi.fn(async () => undefined)
    const runtime = new BackgroundShellRuntime({
      events: { record: vi.fn(async () => undefined) } as unknown as RuntimeEventRecorder,
      threadStore: {
        get: vi.fn(async () => ({
          id: 'thr_1',
          status: 'idle',
          turns: [{ id: 'turn_1', status: 'completed', clientSurface: 'tui' }]
        }))
      } as unknown as ThreadStore,
      turns: { steerTurn, startTurn } as unknown as TurnService,
      nowIso: () => '2026-01-01T00:00:00.000Z'
    })
    runtime.bindAgentLoop({ runTurn })
    await runtime.bashHooks().onSessionSettled?.({
      id: 'abcd1234',
      threadId: 'thr_1',
      turnId: 'turn_1',
      command: 'npm test',
      cwd: '/tmp',
      shell: 'bash',
      status: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:05.000Z',
      exitCode: 0,
      output: 'ok',
      detached: true
    })
    expect(startTurn).toHaveBeenCalledWith({
      threadId: 'thr_1',
      request: {
        prompt: expect.stringContaining('<background_shell_completed>'),
        clientSurface: 'tui',
        displayText: 'Background shell abcd1234 completed',
        messageSource: 'background_shell'
      }
    })
    expect(runTurn).toHaveBeenCalledWith('thr_1', 'turn_new')
    expect(steerTurn).not.toHaveBeenCalled()
  })

  it('does not create a completion turn for an archived thread', async () => {
    const startTurn = vi.fn(async () => ({ threadId: 'thr_1', turnId: 'turn_new', userMessageItemId: 'item_1' }))
    const runTurn = vi.fn(async () => undefined)
    const runtime = new BackgroundShellRuntime({
      events: { record: vi.fn(async () => undefined) } as unknown as RuntimeEventRecorder,
      threadStore: {
        get: vi.fn(async () => ({
          id: 'thr_1',
          status: 'archived',
          turns: [{ id: 'turn_1', status: 'completed' }]
        }))
      } as unknown as ThreadStore,
      turns: { startTurn } as unknown as TurnService,
      nowIso: () => '2026-01-01T00:00:00.000Z'
    })
    runtime.bindAgentLoop({ runTurn })

    await runtime.bashHooks().onSessionSettled?.({
      id: 'abcd1234', threadId: 'thr_1', turnId: 'turn_1', command: 'npm test', cwd: '/tmp', shell: 'bash',
      status: 'completed', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:05.000Z',
      exitCode: 0, output: 'ok', detached: true
    })

    expect(startTurn).not.toHaveBeenCalled()
    expect(runTurn).not.toHaveBeenCalled()
  })

  it('stops active shells and suppresses completion auto-turns during shutdown', async () => {
    const stopSession = vi.fn(async () => true)
    const startTurn = vi.fn(async () => ({ threadId: 'thr_1', turnId: 'turn_new', userMessageItemId: 'item_1' }))
    const runTurn = vi.fn(async () => undefined)
    const runtime = new BackgroundShellRuntime({
      events: { record: vi.fn(async () => undefined) } as unknown as RuntimeEventRecorder,
      threadStore: {
        get: vi.fn(async () => ({
          id: 'thr_1',
          status: 'idle',
          turns: [{ id: 'turn_1', status: 'completed' }]
        }))
      } as unknown as ThreadStore,
      turns: { startTurn } as unknown as TurnService,
      nowIso: () => '2026-01-01T00:00:00.000Z'
    })
    runtime.bindStopHandler(stopSession)
    runtime.bindAgentLoop({ runTurn })
    runtime.upsertSession({
      id: 'running1', threadId: 'thr_1', turnId: 'turn_1', command: 'sleep 10', cwd: '/tmp', shell: 'bash',
      status: 'running', startedAt: '2026-01-01T00:00:00.000Z', exitCode: null, output: '', detached: true
    })

    await runtime.shutdown()
    expect(stopSession).toHaveBeenCalledWith('running1')

    await runtime.bashHooks().onSessionSettled?.({
      id: 'running1', threadId: 'thr_1', turnId: 'turn_1', command: 'sleep 10', cwd: '/tmp', shell: 'bash',
      status: 'completed', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:05.000Z',
      exitCode: 0, output: 'ok', detached: true
    })

    expect(startTurn).not.toHaveBeenCalled()
    expect(runTurn).not.toHaveBeenCalled()
  })

  it('stops only the active shells belonging to a deleted thread', async () => {
    const stopSession = vi.fn(async () => true)
    const runtime = new BackgroundShellRuntime({
      events: { record: vi.fn(async () => undefined) } as unknown as RuntimeEventRecorder,
      threadStore: {} as ThreadStore,
      turns: {} as TurnService,
      nowIso: () => '2026-01-01T00:00:00.000Z'
    })
    runtime.bindStopHandler(stopSession)
    runtime.upsertSession({
      id: 'delete_me', threadId: 'thr_delete', turnId: 'turn_1', command: 'sleep 10', cwd: '/tmp', shell: 'bash',
      status: 'running', startedAt: '2026-01-01T00:00:00.000Z', exitCode: null, output: '', detached: true
    })
    runtime.upsertSession({
      id: 'keep_me', threadId: 'thr_keep', turnId: 'turn_2', command: 'sleep 10', cwd: '/tmp', shell: 'bash',
      status: 'running', startedAt: '2026-01-01T00:00:00.000Z', exitCode: null, output: '', detached: true
    })

    await expect(runtime.stopThread('thr_delete')).resolves.toBe(1)
    expect(stopSession).toHaveBeenCalledTimes(1)
    expect(stopSession).toHaveBeenCalledWith('delete_me')
  })
})
