import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { createElement } from 'react'
import type { NormalizedThread } from '../../agent/types'
import {
  emptyDesignThreadRegistry,
  markDesignThread
} from '../../design/design-thread-registry'
import { markSddAssistantThread } from '../../sdd/sdd-thread-registry'
import type { SddDraft } from '../../sdd/sdd-draft-store'
import { useSddDraftStore } from '../../sdd/sdd-draft-store'
import type { RightPanelMode } from '../chat/WorkbenchTopBar'
import {
  isWorkbenchDesignThread,
  useWorkbenchNavigationController,
  type UseWorkbenchNavigationControllerParams
} from './useWorkbenchNavigationController'

function thread(agentSurface?: NormalizedThread['agentSurface']): NormalizedThread {
  return {
    id: 'thr_design',
    title: 'A drawing',
    ...(agentSurface ? { agentSurface } : {}),
    updatedAt: '2026-08-01T00:00:00.000Z',
    model: 'gpt-5.6-luna',
    mode: 'agent',
    workspace: '/workspace/project'
  }
}

describe('workbench thread navigation surface', () => {
  it('routes a durably classified Design thread to Design without a local registry', () => {
    expect(isWorkbenchDesignThread(
      'thr_design',
      thread('design'),
      emptyDesignThreadRegistry()
    )).toBe(true)
  })

  it('keeps legacy registered Design threads on the Design route', () => {
    const registry = markDesignThread(
      '/workspace/project',
      'drawing-1',
      'thr_design',
      emptyDesignThreadRegistry()
    )

    expect(isWorkbenchDesignThread('thr_design', thread(), registry)).toBe(true)
  })

  it('leaves Code and Write threads on their own navigation paths', () => {
    expect(isWorkbenchDesignThread(
      'thr_design',
      thread('code'),
      emptyDesignThreadRegistry()
    )).toBe(false)
    expect(isWorkbenchDesignThread(
      'thr_design',
      thread('write'),
      emptyDesignThreadRegistry()
    )).toBe(false)
  })
})

class MemoryStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

type NavigationProps = UseWorkbenchNavigationControllerParams

function makeProps(overrides: Partial<NavigationProps> = {}): NavigationProps {
  return {
    activeSddDraft: false,
    activeThreadId: null,
    pluginHostRoute: 'chat',
    rightPanelMode: null,
    route: 'chat',
    runtimeConnection: 'ready',
    sddDraftContent: '',
    threads: [],
    useWorktreePool: false,
    workspaceRoot: '/workspace',
    worktreeBranch: '',
    clearFilePreviewTargets: vi.fn(),
    createConversation: vi.fn(async () => undefined),
    createThread: vi.fn(async () => 'thr_new'),
    createWriteThread: vi.fn(async () => 'thr_write'),
    dismissActiveSddDraft: vi.fn(),
    ensureWriteThreadForWorkspace: vi.fn(async () => null),
    findSddDraftForSidebarThread: vi.fn(async () => null),
    openClaw: vi.fn(),
    openCode: vi.fn(async () => undefined),
    openDesign: vi.fn(),
    openPlugins: vi.fn(),
    openSchedule: vi.fn(),
    openWorkflow: vi.fn(),
    openWrite: vi.fn(async () => undefined),
    selectThread: vi.fn(async () => undefined),
    setConnectPhoneSidebarOpen: vi.fn(),
    setDesignAssistantOpen: vi.fn(),
    setFilePreviewTarget: vi.fn(),
    setInput: vi.fn(),
    setRightPanelMode: vi.fn(),
    setRoute: vi.fn(),
    setUseWorktreePool: vi.fn(),
    setWriteAssistantOpen: vi.fn(),
    ...overrides
  } as NavigationProps
}

const sddDraft: SddDraft = {
  id: 'draft-1',
  workspaceRoot: '/Users/zxy/project',
  relativePath: '.kunsdd/requirements/draft-1/requirement.md',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

const requirementThread: NormalizedThread = {
  id: 'thr_sdd',
  title: 'Requirement session',
  updatedAt: '2026-01-02T00:00:00.000Z',
  model: 'deepseek-v4-pro',
  mode: 'agent',
  workspace: '/Users/zxy/project'
}

let latestController: ReturnType<typeof useWorkbenchNavigationController>

function ControllerHarness(props: NavigationProps): null {
  latestController = useWorkbenchNavigationController(props)
  return null
}

async function renderController(props: NavigationProps): Promise<{
  renderer: ReactTestRenderer
  rerender: (next: NavigationProps) => Promise<void>
}> {
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(createElement(ControllerHarness, props))
  })
  return {
    renderer,
    rerender: async (next) => {
      await act(async () => {
        renderer.update(createElement(ControllerHarness, next))
      })
    }
  }
}

