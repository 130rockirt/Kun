import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorktreeSettingsSection } from './settings-section-worktree'
import { resetPlanWorktreeStoreForTests } from '../plan/plan-worktree-store'

describe('worktree settings', () => {
  afterEach(() => {
    resetPlanWorktreeStoreForTests()
    vi.unstubAllGlobals()
  })

  it('defaults plan isolation off and persists an explicit opt-in', async () => {
    const updateKun = vi.fn()
    vi.stubGlobal('window', {
      kunGui: {
        listGitBranchWorktrees: vi.fn(async () => ({
          ok: true,
          worktreeRoot: '/managed',
          mainBranch: 'feature/source',
          worktrees: []
        })),
        planWorktree: {
          list: vi.fn(async () => [])
        }
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

    const toggle = renderer!.root.findByProps({
      role: 'switch',
      'aria-label': 'planWorktreeDefaultTitle'
    })
    expect(toggle.props['aria-checked']).toBe(false)
    await act(async () => toggle.props.onClick())
    expect(updateKun).toHaveBeenCalledWith({
      planExecution: { useWorktreeByDefault: true }
    })
    act(() => renderer!.unmount())
  })
})
