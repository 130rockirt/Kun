import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorktreeSettingsSection } from './settings-section-worktree'

describe('worktree settings', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps the experimental plan-isolation switch out of worktree management', async () => {
    const updateKun = vi.fn()
    vi.stubGlobal('window', {
      kunGui: {
        listGitBranchWorktrees: vi.fn(async () => ({
          ok: true,
          worktreeRoot: '/managed',
          mainBranch: 'feature/source',
          worktrees: []
        }))
      }
    })
    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = create(createElement(WorktreeSettingsSection, {
        ctx: {
          t: (key: string) => key,
          form: {
            workspaceRoot: '/repo',
            gitBranchPrefix: 'codex/'
          },
          kun: {},
          update: vi.fn(),
          updateKun,
          threads: [],
          locale: 'en'
        }
      }))
    })

    expect(renderer!.root.findAllByProps({ role: 'switch' })).toHaveLength(0)
    expect(updateKun).not.toHaveBeenCalled()
    act(() => renderer!.unmount())
  })
})
