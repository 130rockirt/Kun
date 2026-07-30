import { describe, expect, it, vi } from 'vitest'
import type { BackgroundShellRecordInput } from '../adapters/tool/builtin-tool-types.js'
import { createThreadRecord } from '../domain/thread.js'
import { createTurnRecord } from '../domain/turn.js'
import { BackgroundShellRuntime, type BackgroundShellRuntimeDeps } from './background-shell-runtime.js'

function settledShell(
  status: BackgroundShellRecordInput['status']
): BackgroundShellRecordInput {
  return {
    id: 'shell001',
    threadId: 'thread_1',
    turnId: 'turn_source',
    command: 'npm run build',
    cwd: '/tmp/workspace',
    shell: '/bin/zsh',
    status,
    startedAt: '2026-07-29T00:00:00.000Z',
    finishedAt: '2026-07-29T00:01:00.000Z',
    exitCode: status === 'completed' ? 0 : 1,
    output: status === 'completed' ? 'build complete' : 'build failed',
    detached: true
  }
}

describe('BackgroundShellRuntime completion handoff', () => {
  it.each(['completed', 'failed', 'stopped'] as const)(
    'automatically resumes the agent after a detached shell is %s (#1031)',
    async (status) => {
      const sourceTurn = createTurnRecord({
        id: 'turn_source',
        threadId: 'thread_1',
        prompt: 'Build the project.',
        clientSurface: 'gui',
        disableUserInput: true,
        status: 'completed'
      })
      const thread = {
        ...createThreadRecord({
          id: 'thread_1',
          title: 'Build',
          workspace: '/tmp/workspace',
          model: 'test-model',
          status: 'idle'
        }),
        turns: [sourceTurn]
      }
      const startTurn = vi.fn(async () => ({
        threadId: 'thread_1',
        turnId: 'turn_callback'
      }))
      const steerTurn = vi.fn(async () => undefined)
      const recordEvent = vi.fn(async (event: unknown) => event)
      const runTurn = vi.fn(async () => 'completed')
      const runtime = new BackgroundShellRuntime({
        events: { record: recordEvent },
        threadStore: { get: vi.fn(async () => thread) },
        turns: { startTurn, steerTurn },
        nowIso: () => '2026-07-29T00:01:00.000Z'
      } as unknown as BackgroundShellRuntimeDeps)
      runtime.bindAgentLoop({ runTurn })

      await runtime.bashHooks().onSessionSettled?.(settledShell(status))

      expect(startTurn).toHaveBeenCalledWith({
        threadId: 'thread_1',
        request: expect.objectContaining({
          prompt: expect.stringContaining('<background_shell_completed>'),
          displayText: expect.stringContaining('shell001'),
          messageSource: 'background_shell',
          clientSurface: 'gui',
          disableUserInput: true
        })
      })
      expect(runTurn).toHaveBeenCalledWith('thread_1', 'turn_callback')
    }
  )

  it('does not resume for a foreground shell settlement', async () => {
    const startTurn = vi.fn(async () => ({
      threadId: 'thread_1',
      turnId: 'turn_callback'
    }))
    const runtime = new BackgroundShellRuntime({
      events: { record: vi.fn(async (event: unknown) => event) },
      threadStore: { get: vi.fn() },
      turns: { startTurn, steerTurn: vi.fn() },
      nowIso: () => '2026-07-29T00:01:00.000Z'
    } as unknown as BackgroundShellRuntimeDeps)
    const record = { ...settledShell('completed'), detached: false }

    await runtime.bashHooks().onSessionSettled?.(record)

    expect(startTurn).not.toHaveBeenCalled()
  })
})
