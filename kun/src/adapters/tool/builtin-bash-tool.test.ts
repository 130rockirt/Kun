import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import type { ToolHostContext } from '../../ports/tool-host.js'
import {
  DEFAULT_BACKGROUND_BASH_TIMEOUT_SECONDS,
  DEFAULT_BASH_TIMEOUT_SECONDS,
  type BackgroundShellRecordInput
} from './builtin-tool-types.js'
import {
  createBashLocalTool,
  DEFAULT_FOREGROUND_BASH_LIVENESS_INTERVAL_MS,
  listBashSessionRecords,
  stopBashSessionById
} from './builtin-bash-tool.js'

vi.mock('./local-tool-host.js', () => ({
  LocalToolHost: {
    defineTool: (tool: unknown) => tool
  }
}))

const TEST_TIMEOUT_MS = 10_000

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('background shell did not settle')), TEST_TIMEOUT_MS)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function buildContext(workspace: string, abortSignal = new AbortController().signal): ToolHostContext {
  return {
    threadId: 'thread_foreground',
    turnId: 'turn_foreground',
    workspace,
    approvalPolicy: 'auto',
    sandboxMode: 'workspace-write',
    abortSignal,
    awaitApproval: async () => 'allow' as const
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('bash tool schema', () => {
  it('requires a command so models cannot emit an empty bash invocation', () => {
    const tool = createBashLocalTool()

    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      required: ['command'],
      properties: {
        command: { type: 'string' }
      }
    })
  })

  it('advertises a 15-minute foreground ceiling and explicit 24-hour background execution', () => {
    const tool = createBashLocalTool()

    expect(DEFAULT_BASH_TIMEOUT_SECONDS).toBe(15 * 60)
    expect(DEFAULT_BACKGROUND_BASH_TIMEOUT_SECONDS).toBe(24 * 60 * 60)
    expect(DEFAULT_FOREGROUND_BASH_LIVENESS_INTERVAL_MS).toBe(30 * 1000)
    expect(tool.description).toContain('900-second ceiling')
    expect(tool.description).toContain('Commands expected to run longer must set background=true')
    expect(tool.description).toContain('86400-second ceiling')
  })

  it('passes separate foreground and background defaults to execution admission', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-bash-defaults-'))
    const exec = vi.fn(async () => ({ exitCode: 0 }))
    const tool = createBashLocalTool({ operations: { exec }, maxBackgroundTimeoutSeconds: 1 })

    try {
      await tool.execute({ command: 'echo foreground' }, buildContext(workspace))
      expect(exec).toHaveBeenCalledWith(
        'echo foreground',
        workspace,
        expect.objectContaining({ timeoutSeconds: 15 * 60 })
      )

      const background = await tool.execute(
        { command: 'echo background', background: true },
        buildContext(workspace)
      )
      expect(background).toMatchObject({
        isError: true,
        output: {
          error: expect.stringContaining('timeout exceeds 1 seconds'),
          timeout: 24 * 60 * 60
        }
      })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})

describe('foreground bash liveness and cleanup', () => {
  it('emits silent-command liveness without waiting for durable output', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-bash-liveness-'))
    const updates: Array<Record<string, unknown>> = []
    const tool = createBashLocalTool({
      defaultTimeoutSeconds: 2,
      foregroundLivenessIntervalMs: 20,
      operations: {
        exec: async () => {
          await new Promise((resolve) => setTimeout(resolve, 75))
          return { exitCode: 0 }
        }
      }
    })

    try {
      const result = await tool.execute(
        { command: 'silent command' },
        buildContext(workspace),
        (update) => {
          updates.push(update.output as Record<string, unknown>)
        }
      )

      expect(result.isError).not.toBe(true)
      expect(updates[0]).toMatchObject({ partial: true, output: '' })
      expect(updates.some((update) => update.liveness === true)).toBe(true)
      expect(updates.find((update) => update.liveness === true)).toMatchObject({
        elapsed_seconds: expect.any(Number),
        last_output_age_seconds: expect.any(Number)
      })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'force-kills a foreground process tree that ignores graceful timeout',
    async () => {
      const workspace = await mkdtemp(join(tmpdir(), 'kun-bash-timeout-tree-'))
      const controller = new AbortController()
      const tool = createBashLocalTool({ defaultTimeoutSeconds: 1 })
      const command = `trap '' TERM; sh -c 'trap "" TERM; while :; do sleep 1; done' & child=$!; printf '%s' "$child" > ignored-child.pid; wait "$child"`
      const startedAt = Date.now()

      try {
        const result = await withTimeout(tool.execute({ command }, buildContext(workspace, controller.signal)))

        expect(result).toMatchObject({
          isError: true,
          output: {
            code: 'tool_timeout',
            timeout_seconds: 1,
            error: 'command timed out after 1 seconds'
          }
        })
        expect(Date.now() - startedAt).toBeLessThan(5000)
        const childPid = Number(await readFile(join(workspace, 'ignored-child.pid'), 'utf8'))
        await vi.waitFor(() => expect(processIsAlive(childPid)).toBe(false), { timeout: 1000 })
      } finally {
        controller.abort()
        await rm(workspace, { recursive: true, force: true })
      }
    },
    TEST_TIMEOUT_MS
  )

  it.skipIf(process.platform === 'win32')(
    'uses the same force-kill path when a foreground command is cancelled',
    async () => {
      const workspace = await mkdtemp(join(tmpdir(), 'kun-bash-cancel-tree-'))
      const controller = new AbortController()
      const tool = createBashLocalTool({ defaultTimeoutSeconds: 10 })
      const command = `trap '' TERM; sh -c 'trap "" TERM; while :; do sleep 1; done' & child=$!; printf '%s' "$child" > ignored-child.pid; wait "$child"`
      const running = tool.execute({ command }, buildContext(workspace, controller.signal))

      try {
        await vi.waitFor(async () => {
          const childPid = Number(await readFile(join(workspace, 'ignored-child.pid'), 'utf8'))
          expect(childPid).toBeGreaterThan(0)
        })
        const startedAt = Date.now()
        controller.abort()
        const result = await withTimeout(running)

        expect(result).toMatchObject({
          isError: true,
          output: { error: 'command aborted' }
        })
        expect(Date.now() - startedAt).toBeLessThan(5000)
        const childPid = Number(await readFile(join(workspace, 'ignored-child.pid'), 'utf8'))
        await vi.waitFor(() => expect(processIsAlive(childPid)).toBe(false), { timeout: 1000 })
      } finally {
        controller.abort()
        await running.catch(() => undefined)
        await rm(workspace, { recursive: true, force: true })
      }
    },
    TEST_TIMEOUT_MS
  )

  it.skipIf(process.platform === 'win32')(
    'uses the shared force-kill path for runtime-owned background session stops',
    async () => {
      const workspace = await mkdtemp(join(tmpdir(), 'kun-bash-background-stop-tree-'))
      const tool = createBashLocalTool({
        backgroundShellDataDir: workspace,
        defaultBackgroundTimeoutSeconds: 10
      })
      const command = `trap '' TERM; sh -c 'trap "" TERM; while :; do sleep 1; done' & child=$!; printf '%s' "$child" > ignored-child.pid; wait "$child"`

      try {
        const started = await tool.execute(
          { command, background: true },
          buildContext(workspace)
        )
        expect(started).toMatchObject({
          output: { status: 'running', session_id: expect.any(String) }
        })
        const sessionId = String((started.output as Record<string, unknown>).session_id)
        await vi.waitFor(async () => {
          const childPid = Number(await readFile(join(workspace, 'ignored-child.pid'), 'utf8'))
          expect(childPid).toBeGreaterThan(0)
        })

        expect(await stopBashSessionById(sessionId, 'thread_foreground')).toBe(true)
        const childPid = Number(await readFile(join(workspace, 'ignored-child.pid'), 'utf8'))
        await vi.waitFor(() => expect(processIsAlive(childPid)).toBe(false), { timeout: 1000 })
      } finally {
        await rm(workspace, { recursive: true, force: true })
      }
    },
    TEST_TIMEOUT_MS
  )
})

describe('background bash progress', () => {
  it.skipIf(process.platform === 'win32')(
    'rolls back the process and session when the start hook rejects',
    async () => {
      const workspace = await mkdtemp(join(tmpdir(), 'kun-background-start-reject-'))
      let rejectedSessionId = ''
      let settledRecord: BackgroundShellRecordInput | undefined
      const tool = createBashLocalTool({
        backgroundShellDataDir: workspace,
        defaultBackgroundTimeoutSeconds: 10,
        backgroundShell: {
          onSessionStarted: async (record) => {
            rejectedSessionId = record.id
            await vi.waitFor(async () => {
              const childPid = Number(await readFile(join(workspace, 'ignored-child.pid'), 'utf8'))
              expect(childPid).toBeGreaterThan(0)
            })
            throw new Error('start hook rejected')
          },
          onSessionSettled: (record) => {
            settledRecord = record
          }
        }
      })
      const command = `trap '' TERM; sh -c 'trap "" TERM; while :; do sleep 1; done' & child=$!; printf '%s' "$child" > ignored-child.pid; wait "$child"`

      try {
        const result = await withTimeout(tool.execute(
          { command, background: true },
          buildContext(workspace)
        ))

        expect(result).toMatchObject({
          isError: true,
          output: { error: 'start hook rejected' }
        })
        expect((result.output as Record<string, unknown>).session_id).toBeUndefined()
        expect(rejectedSessionId).toMatch(/^[a-z0-9]{8}$/)
        expect(settledRecord).toMatchObject({ id: rejectedSessionId, status: 'stopped' })
        const childPid = Number(await readFile(join(workspace, 'ignored-child.pid'), 'utf8'))
        await vi.waitFor(() => expect(processIsAlive(childPid)).toBe(false), { timeout: 1000 })
        expect(await listBashSessionRecords('thread_foreground')).not.toContainEqual(
          expect.objectContaining({ id: rejectedSessionId })
        )
      } finally {
        await rm(workspace, { recursive: true, force: true })
      }
    },
    TEST_TIMEOUT_MS
  )

  it('clears the background timeout when a fast process exits during the start hook', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-background-fast-exit-'))
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    let settleSession: ((record: BackgroundShellRecordInput) => void) | undefined
    const settled = new Promise<BackgroundShellRecordInput>((resolve) => {
      settleSession = resolve
    })
    const tool = createBashLocalTool({
      backgroundShellDataDir: workspace,
      defaultBackgroundTimeoutSeconds: 7,
      backgroundShell: {
        onSessionStarted: async () => {
          await new Promise((resolve) => setTimeout(resolve, 100))
        },
        onSessionSettled: (record) => settleSession?.(record)
      }
    })

    try {
      await tool.execute(
        { command: 'node -e "process.exit(0)"', background: true },
        buildContext(workspace)
      )
      expect((await withTimeout(settled)).status).toBe('completed')

      const timerIndex = setTimeoutSpy.mock.calls.findIndex((call) => call[1] === 7000)
      expect(timerIndex).toBeGreaterThanOrEqual(0)
      const timeoutHandle = setTimeoutSpy.mock.results[timerIndex]?.value
      expect(clearTimeoutSpy.mock.calls.some((call) => call[0] === timeoutHandle)).toBe(true)
    } finally {
      setTimeoutSpy.mockRestore()
      clearTimeoutSpy.mockRestore()
      await rm(workspace, { recursive: true, force: true })
    }
  }, TEST_TIMEOUT_MS)

  it('keeps session updates live without updating the tool call after handoff', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-background-bash-'))
    const toolUpdates = vi.fn()
    const sessionUpdates = vi.fn()
    let settleSession: ((record: BackgroundShellRecordInput) => void) | undefined
    const settled = new Promise<BackgroundShellRecordInput>((resolve) => {
      settleSession = resolve
    })
    const tool = createBashLocalTool({
      backgroundShellDataDir: workspace,
      defaultTimeoutSeconds: 5,
      backgroundShell: {
        onSessionUpdated: sessionUpdates,
        onSessionSettled: (record) => settleSession?.(record)
      }
    })
    const context = {
      threadId: 'thread_background',
      turnId: 'turn_background',
      workspace,
      approvalPolicy: 'auto',
      sandboxMode: 'workspace-write',
      abortSignal: new AbortController().signal,
      awaitApproval: async () => 'allow' as const
    } as ToolHostContext

    try {
      const result = await tool.execute({
        command: 'node -e "setTimeout(() => console.log(\'late-output\'), 100); setTimeout(() => {}, 300)"',
        background: true
      }, context, toolUpdates)
      const updatesAtHandoff = toolUpdates.mock.calls.length

      expect(result.output).toMatchObject({
        status: 'running',
        partial: true
      })

      const terminal = await withTimeout(settled)

      expect(terminal.status).toBe('completed')
      expect(terminal.output).toContain('late-output')
      expect(sessionUpdates).toHaveBeenCalled()
      expect(toolUpdates).toHaveBeenCalledTimes(updatesAtHandoff)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  }, TEST_TIMEOUT_MS)
})
