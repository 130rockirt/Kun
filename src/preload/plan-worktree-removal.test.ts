import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('legacy plan-worktree host API removal', () => {
  it('does not expose or register plan-specific worktree IPC', () => {
    const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
    const preload = readFileSync(resolve(root, 'src/preload/index.ts'), 'utf8')
    const apiSurface = readFileSync(resolve(root, 'src/shared/kun-gui-api-surface.ts'), 'utf8')
    const ipcRegistration = readFileSync(
      resolve(root, 'src/main/ipc/register-app-ipc-handlers.ts'),
      'utf8'
    )

    expect(preload).not.toContain('planWorktree:')
    expect(preload).not.toContain("'plan-worktree:")
    expect(apiSurface).not.toContain('PlanWorktreeApi')
    expect(ipcRegistration).not.toContain('registerAppPlanWorktreeIpcHandlers')
    expect(existsSync(resolve(
      root,
      'src/renderer/src/plan/PlanWorktreeGlobalRecovery.tsx'
    ))).toBe(false)
    expect(existsSync(resolve(
      root,
      'src/renderer/src/components/plan/PlanWorktreeLifecycle.tsx'
    ))).toBe(false)
    expect(existsSync(resolve(
      root,
      'src/renderer/src/store/chat-store-plan-worktree-actions.ts'
    ))).toBe(false)
  })
})