describe('workbench navigation controller requirement sessions', () => {
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    useSddDraftStore.getState().clearActiveDraft()
    vi.stubGlobal('window', { localStorage: new MemoryStorage() })
  })

  afterEach(() => {
    useSddDraftStore.getState().clearActiveDraft()
    vi.unstubAllGlobals()
  })

  it('opens only the clicked requirement AI session without opening its draft', async () => {
    const storage = new MemoryStorage()
    markSddAssistantThread(sddDraft, requirementThread.id, storage)
    vi.stubGlobal('window', { localStorage: storage })
    const props = makeProps({
      threads: [requirementThread],
      findSddDraftForSidebarThread: vi.fn(async () => sddDraft)
    })

    await renderController(props)
    await act(async () => {
      latestController.openThread(requirementThread.id)
    })

    expect(props.selectThread).toHaveBeenCalledWith(requirementThread.id)
    expect(props.setRoute).toHaveBeenCalledWith('chat')
    // 点击需求会话不得自动展开草稿编辑器。
    expect(useSddDraftStore.getState().activeDraft).toBeNull()
  })

  it('dismisses an unrelated open draft when clicking a requirement session', async () => {
    const storage = new MemoryStorage()
    markSddAssistantThread(sddDraft, requirementThread.id, storage)
    vi.stubGlobal('window', { localStorage: storage })
    const props = makeProps({
      threads: [requirementThread],
      findSddDraftForSidebarThread: vi.fn(async () => sddDraft)
    })
    useSddDraftStore.getState().setActiveDraft(sddDraft, '# other draft')

    await renderController(props)
    await act(async () => {
      latestController.openThread(requirementThread.id)
    })

    expect(props.dismissActiveSddDraft).toHaveBeenCalledWith({ closeAssistant: true })
    expect(props.selectThread).toHaveBeenCalledWith(requirementThread.id)
  })

  it('opens a plain Code thread through the ordinary path', async () => {
    const codeThread = {
      ...thread(),
      id: 'thr_code',
      title: 'Code task',
      workspace: '/workspace/project'
    }
    const props = makeProps({
      threads: [codeThread]
    })

    await renderController(props)
    await act(async () => {
      latestController.openThread('thr_code')
    })

    expect(props.selectThread).toHaveBeenCalledWith('thr_code')
    expect(props.setRoute).toHaveBeenCalledWith('chat')
    expect(props.findSddDraftForSidebarThread).toHaveBeenCalledWith('thr_code', codeThread)
  })
})

describe('workbench navigation controller Connect Phone return', () => {
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    useSddDraftStore.getState().clearActiveDraft()
    vi.stubGlobal('window', { localStorage: new MemoryStorage() })
  })

  afterEach(() => {
    useSddDraftStore.getState().clearActiveDraft()
    vi.unstubAllGlobals()
  })

  it('keeps the requirement draft when opening Connect Phone and restores Code on return', async () => {
    const props = makeProps({ activeSddDraft: true, route: 'chat' })
    const { rerender } = await renderController(props)

    await act(async () => {
      latestController.toggleConnectPhone()
    })
    expect(props.openClaw).toHaveBeenCalled()
    expect(props.setConnectPhoneSidebarOpen).toHaveBeenCalledWith(true)
    // 打开 Connect Phone 不清空需求草稿。
    expect(props.dismissActiveSddDraft).not.toHaveBeenCalled()

    ;(props.openCode as ReturnType<typeof vi.fn>).mockClear()
    await rerender({ ...props, route: 'claw' })
    await act(async () => {
      latestController.toggleConnectPhone()
    })
    expect(props.setConnectPhoneSidebarOpen).toHaveBeenCalledWith(false)
    expect(props.openCode).toHaveBeenCalled()
    expect(props.openWrite).not.toHaveBeenCalled()
  })

  it.each([
    ['write', 'openWrite'],
    ['design', 'openDesign'],
    ['plugins', 'setRoute'],
    ['schedule', 'setRoute'],
    ['extensions', 'setRoute'],
    ['workflow', 'setRoute']
  ] as const)('restores %s after closing Connect Phone', async (returnRoute, expectedCall) => {
    const props = makeProps({ route: returnRoute })
    const { rerender } = await renderController(props)
    // 先进入 Connect Phone,再切到 claw 路由后关闭。
    await act(async () => {
      latestController.toggleConnectPhone()
    })
    await rerender({ ...props, route: 'claw' })

    await act(async () => {
      latestController.toggleConnectPhone()
    })

    if (expectedCall === 'openWrite') {
      expect(props.openWrite).toHaveBeenCalled()
    } else if (expectedCall === 'openDesign') {
      expect(props.openDesign).toHaveBeenCalled()
    } else {
      expect(props.setRoute).toHaveBeenCalledWith(returnRoute)
    }
  })

  it('does not leave a Claw thread active on the Code route after returning', async () => {
    const props = makeProps({ route: 'chat' })
    const { rerender } = await renderController(props)
    await act(async () => {
      latestController.toggleConnectPhone()
    })

    ;(props.openCode as ReturnType<typeof vi.fn>).mockClear()
    await rerender({ ...props, route: 'claw' })
    await act(async () => {
      latestController.toggleConnectPhone()
    })
    expect(props.openCode).toHaveBeenCalled()
    expect(props.setRoute).not.toHaveBeenCalledWith('claw')
  })
})
