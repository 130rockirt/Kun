import { describe, expect, it } from 'vitest'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { planModeToolBlock } from './plan-mode-tool-policy.js'

function context(): ToolHostContext {
  return {
    threadId: 'thread_1',
    turnId: 'turn_1',
    workspace: '/workspace',
    threadMode: 'plan',
    approvalPolicy: 'auto',
    sandboxMode: 'workspace-write',
    abortSignal: new AbortController().signal,
    awaitApproval: async () => 'allow'
  }
}

describe('Plan mode tool execution policy', () => {
  it('allows generate_image while continuing to block project file mutation', async () => {
    await expect(planModeToolBlock(
      { name: 'generate_image', toolKind: 'file_change' },
      {},
      context()
    )).resolves.toBeNull()

    await expect(planModeToolBlock(
      { name: 'write', toolKind: 'file_change' },
      {},
      context()
    )).resolves.toMatchObject({ code: 'plan_mode_write_blocked' })
  })
})
