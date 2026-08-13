import { describe, expect, it, vi } from 'vitest'
import { discoverSidebarWorktrees } from './sidebar-worktree-discovery'

describe('sidebar worktree discovery', () => {
  it('maps arbitrary linked worktree layouts to the primary project', async () => {
    const readBranches = vi.fn(async (workspaceRoot: string) => ({
      ok: true as const,
      repositoryRoot: workspaceRoot,
      primaryRepositoryRoot: '/Users/zxy/codeproject/ds_project/DeepSeek-GUI',
      currentBranch: 'codex/kun-tui',
      branches: [],
      dirtyCount: 0
    }))

    await expect(discoverSidebarWorktrees([
      '/Users/zxy/codeproject/ds_project/DeepSeek-GUI.worktrees/kun-tui'
    ], readBranches)).resolves.toEqual({
      'git:/users/zxy/codeproject/ds_project/deepseek-gui.worktrees/kun-tui': {
        projectPath: '/Users/zxy/codeproject/ds_project/DeepSeek-GUI',
        worktreePath: '/Users/zxy/codeproject/ds_project/DeepSeek-GUI.worktrees/kun-tui',
        branch: 'codex/kun-tui'
      }
    })
  })

  it('ignores primary checkouts and isolates Git lookup failures', async () => {
    const main = '/Users/zxy/codeproject/ds_project/DeepSeek-GUI'
    const readBranches = vi.fn(async (workspaceRoot: string) => {
      if (workspaceRoot.endsWith('/missing')) throw new Error('missing')
      return {
        ok: true as const,
        repositoryRoot: main,
        primaryRepositoryRoot: main,
        currentBranch: 'develop',
        branches: [],
        dirtyCount: 0
      }
    })

    await expect(discoverSidebarWorktrees([main, `${main}/missing`], readBranches))
      .resolves.toEqual({})
  })
})
