import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import type { ToolHostContext } from '../../ports/tool-host.js'
import type { BackgroundShellRecordInput } from './builtin-tool-types.js'
import { createBashLocalTool } from './builtin-bash-tool.js'

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

describe('background bash progress', () => {
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
